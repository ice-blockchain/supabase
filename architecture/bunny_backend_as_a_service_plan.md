# Building a Multi-Tenant BaaS on bunny.net Infrastructure

## Executive Summary

A Supabase-style, multi-tenant BaaS where bunny.net provides CDN, object storage, edge compute, video, DNS and security (with your own managed Postgres for the data layer, called only from edge functions / Magic Containers — never exposed to end-user apps) is technically feasible and well-supported by bunny.net's API surface.

Key facts:

- **Programmatic provisioning works for everything** (Pull Zones, Storage Zones, Stream Libraries, DNS Zones, Shield/WAF, Edge Scripts, Magic Containers, hostnames, certificates) via a single REST API at `https://api.bunny.net`, with both an OpenAPI spec and an official Terraform provider (`BunnyWay/bunnynet`).
- **No native multi-tenancy primitive** (no organizations/projects/workspaces). Tenant isolation lives in your control plane.
- **500-zone-per-account hard cap** on Pull Zones / Storage Zones / Stream Libraries / DNS Zones is the biggest constraint. **Bunny for Platforms (B4P)** lifts this; engage sales at ~300-400 tenants. Migration to B4P is server-side: same account, same API, same resource IDs, no code changes (confirm in-place upgrade with sales).
- **Authentication is asymmetric**: a single account-level API key controls the control plane; data planes (Storage HTTP API, Stream HTTP API) use per-resource passwords/keys safe to hand to tenants.
- **Billing/usage data is exposed via API** (`/billing/summary`, `/statistics`, plus per-product metrics), sufficient for passthrough+markup billing per Pull Zone. No webhooks — poll-only.

---

## 1. Multi-Tenancy on bunny.net

### 1.1 Provisioning per-tenant

Single unified Core Platform API at `https://api.bunny.net`, authenticated with `AccessKey` header. OpenAPI spec at `docs.bunny.net/openapi`.

Per-tenant resources:

- **Pull Zones (CDN)** — Full CRUD via `/pullzone`. Manage hostnames (`AddHostname`, `LoadFreeCertificate` for Let's Encrypt, `AddCustomCertificate`), edge rules, blocked IPs, cache settings, per-region geo toggles. Pull-zone JSON exposes `MonthlyBandwidthUsed`, `MonthlyCharges` directly — usable for per-tenant metering.
- **Storage Zones** — Full lifecycle via `/storagezone`. Each has its own RW password and RO password from the API — perfect for handing tenant-scoped credentials to client SDKs. Data plane at `https://storage.bunnycdn.com/{zone}/...` (or regional hosts) authenticates with the storage password, not the account key.
- **Stream Video Libraries** — `/videolibrary` CRUD. Each library has its own Stream API key for the separate Stream API at `https://video.bunnycdn.com/library/{libraryId}/...`. Webhooks per library on encoding events.
- **DNS Zones** — `/dnszone` CRUD with per-record CRUD. Records support `Accelerated: true` (CDN-accelerated CNAME flattening for apex), failover monitors, geolocation routing, weighted routing, and routing through an Edge Script (`ScriptId`).
- **Edge Scripting** — `/compute/script` for create/deploy/env vars/secrets. Deno runtime, GitHub auto-deploy from `main`, npm imports, WASM. Standalone (own `*.bunny.run` hostname) or middleware (attached to a Pull Zone via `MiddlewareScriptId`). 500ms cold start cap.
- **Magic Containers** — Dedicated API: Applications, Containers, AutoscalingSettings, ContainerRegistries, Endpoints (HTTP(S) or Anycast TCP/UDP), Volumes, Log Forwarding. Docker registries, per-region scaling, multi-container composition, persistent volumes. **Counts against a separate quota, not the 500 zone cap.**
- **Shield / WAF** — `/shield/...`: AccessLists, ApiGuardian, BotDetection, DDoS, EventLogs, Metrics, RateLimiting, ShieldZone, UploadScanning, WAF. Custom rules, rate-limit rules, bot detection all CRUDable. WAF in API-only mode included with B4P.
- **Optimizer** — Per Pull Zone ($9.50/zone/month flat), toggled via Pull Zone update API.
- **SSL** — `LoadFreeCertificate` (Let's Encrypt), `AddCustomCertificate`, `RemoveCertificate`, `SetForceSSL`. Wildcard SSL auto-issuable when DNS is on bunny.net.

Every primitive needed to provision/teardown per-tenant exists in REST + Terraform.

### 1.2 No sub-accounts / orgs / workspaces

bunny.net has team-member sub-users (humans invited to one shared account), but **no organizations/projects/workspaces, no per-tenant billing entity**. Tenant isolation is entirely your responsibility.

### 1.3 Bunny for Platforms

The program for SaaS/hosting companies wrapping bunny.net's stack. Removes the 500-zone cap (scales to "millions of hostnames"), increases API rate limits, adds per-domain pricing option, BYO wildcard SSL, WAF API-only mode, DDoS for every hostname, dedicated CSE, 100% SLA. Sales-gated (`bunny.net/contact-sales`). No public pricing; expect custom contract with monthly minimum commit.

Customers known to use it: WP Rocket / RocketCDN (12,000+ sites), DreamHost managed CDN.

**Migration path**: B4P runs on the same account/API/resource IDs. Engage at ~300-400 tenants — onboarding takes time.

### 1.4 API rate limits and quotas

- **Default zone caps**: 500 Pull Zones, 500 Storage Zones, 500 Video Libraries, 500 DNS Zones per account. Each independent. B4P removes them.
- **Per-pull-zone hostname limit**: 10 (raisable on request).
- **Storage HTTP API**: 100 concurrent connections per IP, 50 concurrent uploads per Storage Zone, 25 max FTP connections per IP. Per-server, multiple servers per region.
- **Core API rate limits**: Not published as explicit RPM. Implement exponential backoff. B4P significantly increases limits.
- **Edge Script cold start**: 500ms max.

### 1.5 Authentication model

| Surface | Auth credential | Scope | Multi-tenant use |
| --- | --- | --- | --- |
| Core Platform API | Account API Access Key | Full account, no scoping | Server-side only; never expose to tenants |
| Storage HTTP API | Storage Zone Password (RW) or RO Password | Single Storage Zone | Safe per-tenant; pass RO key to client SDKs |
| Stream HTTP API | Library-specific Stream API Key | Single Video Library | Safe per-tenant for upload/playback |
| Statistics / Billing | Account API key | Account-wide | Server-side only |

You can create additional account API keys via `/apikey`, but they inherit account scope — no RBAC. **All tenant CRUD must flow through your control plane.**

### 1.6 Architecture: One-Pull-Zone-Per-Tenant (hard isolation)

- One Pull Zone, one Storage Zone, one optional Stream Library, one Shield Zone, one DNS Zone per tenant.
- Plus per-tenant Magic Container app (or Edge Script) for their backend code.
- Pros: Cleanest billing passthrough (`MonthlyCharges` per Pull Zone). Per-tenant cache purges, edge rules, WAF rules, regional pricing tiers. Per-tenant Storage Zone passwords for direct SDK access. Trivial offboarding.
- Cons: 500-zone cap until B4P. ~5-10 API calls per tenant onboarding.

---

## 2. Metrics & Billing Data

### 2.1 Statistics API

`GET https://api.bunny.net/statistics`

Query params: `dateFrom`, `dateTo` (default last 30 days), `pullZone` (filter, -1 = all), `serverZoneId` (region filter), `hourly` (boolean), plus `loadErrors`, `loadOriginResponseTimes`, `loadOriginTraffic`, `loadRequestsServed`, `loadBandwidthUsed`, `loadGeographicTrafficDistribution`, `loadUserBalanceHistory`.

Response: `TotalBandwidthUsed`, `TotalOriginTraffic`, `AverageOriginResponseTime`, `TotalRequestsServed`, `CacheHitRate`, plus time-series charts (bandwidth, requests, origin shield, errors 3xx/4xx/5xx, geo distribution).

Hourly granularity available. Bunny bills hourly. Per-zone via `pullZone`. Per-region via `serverZoneId` (matters because bunny prices bandwidth across 5 regional tiers: EU/NA, Asia, South America, Africa, Oceania).

### 2.2 Billing API

- `GET /billing/summary` — Monthly per-Pull-Zone summary with `PullZoneId`, `MonthlyUsage` (USD), `MonthlyBandwidthUsed` (bytes). **Easiest passthrough+markup primitive.**
- `GET /billing/details` — Line items.
- `GET /billing/summary/pdf` — PDF invoices.
- `POST /billing/recharge`, `POST /billing/configure-auto-recharge` — Top-ups.

Resources also expose monetary fields directly: Pull Zone (`MonthlyCharges`, `MonthlyBandwidthUsed`), Storage Zone (`StorageUsed`, `FilesStored`, `MonthlyTraffic`), Stream library (`StorageUsage`, `TrafficUsage`).

Magic Containers metrics via per-app Pods/Containers/Endpoints endpoints. Pricing dimensions: CPU-seconds, RAM-GB-hours, NVMe-GB-month, traffic-GB.

### 2.3 Real-time / delay

- Statistics API: 1-5 minute staleness on aggregations.
- **No webhooks for billing or usage.** Poll-only via API. Stream library encoding webhooks exist.
- Log Forwarding (Syslog UDP/TCP) is available but not needed — per-zone API gives everything.

### 2.4 bunny.net pricing dimensions to track

- **CDN bandwidth** — Per-region tiered (5 regional tiers). Standard vs Volume Tier. Region toggles per Pull Zone.
- **Edge Storage** — Standard $0.01/GB/mo (first 2 regions, $0.005/GB/mo additional, up to 9). Edge SSD $0.02/GB/mo per region (up to 14). Free API egress.
- **Stream** — $0.01/GB/mo storage; transcoding free; bandwidth at CDN rates.
- **Magic Containers** — CPU $0.02/3600 CPU-sec, RAM $0.005/GB-hour, NVMe $0.10/GB/mo allocated, egress ~$0.01/GB, Anycast IP $2/mo per app.
- **Edge Scripting** — Request + compute-time based.
- **Optimizer** — $9.50/Pull Zone/mo flat.
- **DNS** — Free.
- **Account-wide** — $1/mo minimum if any zone is active.

### 2.5 Simple metering implementation

Magic Container cron, hourly:

```
1. GET /billing/summary → write per-PullZoneId rows to Postgres
2. GET /statistics?pullZone={id}&serverZoneId={region}&hourly=true 
   for each tenant zone → write per-region usage
3. List storage zones, video libraries → write storage/traffic
4. List MC apps → write CPU/RAM/storage usage
```

~50-100 lines of code. Cross-foot daily against `/billing/summary`. No Syslog needed.

---

## 3. Prior Art

No public Supabase-style BaaS on bunny.net was found. Closest prior art:

- **WP Rocket / RocketCDN** — White-label CDN for ~12,000 WordPress sites, on B4P.
- **DreamHost managed CDN** — Hundreds of thousands of customers, on B4P.
- **HostBill bunny.net DNS module** — Third-party billing module for white-label DNS reselling.
- **DanceLab** (Medium case study) — Video pipeline migrated from Firebase to Bunny Stream. Confirms operational practices: store library API keys server-side, never log them; verify webhook signatures with HMAC SHA-256.
- **ALTCHA Sentinel on Magic Containers** — Notes Bunny Database (libSQL) is a bottleneck for distributed apps; explicitly recommends external Postgres + Redis. **Validates your architecture choice.**

### 3.1 Open-source ecosystem

- **Official Terraform Provider** — `BunnyWay/bunnynet`, ~1.6M downloads, ~70k/mo.
- **Official OpenAPI spec** — `docs.bunny.net/openapi`. Auto-generates clients for any language.
- **Official SDKs** — TypeScript, PHP, .NET, Java (Storage only); iOS (Stream); Edge Scripting SDK (`@bunny.net/edgescript-sdk`); Storage SDK (`@bunny.net/storage-sdk`); Magic Containers SDK.
- **No official JS SDK for Core API** (Pull Zones, DNS, Shield, MC) — generate from OpenAPI or use `fetch`.
- **Community SDKs** — Go (`simplesurance/bunny-go`), PHP (`ToshY/BunnyNet-PHP` — most complete), TypeScript (`dan-online/bunnycdn-stream`), Python (`dlt`), Elixir.
- **GitHub Actions** — `BunnyWay/bunnynet-action`, `BunnyWay/bunny-magic-containers-action`.

### 3.2 Pitfalls and gotchas

- **No S3-compatible Storage API** yet (on roadmap).
- **Cannot disable replication regions** once enabled — must re-create zone.
- **Cannot rename files in Storage** — re-upload + delete.
- **Storage Zone → Pull Zone is 1:1 for serving**.
- **Bunny Database (libSQL) is preview** — not production-ready for distributed apps.
- **Magic Containers egress** ($0.01/GB) considered expensive vs specialised VPS.
- **Edge Script 500ms cold start cap** — lazy-load heavy modules.
- **Edge Scripting SDK quirk** — `@bunny.net/edgescript-sdk` requires manual alias to `./node_modules/@bunny.net/edgescript-sdk/esm-bunny/lib.mjs` for production bundling.
- **Some Billing endpoints partially undocumented** — `/billing/summary`, `/billing/details` work but not in current OpenAPI.
- **No team-member API keys in Terraform** — only master account key.
- **AUP forbids live streaming** without prior consent.
- **Account suspends on negative balance** — control plane must monitor `/billing/summary` and auto-recharge to avoid mass-tenant outage.

---

## 4. Public API Surface

All endpoints under `https://api.bunny.net` unless noted. `AccessKey: <account-api-key>` header.

### 4.1 Account / Billing / Statistics / API Keys

- `GET /statistics` — performance metrics.
- `GET /billing/summary`, `/billing/details`, `/billing/summary/pdf`.
- `POST /billing/checkout`, `POST /billing/auto-recharge`, `POST /billing/applycode`.
- `GET/POST/DELETE /apikey` — API Keys CRUD (account-scoped only).
- `GET/PUT /user`, `GET /user/auditlog`.
- `GET /search`, `GET /countries`, `GET /region`.

### 4.2 Pull Zones (`/pullzone`)

- CRUD: `GET /pullzone`, `POST /pullzone`, `GET/POST/DELETE /pullzone/{id}`.
- Hostname: `addHostname`, `removeHostname`, `setForceSSL`.
- SSL: `loadFreeCertificate?hostname=...`, custom cert upload, delete.
- Edge Rules: `addOrUpdate`, `delete`, `setEdgeRuleEnabled`.
- Security: blocked IPs, blocked referrers, `setZoneSecurityEnabled`, `resetTokenKey`.
- Per-zone Stats: WAF, Safehop, Optimizer, OriginShieldQueue.
- Pull Zone object exposes: `EdgeScriptId`, `MiddlewareScriptId`, `MagicContainersAppId`, `MagicContainersEndpointId`, `StorageZoneId` — Pull Zone routes to MC, Edge Scripts, Storage, or external origin.

### 4.3 Storage Zones (`/storagezone`)

- CRUD on zones plus `resetPassword`, `resetReadOnlyPassword`, `checkAvailability`.
- Data plane: `GET/PUT/DELETE` on `https://{region}.storage.bunnycdn.com/{zoneName}/{path}`. AccessKey = Storage Zone Password. Wrong region returns 401.

### 4.4 DNS Zones (`/dnszone`)

- CRUD on zones (BIND import supported).
- Per-record CRUD: A, AAAA, CNAME, TXT, MX, SRV, CAA, PTR, NS, SVCB, TLSA, HTTPS, plus bunny-specific `RDR`.
- Records: `Accelerated` (CNAME flattening), `MonitorType` (failover), `LatencyZone`, `SmartRoutingType`, `GeolocationLatitude/Longitude`, `Weight`, `ScriptId` (route through Edge Script), `AutoSslIssuance`.

### 4.5 Stream Video Libraries

**Core API** for management: `/videolibrary` CRUD. Returns `ApiKey`, `ReadOnlyApiKey`, hidden `PullZoneId` and `StorageZoneId`, encoder settings, DRM, watermark, encoding tier.

**Stream API** (`video.bunnycdn.com/library/{libraryId}/...`, library ApiKey): videos CRUD, TUS resumable upload, fetch from URL, captions, heatmap, collections, OEmbed, thumbnails, reencode. Webhooks for `VideoQueued/Encoding/Finished/Failed` per library.

### 4.6 Shield API (`/shield`)

ShieldZone CRUD attached to a Pull Zone. WAF (rules, profiles, learning mode), RateLimiting (global counter sync across POPs, per-IP/UA/country/ASN/cookie), BotDetection, AccessLists, DDoS, ApiGuardian, UploadScanning. EventLogs and Metrics endpoints.

### 4.7 Edge Scripting (`/compute/script`)

Resources: Code, EdgeScript, Variable, Secret, Release. Standalone or middleware. GitHub auto-deploy from `main`. Local dev with Deno + `@bunny.net/edgescript-sdk`. Secrets encrypted at rest.

### 4.8 Magic Containers

Resources: Applications, AutoscalingSettings, ContainerRegistries, Containers, Endpoints, Limits, Nodes, Pods, Regions, RegionSettings, Volumes, Log Forwarding.

- Docker images from any registry.
- Multi-container composition (localhost between services).
- Per-app autoscaling per region.
- Reserved Instances (predictable pricing) flagged "coming soon".
- Syslog log forwarding (UDP/TCP, 10-30s delay).
- Templates: `BunnyWay/bunnynet-mc-templates`, `BunnyWay/mc-app-with-redis-template`.

### 4.9 Optimizer

Configured per Pull Zone via Pull Zone properties + Edge Rules. Sub-features: Automatic Optimization, Dynamic Images API, Image Classes, Watermarking, Burrow Smart Routing (Preview), HTML Prerender (Preview).

### 4.10 Logging / Webhooks

- Pull Zone access logs: per-zone toggle, permanent storage in a Storage Zone (daily file rotation), real-time Syslog forwarding.
- Magic Containers Syslog log forwarding per-app.
- Stream webhooks per library on encoding events.
- `GET /user/auditlog` for account-level changes.
- **No general-purpose webhook system for billing, zone-state, hostname-validation, or SSL events.** Poll for SSL issuance status via Pull Zone certificate field.

### 4.11 Dashboard-only / API gaps

- Sub-user / team-member management — no public API.
- Bunny for Platforms admin features — partially gated to dashboard / CSM.
- Account closure / payment-method removal — dashboard-only.
- Live streaming (RTMP) — not supported.
- S3-compatible Storage API — on roadmap.
- CDN cache pre-warming — not supported.
- Per-zone scoped API keys (RBAC) — does not exist.

---

## 5. Architecture (One-Pull-Zone-Per-Tenant)

### 5.1 Per-tenant resource graph

Per tenant onboarding, your control plane provisions:

1. **DNS Zone** (if tenant brings custom domain)
2. **Storage Zone** — gets RW/RO passwords
3. **Stream Library** — gets ApiKey/ReadOnlyApiKey (only if tenant uses video)
4. **Magic Container App** — origin for tenant's backend code; gets `*.b-cdn.net` URL
5. **Pull Zone** — origin = MC endpoint; attach tenant's hostname; `LoadFreeCertificate` for SSL
6. **Shield Zone** — attach to Pull Zone for WAF/rate-limiting
7. **Postgres provisioning** — CREATE DATABASE/SCHEMA + role with scoped permissions
8. **Inject secrets into MC app**: `DATABASE_URL`, `JWT_SIGNING_SECRET`, `BUNNY_STORAGE_KEY` (RW), `BUNNY_STREAM_KEY`
9. **Generate tenant credentials bundle** for AI agent / tenant dashboard:
   - CDN URL: `https://api.tenant.com` (their Pull Zone)
   - Storage RO key + zone name + region
   - Stream library RO key + library ID
   - JWT signing key (public verification key for their frontend)

### 5.2 Tenant app flow

```
Tenant's React/RN app
  ├─→ Bunny CDN (their Pull Zone) — static assets
  ├─→ Bunny Storage (their Zone, RO key) — direct media reads
  ├─→ Bunny Stream (their library key) — video upload/playback
  └─→ api.tenant.com (their Pull Zone → their MC app) — all API calls
         ├─ Authorization: Bearer <jwt> validated in MC code
         └─→ your Postgres (tenant-scoped DB/role, never exposed)

Tenant's Next.js SSR (if applicable)
  └─→ Their own MC app (separate or same) — same flow
```

### 5.3 Auth model

- **Storage / Stream / CDN reads**: bunny-native auth (Storage RO password, Stream RO key, optional Bunny Token Authentication signed URLs). No proxy needed.
- **API calls (MC app)**: tenant implements JWT validation inside their MC code using the signing secret you injected. You don't run a shared auth gateway.
- **Front the MC with a Pull Zone**: gives tenant a custom domain, SSL, Shield/WAF rate limits, optionally Bunny Token Authentication as a first gate before requests hit MC.

### 5.4 Control plane

One shared Magic Container app (or set of apps) running:

- **Provisioning service** — REST calls to `api.bunny.net` to create/delete tenant resources. State in your Postgres (tenant_id ↔ PullZoneId/StorageZoneId/etc.).
- **Metering cron** — hourly poll of `/billing/summary` and `/statistics` per tenant zone, write to Postgres.
- **Billing service** — monthly aggregate, apply markup, generate invoices.
- **SSL/state poller** — every 5 min check certificate status, hostname validation, account balance.
- **Auto-recharge guard** — monitor `/billing/summary` balance, trigger `POST /billing/recharge` when below threshold to prevent suspension.

### 5.5 IaC strategy

- **Terraform** for *your own* infra: shared MC apps (control plane, metering), shared Storage Zone for logs, base DNS, base Pull Zones.
- **REST API directly** from control plane for *per-tenant* provisioning. Keep state in your Postgres. Terraform is awkward for runtime per-tenant ops.

---

## 6. MVP Plan

### Phase 0 — Setup 

1. Create bunny.net account, generate master API key.
2. Provision managed Postgres cluster (e.g., Neon, RDS, or self-hosted).
3. Set up control-plane repo: TypeScript or Go service, Postgres schema (`tenants`, `bunny_resources`, `usage_metrics`, `invoices`).
4. Generate Bunny API client from OpenAPI spec.

### Phase 1 — Single tenant end-to-end 

Goal: one hardcoded tenant with full resource graph working.

1. Provision script that calls REST API in order: Storage Zone → Stream Library → MC app (with hello-world container) → Pull Zone (origin = MC endpoint) → Shield Zone → DNS records → SSL.
2. MC container template: Node/Bun HTTP server, JWT validation middleware, Postgres connection pool, one example endpoint querying tenant schema.
3. Postgres provisioning: `CREATE SCHEMA tenant_<id>`, role with scoped grants, inject `DATABASE_URL` as MC secret.
4. Smoke test: deploy a React app that signs a JWT, calls `api.test.com`, gets data from Postgres.

### Phase 2 — Multi-tenant + control plane 

1. Tenant CRUD API (`POST /tenants` triggers full provisioning, `DELETE /tenants/:id` tears down).
2. Persist all bunny resource IDs in Postgres.
3. Tenant credentials bundle endpoint — returns CDN URL, Storage RO key, Stream key, JWT signing key.
4. Idempotency + retry on every bunny API call (provisioning is multi-step; failures must be recoverable).
5. SSL polling: cron every 5 min, check Pull Zone certificate status, mark tenant ready.

### Phase 3 — Metering + billing 

1. Hourly cron: `GET /billing/summary`, `GET /statistics?pullZone={id}&hourly=true` per tenant, write to `usage_metrics`.
2. Daily reconciliation against `/billing/summary` totals.
3. Monthly invoice generator: aggregate, apply markup, create invoice row.
4. Auto-recharge guard: monitor account balance, top up if below floor.

### Phase 4 — Dashboard 

1. Customer-facing dashboard: tenant management, view usage/billing, manage custom domains, view logs (proxy from bunny logs).
2. Admin dashboard: tenant overview, account balance, manual top-up, support actions.

### Critical path checks before launch

- Confirm with bunny sales: in-place upgrade path to B4P from your existing account.
- Verify `/billing/summary` accuracy on a real tenant for a full billing cycle.
- Load-test provisioning: time to fully provision one tenant should be <60s.
- Failure-mode test: what happens if tenant goes negative on usage / your account hits balance floor / a Pull Zone fails SSL issuance.
- Decide tenant pricing tiers and bunny region exposure (Volume Tier vs Standard Tier vs B4P per-domain).

### When to engage Bunny for Platforms

At ~300 active tenants. Onboarding takes weeks. Don't wait until you hit 500.