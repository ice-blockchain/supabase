# Architecture

## Overview

```mermaid
flowchart LR
    Browser["Studio (Next.js dev)"]
    Kong["Kong 3.9.1<br/>docker/volumes/api/kong.yml"]
    Dash["dashboard catch-all<br/>/api/platform/auth/{ref}/{invite,magiclink,otp,recover,users/*}<br/>→ Studio Next.js proxy"]
    Traffic["traffic-one<br/>functions/index.ts"]
    GoTrue["GoTrue (/admin/*, /token, /signup, /recover, ...)"]
    PG[("Postgres<br/>traffic.*")]
    Vault[("Postgres Vault<br/>vault.decrypted_secrets")]
    PgMeta["pg-meta"]
    Logflare["Logflare"]
    Functions["edge-runtime (deno)<br/>/home/deno/functions"]

    Browser -->|"/api/platform/profile"| Kong
    Browser -->|"/api/platform/organizations*"| Kong
    Browser -->|"/api/platform/notifications*"| Kong
    Browser -->|"/api/platform/update-email"| Kong
    Browser -->|"/api/platform/feedback*"| Kong
    Browser -->|"/api/platform/cli*"| Kong
    Browser -->|"/api/platform/telemetry*"| Kong
    Browser -->|"/api/platform/database/*/backups*"| Kong
    Browser -->|"/api/platform/replication/*"| Kong
    Browser -->|"/api/platform/projects/{ref}/*"| Kong
    Browser -->|"/api/v1/projects/{ref}/*"| Kong
    Browser -->|"/api/v1/branches/*"| Kong
    Browser -->|"/api/v1/organizations*"| Kong
    Browser -->|regex /api/platform/auth/{ref}/config| Kong
    Browser -->|"/api/platform/auth/{ref}/{invite,magiclink,otp,recover,users/*}"| Dash

    Kong -->|strip_path → functions:9000/traffic-one| Traffic
    Traffic -->|supabase.auth.getUser| GoTrue
    Traffic -->|/admin/settings, /admin/config| GoTrue
    Traffic -->|traffic_api role| PG
    Traffic -->|project secrets| Vault
    Traffic -->|types/typescript, extensions| PgMeta
    Traffic -->|usage SQL, log-drain tail| Logflare
    Traffic -->|{slug}/index.ts + .meta.json| Functions
```

## Request Flow

### Authenticated routes (profile, tokens, etc.)

```
Browser
  → GET /api/platform/profile (Authorization: Bearer JWT)
  → Kong (strip_path: /api/platform/profile)
  → Edge Runtime (http://functions:9000/traffic-one)
  → traffic-one worker
    → supabase.auth.getUser(token) → GoTrue → claims (sub, email)
    → SELECT from traffic.profiles WHERE gotrue_id = claims.sub → Postgres
  → 200 JSON response
```

### Organization routes

```
Browser
  → GET/POST/PATCH/DELETE /api/platform/organizations* (Authorization: Bearer JWT)
  → Kong (strip_path: /api/platform/organizations)
  → Edge Runtime (http://functions:9000/traffic-one/organizations*)
  → traffic-one worker
    → supabase.auth.getUser(token) → GoTrue → claims (sub, email)
    → getOrCreateProfile → profileId
    → organization.service.ts → traffic.organizations + traffic.organization_members → Postgres
    → audit log insert → traffic.audit_logs
  → JSON response
```

### Unauthenticated routes (signup, reset-password)

```
Browser
  → POST /api/platform/signup (no Authorization)
  → Kong (strip_path: /api/platform/signup)
  → Edge Runtime (http://functions:9000/traffic-one/signup)
  → traffic-one worker
    → supabase.auth.signUp() → GoTrue → creates user
  → 201 response
```

### Billing routes

```
Browser
  → GET/PUT/POST/DELETE /api/platform/organizations/{slug}/billing/* (Authorization: Bearer JWT)
  → GET/PUT/POST/DELETE /api/platform/organizations/{slug}/customer
  → GET/PUT/DELETE /api/platform/organizations/{slug}/tax-ids
  → GET/POST/DELETE /api/platform/organizations/{slug}/payments*
  → GET/POST /api/platform/projects/{ref}/billing/addons*
  → GET/POST /api/platform/stripe/*
  → Kong → Edge Runtime → traffic-one worker
    → supabase.auth.getUser(token) → GoTrue → claims
    → getOrCreateProfile → profileId
    → routes/organizations.ts delegates to routes/billing.ts → services/billing.service.ts → Postgres
    → (optional) services/stripe.service.ts → Stripe API (if STRIPE_API_KEY set)
  → JSON response
```

### Team / Members routes

```
Browser
  → GET /api/platform/organizations/{slug}/members*
  → GET /api/platform/organizations/{slug}/roles
  → POST/DELETE /api/platform/organizations/{slug}/members/invitations*
  → PATCH/DELETE /api/platform/organizations/{slug}/members/{gotrue_id}*
  → GET/PATCH /api/platform/organizations/{slug}/members/mfa/enforcement
  → Kong → Edge Runtime → traffic-one worker
    → supabase.auth.getUser(token) → GoTrue → claims
    → getOrCreateProfile → profileId
    → routes/organizations.ts delegates to routes/members.ts → services/member.service.ts
    → member.service.ts → traffic.organization_members / traffic.organization_member_roles
                         / traffic.invitations / traffic.roles → Postgres
    → audit log insert (for mutations) → traffic.audit_logs
  → JSON response
```

### Organization Settings routes

```
Browser
  → GET /api/platform/organizations/{slug}/audit?iso_timestamp_start&iso_timestamp_end
  → GET/POST/PUT/DELETE /api/platform/organizations/{slug}/sso
  → Kong → Edge Runtime → traffic-one worker
    → supabase.auth.getUser(token) → GoTrue → claims
    → getOrCreateProfile → profileId
    → routes/organizations.ts delegates to services/org-settings.service.ts
    → org-settings.service.ts → traffic.organizations / traffic.sso_providers / traffic.audit_logs → Postgres
    → audit log insert (for mutations) → traffic.audit_logs
  → JSON response
```

### Project routes

```
Browser
  → GET/POST/PATCH/DELETE /api/platform/projects* (Authorization: Bearer JWT)
  → GET /api/v1/projects/{ref}/health
  → Kong → Edge Runtime → traffic-one worker
    → supabase.auth.getUser(token) → GoTrue → claims
    → getOrCreateProfile → profileId
    → routes/projects.ts → services/project.service.ts
    → project.service.ts → traffic.projects + membership check via traffic.organization_members → Postgres
    → provisioner (local: env vars / api: external HTTP) → credentials
    → Vault (vault.create_secret / vault.decrypted_secrets) → encrypted credential storage
    → audit log insert → traffic.audit_logs
  → JSON response

Project creation flow:
  1. Verify org membership
  2. Generate 20-char hex ref
  3. Call provisioner.provision() → credentials
  4. Store sensitive credentials (service_key, db_pass, conn_string) in Vault
  5. INSERT project with Vault UUIDs + non-sensitive fields
  6. Write audit log
  7. Return CreateProjectResponse

Lifecycle operations:
  - Pause: status → INACTIVE
  - Restore: status → ACTIVE_HEALTHY
  - Restart: no-op (returns 200)
```

### Usage routes

```
Browser
  → GET /api/platform/organizations/{slug}/usage?project_ref&start&end (Authorization: Bearer JWT)
  → GET /api/platform/organizations/{slug}/usage/daily?start&end&project_ref
  → Kong → Edge Runtime → traffic-one worker
    → supabase.auth.getUser(token) → GoTrue → claims
    → getOrCreateProfile → profileId
    → routes/organizations.ts delegates to services/usage.service.ts
    → usage.service.ts:
      → Postgres: pg_database_size(), storage.objects → DATABASE_SIZE, STORAGE_SIZE
      → Logflare (http://analytics:4000): SQL queries → FUNCTION_INVOCATIONS, EGRESS, MAU, REALTIME, etc.
      → pricing.config.ts + traffic.pricing_overrides → cost calculation with discounts
  → JSON response (OrgUsageResponse or OrgDailyUsageResponse)
```

### Route groups and handlers

Every route group below is dispatched by [`functions/index.ts`](functions/index.ts) after Kong strips the `/api/platform/*` or `/api/v1/*` prefix. Handlers share the common Authorization → `getOrCreateProfile` → membership check pattern; the table below notes the strip-path convention, the tables touched, and the audit action(s) emitted.

| Route group                                                   | Route file                                                                                                               | Kong paths                                                                                                                                                             | Mutates                                                                                                                  | Audit actions                                                                                                                 |
| ------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------ | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------ | ----------------------------------------------------------------------------------------------------------------------------- |
| **Profile / update-email**                                    | [`routes/profile.ts`](functions/routes/profile.ts), [`routes/update-email.ts`](functions/routes/update-email.ts)         | `/api/platform/profile*`, `/api/platform/update-email`                                                                                                                 | `traffic.profiles`, `auth.users.email` via GoTrue admin                                                                  | `profile.email_updated`                                                                                                       |
| **Notifications**                                             | [`routes/notifications.ts`](functions/routes/notifications.ts)                                                           | `/api/platform/notifications*`                                                                                                                                         | `traffic.notifications`                                                                                                  | `notifications.update`                                                                                                        |
| **GoTrue admin**                                              | [`routes/auth-config.ts`](functions/routes/auth-config.ts)                                                               | regex `~/api/platform/auth/[^/]+/config`                                                                                                                               | `traffic.auth_config_overrides` + (opportunistically) GoTrue's `/admin/config` HTTP endpoint                             | `auth_config.update`                                                                                                          |
| **Backups**                                                   | [`routes/backups.ts`](functions/routes/backups.ts)                                                                       | `/api/platform/database/*/backups*`                                                                                                                                    | read-only + 501 for restore/PITR                                                                                         | —                                                                                                                             |
| **Replication**                                               | [`routes/replication.ts`](functions/routes/replication.ts)                                                               | `/api/platform/replication/*`                                                                                                                                          | read-only stub (empty arrays); 501 for writes                                                                            | —                                                                                                                             |
| **Analytics / log drains / infra-monitoring**                 | [`routes/project-analytics.ts`](functions/routes/project-analytics.ts)                                                   | `/api/platform/projects/{ref}/(analytics\|infra-monitoring\|api/(rest\|graphql))*`                                                                                     | `traffic.log_drains`                                                                                                     | `project.log_drain_{created,updated,deleted}`                                                                                 |
| **Database migrations**                                       | [`routes/database-migrations.ts`](functions/routes/database-migrations.ts)                                               | `/api/platform/pg-meta/*/migrations*`                                                                                                                                  | `traffic.schema_migrations`                                                                                              | `schema_migrations.insert`                                                                                                    |
| **Feedback**                                                  | [`routes/feedback.ts`](functions/routes/feedback.ts)                                                                     | `/api/platform/feedback/*`                                                                                                                                             | `traffic.feedback`                                                                                                       | `profile.feedback_submitted`, `profile.feedback_updated`                                                                      |
| **CLI**                                                       | [`routes/cli.ts`](functions/routes/cli.ts)                                                                               | `/api/platform/cli/*`                                                                                                                                                  | `traffic.scoped_access_tokens`                                                                                           | `scoped_access_tokens.insert`                                                                                                 |
| **Project config + lint exceptions + DB password rotation**   | [`routes/project-config.ts`](functions/routes/project-config.ts)                                                         | `/api/platform/projects/{ref}/config/(postgrest\|storage\|realtime\|pgbouncer\|secrets)`, `/settings/sensitivity`, `/db-password`, `/notifications/advisor/exceptions` | `traffic.project_config`, `traffic.lint_exceptions`, `traffic.projects.sensitivity`                                      | `project.config_updated`, `project.db_password_rotated`                                                                       |
| **Disk / resize / regions / restore-versions**                | [`routes/project-disk.ts`](functions/routes/project-disk.ts)                                                             | `/api/platform/projects/{ref}/(disk\|resize\|restore/versions)`, `/api/platform/projects/available-regions`                                                            | read-only; 501 for `/resize` and `POST /disk*`                                                                           | —                                                                                                                             |
| **Project network + read-replicas + privatelink**             | [`routes/project-network.ts`](functions/routes/project-network.ts)                                                       | `/api/v1/projects/{ref}/(network-restrictions\|network-bans\|read-replicas)`, `/api/platform/projects/{ref}/privatelink/*`                                             | stubs; 501 for mutations                                                                                                 | —                                                                                                                             |
| **Project lifecycle (upgrade, types, readonly, actions)**     | [`routes/project-lifecycle.ts`](functions/routes/project-lifecycle.ts)                                                   | `/api/v1/projects/{ref}/(upgrade*\|types/typescript\|readonly/temporary-disable\|actions*)`                                                                            | read-only or 501                                                                                                         | —                                                                                                                             |
| **Project auth (third-party-auth, SSL enforcement, secrets)** | [`routes/project-auth.ts`](functions/routes/project-auth.ts)                                                             | `/api/v1/projects/{ref}/(config/auth/third-party-auth*\|ssl-enforcement\|secrets)`                                                                                     | `traffic.project_third_party_auth`, `traffic.project_secrets` (Vault-encrypted), `project_config.ssl_enforcement` column | `project.third_party_auth_{added,removed}`, `project.ssl_enforcement_updated`, `project.secret_set`, `project.secret_deleted` |
| **Project API keys + signing keys**                           | [`routes/project-api-keys.ts`](functions/routes/project-api-keys.ts)                                                     | `/api/v1/projects/{ref}/(api-keys*\|config/auth/signing-keys*)`                                                                                                        | `traffic.project_api_keys`, `traffic.project_jwt_signing_keys`                                                           | `project.api_key_{created,updated,revoked}`, `project.signing_key_{rotated,revoked}`                                          |
| **Content (snippets + folders)**                              | [`routes/content.ts`](functions/routes/content.ts)                                                                       | `/api/platform/projects/{ref}/content*`                                                                                                                                | `traffic.content_items`, `traffic.content_folders`                                                                       | `project.content_{created,updated,deleted}`, `project.content_folder_{created,updated,deleted}`                               |
| **Branches + custom hostnames**                               | [`routes/branches.ts`](functions/routes/branches.ts), [`routes/custom-hostname.ts`](functions/routes/custom-hostname.ts) | `/api/v1/(projects/{ref}/branches*\|branches/*)`, `/api/v1/projects/{ref}/custom-hostname*`                                                                            | `traffic.branches`, `traffic.custom_hostnames`                                                                           | `project.branch_{created,updated,pushed,merged,reset,restored,deleted}`, `project.custom_hostname_initialized`                |
| **Edge function mutations**                                   | [`routes/edge-function-mutations.ts`](functions/routes/edge-function-mutations.ts)                                       | `/api/v1/projects/{ref}/functions/(deploy\|{slug})` (POST/PATCH/DELETE)                                                                                                | filesystem writes into `/home/deno/functions/{slug}/` (writable bind-mount) + `.meta.json`                               | `project.edge_function_{deployed,updated,deleted}`                                                                            |
| **JIT (just-in-time database access)**                        | [`routes/jit.ts`](functions/routes/jit.ts)                                                                               | `/api/v1/projects/{ref}/(jit-access\|database/jit*)`                                                                                                                   | `traffic.jit_policies`, `traffic.jit_grants` + real Postgres roles via superuser pool                                    | `project.jit_policy_updated`, `project.jit_grant_{issued,revoked}`                                                            |

**GoTrue admin proxy semantics.** `GET /config` and `GET /config/hooks` return a three-layer merge: env-derived defaults ← (optional) live `GET {GOTRUE_URL}/admin/settings` ← `traffic.auth_config_overrides`. `PATCH /config` forwards the patch to `POST {GOTRUE_URL}/admin/config`; fields GoTrue accepts propagate live and any rejected fields fall through to the overrides table so Studio's view remains consistent even on self-hosted GoTrue builds that don't expose live mutation.

**Logflare fallback.** When Logflare's SQL endpoint is unreachable, `logflare.client.ts` returns `{ result: [] }` so `GET /projects/{ref}/analytics/endpoints/logs.*` never 5xxs. Studio's chart renders an empty timeseries instead of a Suspense error.

**Edge function deploy filesystem contract.** The `functions` container must mount `/home/deno/functions` as a **writable** bind-mount shared with the `traffic-one` worker. Multipart-body deploys write `{slug}/index.ts` + `.meta.json` atomically; delete is `Deno.remove(dir, { recursive: true })`. **There is no live reload** — newly-written files are picked up on the next cold start of the function slug (see `edge-function-mutations.ts:351-356`).

## Usage APIs

### Data Sources

All usage metrics are derived from real data via two backends:

| Backend  | Metrics                      | Query Method                                                     |
| -------- | ---------------------------- | ---------------------------------------------------------------- |
| Postgres | `DATABASE_SIZE`              | `pg_database_size(current_database())`                           |
| Postgres | `STORAGE_SIZE`               | `SUM((metadata->>'size')::bigint) FROM storage.objects`          |
| Logflare | `FUNCTION_INVOCATIONS`       | `COUNT(DISTINCT id) FROM function_edge_logs`                     |
| Logflare | `EGRESS`                     | `SUM(content_length) FROM edge_logs` with UNNEST on metadata     |
| Logflare | `MONTHLY_ACTIVE_USERS`       | `COUNT(DISTINCT actor_id) FROM auth_logs`                        |
| Logflare | `REALTIME_MESSAGE_COUNT`     | `COUNT(*) FROM realtime_logs`                                    |
| Logflare | `REALTIME_PEAK_CONNECTIONS`  | Derived from `realtime_logs` connection events                   |
| Logflare | `STORAGE_IMAGES_TRANSFORMED` | `COUNT(*) FROM edge_logs WHERE path LIKE '/storage/v1/render/%'` |

Logflare is queried via its SQL endpoint: `GET http://analytics:4000/api/endpoints/query/logs.all?project=default&sql=<SQL>&iso_timestamp_start=<ISO>&iso_timestamp_end=<ISO>` with `x-api-key: LOGFLARE_PRIVATE_ACCESS_TOKEN`.

### Pricing Model

Default pricing is hardcoded in `pricing.config.ts` per plan (free/pro/team/enterprise). Three pricing strategies:

| Strategy  | Cost Calculation                                                        |
| --------- | ----------------------------------------------------------------------- |
| `UNIT`    | `overage × per_unit_price` where `overage = max(0, usage - free_units)` |
| `PACKAGE` | `ceil(overage / package_size) × package_price`                          |
| `NONE`    | Always $0 (metric tracked but not billed)                               |

### Discount System

Per-organization pricing overrides via `traffic.pricing_overrides`:

| Column                  | Purpose                                                  |
| ----------------------- | -------------------------------------------------------- |
| `metric`                | Specific metric (NULL = global discount for all metrics) |
| `discount_percent`      | Percentage off the overage price (e.g. 10.00 = 10%)      |
| `custom_free_units`     | Override included quota (NULL = use plan default)        |
| `custom_per_unit_price` | Override per-unit price (NULL = use plan default)        |

**Override priority** (highest to lowest):

1. Per-metric override for the org (`metric IS NOT NULL`)
2. Global override for the org (`metric IS NULL`)
3. Default plan pricing from `pricing.config.ts`

**Cost formula with discounts:**

```
effective_free_units = override.custom_free_units ?? default.free_units
effective_price = override.custom_per_unit_price ?? default.per_unit_price
if (discount_percent > 0): effective_price *= (1 - discount_percent / 100)
overage = max(0, usage - effective_free_units)
cost = overage * effective_price  // (or package-based for PACKAGE strategy)
```

## Design Decisions

### Auth

GoTrue JWT via `supabase.auth.getUser(token)` for all routes except `/signup` and `/reset-password`, which are public proxies to GoTrue's native signup (`POST /signup`) and recovery (`POST /recover`) endpoints. These use the existing supabase-js client (anon key) and forward captcha tokens via the SDK's `options.captchaToken`.

### Database

Direct Postgres via `TRAFFIC_DB_URL` using a restricted `traffic_api` role. This role has granular per-table permissions and is append-only on `traffic.audit_logs` (INSERT + SELECT, no UPDATE/DELETE). The `postgres` superuser is reserved for migrations.

### Routing

Kong `strip_path: true` strips route prefixes (`/api/platform/profile`, `/api/platform/organizations`, etc.). The function receives clean paths like `/`, `/access-tokens`, `/permissions`. For organizations, slug subpaths like `/{slug}` and `/{slug}/projects` are preserved after prefix stripping.

**Studio port asymmetry (8082 vs 3000).** The prebuilt `supabase/studio:2026.04.08-sha-205cbe7` image runs `next dev -p ${STUDIO_PORT:-8082}` (see `apps/studio/package.json`). The base `docker/docker-compose.yml` healthcheck therefore probes `http://localhost:8082/api/platform/profile` rather than the upstream `localhost:3000` URL. Platform mode disables the healthcheck entirely in `docker-compose.platform.yml`, so this matters only for non-platform self-hosted users — if they run a build that listens on 3000 instead of 8082, the healthcheck will fail. This is flagged in [§ Known Gaps / Remaining Work](#known-gaps--remaining-work).

### Kong Open Auth Routes

Five Kong services expose GoTrue endpoints **without** the `key-auth` plugin (unlike the `auth-v1-*` services that wrap GoTrue with the apikey requirement):

| Route                   | Kong service           | Upstream                   |
| ----------------------- | ---------------------- | -------------------------- |
| `POST /auth/v1/token`   | `auth-v1-open-token`   | `http://auth:9999/token`   |
| `GET/PUT /auth/v1/user` | `auth-v1-open-user`    | `http://auth:9999/user`    |
| `POST /auth/v1/logout`  | `auth-v1-open-logout`  | `http://auth:9999/logout`  |
| `POST /auth/v1/signup`  | `auth-v1-open-signup`  | `http://auth:9999/signup`  |
| `POST /auth/v1/recover` | `auth-v1-open-recover` | `http://auth:9999/recover` |

All five use `strip_path: true`, a single CORS plugin, and forward any body/headers verbatim to the GoTrue upstream.

**Why they are open.** Studio's platform-mode `AuthClient` (see `traffic-one/studio-patches/gotrue.ts`) is constructed with only `NEXT_PUBLIC_GOTRUE_URL` and does not attach an `apikey` header on login/refresh/logout/signup/recover calls, matching supabase.com's production dashboard behavior. Gating these endpoints behind `key-auth` in Kong would break the sign-in form, the refresh-token loop, sign-up, and password recovery in self-hosted platform mode. The endpoints themselves remain safe because GoTrue performs its own authentication (password, refresh token, JWT Bearer, or recovery nonce) and enforces rate limits / captcha internally.

**Scope of exposure.** The `paths:` entries use prefix matching, so `POST /auth/v1/token?grant_type=refresh_token` and `PATCH /auth/v1/user` both route through. Other GoTrue endpoints (admin APIs, SSO, MFA) continue to flow through `auth-v1-*` which still requires the dashboard apikey.

### Platform services routed to `traffic-one`

Every Kong `platform-*` and `v1-*` service that forwards traffic to `traffic-one` is listed below. All services target the same upstream (`http://functions:9000/traffic-one`) and rely on Kong's `strip_path` behaviour to deliver clean tails to [`functions/index.ts`](functions/index.ts).

| Kong service              | Paths                                                                              | `strip_path` | Notes                                                                                                                                                            |
| ------------------------- | ---------------------------------------------------------------------------------- | ------------ | ---------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `platform-profile`        | `/api/platform/profile`                                                            | true         | —                                                                                                                                                                |
| `platform-update-email`   | `/api/platform/update-email`                                                       | true         | —                                                                                                                                                                |
| `platform-signup`         | `/api/platform/signup`                                                             | true         | Unauthenticated                                                                                                                                                  |
| `platform-reset-password` | `/api/platform/reset-password`                                                     | true         | Unauthenticated                                                                                                                                                  |
| `platform-organizations`  | `/api/platform/organizations`                                                      | true         | Dispatches sub-resources (billing, members, audit, sso, usage, documents, tax-ids, etc.) inside the function worker                                              |
| `platform-notifications`  | `/api/platform/notifications`                                                      | true         | Replaces the previously defined `platform-notifications-stub` (see below)                                                                                        |
| `platform-auth`           | regex `~/api/platform/auth/[^/]+/config` (matches `/config`, `/config/hooks`, ...) | false        | Regex route so we **do not** shadow Studio's existing Next.js proxies at `/api/platform/auth/{ref}/{invite,magiclink,otp,recover,users/*}`                       |
| `platform-database`       | `/api/platform/database`                                                           | true         | Dispatches `/backups*`, `/{ref}/backups/*`, etc.                                                                                                                 |
| `platform-replication`    | `/api/platform/replication`                                                        | true         | Read-only stubs; mutations are 501                                                                                                                               |
| `platform-feedback`       | `/api/platform/feedback`                                                           | true         | `traffic.feedback`                                                                                                                                               |
| `platform-cli`            | `/api/platform/cli`                                                                | true         | CLI-login handshake backed by `traffic.scoped_access_tokens`                                                                                                     |
| `platform-telemetry`      | `/api/platform/telemetry`                                                          | true         | Sink for Studio telemetry events                                                                                                                                 |
| `v1-organizations`        | `/api/v1/organizations`                                                            | true         | V1 organization endpoints separate from the platform API                                                                                                         |
| `v1-branches`             | `/api/v1/branches`                                                                 | true         | Global branch endpoints (diff, push, merge, reset, restore, delete) — per-project CRUD is served under `/api/v1/projects/{ref}/branches` via `platform-projects` |

Project-level `/api/v1/projects/{ref}/*` endpoints (api-keys, signing-keys, ssl-enforcement, secrets, network, read-replicas, disk, types/typescript, upgrade, custom-hostname, functions/deploy, jit-access, database/jit, etc.) are all dispatched inside `traffic-one` after the `/api/v1/projects` → functions forwarding handled by the existing `v1-projects` + `platform-projects` services.

#### `platform-notifications-stub` removal

`platform-notifications-stub` was a transitional Kong service that returned a hard-coded empty notifications array while the real handler was being developed. It has been **removed** and replaced by `platform-notifications`, which routes to [`functions/routes/notifications.ts`](functions/routes/notifications.ts) backed by `traffic.notifications`. Operators upgrading from older builds should verify the stub block is gone from their mounted `docker/volumes/api/kong.yml`.

### CORS

Returns `Access-Control-Allow-Origin: *` and `Access-Control-Allow-Headers` on all responses and handles OPTIONS preflight.

### Self-contained

Each edge function contains all its own code. No `_shared/` folder. No cross-function imports. `corsHeaders` is exported from `index.ts` and imported by route handlers to avoid duplication.

## Database Schema

All tables live in the `traffic` schema.

### traffic_api Role Permissions

| Table                     | SELECT | INSERT | UPDATE | DELETE |
| ------------------------- | ------ | ------ | ------ | ------ |
| profiles                  | ✓      | ✓      | ✓      | ✓      |
| organizations             | ✓      | ✓      | ✓      | ✓      |
| organization_members      | ✓      | ✓      | ✓      | ✓      |
| projects                  | ✓      | ✓      | ✓      | ✓      |
| access_tokens             | ✓      | ✓      | ✗      | ✓      |
| scoped_access_tokens      | ✓      | ✓      | ✗      | ✓      |
| notifications             | ✓      | ✓      | ✓      | ✗      |
| audit_logs                | ✓      | ✓      | ✗      | ✗      |
| products                  | ✓      | ✓      | ✓      | ✓      |
| prices                    | ✓      | ✓      | ✓      | ✓      |
| subscriptions             | ✓      | ✓      | ✓      | ✓      |
| customers                 | ✓      | ✓      | ✓      | ✓      |
| payment_methods           | ✓      | ✓      | ✓      | ✓      |
| invoices                  | ✓      | ✓      | ✓      | ✓      |
| tax_ids                   | ✓      | ✓      | ✓      | ✓      |
| credits                   | ✓      | ✓      | ✓      | ✓      |
| credit_transactions       | ✓      | ✓      | ✓      | ✓      |
| project_addons            | ✓      | ✓      | ✓      | ✓      |
| upgrade_requests          | ✓      | ✓      | ✓      | ✓      |
| pricing_overrides         | ✓      | ✓      | ✓      | ✓      |
| sso_providers             | ✓      | ✓      | ✓      | ✓      |
| roles                     | ✓      | ✗      | ✗      | ✗      |
| organization_member_roles | ✓      | ✓      | ✓      | ✓      |
| invitations               | ✓      | ✓      | ✓      | ✓      |

### Other Permissions

| Object                                     | Permission | Purpose                            |
| ------------------------------------------ | ---------- | ---------------------------------- |
| `pg_database_size(name)`                   | EXECUTE    | Usage API: query database size     |
| `storage.objects`                          | SELECT     | Usage API: query storage size      |
| `vault.create_secret(text,text,text)`      | EXECUTE    | Projects: store credentials        |
| `vault.update_secret(uuid,text,text,text)` | EXECUTE    | Projects: update credentials       |
| `vault.decrypted_secrets`                  | SELECT     | Projects: read decrypted secrets   |
| `vault.secrets`                            | DELETE     | Projects: remove secrets on delete |

### Tables

- **traffic.profiles** — `id SERIAL PK`, `gotrue_id UUID UNIQUE`, `username`, `primary_email`, `first_name`, `last_name`, `mobile`, `is_alpha_user`, `is_sso_user`, `free_project_limit`, `disabled_features TEXT[]`, timestamps
- **traffic.organizations** — `id SERIAL PK`, `name`, `slug UNIQUE`, `billing_email`, `opt_in_tags TEXT[]`, `mfa_enforced BOOLEAN` (default `false`), `additional_billing_emails TEXT[]`, `plan_id` (default `free`), `plan_name` (default `Free`), timestamps
- **traffic.organization_members** — `id SERIAL PK`, `organization_id FK` (CASCADE), `profile_id FK` (CASCADE), `role` (default `owner`), `created_at`, `UNIQUE(organization_id, profile_id)`
- **traffic.access_tokens** — `id SERIAL PK`, `profile_id FK`, `name`, `token_hash`, `token_alias`, `scope`, `expires_at`, `last_used_at`, `created_at`
- **traffic.scoped_access_tokens** — `id UUID PK`, `profile_id FK`, `name`, `token_hash`, `token_alias`, `permissions TEXT[]`, `organization_slugs TEXT[]`, `project_refs TEXT[]`, `expires_at`, `last_used_at`, `created_at`
- **traffic.notifications** — `id UUID PK`, `profile_id FK`, `name`, `data JSONB`, `meta JSONB`, `priority`, `status`, `inserted_at`
- **traffic.audit_logs** — `id UUID PK`, `profile_id FK`, `organization_id FK` (nullable, SET NULL on delete), `action_name`, `action_metadata JSONB`, `actor_id`, `actor_type`, `actor_metadata JSONB`, `target_description`, `target_metadata JSONB`, `occurred_at`
- **traffic.projects** — `id SERIAL PK`, `ref TEXT UNIQUE`, `name`, `organization_id FK` (CASCADE), `region` (default `local`), `cloud_provider` (default `FLY`), `status` (default `COMING_UP`), `endpoint`, `anon_key`, `db_host`, `service_key_secret_id UUID` (Vault), `db_pass_secret_id UUID` (Vault), `connection_string_secret_id UUID` (Vault), timestamps

#### Billing Tables (migration 007)

- **traffic.products** — `id TEXT PK`, `active`, `name`, `description`, `image`, `metadata JSONB`
- **traffic.prices** — `id TEXT PK`, `product_id FK`, `active`, `unit_amount`, `currency`, `type` (pricing_type enum), `interval` (pricing_plan_interval enum), `interval_count`, `trial_period_days`, `metadata JSONB`
- **traffic.subscriptions** — `id TEXT PK`, `organization_id FK UNIQUE` (CASCADE), `status` (subscription_status enum), `price_id FK`, `tier`, `plan_id`, `plan_name`, `billing_cycle_anchor`, `usage_billing_enabled`, `nano_enabled`, `stripe_subscription_id`, `stripe_customer_id`, period timestamps
- **traffic.customers** — `id SERIAL PK`, `organization_id FK UNIQUE` (CASCADE), `stripe_customer_id`, `billing_name`, address fields, timestamps
- **traffic.payment_methods** — `id TEXT PK`, `organization_id FK` (CASCADE), `type`, `card_brand`, `card_last4`, `card_exp_month`, `card_exp_year`, `is_default`, `stripe_payment_method_id`
- **traffic.invoices** — `id TEXT PK`, `organization_id FK` (CASCADE), `number`, `status`, `amount_due`, `subtotal`, `period_start`, `period_end`, `invoice_pdf`, `stripe_invoice_id`, `subscription_id`
- **traffic.tax_ids** — `id SERIAL PK`, `organization_id FK` (CASCADE), `type`, `value`
- **traffic.credits** — `id SERIAL PK`, `organization_id FK UNIQUE` (CASCADE), `balance`
- **traffic.credit_transactions** — `id SERIAL PK`, `organization_id FK` (CASCADE), `amount`, `type`, `description`
- **traffic.project_addons** — `id SERIAL PK`, `project_ref`, `addon_type`, `addon_variant`, `UNIQUE(project_ref, addon_type)`
- **traffic.upgrade_requests** — `id SERIAL PK`, `organization_id FK` (CASCADE), `requested_plan`, `note`, `status`

#### Usage Tables (migration 008)

- **traffic.pricing_overrides** — `id SERIAL PK`, `organization_id FK` (CASCADE), `metric VARCHAR(64)` (NULL = global), `discount_percent NUMERIC(5,2)`, `custom_free_units NUMERIC`, `custom_per_unit_price NUMERIC`, `notes TEXT`, timestamps, `UNIQUE(organization_id, metric)`

#### Team / Members Tables (migration 010)

- **traffic.roles** — `id INTEGER PK`, `name TEXT UNIQUE`, `description TEXT`, `base_role_id INTEGER`. Seeded with 4 fixed roles: Read only (2), Developer (3), Administrator (4), Owner (5)
- **traffic.organization_member_roles** — `id SERIAL PK`, `organization_id FK` (CASCADE), `profile_id FK` (CASCADE), `role_id FK` (CASCADE), `project_refs TEXT[]`, `created_at`, `UNIQUE(organization_id, profile_id, role_id)`. Junction table for multi-role assignment
- **traffic.invitations** — `id SERIAL PK`, `organization_id FK` (CASCADE), `invited_email TEXT`, `role_id FK` (CASCADE), `token UUID UNIQUE`, `role_scoped_projects TEXT[]`, `invited_at`, `expires_at` (default now + 24h). Token-based invitation workflow

#### Organization Settings Tables (migration 009)

- **traffic.sso_providers** — `id UUID PK`, `organization_id FK UNIQUE` (CASCADE), `enabled BOOLEAN`, `metadata_xml_file TEXT`, `metadata_xml_url TEXT`, `domains TEXT[]`, `email_mapping TEXT[]`, `first_name_mapping TEXT[]`, `last_name_mapping TEXT[]`, `user_name_mapping TEXT[]`, `join_org_on_signup_enabled BOOLEAN`, `join_org_on_signup_role TEXT`, timestamps

#### Auth Config Overrides (migration 012)

- **traffic.auth_config_overrides** — `id SERIAL PK`, `project_ref TEXT`, `config_key TEXT`, `config_value JSONB`, `updated_at`, `UNIQUE(project_ref, config_key)`. Layer that sits on top of env-derived GoTrue defaults and any live `/admin/settings` response. See [Route groups and handlers](#route-groups-and-handlers).

#### Schema Migrations (migration 013)

- **traffic.schema_migrations** — `id SERIAL PK`, `project_ref TEXT`, `version TEXT`, `name TEXT`, `statements TEXT[]`, `inserted_at`, `UNIQUE(project_ref, version)`. Append-only log of DDL batches applied through `POST /pg-meta/{ref}/migrations`.

#### Feedback (migration 014)

- **traffic.feedback** — `id SERIAL PK`, `profile_id FK` (SET NULL), `category TEXT CHECK IN ('general','upgrade_survey','downgrade_survey','support_ticket')`, `message TEXT`, `project_ref TEXT`, `organization_slug TEXT`, `tags TEXT[]`, `metadata JSONB`, `custom_fields JSONB`, timestamps. Mutations are scoped by `profile_id` to prevent cross-user writes.

#### Project API Keys & JWT Signing Keys (migration 015)

- **traffic.project_api_keys** — `id SERIAL PK`, `project_ref TEXT`, `name TEXT`, `description TEXT`, `key_hash TEXT`, `key_alias TEXT`, `type TEXT CHECK IN ('publishable','secret')`, `tags TEXT[]`, timestamps, `deleted_at`. Plaintext surfaced once on CREATE and never stored.
- **traffic.project_jwt_signing_keys** — `id SERIAL PK`, `project_ref TEXT`, `algorithm TEXT`, `status TEXT CHECK IN ('in_use','standby','previously_used','revoked')`, `public_jwk JSONB`, `private_jwk_secret_id UUID` (Vault), timestamps. Exactly one `in_use` row per project, enforced transactionally.

#### Log Drains (migration 016)

- **traffic.log_drains** — `id SERIAL PK`, `project_ref TEXT`, `token UUID UNIQUE`, `name TEXT`, `description TEXT`, `type TEXT`, `config JSONB`, `filters JSONB`, `active BOOLEAN`, timestamps, `deleted_at`. Partial unique index `(project_ref, name) WHERE deleted_at IS NULL`.

#### Content (migration 017)

- **traffic.content_folders** — `id UUID PK`, `project_ref TEXT`, `owner_id FK` (CASCADE), `parent_id UUID FK` (CASCADE), `name TEXT`, timestamps. Per-owner folder tree rooted at `parent_id IS NULL`.
- **traffic.content_items** — `id UUID PK`, `project_ref TEXT`, `owner_id FK` (CASCADE), `folder_id UUID FK` (SET NULL), `name TEXT`, `description TEXT`, `type TEXT CHECK IN ('sql','report','log_sql')`, `visibility TEXT CHECK IN ('user','project')`, `content JSONB`, `favorite BOOLEAN`, timestamps. `visibility='user'` is owner-only; `visibility='project'` is readable by any member of the project's organization.

#### Project Config + Lint Exceptions + `projects.sensitivity` (migration 018)

- **traffic.project_config** — `id SERIAL PK`, `project_ref TEXT UNIQUE`, `postgrest JSONB`, `storage JSONB`, `realtime JSONB`, `pgbouncer JSONB`, `secrets_rotation JSONB`, `updated_at`. Per-surface JSONB override shallow-merged with code-side defaults on read.
- **traffic.lint_exceptions** — `id SERIAL PK`, `project_ref TEXT`, `lint_name TEXT`, `disabled BOOLEAN`, `metadata JSONB`, timestamps, `UNIQUE(project_ref, lint_name)`.
- `ALTER TABLE traffic.projects ADD COLUMN sensitivity TEXT CHECK IN ('LOW','MEDIUM','HIGH','CRITICAL') DEFAULT 'MEDIUM'`.

#### Third-Party Auth + Secrets + `project_config.ssl_enforcement` (migration 019)

- **traffic.project_third_party_auth** — `id UUID PK`, `project_ref TEXT`, `type TEXT CHECK IN ('oidc','custom_jwks')`, `oidc_issuer_url TEXT`, `jwks_url TEXT`, `custom_jwks JSONB`, `resolved_jwks JSONB`, timestamps.
- **traffic.project_secrets** — `id SERIAL PK`, `project_ref TEXT`, `name TEXT`, `secret_id UUID` (Vault), timestamps, `UNIQUE(project_ref, name)`. Plaintext lives only in `vault.decrypted_secrets`.
- `ALTER TABLE traffic.project_config ADD COLUMN ssl_enforcement JSONB DEFAULT '{}'::jsonb`.

#### Branches + Custom Hostnames (migration 020)

- **traffic.branches** — `id UUID PK`, `project_ref TEXT`, `branch_name TEXT`, `parent_project_ref TEXT`, `is_default BOOLEAN`, `git_branch TEXT`, `status TEXT CHECK IN ('created','pushing','pushed','merged','revoked')`, `pr_number INTEGER`, timestamps, `merged_at`, `deleted_at`. Partial unique index `(project_ref, branch_name) WHERE deleted_at IS NULL` so soft-deleted names can be reused.
- **traffic.custom_hostnames** — `id SERIAL PK`, `project_ref TEXT UNIQUE`, `custom_hostname TEXT`, `status TEXT CHECK IN ('not_configured','pending','active','failed')`, `verification_errors JSONB`, `ownership_verified BOOLEAN`, `ssl_verified BOOLEAN`, timestamps. Activation/reverification are 501 on self-hosted; table is a mirror of user-entered config.
- **No `branch_refs` table.** Every branch attribute lives on `traffic.branches` directly.

#### JIT Policies + Grants (migration 021)

- **traffic.jit_policies** — `id SERIAL PK`, `project_ref TEXT UNIQUE`, `policy JSONB`, `updated_at`. Handler returns defaults when no row exists.
- **traffic.jit_grants** — `id SERIAL PK`, `project_ref TEXT`, `profile_id FK` (SET NULL), `username TEXT`, `password_secret_id UUID` (Vault), `scope TEXT`, `status TEXT CHECK IN ('active','pending','revoked','expired')`, `granted_at`, `expires_at`, `revoked_at`. `pending` status is used when the controlling connection lacks CREATEROLE (tests / restricted envs) — the grant row is persisted for the UI but no real PG role is materialized.

## Audit Logging

Audit log inserts are done in application code (not database triggers) so the function has full access to HTTP context (method, route, client IP, email). Every mutating operation wraps the table change and audit log insert in a single Postgres transaction.

**Action names** follow `<table_name>.<operation>`:

| Action                             | When                                                                 |
| ---------------------------------- | -------------------------------------------------------------------- |
| `profiles.insert`                  | Profile created (first login)                                        |
| `profiles.update`                  | Profile fields updated                                               |
| `access_tokens.insert`             | Access token created                                                 |
| `access_tokens.delete`             | Access token revoked                                                 |
| `scoped_access_tokens.insert`      | Scoped token created                                                 |
| `scoped_access_tokens.delete`      | Scoped token revoked                                                 |
| `organizations.insert`             | Organization created                                                 |
| `organizations.update`             | Organization name/billing_email updated                              |
| `organizations.delete`             | Organization deleted                                                 |
| `projects.insert`                  | Project created                                                      |
| `projects.update`                  | Project name updated                                                 |
| `projects.delete`                  | Project deleted                                                      |
| `projects.pause`                   | Project paused (status → INACTIVE)                                   |
| `projects.restore`                 | Project restored (status → ACTIVE_HEALTHY)                           |
| `projects.transfer`                | Project transferred to another org                                   |
| `organizations.mfa_update`         | MFA enforcement toggled                                              |
| `sso_providers.insert`             | SSO provider created                                                 |
| `sso_providers.update`             | SSO provider updated                                                 |
| `sso_providers.delete`             | SSO provider deleted                                                 |
| `organization_members.delete`      | Member removed from organization                                     |
| `organization_member_roles.insert` | Role assigned to member                                              |
| `organization_member_roles.update` | Member role updated (project scoping)                                |
| `organization_member_roles.delete` | Role unassigned from member                                          |
| `invitations.insert`               | Invitation created                                                   |
| `invitations.delete`               | Invitation deleted                                                   |
| `invitations.accept`               | Invitation accepted (member joined)                                  |
| `notifications.update`             | Notification status changed                                          |
| `notifications.archive_all`        | Every non-archived notification for the profile archived in one call |
| `account.login`                    | Login event recorded                                                 |
| `subscriptions.update`             | Subscription plan changed                                            |
| `customers.upsert`                 | Customer billing profile updated                                     |
| `tax_ids.insert`                   | Tax ID added                                                         |
| `tax_ids.delete`                   | Tax ID removed                                                       |
| `credits.redeem`                   | Credits redeemed                                                     |
| `credits.top_up`                   | Credits purchased                                                    |
| `upgrade_requests.insert`          | Upgrade request submitted                                            |

### Additional actions

The following additional actions are emitted by feature-specific services beyond the core profile / organization / project flows. Every action lives under one of four namespaces: `profile.*`, `project.*`, `auth_config.*`, or `schema_migrations.*`.

| Action                                | When                                                                                                                                                                                                   |
| ------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ |
| `profile.email_updated`               | `PUT /update-email` success                                                                                                                                                                            |
| `profile.feedback_submitted`          | `POST /feedback/send` success                                                                                                                                                                          |
| `profile.feedback_updated`            | `PATCH /feedback/conversations/{id}/custom-fields`                                                                                                                                                     |
| `auth_config.update`                  | `PATCH /api/platform/auth/{ref}/config`                                                                                                                                                                |
| `schema_migrations.insert`            | `POST /pg-meta/{ref}/migrations` applied a migration                                                                                                                                                   |
| `project.api_key_created`             | `POST /v1/projects/{ref}/api-keys` (publishable or secret)                                                                                                                                             |
| `project.api_key_updated`             | `PATCH /v1/projects/{ref}/api-keys/{id}`                                                                                                                                                               |
| `project.api_key_revoked`             | `DELETE /v1/projects/{ref}/api-keys/{id}` (soft-delete)                                                                                                                                                |
| `project.signing_key_rotated`         | `POST /v1/projects/{ref}/config/auth/signing-keys` and `POST /.../signing-keys/{id}/rotate` — both paths share the rotation code that moves `in_use → previously_used` and promotes `standby → in_use` |
| `project.signing_key_revoked`         | `DELETE /v1/projects/{ref}/config/auth/signing-keys/{id}`                                                                                                                                              |
| `project.log_drain_created`           | `POST /projects/{ref}/analytics/log-drains`                                                                                                                                                            |
| `project.log_drain_updated`           | `PUT /projects/{ref}/analytics/log-drains/{token}`                                                                                                                                                     |
| `project.log_drain_deleted`           | `DELETE /projects/{ref}/analytics/log-drains/{token}`                                                                                                                                                  |
| `project.content_folder_created`      | `POST /projects/{ref}/content/folders`                                                                                                                                                                 |
| `project.content_folder_updated`      | `PATCH /projects/{ref}/content/folders/{id}`                                                                                                                                                           |
| `project.content_folder_deleted`      | `DELETE /projects/{ref}/content/folders/{id}`                                                                                                                                                          |
| `project.content_created`             | `POST /projects/{ref}/content` (SQL / report / log-sql item)                                                                                                                                           |
| `project.content_updated`             | `PATCH /projects/{ref}/content/{id}` + bulk `PATCH /projects/{ref}/content`                                                                                                                            |
| `project.content_deleted`             | `DELETE /projects/{ref}/content/{id}`                                                                                                                                                                  |
| `project.config_updated`              | `PATCH /config/{postgrest,storage,realtime,pgbouncer,secrets}` + `PATCH /settings/sensitivity`                                                                                                         |
| `project.db_password_rotated`         | `POST /projects/{ref}/db-password`                                                                                                                                                                     |
| `project.branch_created`              | `POST /projects/{ref}/branches`                                                                                                                                                                        |
| `project.branch_updated`              | `PATCH /v1/branches/{id}` (fields listed in `target_metadata.keys`)                                                                                                                                    |
| `project.branch_pushed`               | `POST /v1/branches/{id}/push`                                                                                                                                                                          |
| `project.branch_merged`               | `POST /v1/branches/{id}/merge`                                                                                                                                                                         |
| `project.branch_reset`                | `POST /v1/branches/{id}/reset`                                                                                                                                                                         |
| `project.branch_restored`             | `POST /v1/branches/{id}/restore` (soft-delete reversal)                                                                                                                                                |
| `project.branch_deleted`              | `DELETE /v1/branches/{id}`                                                                                                                                                                             |
| `project.custom_hostname_initialized` | `POST /projects/{ref}/custom-hostname/initialize`                                                                                                                                                      |
| `project.jit_policy_updated`          | `PUT /projects/{ref}/jit-access` (policy JSON)                                                                                                                                                         |
| `project.jit_grant_issued`            | `PUT /projects/{ref}/database/jit` (real PG role created or `pending` fallback)                                                                                                                        |
| `project.jit_grant_revoked`           | `DELETE /projects/{ref}/database/jit/{id}` (or `cleanupExpiredGrants` tick)                                                                                                                            |
| `project.third_party_auth_added`      | `POST /projects/{ref}/config/auth/third-party-auth`                                                                                                                                                    |
| `project.third_party_auth_removed`    | `DELETE /projects/{ref}/config/auth/third-party-auth/{id}`                                                                                                                                             |
| `project.ssl_enforcement_updated`     | `PUT /projects/{ref}/ssl-enforcement`                                                                                                                                                                  |
| `project.secret_set`                  | `POST /projects/{ref}/secrets`                                                                                                                                                                         |
| `project.secret_deleted`              | `DELETE /projects/{ref}/secrets`                                                                                                                                                                       |
| `project.edge_function_deployed`      | `POST /v1/projects/{ref}/functions/deploy`                                                                                                                                                             |
| `project.edge_function_updated`       | `PATCH /v1/projects/{ref}/functions/{slug}`                                                                                                                                                            |
| `project.edge_function_deleted`       | `DELETE /v1/projects/{ref}/functions/{slug}`                                                                                                                                                           |

Enumerate the shipped action set at any point via:

```
rg "'(profile|project|auth_config|schema_migrations)\\.[a-z_]+'" traffic-one/functions
```

If the audit insert fails, the entire transaction rolls back.

## Permissions

The permission service (`permission.service.ts`) queries `traffic.organization_members` joined with `traffic.organizations` to return one wildcard permission entry per organization the user belongs to. Each entry grants `actions: ["%"]` and `resources: ["%"]` for the corresponding `organization_slug`. If the user has no organizations, a fallback "default" slug is returned for backwards compatibility.

## Authorization Rules (Members)

| Operation                          | Required Role                                     |
| ---------------------------------- | ------------------------------------------------- |
| List members / invitations / roles | Any org member                                    |
| Create invitation                  | Owner or Administrator (role_id ≥ 4)              |
| Delete invitation                  | Owner or Administrator                            |
| Accept invitation                  | Any authenticated user (token validation)         |
| Delete member                      | Owner or Administrator (cannot remove last owner) |
| Assign / update / unassign role    | Owner or Administrator (cannot demote last owner) |
| MFA enforcement toggle             | Owner or Administrator                            |

Authorization is checked via `getMemberHighestRoleId()` which returns the maximum `role_id` from `organization_member_roles` for the acting user.

## Files Changed (Outside traffic-one/)

See [§ Studio Patch Strategy](#studio-patch-strategy) for why some Studio changes are committed to source while others are mounted as volume overlays.

### Studio source (committed)

- `apps/studio/components/interfaces/Auth/Hooks/HooksListing.tsx` — guard `CreateHookSheet` against undefined `authConfig` (defensive null-check; upstream-worthy correctness fix).
- `apps/studio/components/interfaces/SQLEditor/UtilityPanel/UtilityPanel.tsx` — null-safety on `payload` / `payload.content` and `snippet?.name` (defensive null-check).
- `apps/studio/components/interfaces/Settings/Database/PoolingModesModal.tsx` — `Array.isArray` guard before `.find()` on the pooling modes list (defensive null-check).
- `apps/studio/lib/api/incident-banner.ts` — return `[]` instead of throwing when `INCIDENT_IO_API_KEY` is unset (self-hosted gate).
- `apps/studio/lib/api/self-hosted/util.ts` — allow self-hosted operation when `IS_PLATFORM && PLATFORM_PG_META_URL` is set (self-hosted-platform gate).
- `apps/studio/proxy.ts` — early-return from the cloud proxy when `NEXT_PUBLIC_SELF_HOSTED_PLATFORM === 'true'` (self-hosted-platform gate).

### Docker / Kong / env (committed)

- `docker/docker-compose.yml` — Postgres image bumped to `supabase/postgres:17.6.1.084`; Studio healthcheck URL retargeted to `http://localhost:8082/api/platform/profile` because the prebuilt `supabase/studio:2026.04.08-sha-205cbe7` image runs `next dev` on port 8082 (see `apps/studio/package.json`).
- `docker/docker-compose.platform.yml` — platform overlay. For `studio`: volume mounts for `traffic-one/studio-patches/*`, volume mounts for the three `apps/studio/*` module files patched above, `mem_limit`, healthcheck disable, `HOSTNAME: "::"`, `STUDIO_PORT: 3000`, and `NEXT_PUBLIC_*` platform env. For `functions`: `TRAFFIC_DB_URL`, `LOGFLARE_URL`, `LOGFLARE_PRIVATE_ACCESS_TOKEN`, `POOLER_TENANT_ID`, `POOLER_DEFAULT_POOL_SIZE`, `POOLER_MAX_CLIENT_CONN`, `POOLER_PROXY_PORT_TRANSACTION`, `POSTGRES_PORT`.
- `docker/volumes/api/kong.yml` — open auth routes (`/auth/v1/{token,user,logout,signup,recover}`; see [§ Kong Open Auth Routes](#kong-open-auth-routes)) plus the `platform-profile` / `platform-signup` / `platform-reset-password` / `platform-organizations` services + routes inserted before the dashboard catch-all.
- `docker/.env.example` — `TRAFFIC_API_PASSWORD` variable (harmless in non-platform mode since nothing else references it in the base compose file).

### Auto-generated (git-ignored)

- `docker/volumes/functions/traffic-one/` — regenerated by `traffic-one/deploy.sh` (via `cp -r`) from `traffic-one/functions/`. Not tracked in git; see `.gitignore`.

## Studio Patch Strategy

Studio is delivered to self-hosted platform mode using two complementary mechanisms. The choice for any given patch is dictated by whether the target file is a plain `.ts` module that Next.js can re-bundle at request time or a `.tsx` component / build-time file that must be present in the image when it boots.

### 1. Volume overlays (preferred, ephemeral)

For `.ts` library files whose changes need to travel with the platform layer rather than a fork of Studio, `docker-compose.platform.yml` bind-mounts replacement files into the running container. These overlays are read by the in-container `next dev` server the first time the module is requested and re-read on edit.

| Host path                                  | Container path                                 | Purpose                                                                                                                                                                                                             |
| ------------------------------------------ | ---------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `traffic-one/studio-patches/gotrue.ts`     | `/app/packages/common/gotrue.ts`               | Replace the shared `AuthClient` constructor so Studio talks directly to GoTrue via `NEXT_PUBLIC_GOTRUE_URL` without forwarding the dashboard apikey (pairs with [§ Kong Open Auth Routes](#kong-open-auth-routes)). |
| `traffic-one/studio-patches/apiHelpers.ts` | `/app/apps/studio/lib/api/apiHelpers.ts`       | Strip the `x-connection-encrypted` header in self-hosted platform mode so `pg-meta` falls back to its default `PG_CONNECTION`.                                                                                      |
| `traffic-one/studio-patches/.env.local`    | `/app/apps/studio/.env.local`                  | Inject platform-mode env values that Next.js reads at dev-server startup.                                                                                                                                           |
| `apps/studio/lib/api/incident-banner.ts`   | `/app/apps/studio/lib/api/incident-banner.ts`  | Same file as the committed source edit; mounted read-only so platform-mode containers pick up the committed version of the file instead of whatever version shipped with the image.                                 |
| `apps/studio/proxy.ts`                     | `/app/apps/studio/proxy.ts`                    | Same rationale as `incident-banner.ts`.                                                                                                                                                                             |
| `apps/studio/lib/api/self-hosted/util.ts`  | `/app/apps/studio/lib/api/self-hosted/util.ts` | Same rationale as above.                                                                                                                                                                                            |

### 2. Source modifications (permanent)

For `.tsx` React components and any file that must be baked into the image at build time, the change is committed to `apps/studio/*` so that a future Studio rebuild preserves the fix. These are the committed Studio edits listed in [§ Files Changed (Outside traffic-one/)](#files-changed-outside-traffic-one). Three of them (`incident-banner.ts`, `proxy.ts`, `self-hosted/util.ts`) are _also_ mounted as read-only overlays by `docker-compose.platform.yml` so that the currently pinned `supabase/studio` image — which was built before these fixes existed — picks them up at runtime without waiting for a rebuild.

### Dev-mode assumption

The whole strategy rests on the prebuilt `supabase/studio:2026.04.08-sha-205cbe7` image running Next.js in **dev mode** (`next dev -p 8082`), where modules are re-bundled on demand from the mounted `.ts` files. If that image (or a replacement) is ever switched to a production build (`next start` against a prebaked `.next/`), the bind mounts in `docker-compose.platform.yml` will silently have no effect — the bundled JavaScript in the image will be served instead. Upgrading the pinned image tag therefore requires re-validating that it still runs `next dev`, or migrating every overlay into the source tree and rebuilding the image from this repo.

## Environment Variables

All variables below are read via `Deno.env.get("…")` inside the `functions/` runtime. The list was enumerated against the shipped code (not earlier planning docs), so nothing phantom — `GOTRUE_ADMIN_URL`, `VAULT_URL`, `VAULT_TOKEN` — is listed. Project-secret encryption uses the **Postgres Vault extension** (`vault.create_secret` / `vault.decrypted_secrets`), not an HTTP Vault.

### Core

| Variable                                             | Required | Description                                                                                                                           |
| ---------------------------------------------------- | -------- | ------------------------------------------------------------------------------------------------------------------------------------- |
| `SUPABASE_URL`                                       | Yes      | Base URL of the Supabase stack used by the supabase-js client inside `traffic-one`.                                                   |
| `SUPABASE_ANON_KEY`                                  | Yes      | Anon key; supabase-js auth calls.                                                                                                     |
| `SUPABASE_SERVICE_KEY` / `SUPABASE_SERVICE_ROLE_KEY` | Yes      | Service-role key for privileged supabase-js calls (legacy + canonical name, both accepted).                                           |
| `SUPABASE_SECRET_KEY`                                | No       | Optional secret key used when signing "secret" project API keys; falls back to the service key.                                       |
| `TRAFFIC_DB_URL` / `SUPABASE_DB_URL`                 | Yes      | Direct Postgres DSN used by `traffic_api` role connection pool. Two names for backwards compat.                                       |
| `JWT_SECRET`                                         | Yes      | GoTrue shared HS256 secret. Used by `services/gotrue-admin.service.ts` to mint the service-role JWT it sends to the GoTrue admin API. |

### GoTrue admin proxy

Read opportunistically by `gotrue-admin.service.ts`. Env values act as defaults when `traffic.auth_config_overrides` has no row and the live GoTrue `/admin/settings` fetch is empty or fails.

| Variable                       | Purpose                                                                                         |
| ------------------------------ | ----------------------------------------------------------------------------------------------- |
| `GOTRUE_URL`                   | Base URL of the GoTrue admin HTTP API (e.g. `http://auth:9999`).                                |
| `SITE_URL`, `API_EXTERNAL_URL` | URL config defaults.                                                                            |
| `MAILER_*`, `SMTP_*`           | Mailer/SMTP defaults exposed to Studio's auth config UI.                                        |
| `EXTERNAL_*`                   | Per-provider OAuth defaults (e.g. `EXTERNAL_GOOGLE_ENABLED`, `EXTERNAL_GOOGLE_CLIENT_ID`, ...). |
| `MAILER_TEMPLATES_*`           | Template URL overrides (confirmation, recovery, magic-link, invite, email-change).              |
| `RATE_LIMIT_*`                 | GoTrue rate-limit knobs surfaced as read-only defaults.                                         |
| Every other `GOTRUE_*`         | Any additional GoTrue env var is forwarded transparently to the merge.                          |

### Analytics / log drains

| Variable                        | Required | Description                                                    |
| ------------------------------- | -------- | -------------------------------------------------------------- |
| `LOGFLARE_URL`                  | Yes      | Logflare analytics endpoint (default: `http://analytics:4000`) |
| `LOGFLARE_PRIVATE_ACCESS_TOKEN` | Yes      | Private access token for Logflare SQL queries                  |

### Types / pg-meta

| Variable      | Required | Description                                                                                               |
| ------------- | -------- | --------------------------------------------------------------------------------------------------------- |
| `PG_META_URL` | Yes      | Internal base URL of `pg-meta` used by `GET /v1/projects/{ref}/types/typescript` and `/extensions` et al. |

### Disk / versions

| Variable                     | Required | Description                                                               |
| ---------------------------- | -------- | ------------------------------------------------------------------------- |
| `LOCAL_DISK_SIZE_GB`         | No       | Value returned by `GET /projects/{ref}/disk` for `size_gb` (default `8`). |
| `LOCAL_DISK_TYPE`            | No       | Value returned for `type` (default `gp3`).                                |
| `LOCAL_DISK_IOPS`            | No       | Value returned for `iops` (default `3000`).                               |
| `LOCAL_DISK_THROUGHPUT_MBPS` | No       | Value returned for `throughput_mbps` (default `125`).                     |
| `POSTGRES_VERSION`           | No       | Shown under `GET /projects/{ref}/restore/versions` (default `15`).        |

### JIT

| Variable            | Required | Description                                                                       |
| ------------------- | -------- | --------------------------------------------------------------------------------- |
| `POSTGRES_HOST`     | Yes      | Host for the controlling Postgres connection used to `CREATE ROLE` / `DROP ROLE`. |
| `POSTGRES_PORT`     | Yes      | Port.                                                                             |
| `POSTGRES_USER`     | Yes      | Superuser-capable username (needs `CREATEROLE`).                                  |
| `POSTGRES_PASSWORD` | Yes      | Superuser password.                                                               |
| `POSTGRES_DB`       | Yes      | Target database name (also reused by the pgbouncer config handler).               |

If the controlling role cannot `CREATEROLE`, `jit.service.ts` falls back to `status='pending'` grants (row persists, no real PG role).

**Operator note — Postgres log redaction.** `createPostgresRole()` in [`services/jit.service.ts`](functions/services/jit.service.ts) issues `SET LOCAL log_statement = 'none'` inside its own transaction before running `CREATE ROLE` / `ALTER ROLE … PASSWORD`. That suppresses the DDL body so JIT passwords don't land in `postgresql.log` even when the cluster runs `log_statement = 'ddl'` or `'all'`. Operators running alongside external audit tooling that captures DDL outside the session (e.g. `pgaudit`) must still ensure those sinks are redacted or disabled for this function's session. Passwords fed into `createPostgresRole` are **server-generated only** (see `generatePassword()` in the same file); never interpolate user-supplied input into that code path.

### Pooler (reported by `GET /projects/{ref}/config/pgbouncer`)

| Variable                        | Required | Description                           |
| ------------------------------- | -------- | ------------------------------------- |
| `POOLER_TENANT_ID`              | Yes      | Supavisor tenant ID.                  |
| `POOLER_DEFAULT_POOL_SIZE`      | Yes      | Default pool size reported to Studio. |
| `POOLER_MAX_CLIENT_CONN`        | Yes      | Max client connections.               |
| `POOLER_PROXY_PORT_TRANSACTION` | Yes      | Transaction-mode proxy port.          |

### Provisioner

| Variable               | Required | Description                                                                                                       |
| ---------------------- | -------- | ----------------------------------------------------------------------------------------------------------------- |
| `PROJECT_PROVISIONER`  | No       | `local` (default) or `api`. Controls whether project creation runs locally or calls an external HTTP provisioner. |
| `PROVISIONER_API_URL`  | If `api` | Base URL of the external provisioner.                                                                             |
| `DEFAULT_PROJECT_NAME` | No       | Human-friendly default name surfaced in the CreateProjectResponse.                                                |

### Billing

| Variable                        | Required | Description                                                                                 |
| ------------------------------- | -------- | ------------------------------------------------------------------------------------------- |
| `STRIPE_API_KEY`                | No       | Stripe secret key. If not set, billing works in local-only mode (DB-backed, no Stripe sync) |
| `STRIPE_WEBHOOK_SIGNING_SECRET` | No       | Stripe webhook endpoint signing secret for verifying webhook events                         |

## Self-hosted limitations

The following endpoints are intentionally unimplemented in self-hosted mode and return `501 { code: "self_hosted_unsupported", message: "…" }`. Studio surfaces the `code` so the UI can render a helpful "not available in self-hosted" banner instead of a generic failure.

| Endpoint                                                           | Reason                                                                                                                 |
| ------------------------------------------------------------------ | ---------------------------------------------------------------------------------------------------------------------- |
| `POST /api/platform/projects/{ref}/resize`                         | No block-device orchestration in self-hosted.                                                                          |
| `POST /api/platform/projects/{ref}/read-replicas/setup`            | No replica provisioning.                                                                                               |
| `POST /api/platform/projects/{ref}/read-replicas/remove`           | No replica provisioning.                                                                                               |
| `POST /api/v1/projects/{ref}/network-restrictions/apply`           | No WAF/firewall integration.                                                                                           |
| `POST /api/platform/projects/{ref}/privatelink/associations/*`     | No VPC peering in self-hosted.                                                                                         |
| `DELETE /api/platform/projects/{ref}/privatelink/associations/*`   | No VPC peering in self-hosted.                                                                                         |
| `POST /api/platform/cloud-marketplace/link`                        | Self-hosted is not sold through cloud marketplaces.                                                                    |
| `POST /api/platform/organizations/{slug}/documents/dpa`            | No DPA document generation.                                                                                            |
| `POST /api/platform/projects/{ref}/claim`                          | No cross-org project-transfer marketplace in self-hosted (ownership is implied by membership).                         |
| `POST /api/v1/projects/{ref}/custom-hostname/activate`             | No DNS control in self-hosted.                                                                                         |
| `POST /api/v1/projects/{ref}/custom-hostname/reverify`             | No DNS control in self-hosted.                                                                                         |
| `POST /api/platform/database/{ref}/backups/restore`                | No off-cluster PITR scaffolding.                                                                                       |
| `POST /api/platform/database/{ref}/backups/pitr`                   | No off-cluster PITR scaffolding.                                                                                       |
| `POST /api/platform/replication/{ref}/*` (writes)                  | Replication read-model only.                                                                                           |
| `POST /api/v1/projects/{ref}/upgrade`                              | No in-place Postgres upgrade scaffolding.                                                                              |
| `PUT /api/platform/projects/{ref}/api-keys/legacy`                 | Rotating the legacy `anon` / `service_role` keys requires restarting the stack with new env vars, not a runtime write. |
| `POST /api/platform/projects/{ref}/jwt-signing-keys/legacy/rotate` | Rotating the legacy HS256 `JWT_SECRET` requires restarting GoTrue with a new env var, not a runtime write.             |

Additionally, Stripe provisioning / reconciliation, Vercel integration, and Partners integration remain deferred (see [§ Known Gaps / Remaining Work](#known-gaps--remaining-work)).

`GET /v1/branches/{id}/diff` returns an **empty-stub** shape (`{ diff: '', paths: [] }`). Computing a real diff would require a background `pg_dump` worker comparing branch + parent project schemas; this is intentionally not in-scope for self-hosted and is documented in [`traffic-one/tests/branches-test.ts`](tests/branches-test.ts) via the `empty-stub` assertion on that endpoint.

## Invariants

- Studio source is patched only for (a) defensive null-checks that are upstream-worthy correctness fixes and (b) self-hosted-platform-mode gates; every patched file is enumerated in [§ Files Changed (Outside traffic-one/)](#files-changed-outside-traffic-one). For the split between source edits and volume overlays, see [§ Studio Patch Strategy](#studio-patch-strategy).
- All response shapes match `packages/api-types/types/platform.d.ts`
- The dashboard catch-all route in Kong continues to work
- `VERIFY_JWT` remains `false`; the function handles auth itself
- Existing edge functions (`hello`, etc.) are unaffected

## Known Gaps / Remaining Work

The remaining gaps below are tracked for future work.

### Intentional behavior notes

- **Downloadable-backups shape.** `GET /api/platform/database/{ref}/backups/downloadable` returns `{ backups: [], status: "ok" }`. This wrapped shape matches `packages/api-types/types/platform.d.ts` and is what Studio's React Query hook destructures.
- **CLI login token storage.** CLI-login handshake tokens are stored in `traffic.scoped_access_tokens` and surfaced via [`routes/cli.ts`](functions/routes/cli.ts) / [`tests/cli-test.ts`](tests/cli-test.ts).
- **Branch diff is an empty stub.** `GET /v1/branches/{id}/diff` returns `{ diff: '', paths: [] }`. A real implementation would need an out-of-band `pg_dump` worker comparing the branch against the parent schema, which is out of scope for self-hosted. Covered by an `empty-stub` assertion in [`tests/branches-test.ts`](tests/branches-test.ts).

### High severity

- **Vercel / Partners / Stripe provisioning** is deferred. `provisioner.service.ts` ships with a `local` + `api` strategy only; cloud provisioners are **not** wired up and every Stripe-backed flow degrades to the DB-only path when `STRIPE_API_KEY` is unset. Cohort landing: `routes/provisioner.ts` + `services/partners.service.ts` + a Stripe webhook reconciler.

### Medium severity

- **Live GoTrue reconfigure is best-effort only.** `PATCH /api/platform/auth/{ref}/config` forwards to `POST {GOTRUE_URL}/admin/config` but self-hosted GoTrue only accepts a subset of fields at runtime (the rest need an env-variable change + container restart). Fields that GoTrue rejects or silently ignores persist in `traffic.auth_config_overrides` so Studio's read view stays consistent, but the running auth server keeps its boot-time config until the operator restarts it. Surfaced in [`services/gotrue-admin.service.ts`](functions/services/gotrue-admin.service.ts) with the same trade-off.
- **`REALTIME_PEAK_CONNECTIONS` metric reports `0` in self-hosted daily usage.** Peak-concurrent-connections is derived from connection/disconnection events on hosted Supabase. Self-hosted Logflare does not capture those events, so [`services/usage.service.ts#getOrgDailyUsage`](functions/services/usage.service.ts) intentionally emits `usage: 0` for every day instead of running a misleading proxy query. The metric key is still present in the daily-usage feed so Studio's chart renders — it just always flat-lines.
- **Sign-in SSR hydration mismatch in `LastSignInWrapper`** — Next.js dev overlay surfaces "Text content does not match server-rendered HTML" on `/sign-in`. The login form still works but the overlay must be dismissed. Fix lives in Studio source (`apps/studio/components/.../LastSignInWrapper.tsx`), not traffic-one.

### Low severity

- **TanStack Query DevTools button visible in platform mode** — the "Open TanStack query devtools" button renders in the bottom-left corner on every page. Fix: gate the devtools mount on `NEXT_PUBLIC_IS_PLATFORM !== 'true'` or a dedicated env flag in Studio source.
- **Studio healthcheck port asymmetry** (also noted under [§ Routing](#routing)) — base `docker/docker-compose.yml` healthcheck probes `localhost:8082`, which only matches a Studio build running `next dev` / `next start` on port 8082. Non-platform self-hosted users whose Studio binary listens on 3000 will see the healthcheck fail; platform mode disables the healthcheck entirely so is unaffected.

## Verification

Re-run these from the repo root whenever you change shipped behaviour to confirm the docs above still match reality.

```bash
rg "'(profile|project|auth_config|schema_migrations)\.[a-z_]+'" traffic-one/functions
```

Enumerate the audit-log action names actually emitted by the function code. The output should match the union of [§ Audit Logging](#audit-logging) and [§ Additional actions](#additional-actions).

```bash
rg "Deno\.env\.get\(" traffic-one/functions
```

Enumerate every environment variable read by the function runtime. Cross-check the output against [§ Environment Variables](#environment-variables); any variable that appears here and is missing from the doc needs to be added, and anything documented but not matched is stale.

```bash
ls traffic-one/migrations/
```

Diff the migration filename list against [§ Tables](#tables). Each numbered migration must have a corresponding `#### ... (migration NNN)` subsection; absence of one or the other is a doc/schema drift signal.
