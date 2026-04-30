# Building a Self-Hosted Supabase Cloud Clone on Bare Metal: An Architectural Reference

This report maps every closed-source component of Supabase Cloud (which runs on AWS + Cloudflare + Pulumi) to a concrete open-source replacement suitable for a multi-tenant, multi-DC, no-Kubernetes deployment built on Firecracker microVMs. It is written for a system architect who is going to fork Supabase OSS and operate the platform themselves across ~10 colo locations.

The closest reference architecture in the public cloud world is **Fly.io**, whose engineering blog is the most directly applicable body of prior art: Firecracker on bare metal across many regions, anycast IPs, no Kubernetes, a per-host Go orchestrator (`flyd`), a CRDT-replicated SQLite gossip layer (`Corrosion`), and a Rust proxy (`fly-proxy`). **Koyeb's** "from Kubernetes to Nomad + Firecracker + Kuma" post is the second key reference, because they build on a stack you can actually buy off the shelf. **Neon's** pageserver/safekeeper split is the right reference for branching/PITR. Where this report makes calls, they tend to align with the choices Fly, Koyeb, and Neon have publicly defended.

---

## 1. Recommended stack at a glance

| Supabase Cloud component (closed) | Recommended OSS replacement | Why |
|---|---|---|
| Pulumi + custom control plane (provisioning) | **Custom Go control plane (global) + per-host `flyd`-style agent**, with **HashiCorp Nomad + firecracker-task-driver** as the scheduling primitive for stateless multi-tenant services; a custom orchestrator for stateful per-tenant Postgres microVMs | Nomad is proven to 10K+ nodes, federates natively, and Koyeb runs exactly this pattern in production. A per-host Go agent for Postgres microVMs (Fly's `flyd` model) is needed because Nomad's scheduler is not the right place to encode "this volume must follow this VM" semantics. |
| Pulumi as IaC | **OpenTofu** (or **Pulumi Automation API** with a self-hosted state backend) for *infrastructure*; for *tenant lifecycle*, a Go state machine writing to Postgres, NOT IaC | IaC is a poor fit for thousands of tenants/sec; you want imperative state machines with idempotent steps. Use OpenTofu for racks, networks, hypervisors; use code for projects. |
| Cloudflare CDN/edge | **BGP anycast** announced via **BIRD2 + GoCast** + **Caddy** (on-demand TLS) or **Pingora**/Envoy at the edge; **Varnish** for HTTP caching; **bunny.net** or **Fastly** if you want hosted edge while keeping origins self-hosted | This is the hardest replacement; expect to keep a hosted CDN in front for at least year one. |
| Cloudflare DDoS / WAF | **Coraza WAF** + **OWASP CRS**; **FastNetMon** + RTBH for L3/L4; transit DDoS scrubbing from upstreams (Voxility, Path.net) or Hivelocity's included filtering | Pure DIY DDoS at >50 Gbps is hard; lean on transit providers. |
| AWS S3 | **Garage** for geo-replicated user blobs; **MinIO** or **Ceph RGW** for high-throughput regional pools; **SeaweedFS** for billions-of-small-files cases | Garage is purpose-built for multi-DC over plain Internet; MinIO has the most operational surface but recent license/feature concerns post-2024; Ceph RGW is the most fully-featured S3 but the biggest operational ask. |
| AWS Secrets Manager | **OpenBao** (Linux Foundation Vault fork, MPL 2.0); use Namespaces for per-tenant trees | OpenBao 2.x has Namespaces (formerly enterprise-only), is API-compatible with Vault, and has no BSL non-compete clauses — important if you are *operating a SaaS* that competes with HashiCorp's hosted offering. |
| Route53 | **PowerDNS Authoritative** with MariaDB/Galera or LMDB backend, anycasted via BIRD2 at every POP; PowerDNS REST API for programmatic record creation | Battle-tested for hosting providers; first-class API; the typical pattern at hosting companies. |
| Let's Encrypt automation | **Caddy** on-demand TLS for per-tenant custom domains; **lego** or **acme.sh** for wildcard certs via DNS-01 against PowerDNS | Caddy's on-demand TLS is explicitly the same mechanism used by SaaS like Render, Vercel, and many custom-domain platforms. |
| WAL-G + S3 (PITR) | **WAL-G unchanged**, pointed at Garage/MinIO; consider **pgBackRest** for tenants >500 GB; cross-region replication via Garage zones or MinIO site replication | Supabase already uses WAL-G; just swap the backend. |
| Logflare + BigQuery | **Logflare** with **ClickHouse backend** (now supported), fed by **Vector** (already in Supabase OSS) | ClickHouse is the de-facto OSS log warehouse; Logflare itself is open source and self-hostable. |
| Metrics | **VictoriaMetrics cluster** (multi-tenant native) or **Prometheus + Mimir** | VictoriaMetrics has built-in `accountID` multi-tenancy that matches the per-project model. |
| Tracing | **Grafana Tempo** | Object-storage backed, pairs cleanly with Vector + ClickHouse. |
| Cross-DC overlay | **WireGuard** mesh managed by **Headscale** (Tailscale control-plane fork) for the operator/control plane; **Nebula** if you want a more scalable lighthouse-based mesh; **Consul Connect** for service mesh between control-plane services | For the data plane between tenant microVMs, prefer plain L3 over your colo backhaul + IPsec/WG only at edges. |
| Cross-DC state | Postgres for the **global control plane** (single primary, regional read replicas); a **gossip/CRDT layer** (Corrosion or NATS JetStream KV) for *fast-changing* placement state | Fly.io explicitly warns against putting routing/placement state through global Raft; that lesson cost them outages. Use Postgres for billing/projects, gossip for "where does machine X live right now." |

---

## 2. Provisioning & orchestration: the deepest part of the design

### 2.1 Why not Kubernetes (validating the user's instinct)

Koyeb's post-mortem on moving off Kubernetes to Nomad + Firecracker is the canonical justification: K8s requires a full cluster + control plane per region, doesn't natively span DCs, has a fast release cadence that becomes a full-time upgrade job at scale, and the Firecracker-on-K8s integration story (Kata Containers, KubeVirt) adds layers without solving the per-tenant Postgres-with-persistent-disk problem cleanly. Fly.io explicitly replaced Nomad with their own `flyd` because they wanted *each host* to be the source of truth for its own workloads, not a centralized scheduler. That ownership model is what makes the platform tolerant of partitions across 10 datacenters.

### 2.2 Firecracker vs Cloud Hypervisor for tenant Postgres

Firecracker is optimized for ephemeral serverless functions: ~125 ms boot, exactly five virtio devices (net, block, vsock, serial, keyboard), no GPU/USB passthrough, no live migration, no CPU/memory hotplug. The original Firecracker paper (Agache et al., NSDI 2020) explicitly notes that Firecracker's block I/O implementation is serial (no flush-to-disk in early versions, currently limited to ~13K IOPS per guest at 4 KB) — that is fine for ephemeral compute but is something to test for production Postgres workloads.

For a **Postgres-per-tenant** architecture, **Cloud Hypervisor** is the more honest choice for most tenants:
- ~200 ms boot vs ~125 ms — irrelevant when the VM lives for weeks/months
- CPU/memory hotplug (you want this for paid-plan upgrades without restart)
- vhost-user-blk for higher-IOPS persistent storage
- vfio passthrough for NVMe if you need it
- Live migration (still maturing, but exists)
- Same Rust/KVM-based security story; Kata Containers defaults to Cloud Hypervisor for exactly these reasons

**Concrete recommendation:** use Firecracker for ephemeral workers (Edge Functions / Deno isolates; Realtime channels; pooler shards), and Cloud Hypervisor for the long-lived per-tenant Postgres microVMs. Your orchestrator should abstract the VMM behind a `MicroVM` interface so you can swap. Fly.io itself has been gradually moving away from pure Firecracker for stateful workloads (their LSVD object-storage-backed disks story in the "Sprites" blog post acknowledges that Firecracker's IO path is not adequate for "a hot Postgres node in production").

### 2.3 Nomad as the substrate, custom controller for stateful tenants

Use Nomad for everything that is *not* a per-tenant Postgres VM:
- Stateless multi-tenant fleets: GoTrue (Auth), PostgREST, Storage API, Realtime, Supavisor, Edge Functions runner, Kong/Envoy
- Cron-style jobs (backup verifications, log rotations)
- The control-plane services themselves
- Optionally, ephemeral Firecracker worker microVMs for untrusted user code (Edge Functions)

Federate Nomad as **one region per datacenter** (region = DC), each with 5 servers, joined into a single federated set via `nomad server join`. Don't try to run one global Raft — Nomad's federation is precisely designed so each region has its own Raft and only routes cross-region requests when needed. This matches HashiCorp's published reference architecture and Koyeb's experience.

For Firecracker integration in Nomad:
- The `cneira/firecracker-task-driver` exists but has been stuck on Firecracker 0.25.x; you will likely fork or maintain a private build. Plan to spend ~1 engineer-quarter on a Cloud-Hypervisor task driver. Koyeb wrote their own Firecracker driver and considered it a reasonable lift.
- Use **ZFS zvols** for guest rootfs (the canonical pattern in the firecracker-task-driver README); ZFS snapshots become your branching primitive (see §8).
- Use `tc-redirect-tap` + a CNI chain (`ptp` + `firewall` + `tc-redirect-tap`) for guest networking so Nomad allocates host TAP devices.

For per-tenant Postgres VMs, do **not** use Nomad as the scheduler. Instead, model after Fly's `flyd`:

> "On thousands of beefy 'worker' servers in our fleet, each `flyd` is solely responsible for its own state — every server is the source of truth for its own workloads, without a global top-down orchestrator. Under the hood, flyd is a specialized database server that durably tracks the steps in a series of fine state machines, like 'create a Fly Machine' or 'cordon off an existing Fly Machine'." — *Fly Machines / Making Machines Move*

Concretely:

**Per-host agent (call it `pgvmd`)**: a single Go binary on each Postgres-host machine, owning a local BoltDB or SQLite of its own VMs. Exposes a small gRPC API: `CreateVM`, `StartVM`, `SuspendVM`, `ResumeVM`, `SnapshotVM`, `CloneVM`, `DestroyVM`, `AttachDisk`. All operations are durable finite state machines persisted to local disk before any side effect. This is exactly Fly's `flyd` design and is the right pattern.

**Regional placement service**: a stateless Go service per region that picks which host gets the new VM (bin-packing on CPU/RAM/disk, anti-affinity by tenant tier, capacity reservations). Talks to local `pgvmd` instances over mTLS. Reads available capacity from a fast gossip layer (Corrosion or NATS JetStream KV).

**Global control plane**: a Go service with Postgres as its source of truth. Holds projects, organizations, billing, IAM, the JWT key catalog, and the tenant→region assignment. Exposes a Management API equivalent to Supabase's `api.supabase.com`.

### 2.4 Replacing Pulumi specifically

Pulumi is used by Supabase Cloud for two distinct things, and these need different replacements:

1. **Static infra (racks, networks, hypervisor pool, DNS root, AWS-equivalent inventory)** → **OpenTofu** with workspaces per region. State backend in PostgreSQL (OpenTofu supports a Postgres state backend) or in Garage/MinIO with state locking via DynamoDB-equivalent (use Postgres advisory locks). Avoid Terraform Cloud / Pulumi Service.

2. **Per-tenant resources (microVMs, DNS records per project, certs, routing rules)** → **NOT IaC**. Terraform/OpenTofu/Pulumi state files become a liability above a few thousand managed resources (state locking, plan times, blast radius). Instead, use a Go control-plane service with idempotent operations against the underlying APIs (PowerDNS API, Caddy admin API, your `pgvmd` API, Vault/OpenBao, OpenBao, Garage admin API, etc.). This is what Render, Fly, Railway, and Supabase itself do.

If you want IaC ergonomics for the imperative path, Pulumi's **Automation API** does work without the Pulumi Service — you can self-host state in S3-compatible storage. But honestly, at this scale you are writing a control plane, not running IaC; embrace it.

**Crossplane is explicitly off the table** because (a) it requires Kubernetes and (b) its reconciliation model has the same scaling pathologies as plain IaC at high tenant counts.

### 2.5 Tenant lifecycle state machine

The project lifecycle, modeled as durable FSMs in the global control plane (Postgres) and the regional `pgvmd`:

```
Pending  →  Provisioning  →  Active  ⇄  Paused  →  Deleted
                ↓                ↓        ↓
             Failed          Migrating  Restoring
```

Each transition is composed of *local* FSM steps on the host (Fly's pattern):
- `CreateZFSVolume` → `WriteRootfs` → `RegisterCNINetwork` → `LaunchFirecracker` → `WaitForPgReady` → `RunBootstrapMigrations` → `WriteSecretsToVault` → `RegisterInRouter` → `WriteDNSRecord` → `IssueTLSCert` → `MarkActive`.

Each step is recorded in `pgvmd`'s BoltDB before it runs and after it completes, with a rollback or retry path. The global control plane only sees coarse-grained transitions; the *fine-grained* steps are owned by the host. This is what makes the system tolerant of control-plane downtime.

### 2.6 What to put in which state store

This is where Fly's hard-won lesson matters most: **don't put everything in one store**.

| Data | Store | Reason |
|---|---|---|
| Projects, orgs, billing, IAM, JWT JWKS, tenant→region mapping | **Postgres** (the global control plane DB itself, with Patroni or pg_auto_failover for HA, replicated to a warm standby DC) | Strong consistency, transactions, joins, audit trails |
| "Where is machine X right now?" health, rapidly-changing capacity numbers, current resident set per host | **Corrosion** (CRDT-over-SQLite gossip) or **NATS JetStream KV** | Fly's blog explains why this can't go through global Raft — they saturated their uplinks the first time they tried. Eventually-consistent gossip is the right tool. |
| Per-host VM state of truth | **Local BoltDB/SQLite on each host (pgvmd)** | Survives control-plane outages; the host is the source of truth for its own workloads. |
| Secrets | **OpenBao** with Raft storage, replicated as performance secondaries to each region | Per-region read locality, central write |
| Logs | **ClickHouse cluster** in each region | Bulk ingest, retention tuning |
| Metrics | **VictoriaMetrics cluster** | Multi-tenant native |

CockroachDB / FoundationDB are tempting but add operational load you do not need if you split the problem like this. Keep Postgres for "things you'd use a SQL database for anyway" and gossip for "things that change every second per host."

---

## 3. Edge / CDN replacement

This is the *hardest* part of leaving AWS+Cloudflare. Be honest with yourself about it.

### 3.1 What you actually need

Supabase Cloud's edge is roughly:
1. Anycast TCP/HTTPS termination near the user
2. WAF + bot mitigation
3. Smart CDN (cache-on-ETag, useful for Storage)
4. Per-tenant custom domain TLS termination
5. Routing to the correct project's region

### 3.2 Anycast on Hivelocity-style colo

You need:
- **Your own ASN** (apply via ARIN / RIPE; 6–10 weeks)
- **A /24 IPv4 + /48 IPv6** (PI space; ARIN waitlist or buy on the market — IPv4 is now ~$50/IP)
- **BGP sessions** to upstream transit at every POP

Open-source pieces:
- **BIRD2** as the BGP daemon on each edge host
- **GoCast** (mayuresh82/gocast) as a higher-level controller that announces/withdraws VIPs based on health checks; integrates with Consul for autodiscovery
- **ExaBGP** if you prefer Python-based programmatic control
- **ECMP** on the upstream router for in-POP load balancing

This pattern is documented by Andree Toonk, Equinix Metal, NetActuate, and the Packetframe APNIC blog post — all of them describe near-identical setups. You should expect to spend 1 senior network engineer for ~2 quarters to get clean anycast working in 10 POPs, and you will probably contract with a consultancy for the BGP peering relationships.

### 3.3 DDoS

Realistic split:
- **L3/L4 volumetric**: rely on transit upstreams (Hivelocity offers basic DDoS filtering; for serious capacity contract with **Voxility** or **Path.net** for scrubbing). This is the part you cannot do yourself below ~100 Gbps without significant capex.
- **L3/L4 detection + RTBH triggering**: **FastNetMon Community/Advanced** consuming sFlow/IPFIX from your edge routers, advertising blackhole routes via BIRD.
- **L7 / application**: **Coraza WAF** (Go, modern Apache 2.0) with **OWASP CRS** rules, embedded into Caddy as a module or run as a sidecar. ModSecurity v3 still works but Coraza is the actively-developed path.

### 3.4 Edge proxy

Three viable choices:

- **Caddy** — strongest fit for the *custom-domain* problem. On-demand TLS with the `ask` endpoint pattern is exactly what you need (Caddy's docs explicitly position this as "the secret sauce of many SaaS products that offer custom domains," and the community thread documents one user serving 250K domains on a single Caddy host). Pair with the [`caddy-l4`](https://github.com/mholt/caddy-l4) module if you need TCP-level routing.
- **Cloudflare Pingora** (open-sourced 2024) — Rust, designed for the same workload Cloudflare runs internally. Higher ops bar, but if you are at a scale where Caddy's Go runtime overhead matters, Pingora is the upgrade path.
- **Envoy** — heaviest, but if you need xDS dynamic config with no restarts (which you will at thousands of tenants), Envoy is purpose-built. Use **go-control-plane** to push routes to Envoy from your control plane.

**Recommended split:** Caddy at the very edge handling on-demand TLS and HTTP routing for *.your-platform.com plus customer domains; Envoy (or Caddy itself with the `reverse_proxy` directive and dynamic upstreams) doing intra-region routing to tenant pods.

### 3.5 CDN for Supabase Storage's "Smart CDN" feature

Supabase's Smart CDN works by caching by *S3 ETag* so cache invalidates automatically when the underlying object changes. To replicate:

- Put **Varnish** (or Caddy with the `cache-handler` module backed by a local Souin/SQLite) at each edge POP.
- Use the `ETag` header from your origin (Garage/MinIO emit this natively) as part of the cache key — Varnish VCL can do this in a few lines.
- For purges, your control plane writes the new ETag and the proxy revalidates on the next request.

Pragmatically, **bunny.net** is what most "we're not Cloudflare" SaaS use; it's $0.005–0.01/GB and has 100+ POPs, supports custom origin headers, and has a fast purge API. Use it as origin shield in front of your Garage clusters in year one and revisit DIY edge caching in year two when you actually have the traffic to justify it.

---

## 4. S3-compatible object storage

### 4.1 Quick selection guide

| Workload | Recommended |
|---|---|
| User-uploaded blobs across 10 DCs, mixed sizes, eventual consistency tolerable | **Garage** |
| High-throughput regional pool (per-region tenant Storage), strong consistency, billions of objects | **MinIO** (still OSS under AGPLv3 — but watch the post-2024 commercial direction) or **Ceph RGW** |
| Tenant database backups (WAL-G target) | **Garage** with 3-replica across geos OR **MinIO** with site replication |
| Logs / metrics object backend (Tempo, Mimir, Loki) | **MinIO** for local-DC, replicate cold to Garage |
| Billions of small files (image thumbnails, avatars) | **SeaweedFS** |

### 4.2 Garage (the most aligned with your architecture)

Garage by Deuxfleurs is purpose-built for "small-to-medium S3 over the open Internet across multiple datacenters." Key properties:
- No consensus protocol (no Paxos/Raft); uses Dynamo-style replication + CRDTs
- Replication mode `3` keeps copies in 3 different zones
- Benchmarks show Garage massively outperforms MinIO when nodes have high RTT between them (because MinIO's Raft pays the RTT cost on every write)
- Native multi-DC concept ("zones") that maps perfectly to your 10 colos
- Provides a website-from-bucket feature (which MinIO and Ceph do not!) — useful if you ever offer Vercel-style static hosting
- REST admin API, Prometheus metrics, OpenTelemetry tracing
- Supports S3 multipart (you need this for tus-resumable uploads in Supabase Storage)

Garage's intentional non-goals: extreme single-node throughput and erasure coding (it does plain replication only). For Supabase Storage's typical workload (user images and PDFs in the kilobyte-to-megabyte range) this is fine. If you have customers uploading 100 GB video files, route those to a MinIO regional pool instead.

### 4.3 MinIO

Production patterns:
- **Erasure coding** EC:4 (4 parity per 16 disks) for the canonical setup
- **Multi-site replication** via `mc replicate` for cross-DC; this is async and works over the Internet
- License: AGPLv3 — fine for a SaaS that doesn't redistribute MinIO. Note that since 2024 MinIO has been more aggressive about pushing enterprise features (caching, KES) and removing some OSS features (the Console UI was stripped down). Keep an upgrade lock.

### 4.4 Ceph RGW

- Most fully featured S3 (full ACLs, IAM, lifecycle, object lock, multi-tenancy via tenant-prefixed buckets, true erasure coding with k+m, bucket notifications via SNS/Kafka)
- Multi-site replication via `radosgw-multisite`
- The operational ask is *real*: budget 1–2 dedicated SREs. Cephadm (not Rook, since you're skipping K8s) has matured and is now the recommended deploy method.
- Use it where you'd otherwise be tempted to also run a separate block-storage layer — Ceph gives you RBD (block) + RGW (object) + CephFS in the same cluster.

### 4.5 Required S3 features

Verify against your shortlist:
- ✅ **S3 multipart**: Garage ✅, MinIO ✅, Ceph ✅, SeaweedFS ✅
- ✅ **Presigned URLs**: all four
- ✅ **Bucket policies / IAM-style**: MinIO best, Ceph good, Garage limited (key-based ACL via CLI), SeaweedFS limited
- ✅ **ETag for Smart CDN**: all four (it's part of S3 spec)

---

## 5. Secrets management

### 5.1 OpenBao vs Vault

Use **OpenBao**. The deciding factors:
1. You are *operating a SaaS that competes with a managed database* — Vault's BSL 1.1 explicitly forbids "offering Vault as a hosted or embedded service to third parties in competition with HashiCorp's commercial offerings." Even if your read of that restriction is narrow, your future enterprise customers' legal teams will not be.
2. OpenBao 2.x added **Namespaces** (formerly Vault Enterprise-only) which is exactly what you need for multi-tenant isolation.
3. OpenBao 2.5+ added horizontal read scalability (also formerly Enterprise-only).
4. API/CLI compatible with Vault — your existing Terraform providers, helm charts, libraries all work.
5. IBM-backed Linux Foundation governance.

Caveats: OpenBao still lacks **Disaster Recovery Replication** and **Performance Replication** out of the box (those remain Vault Enterprise). For your topology, the workaround is:
- One OpenBao cluster per region (5 nodes, integrated Raft)
- Cross-region replication via continuous Raft snapshot ship + restore on a hot-standby cluster
- Or, simpler: keep secrets in your global control-plane Postgres encrypted at rest with a master key in OpenBao, and treat OpenBao as the KMS rather than the database.

### 5.2 Distribution pattern — don't tie everything to OpenBao availability

Per-tenant secrets used by the multi-tenant fleets (GoTrue's per-project JWT secret, Storage's per-project S3 keys, etc.) cannot have OpenBao on the runtime hot path or every OpenBao blip will take down auth for everyone. Pattern:

1. Control plane generates secret → stores in OpenBao (source of truth) → also writes encrypted to the global Postgres.
2. The control plane writes the **public** parts (JWKS for JWT verification) to a flat file/object in Garage that all GoTrue / PostgREST / Realtime instances poll every N seconds (or subscribe via NATS).
3. Per-tenant **private** parts the multi-tenant fleets need (e.g., the row in `_realtime.tenants` for Realtime) are written by the control plane *into the tenant-config Postgres tables* over a normal Postgres connection — exactly how Supabase Cloud does it today. Realtime's `_realtime` schema and Supavisor's `_supavisor` schema are designed for this.
4. **Per-tenant DB passwords** the per-tenant Postgres VM needs at boot are injected via cloud-init / Firecracker MMDS at VM creation, and never read again — the VM only knows its own credentials.

This means OpenBao going down means you can't *create new projects* but existing projects keep working. That's the right blast radius.

### 5.3 JWT keys

Use **asymmetric JWTs (Ed25519 or RS256)** and publish the JWKS publicly. Supabase moved to this model in 2024 because it lets PostgREST/Realtime/Storage verify tokens without a shared secret. In your clone:
- Store private keys in OpenBao, one keypair per project
- Publish JWKS at `https://<project>.your-platform.com/auth/v1/.well-known/jwks.json`
- All verifying services (Postgres via pgjwt, PostgREST, Storage, Realtime) verify against JWKS, no secret distribution needed

---

## 6. DNS / TLS

### 6.1 Authoritative DNS

**PowerDNS Authoritative** with the **gmysql** backend on a **Galera** or **MySQL Group Replication** cluster, anycasted at every POP via BIRD2. The "Building a highly available global anycast PowerDNS cluster" walkthrough by quantum5 is the closest published reference; NetActuate publishes an Ansible playbook for the same pattern.

- 10 anycast nodes, each running PowerDNS authoritative + Galera replica
- Single writer model: one master (e.g., in a primary DC) takes writes; anycast nodes are async replicas. Failover is manual; that's fine because *write* downtime to DNS for ten minutes does not break user-facing resolution.
- PowerDNS REST API for programmatic record creation by the control plane (X-API-Key header, JSON, OpenAPI 3.1 spec). Your Go control plane just makes HTTP calls.
- DNSSEC: PowerDNS handles inline signing automatically.
- Don't use CoreDNS for authoritative — it's designed for service discovery and lacks features like AXFR-out, Lua records, geo-routing.

### 6.2 TLS

Three certificate stories:

1. **Platform wildcard** (`*.your-platform.com`): issued via DNS-01 against PowerDNS using **lego** (single binary, supports PowerDNS provider natively). Run as a cron in the control plane; renew weekly.
2. **Per-project subdomains** (`<project>.your-platform.com`): covered by the wildcard above; no per-cert work.
3. **Customer custom domains** (`api.customer.com`): **Caddy on-demand TLS** with an `ask` endpoint pointing at your control plane. The control plane checks "does this customer have this domain registered and verified?" → returns 200 → Caddy issues via Let's Encrypt HTTP-01. Cache certs in Caddy's storage backend (point at S3-compatible Garage so all edge Caddy instances share). Note Let's Encrypt's 50-cert-per-week-per-registered-domain limit applies per customer's domain, which is fine, and the 300-orders-per-3h account limit which means you should run multiple ACME accounts and shard.

For very large numbers of custom domains, lookup the dev.to article "Scalable Multi-Tenant Architecture for Hundreds of Custom Domains" for the CloudFront SaaS-distribution pattern; the equivalent in your stack is "one Caddy fleet per region, each with its own ACME account, all sharing cert storage in Garage with read-through caching."

---

## 7. Backups / PITR

Keep WAL-G (Supabase's choice) but consider pgBackRest for tenants over ~500 GB.

### 7.1 The recommendation

- **WAL-G** for the default tier, pointing at a per-region Garage bucket. Encryption-at-rest via WAL-G's libsodium support. Cross-region replication via Garage's multi-zone placement (configure replication mode = 3 with zones spanning your 10 DCs and you get geo-redundant backups for free).
- **pgBackRest** for premium / enterprise tier tenants where the database is large enough that block-level incremental backups and parallel restore matter. pgBackRest beats WAL-G at the high end on (a) block-level incremental, (b) parallel restore speed, (c) more robust verification (`pgbackrest verify`). The trade-off is pgBackRest needs a "stanza" concept and a slightly more involved per-tenant setup.

### 7.2 Avoid Barman at this scale

Barman is excellent for "DBA team manages a fleet of corporate databases" — it assumes a centralized backup server pulling from N databases. That's the wrong shape for thousands of tenant VMs each pushing to their own object-storage bucket prefix.

### 7.3 PITR for the per-tenant model

Each per-tenant Postgres VM:
- `archive_command` set to `wal-g wal-push %p` to its tenant prefix in Garage
- `wal-g backup-push` runs nightly (via systemd timer inside the VM)
- Recovery: spin up a new Firecracker VM with same tenant ID, `wal-g backup-fetch` + `wal-g wal-fetch` for PITR target time. The new Postgres comes up and the control plane swings the routing.

This is the same pattern Crunchy Bridge and Render use; it works.

---

## 8. Branching (the Supabase-Cloud-only feature)

Supabase Cloud's branching is implemented per-project and is the closest Supabase comes to Neon-style instant copy-on-write. Without Neon's pageserver, you have three choices in descending order of fidelity:

### 8.1 ZFS snapshots (recommended)

Each tenant Postgres VM's data volume is a ZFS zvol on the host. To branch:
1. `zfs snapshot tank/tenant-X@branch-Y`
2. `zfs clone tank/tenant-X@branch-Y tank/tenant-X-branch-Y`
3. Boot a new Firecracker VM with `tank/tenant-X-branch-Y` as the rootfs disk (or data disk)
4. Postgres comes up against the cloned data — the file is shared until either side writes, true CoW.

**Caveats:**
- The branch lives on the *same physical host* as the parent. Cross-host branching means snapshot send/receive (slower, but still cheap relative to pg_dump).
- Postgres needs to come up against a quiesced state — best done via a Postgres `CHECKPOINT;` then `pg_start_backup()` or just by snapshotting *after* a graceful Postgres shutdown if branching can be slightly slow. For "branching while parent is live" you need a `pg_start_backup` / `pg_stop_backup` dance — Stolon and CloudNativePG have battle-tested versions.

### 8.2 LVM thin pool

LVM2 thin provisioning gives you nearly the same primitive (`lvcreate --snapshot --thinpool`) without ZFS's memory overhead. Used in production by many telco/finance shops. Less convenient for send/receive across hosts.

### 8.3 pg_dump replay

Falls back to "dump the parent, restore into a fresh VM." Works at any size but is O(N) in DB size. Use only for tenants that haven't enabled branching as a paid feature.

### 8.4 The Neon route (for the truly ambitious)

Long-term, the "right" answer is Neon's pageserver/safekeeper architecture: separate storage from compute, store WAL in a Pageserver, have Postgres compute talk to it over the network. Neon is Apache 2.0 (the core; cloud control plane is private). You *could* fork Neon's pageserver and integrate it with your control plane. This is a multi-engineer-year undertaking; revisit at >5K paying tenants.

---

## 9. Observability / logs

### 9.1 Logflare with ClickHouse

Logflare's BigQuery backend is a non-starter (proprietary, leaves your environment). Logflare's Postgres backend is officially "not optimized for production usage" by Supabase's own documentation. Logflare *does* have a ClickHouse backend (recently added and mentioned in their case studies). Use that.

Pipeline (drop-in replacement for Supabase Cloud's pipeline):
```
Each service ─stdout─▶ Vector ─HTTP─▶ Logflare ─▶ ClickHouse cluster (per region)
                                                              │
                                                              └─▶ S3 cold tier (Garage) for >30d retention
```

Vector is already in Supabase OSS, so this is a one-config swap. Each region gets its own ClickHouse cluster (3 shards × 2 replicas is a good starting point); the global Logs Explorer in Studio queries via `clusterAllReplicas('region-{1..10}', ...)` for cross-region queries.

### 9.2 Metrics

**VictoriaMetrics cluster mode** is the right answer because it has native multi-tenancy via `accountID` URL prefix — you assign one accountID per Supabase project and your tenant isolation is automatic. Mimir works too but its multi-tenancy is more involved (Cortex-derived headers, per-tenant tenant config). VictoriaMetrics cluster components: vmstorage, vminsert, vmselect — all single Go binaries, run under systemd, scales horizontally on commodity hardware.

### 9.3 Tracing

**Grafana Tempo**, backed by Garage (it's S3-compatible storage natively). Pair with the `grafana-agent` flow for trace ingest. Turn this on only for your control-plane services; tracing user code in tenant VMs is rarely worth the cost at this scale.

### 9.4 Don't fall into the trap

Avoid SigNoz / OpenObserve / standalone Grafana Loki / VictoriaLogs unless you have a specific reason. The Supabase Studio UI is already wired for Logflare; replicating that integration against a different log backend is more work than getting Logflare→ClickHouse working.

---

## 10. Networking across 10 DCs

### 10.1 Layered overlay strategy

- **Operator/admin plane** (SSH into hosts, run kubectl-equivalent, Nomad UI access): **Headscale** (Tailscale control plane fork). Open source, drop-in for the Tailscale daemon. Run two Headscale instances behind Postgres for HA.
- **Control-plane service mesh** (your Go services talking to each other across DCs): **Consul Connect** with Consul federated across DCs. Provides mTLS, intentions (auth policy), and L7 observability. You already need Consul for Nomad service discovery, so this is free.
- **Data plane within a DC** (microVM ↔ multi-tenant fleet ↔ pooler): plain L2/L3 in the colo. CNI on the host with `tc-redirect-tap`; per-VLAN tenant isolation if you go that far.
- **Data plane across DCs** (Postgres replication for read replicas, WAL-G to Garage, metrics ingestion): plain Internet with TLS, or a private IPsec/WireGuard backbone if your colos give you cross-connects. Don't try to mesh microVMs across DCs — replicate at the *application* layer (Postgres logical replication) where you actually need it.

### 10.2 Cross-DC state — the Fly lesson

Fly.io initially put placement state in a global Consul cluster. They saturated their fleet's uplinks once when a Consul outage caused thousands of workers to retry-storm. Their fix was **Corrosion**: a per-host SQLite database, replicated via SWIM gossip + CRDTs over QUIC, with p99 propagation of 1 second across 40+ regions. The key takeaway from their post-mortems is to avoid a single global state domain — they've now broken Corrosion into multiple state domains.

For your platform:
- Global control-plane DB (Postgres) handles slow-changing, transactional state.
- Within each region, a small Corrosion cluster (or NATS JetStream KV) handles host-level "where is what" gossip.
- Cross-region propagation of cosmetic state (load metrics, global view of fleet) goes via a Postgres logical-replication-fed read replica or a CDC pipeline (Debezium → NATS).
- **Do not** try to make global gossip your single source of truth for billing-critical data. CockroachDB/FoundationDB are tempting but the operational ask doesn't pay back at 10 DCs.

---

## 11. End-to-end "create new project" walkthrough

A user clicks "New Project" in your Studio. What happens:

1. **Studio → Management API** (your Go global control plane): `POST /v1/projects` with name, region, tier.
2. **Control plane writes to Postgres**: row in `projects` with status `Pending`, generates UUID, allocates subdomain `<project-id>.your-platform.com`, generates anon/service JWT keypair. Calls OpenBao to store private key under `secret/projects/<project-id>/jwt`.
3. **Control plane → regional placement service** (the one in the user's chosen DC): `Schedule(projectID, tier)`. The placement service queries the in-region Corrosion gossip for capacity, picks a host, returns hostID. State is now `Provisioning`.
4. **Placement service → host's `pgvmd`**: `CreateVM(projectID, ...)` over mTLS gRPC. `pgvmd` writes "step 1: allocate ZFS volume" to its local BoltDB and starts the FSM.
5. **`pgvmd` FSM**:
   - `zfs create -V 8G tank/proj-<id>` (or `zfs clone tank/empty-supabase-template@v15.5` to skip migrations entirely)
   - Configure CNI network for the new VM
   - Launch Cloud-Hypervisor with that volume + a kernel image + cloud-init data containing the `postgres` superuser password (read from OpenBao)
   - Wait for Postgres `pg_isready`
   - Run Supabase OSS bootstrap migrations: create `auth`, `realtime`, `storage`, `_realtime`, `_supavisor` schemas, install pg_graphql, pgsodium, pgjwt, etc.
   - Write the per-project JWT secret + JWKS into the project's own database (used by RLS)
   - Mark VM `Active` in local BoltDB
   - Report back to placement service
6. **Control plane (in parallel)**:
   - **DNS**: PowerDNS REST `POST /api/v1/servers/localhost/zones/your-platform.com/records` to create `<project-id>.your-platform.com` A record pointing at your edge anycast IP.
   - **Routing**: `POST` to your Caddy admin API (or push via Envoy xDS) to map `<project-id>.your-platform.com` → the host that hosts the VM, with PROXY-protocol header injection so the VM sees the real client IP.
   - **TLS**: nothing — wildcard cert covers it.
   - **Multi-tenant fleets registration**: `INSERT` into the shared `_realtime.tenants` table with the new project's connection string and JWT secret; same for the Supavisor pooler's `_supavisor.tenants` table; same for the Storage API's tenant-config table. These are the side-effect tables that Supabase Cloud's control plane writes to in production.
   - **Backups**: enable cron on the host to run WAL-G against the tenant's Garage bucket prefix.
   - **Observability**: register the tenant with Logflare (ClickHouse) so logs from the new VM are routed to its source.
7. **Mark project `Active`** in global Postgres. Send webhook to user's email.

End-to-end target: **10–30 seconds** if you start from a ZFS-cloned template; **2–5 minutes** if you boot from scratch and run all migrations. Supabase Cloud's documented provisioning time is about a minute, so the cloned-template path is essential.

### 11.2 Pause/resume (scale-to-zero)

Two implementations, and you want both:

- **Soft pause**: Cloud-Hypervisor `pause` API stops vCPU execution but keeps memory resident. Resume is sub-second. Free for the user, costs you only the RAM. Use for the "auto-pause after 5 min idle" tier.
- **Hard pause**: snapshot the VM (Cloud-Hypervisor's snapshot/restore is mature; Firecracker's is too — see Fly's "Machine Suspend and Resume" doc) to a file in Garage, terminate the VM, free RAM and CPU. Resume = pull snapshot, restore. ~1–3 seconds for a small Postgres. Use for "free tier paused after 7 days idle."

Critically, Supabase's own free tier "pause" today is essentially a hard pause: the VM is stopped, the disk retained. You can do better by combining the two: 5 min idle → soft pause; 24 h soft-paused → hard pause + reclaim RAM; 90 d hard-paused → cold-archive disk to Garage and free local NVMe.

---

## 12. Risks and "things that are genuinely hard"

This is the section a system architect needs most. In rough order of pain:

1. **Anycast and DDoS at commodity colo.** Cloudflare absorbs hundreds of Gbps and bills you nothing. Hivelocity's stated DDoS protection is meaningful but not Cloudflare-grade. You **will** get DDoSed by an angry tenant's customer eventually. Plan for it: contract upstream scrubbing (Voxility/Path.net), be willing to nullroute customer IPs, and consider keeping bunny.net or Fastly in front for the first 12–24 months as a "cheat code."
2. **Cross-region S3 durability.** S3's 11 nines are real and unfakeable on commodity disk. Garage with 3 zones gets you to maybe 6–7 nines if you're rigorous about disk monitoring; Ceph similar; MinIO similar. For PITR specifically, mitigate by replicating WAL-G prefix to *two* independent storage clusters (e.g., Garage + a hosted Wasabi/Backblaze B2 account as belt-and-suspenders). That hosted backup is your "if our entire infra dies" insurance.
3. **The Firecracker block-IO ceiling for Postgres.** The original Firecracker NSDI paper documents a guest-side ceiling around 13K IOPS at 4 KB and serial IO submission. Your Postgres tenants will hit this if they're write-heavy. Mitigations: use Cloud Hypervisor (vhost-user-blk) for Postgres VMs, not Firecracker; pin tenant VMs to NVMe-direct hosts; offer a "premium" tier on dedicated bare metal without virtualization for the largest tenants.
4. **The firecracker-task-driver Nomad plugin is unmaintained-ish.** The cneira/firecracker-task-driver is stuck on Firecracker 0.25.x. You will fork it. Budget for that.
5. **Operating PowerDNS authoritative under DDoS.** A reflected DNS amplification attack against your nameservers is a normal Tuesday at scale. Anycast helps; rate limiting at BIRD2 helps; but you also need RRL (response rate limiting) configured in PowerDNS and ideally run a recursor like dnsdist in front for ACL.
6. **Operating OpenBao without DR replication.** Until OpenBao gains parity with Vault Enterprise's DR replication, you're rolling your own (Raft snapshot ship + restore). This is not hard, but you need to test failover and keep someone on call who knows how to bootstrap a fresh OpenBao from a cold backup.
7. **Cross-DC clock skew.** WAL-G, pgBackRest, Corrosion, distributed Postgres replication, JWT validation — all assume well-disciplined NTP. You **must** run **chrony** with multiple internal stratum-2 sources per DC. This bites everyone eventually.
8. **Supabase upstream churn.** Every minor version of GoTrue, Realtime, Supavisor, Storage may change its tenant-config schema. Your control plane writes to those tables. You will need a migration strategy and a CI bot that diff-checks upstream schema changes.
9. **Building the control plane is the actual product.** The OSS Supabase docker-compose is a single-tenant educational setup. The Cloud version has *years* of multi-tenancy plumbing (including Studio's awareness of multiple projects, the `api.supabase.com` Management API, billing, branching, etc.). Realistically, this is **2–4 senior engineers for 12–18 months** to reach feature parity, plus an SRE. Plan accordingly.

---

## 13. Reference reading (real engineering blogs)

The most useful published prior art:

- **Fly.io blog** — `Corrosion` (eventual consistency at 40+ regions, why Raft globally is a trap), `Making Machines Move` (dm-clone, NBD, iSCSI, the volume migration story), `The Design & Implementation of Sprites` (object-storage-backed VM disks, why Firecracker isn't right for hot Postgres), `Machine Suspend and Resume`, the Fly architecture page, and the Platform Engineer: Fly Machines job posting (which is the most candid description of `flyd` available in public).
- **Koyeb blog** — "The Koyeb Serverless Engine: from Kubernetes to Nomad, Firecracker, and Kuma" and "Lightweight Virtualization: the Container Ecosystem and Firecracker MicroVMs."
- **Neon docs** — pageserver/safekeeper architecture, branching internals.
- **Crunchy Data Bridge** — public posts on PostgreSQL on Kubernetes (CrunchyData/postgres-operator), pgBackRest patterns at scale.
- **Render** and **Railway** blogs — both run multi-tenant on Firecracker-adjacent stacks, both have published useful posts on per-tenant TLS and pause-resume.
- **Ubicloud** blog — "Cloud virtualization: Red Hat, AWS Firecracker, and Ubicloud internals" is the cleanest explainer of Firecracker vs Cloud Hypervisor for non-serverless workloads. Ubicloud's full open-source AWS-clone (their elastic-cloud-control-plane on GitHub) is itself worth reading as the closest existing OSS equivalent of what you're building.
- **APNIC blog** — "Building an open source anycast CDN" by Nate Sales (Packetframe) — the canonical practical guide to BIRD2 + anycast + Varnish + Caddy on commodity colo.
- **AWS Firecracker NSDI 2020 paper** by Agache et al. — the empirical I/O performance numbers (sections 6–7) are essential reading before betting Postgres on Firecracker.
- **Mayuresh Bagalkote's blog** — GoCast architecture and BGP-anycast-as-a-service patterns.
- **Cloudflare Pingora** open-source release announcement (2024) — relevant if you ever outgrow Caddy at the edge.

---

## 14. TL;DR architecture

```
                        ┌─────────────────────────────────────────────┐
                        │       GLOBAL CONTROL PLANE (1 region)       │
                        │  Go services + Postgres (HA, warm standby)  │
                        │  - Management API (Supabase api equivalent) │
                        │  - Project lifecycle FSM                    │
                        │  - Billing / IAM / Org                      │
                        │  - JWKS publisher                           │
                        │  - OpenBao primary cluster                  │
                        │  - PowerDNS primary (Galera writer)         │
                        └────────────────────┬────────────────────────┘
                                             │
                                             │ control-plane API + gossip
                                             ▼
       ┌─────────────────────────────────────────────────────────────────────┐
       │                         PER-REGION DATA PLANE  (× 10)                │
       │  ┌──────────────┐  ┌──────────────┐  ┌──────────────────────────┐  │
       │  │  Edge/POP    │  │  Multi-tenant│  │   Per-tenant compute     │  │
       │  │              │  │  fleets      │  │                          │  │
       │  │ Anycast IP   │  │              │  │  Postgres VM (CloudHV)   │  │
       │  │ BIRD2+GoCast │──▶ GoTrue       │──▶ ZFS zvol per tenant      │  │
       │  │ Caddy        │  │ PostgREST    │  │ ┌──────────────────────┐ │  │
       │  │ on-demand TLS│  │ Realtime     │  │ │ pgvmd (per host)     │ │  │
       │  │ Coraza WAF   │  │ Storage      │  │ │ - durable FSM (Bolt) │ │  │
       │  │              │  │ Edge Funcs   │  │ │ - VM lifecycle       │ │  │
       │  │ PowerDNS     │  │ Supavisor    │  │ │ - snapshot/clone     │ │  │
       │  │ replica      │  │ (on Nomad)   │  │ │ - WAL-G push         │ │  │
       │  └──────────────┘  └──────────────┘  │ └──────────────────────┘ │  │
       │                                       │ Ephemeral Firecracker    │  │
       │  ┌──────────────────────────────────┐ │ workers for Edge Funcs   │  │
       │  │ Garage (S3, multi-zone replica)  │ │ (on Nomad)               │  │
       │  │ ClickHouse (logs)                │ └──────────────────────────┘  │
       │  │ VictoriaMetrics (metrics)        │                                │
       │  │ OpenBao perf-secondary           │                                │
       │  │ Corrosion gossip                 │                                │
       │  └──────────────────────────────────┘                                │
       └─────────────────────────────────────────────────────────────────────┘
```

Get this skeleton running with two regions and ten tenants before you scale either dimension. The architecture above is composable — you can adopt Garage before BGP anycast, OpenBao before Cloud Hypervisor, etc. — but the **global Postgres control plane + per-host `pgvmd`-style agent** is the load-bearing decision; everything else swaps in around it.

The single most important insight, from Fly's hard-won experience, is this: **the host is the source of truth for its own workloads.** Every other choice (gossip vs Raft, IaC vs Go control plane, Nomad for stateless vs custom for stateful) follows from that principle. Build for that, and a multi-DC, no-Kubernetes Supabase clone is a multi-year project but a tractable one.