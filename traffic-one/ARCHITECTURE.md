# Architecture

## Overview

```mermaid
flowchart LR
    Browser["Studio (Next.js dev)"]
    Kong["Kong 3.9.1<br/>docker/volumes/api/kong.yml"]
    Traffic["traffic-one<br/>functions/index.ts"]
    Resolver["getProjectBackend(ref)<br/>services/project-backend.service.ts"]
    GoTrue["GoTrue (per-project /auth/v1/admin/*)"]
    PG[("Postgres<br/>traffic.*")]
    Vault[("Postgres Vault<br/>vault.decrypted_secrets")]
    ProjectDB[("Project Postgres<br/>backend.connectionString")]
    PgMeta["pg-meta (per-project)<br/>backend.pgMetaUrl"]
    Logflare["Logflare (per-project)<br/>backend.logflareUrl"]
    FnAdmin["Edge Functions admin<br/>backend.functionsApiUrl"]
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
    Browser -->|"/api/platform/auth/{ref}/**"| Kong
    Browser -->|"/api/platform/pg-meta/{ref}/**"| Kong

    Kong -->|"strip_path: true<br/>(platform/* + v1/* majority)<br/>→ functions:9000/traffic-one/{rest}"| Traffic
    Kong -->|"strip_path: false<br/>(platform/auth + platform/pg-meta)<br/>→ functions:9000/traffic-one/api/platform/{auth,pg-meta}/{rest}"| Traffic
    Traffic -->|supabase.auth.getUser| GoTrue
    Traffic -->|traffic_api role + audit| PG
    Traffic -->|resolve per-project URLs + keys| Resolver
    Resolver -->|SELECT traffic.projects ⋈ vault.decrypted_secrets| PG
    Resolver --> Vault
    Traffic -->|/auth/v1/admin/* (config + users/invite/...)| GoTrue
    Traffic -->|/query, /tables, /types, /generators/typescript, ...| PgMeta
    Traffic -->|analytics SQL, usage SQL, log-drain tail| Logflare
    Traffic -->|api mode: /_deploy, /_meta/*| FnAdmin
    Traffic -->|shared-stack: {slug}/index.ts + .meta.json| Functions
    Traffic -->|one-shot Pool: CREATE/DROP ROLE, ALTER ROLE| ProjectDB
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

| Route group                                                   | Route file                                                                                                               | Kong paths                                                                                                                                                             | Mutates                                                                                                                                                                                                                                                                                                                           | Audit actions                                                                                                                                      |
| ------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------ | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------- | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | -------------------------------------------------------------------------------------------------------------------------------------------------- |
| **Profile / update-email**                                    | [`routes/profile.ts`](functions/routes/profile.ts), [`routes/update-email.ts`](functions/routes/update-email.ts)         | `/api/platform/profile*`, `/api/platform/update-email`                                                                                                                 | `traffic.profiles`, `auth.users.email` via GoTrue admin                                                                                                                                                                                                                                                                           | `profile.email_updated`                                                                                                                            |
| **Notifications**                                             | [`routes/notifications.ts`](functions/routes/notifications.ts)                                                           | `/api/platform/notifications*`                                                                                                                                         | `traffic.notifications`                                                                                                                                                                                                                                                                                                           | `notifications.update`                                                                                                                             |
| **GoTrue config**                                             | [`routes/auth-config.ts`](functions/routes/auth-config.ts)                                                               | `/api/platform/auth/{ref}/config[/hooks]`                                                                                                                              | `traffic.auth_config_overrides` + (opportunistically) `{backend.endpoint}/auth/v1/admin/config`                                                                                                                                                                                                                                   | `auth_config.update`                                                                                                                               |
| **GoTrue admin proxy**                                        | [`routes/project-auth-admin.ts`](functions/routes/project-auth-admin.ts)                                                 | `/api/platform/auth/{ref}/(users*\|invite\|magiclink\|recover\|otp\|validate/spam\|users/{id}/factors)`                                                                | Forwards to `{backend.endpoint}/auth/v1/admin/*` using `backend.serviceKey`                                                                                                                                                                                                                                                       | `auth_admin.user_{create,update,delete}`, `auth_admin.mfa_factors_delete`, `auth_admin.{invite,magiclink,recover,otp}`, `auth_admin.validate_spam` |
| **pg-meta proxy**                                             | [`routes/project-pg-meta.ts`](functions/routes/project-pg-meta.ts)                                                       | `/api/platform/pg-meta/{ref}/(query\|tables\|triggers\|types\|policies\|extensions\|foreign-tables\|materialized-views\|views\|column-privileges\|publications)`       | Forwards to `{backend.pgMetaUrl}/*` using `backend.serviceKey`                                                                                                                                                                                                                                                                    | `project.pg_meta.query` (emitted for every `POST /{ref}/query` regardless of upstream outcome)                                                     |
| **Backups**                                                   | [`routes/backups.ts`](functions/routes/backups.ts)                                                                       | `/api/platform/database/*/backups*`                                                                                                                                    | read-only + 501 for restore/PITR                                                                                                                                                                                                                                                                                                  | —                                                                                                                                                  |
| **Replication**                                               | [`routes/replication.ts`](functions/routes/replication.ts)                                                               | `/api/platform/replication/*`                                                                                                                                          | read-only stub (empty arrays); 501 for writes                                                                                                                                                                                                                                                                                     | —                                                                                                                                                  |
| **Analytics / log drains / infra-monitoring**                 | [`routes/project-analytics.ts`](functions/routes/project-analytics.ts)                                                   | `/api/platform/projects/{ref}/(analytics\|infra-monitoring\|api/(rest\|graphql))*`                                                                                     | `traffic.log_drains`                                                                                                                                                                                                                                                                                                              | `project.log_drain_{created,updated,deleted}`                                                                                                      |
| **Database migrations**                                       | [`routes/database-migrations.ts`](functions/routes/database-migrations.ts)                                               | `/api/v1/projects/{ref}/database/migrations` (GET + POST; via `v1-projects-health` Kong service, NOT the pg-meta proxy)                                                | `traffic.schema_migrations`                                                                                                                                                                                                                                                                                                       | `schema_migrations.insert`                                                                                                                         |
| **Feedback**                                                  | [`routes/feedback.ts`](functions/routes/feedback.ts)                                                                     | `/api/platform/feedback/*`                                                                                                                                             | `traffic.feedback`                                                                                                                                                                                                                                                                                                                | `profile.feedback_submitted`, `profile.feedback_updated`                                                                                           |
| **CLI**                                                       | [`routes/cli.ts`](functions/routes/cli.ts)                                                                               | `/api/platform/cli/*`                                                                                                                                                  | `traffic.scoped_access_tokens`                                                                                                                                                                                                                                                                                                    | `scoped_access_tokens.insert`                                                                                                                      |
| **Project config + lint exceptions + DB password rotation**   | [`routes/project-config.ts`](functions/routes/project-config.ts)                                                         | `/api/platform/projects/{ref}/config/(postgrest\|storage\|realtime\|pgbouncer\|secrets)`, `/settings/sensitivity`, `/db-password`, `/notifications/advisor/exceptions` | `traffic.project_config`, `traffic.lint_exceptions`, `traffic.projects.sensitivity`                                                                                                                                                                                                                                               | `project.config_updated`, `project.db_password_rotated`                                                                                            |
| **Disk / resize / regions / restore-versions**                | [`routes/project-disk.ts`](functions/routes/project-disk.ts)                                                             | `/api/platform/projects/{ref}/(disk\|resize\|restore/versions)`, `/api/platform/projects/available-regions`                                                            | read-only; 501 for `/resize` and `POST /disk*`                                                                                                                                                                                                                                                                                    | —                                                                                                                                                  |
| **Project network + read-replicas + privatelink**             | [`routes/project-network.ts`](functions/routes/project-network.ts)                                                       | `/api/v1/projects/{ref}/(network-restrictions\|network-bans\|read-replicas)`, `/api/platform/projects/{ref}/privatelink/*`                                             | stubs; 501 for mutations                                                                                                                                                                                                                                                                                                          | —                                                                                                                                                  |
| **Project lifecycle (upgrade, types, readonly, actions)**     | [`routes/project-lifecycle.ts`](functions/routes/project-lifecycle.ts)                                                   | `/api/v1/projects/{ref}/(upgrade*\|types/typescript\|readonly/temporary-disable\|actions*)`                                                                            | read-only or 501                                                                                                                                                                                                                                                                                                                  | —                                                                                                                                                  |
| **Project auth (third-party-auth, SSL enforcement, secrets)** | [`routes/project-auth.ts`](functions/routes/project-auth.ts)                                                             | `/api/v1/projects/{ref}/(config/auth/third-party-auth*\|ssl-enforcement\|secrets)`                                                                                     | `traffic.project_third_party_auth`, `traffic.project_secrets` (Vault-encrypted), `project_config.ssl_enforcement` column                                                                                                                                                                                                          | `project.third_party_auth_{added,removed}`, `project.ssl_enforcement_updated`, `project.secret_set`, `project.secret_deleted`                      |
| **Project API keys + signing keys**                           | [`routes/project-api-keys.ts`](functions/routes/project-api-keys.ts)                                                     | `/api/v1/projects/{ref}/(api-keys*\|config/auth/signing-keys*)`                                                                                                        | `traffic.project_api_keys`, `traffic.project_jwt_signing_keys`                                                                                                                                                                                                                                                                    | `project.api_key_{created,updated,revoked}`, `project.signing_key_{rotated,revoked}`                                                               |
| **Content (snippets + folders)**                              | [`routes/content.ts`](functions/routes/content.ts)                                                                       | `/api/platform/projects/{ref}/content*`                                                                                                                                | `traffic.content_items`, `traffic.content_folders`                                                                                                                                                                                                                                                                                | `project.content_{created,updated,deleted}`, `project.content_folder_{created,updated,deleted}`                                                    |
| **Branches + custom hostnames**                               | [`routes/branches.ts`](functions/routes/branches.ts), [`routes/custom-hostname.ts`](functions/routes/custom-hostname.ts) | `/api/v1/(projects/{ref}/branches*\|branches/*)`, `/api/v1/projects/{ref}/custom-hostname*`                                                                            | `traffic.branches`, `traffic.custom_hostnames`                                                                                                                                                                                                                                                                                    | `project.branch_{created,updated,pushed,merged,reset,restored,deleted}`, `project.custom_hostname_initialized`                                     |
| **Edge function mutations**                                   | [`routes/edge-function-mutations.ts`](functions/routes/edge-function-mutations.ts)                                       | `/api/v1/projects/{ref}/functions/(deploy\|{slug})` (POST/PATCH/DELETE)                                                                                                | **shared-stack** (`isSharedStack(backend)`): filesystem writes into `/home/deno/functions/{slug}/` (writable bind-mount) + `.meta.json`. **api mode**: `POST {functionsApiUrl}/_deploy`, `PATCH/DELETE {functionsApiUrl}/_meta/{slug}` (see [§ Edge function deploy HTTP contract](#edge-function-deploy-http-contract-api-mode)) | `project.edge_function_{deployed,updated,deleted}`                                                                                                 |
| **JIT (just-in-time database access)**                        | [`routes/jit.ts`](functions/routes/jit.ts)                                                                               | `/api/v1/projects/{ref}/(jit-access\|database/jit*)`                                                                                                                   | `traffic.jit_policies`, `traffic.jit_grants` + real Postgres roles via superuser pool                                                                                                                                                                                                                                             | `project.jit_policy_updated`, `project.jit_grant_{issued,revoked}`                                                                                 |

**GoTrue admin proxy semantics.** `GET /config` and `GET /config/hooks` return a three-layer merge: env-derived defaults ← (optional) live `GET {backend.endpoint}/auth/v1/admin/settings` ← `traffic.auth_config_overrides`. `PATCH /config` forwards the patch to `POST {backend.endpoint}/auth/v1/admin/config`; fields GoTrue accepts propagate live and any rejected fields fall through to the overrides table so Studio's view remains consistent even on self-hosted GoTrue builds that don't expose live mutation. All outbound calls are signed with `backend.serviceKey` (resolved via `getProjectBackend(ref)` — no global `GOTRUE_URL` / `JWT_SECRET` read). User / invite / magiclink / recover / otp / factor operations live on a sibling handler ([`routes/project-auth-admin.ts`](functions/routes/project-auth-admin.ts)); see the GoTrue admin proxy row in the route table above and [§ Project-backend dispatch](#project-backend-dispatch).

**Logflare fallback.** When Logflare's SQL endpoint is unreachable, `logflare.client.ts` returns `{ result: [] }` so `GET /projects/{ref}/analytics/endpoints/logs.*` never 5xxs. Studio's chart renders an empty timeseries instead of a Suspense error.

**Edge function deploy filesystem contract.** The `functions` container must mount `/home/deno/functions` as a **writable** bind-mount shared with the `traffic-one` worker. Multipart-body deploys write `{slug}/index.ts` + `.meta.json` atomically; delete is `Deno.remove(dir, { recursive: true })`. **There is no live reload** — newly-written files are picked up on the next cold start of the function slug (see `edge-function-mutations.ts:351-356`).

### Edge function deploy HTTP contract (api mode)

When `!isSharedStack(backend)` the traffic-one dispatcher proxies every mutation to `${backend.functionsApiUrl}`. The external runtime MUST expose this admin surface, signed with the project `service_role` key via `Authorization: Bearer …` + `apikey: …` :

| Traffic-one helper      | Outbound request                                                                                                                     | Expected response                             |
| ----------------------- | ------------------------------------------------------------------------------------------------------------------------------------ | --------------------------------------------- |
| `listRemoteFunctions`   | `GET    {functionsApiUrl}/_meta`                                                                                                     | `FunctionEntry[]` (empty on non-2xx)          |
| `getRemoteFunction`     | `GET    {functionsApiUrl}/_meta/{slug}`                                                                                              | `FunctionEntry` or 404                        |
| `getRemoteFunctionBody` | `GET    {functionsApiUrl}/_meta/{slug}/body`                                                                                         | `Array<{ name, content }>` or 404             |
| `deployRemoteFunction`  | `POST   {functionsApiUrl}/_deploy` with `{ slug, name?, verify_jwt?, entrypoint_path?, import_map_path?, files: [{name, content}] }` | `FunctionEntry` on 2xx, error body on 4xx/5xx |
| `patchRemoteFunction`   | `PATCH  {functionsApiUrl}/_meta/{slug}` with `FunctionMeta` JSON                                                                     | `FunctionEntry` or 404                        |
| `deleteRemoteFunction`  | `DELETE {functionsApiUrl}/_meta/{slug}`                                                                                              | 2xx (body ignored) or 404                     |

The previous plan draft described this as `PUT/DELETE {base}/{slug}`. That shape is **not** what the code implements — the authoritative set is the one above, centralized in [`services/edge-functions.service.ts`](functions/services/edge-functions.service.ts). An orchestrator that targets the old shape WILL fail the live path and fall through to whatever error handling the calling route applies.

## Project-backend dispatch

Every Studio call in the shape `/api/platform/*/{ref}/*` targets one specific
tenant. A single self-hosted Studio can speak to many independently provisioned
project backends (GoTrue, PostgREST, pg-meta, Logflare, Edge Functions,
Postgres) — one set of URLs + credentials per `ref`. `traffic-one` centralises
that dispatch so route handlers never touch a global environment variable for
project-scoped traffic.

### The `ProjectBackend` object

[`services/project-backend.service.ts`](functions/services/project-backend.service.ts)
exports `getProjectBackend(ref, pool)`, which joins `traffic.projects` with
`vault.decrypted_secrets` and returns a single `ProjectBackend` object shaped
like this:

The only columns actually selected by the resolver's `SELECT ... FROM traffic.projects` are **`ref`, `endpoint`, `anon_key`, `db_host`, `service_key_secret_id`, `db_pass_secret_id`, `connection_string_secret_id`** (see [`functions/services/project-backend.service.ts`](functions/services/project-backend.service.ts) row shape). Every other field below is either derived from `endpoint` at resolve time, decrypted out of the Vault secret UUIDs, or read from a platform-global env var. There is **no** `pg_meta_url` / `logflare_url` / `functions_api_url` / `db_port` / `db_user` / `db_name` column on `traffic.projects` today — a Phase 6 schema migration would add some of those (see [§ Env-var fallback](#environment-variables) and the M9 note), but they do not exist now, and the table reflects the code as it ships.

| Field              | Type     | Source                                                                                                                                                                                                                                                                    | Used by                                                                                                                                    |
| ------------------ | -------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------ |
| `ref`              | `string` | `traffic.projects.ref` (row column).                                                                                                                                                                                                                                      | Echoed back on outbound audit rows.                                                                                                        |
| `endpoint`         | `string` | `traffic.projects.endpoint` (row column); in shared-stack mode falls back to `SUPABASE_URL` env when the column is `NULL`.                                                                                                                                                | Base URL for `/auth/v1`, `/rest/v1`, `/graphql/v1` proxies.                                                                                |
| `anonKey`          | `string` | `traffic.projects.anon_key` (row column); in shared-stack mode falls back to `SUPABASE_ANON_KEY`. **Per-project mode refuses to fall back (C2)** — a missing `anon_key` surfaces as `project_backend_not_provisioned`.                                                    | `listLegacyApiKeys`, GraphQL proxy default auth.                                                                                           |
| `serviceKey`       | `string` | Decrypted from `vault.decrypted_secrets` via `service_key_secret_id` (row column). In shared-stack mode falls back to `SUPABASE_SERVICE_ROLE_KEY` / `SUPABASE_SECRET_KEY` / `SUPABASE_SERVICE_KEY`. **Per-project mode refuses to fall back (C2)** — see `anonKey` above. | `Authorization: Bearer …` + `apikey: …` on every outbound call (GoTrue admin, PostgREST, pg-meta, Logflare, Edge Functions admin).         |
| `pgMetaUrl`        | `string` | **Derived, not a column.** Per-project: `{endpoint}/pg-meta/v1`. Shared-stack: `PG_META_URL` env (default `http://meta:8080`).                                                                                                                                            | `/types/typescript`, `/api/platform/pg-meta/{ref}/*` dispatcher.                                                                           |
| `logflareUrl`      | `string` | **Derived, not a column.** Per-project: `{endpoint}/analytics/v1`. Shared-stack: `LOGFLARE_URL` env (default `http://analytics:4000`).                                                                                                                                    | `handleAnalyticsEndpoint`, `getOrgUsage`, `getOrgDailyUsage`.                                                                              |
| `logflareToken`    | `string` | **Platform-global env only (M9 Phase 6 limitation).** Always `LOGFLARE_PRIVATE_ACCESS_TOKEN` — even in per-project mode. No per-tenant Vault secret today; a `logflare_access_token_secret_id` column is the planned Phase 6 migration.                                   | `x-api-key` on Logflare SQL endpoint calls.                                                                                                |
| `dbHost`           | `string` | `traffic.projects.db_host` (row column); falls back to `POSTGRES_HOST` env or the host parsed out of `SUPABASE_DB_URL`.                                                                                                                                                   | In-container superuser pool target for JIT DDL + db-password rotation.                                                                     |
| `externalDbHost`   | `string` | **Env only, not a column.** `SUPABASE_PUBLIC_DB_HOST` env when set; otherwise mirrors `dbHost`.                                                                                                                                                                           | Human-readable connection string returned to clients (JIT `connection_string` field, cloud Studio download links).                         |
| `dbPort`           | `number` | **Env only, not a column.** `POSTGRES_PORT` env or the port parsed out of `SUPABASE_DB_URL` (default `5432`).                                                                                                                                                             | Composing `connectionString` fallback + rendered DSN.                                                                                      |
| `dbUser`           | `string` | **Env only, not a column.** `POSTGRES_USER` env or the user parsed out of `SUPABASE_DB_URL` (default `postgres`).                                                                                                                                                         | Composing `connectionString` fallback.                                                                                                     |
| `dbName`           | `string` | **Env only, not a column.** `POSTGRES_DB` env or the database name parsed out of `SUPABASE_DB_URL` (default `postgres`).                                                                                                                                                  | Composing `connectionString` fallback.                                                                                                     |
| `dbPass`           | `string` | Decrypted from `vault.decrypted_secrets` via `db_pass_secret_id` (row column); falls back to `POSTGRES_PASSWORD` env or the password parsed out of `SUPABASE_DB_URL`.                                                                                                     | Only surfaced when Studio needs the project superuser password (not emitted by any current route); composing `connectionString` fallback.  |
| `connectionString` | `string` | Decrypted from `vault.decrypted_secrets` via `connection_string_secret_id` (row column) **iff** it parses to a DSN with a non-empty password; otherwise composed from `postgresql://{dbUser}:{dbPass}@{dbHost}:{dbPort}/{dbName}`.                                        | One-shot `Pool` target for `updateDbPassword` + JIT `createPostgresRole` / `dropPostgresRole`. Empty string → service falls back to stubs. |
| `functionsApiUrl`  | `string` | **Derived, not a column.** Always `{endpoint}/functions/v1` after trimming a trailing slash. In shared-stack mode this is `http://kong:8000/functions/v1`; per-project it points at the orchestrator's edge-runtime admin surface.                                        | `deployRemoteFunction`, `patchRemoteFunction`, `deleteRemoteFunction`, `listRemoteFunctions`, `getRemoteFunction*`.                        |

`getProjectBackend` raises `ProjectBackendNotProvisionedError` when either
`endpoint` or `serviceKey` cannot be resolved (even after env fallback). The
error carries a `missing: string[]` array so route handlers can bubble a
structured `501 { code: "project_backend_not_provisioned", missing: [...] }`
response — Studio renders it as a "project not fully provisioned" banner
instead of a generic 5xx.

Two transport helpers live on the same module:

- `fetchProjectJson(backend, path, init?, fetch?)` — path-relative variant.
  `path` must start with `/` and is joined onto `backend.endpoint`. Sets
  `Authorization: Bearer ${backend.serviceKey}`, `apikey: ${backend.serviceKey}`,
  and `Content-Type: application/json` when a body is present unless the
  caller already specified them.
- `fetchProjectUrl(backend, url, init?, fetch?)` — absolute-URL variant.
  Same auth injection as `fetchProjectJson`, but targets a fully-qualified
  URL (used for `pgMetaUrl`, `functionsApiUrl`, `logflareUrl`, which may be
  on a different host than `endpoint` in api-mode deployments).

### ApiProvisioner response shape contract

When `PROJECT_PROVISIONER=api`, project creation in [`services/project.service.ts`](functions/services/project.service.ts)
delegates to the external HTTP orchestrator configured via `PROVISIONER_API_URL`.
The provisioner's `POST /projects` response is consumed by
[`services/provisioners/api.provisioner.ts`](functions/services/provisioners/api.provisioner.ts),
which today reads **only the five fields below** — anything else in the
response body is ignored. These fields feed directly into the
`traffic.projects` row + three Vault secrets that back `getProjectBackend`:

```json
{
  "endpoint": "https://{ref}.supabase.example.com",
  "anon_key": "eyJhbGciOi...",
  "service_key": "eyJhbGciOi...",
  "db_host": "db-{ref}.supabase.example.com",
  "db_pass": "super-secret"
}
```

| Response field | Stored in                                             | Required                              |
| -------------- | ----------------------------------------------------- | ------------------------------------- |
| `endpoint`     | `traffic.projects.endpoint` (plain column)            | Yes — drives every outbound proxy URL |
| `anon_key`     | `traffic.projects.anon_key` (plain column)            | Yes for per-project mode (C2)         |
| `service_key`  | `vault.decrypted_secrets` via `service_key_secret_id` | Yes — signs every outbound admin call |
| `db_host`      | `traffic.projects.db_host` (plain column)             | Yes — in-container Pool target        |
| `db_pass`      | `vault.decrypted_secrets` via `db_pass_secret_id`     | Yes — Pool password                   |

The `connection_string` secret is **not** accepted from the provisioner
today: `services/project.service.ts` composes
`postgresql://postgres:{db_pass}@{db_host}:5432/postgres` itself and writes
that into the `connection_string_secret_id` slot. An orchestrator that ships
a pre-built DSN will have it silently discarded.

The following fields are part of the planned
per-project surface but `api.provisioner.ts` does not read them yet.
Returning them is harmless (they are ignored) but a deployment that depends
on them will not work until the Phase 6 schema migration lands:

- `pg_meta_url`, `logflare_url`, `functions_api_url` — today these are
  **derived** from `endpoint` (per-project) or from env (shared-stack);
  there are no corresponding columns on `traffic.projects` yet.
- `logflare_token` — today always the platform-global
  `LOGFLARE_PRIVATE_ACCESS_TOKEN` (see M9 / [§ Env-var fallback](#environment-variables)).
  A future `logflare_access_token_secret_id` Vault slot is the planned fix.
- `db_port`, `db_user`, `db_name` — today read from `POSTGRES_*` env /
  `SUPABASE_DB_URL` only; they do not round-trip through the provisioner
  or `traffic.projects`.

Sensitive fields written to Vault (`service_key`, `db_pass`, and the
locally-composed `connection_string`) are referenced by UUID from
`traffic.projects.*_secret_id`. Non-sensitive fields (`endpoint`, `anon_key`,
`db_host`) live on `traffic.projects` directly.

In **local mode** (`PROJECT_PROVISIONER=local`, the default for
single-container docker-compose deployments) the provisioner returns empty
strings / nulls for many fields and `getProjectBackend` fills them in from
the shared env vars (`SUPABASE_URL`, `SUPABASE_ANON_KEY`, `PG_META_URL`,
`LOGFLARE_URL`, `POSTGRES_*`, etc.). The helper `isSharedStack(backend)` on
the same module returns `true` iff `backend.endpoint` equals `SUPABASE_URL`
(or `SUPABASE_URL` itself is empty, which we treat defensively as "shared
stack" — see L1), which the edge-functions route uses to pick the
filesystem-write path instead of proxying over HTTP.

per-project mode disables `anon_key` + `service_key` env
fallbacks.** When `isPerProjectBackend(row.endpoint)` is true — i.e. the
project row's endpoint differs from the platform-global `SUPABASE_URL` —
`getProjectBackend` refuses to substitute `SUPABASE_ANON_KEY` /
`SUPABASE_SERVICE_ROLE_KEY` for a missing `traffic.projects.anon_key` /
missing Vault `service_key_secret_id`. Falling back would silently sign
outbound admin calls for tenant B with the platform-wide service_role key,
which is a cross-tenant credential leak. Instead the resolver throws
`ProjectBackendNotProvisionedError` with the exact missing credentials
in `missing[]`, and route handlers surface that as a structured `501
{ code: "project_backend_not_provisioned", missing: [...] }` via the
shared [`notProvisionedResponse`](functions/utils/not-provisioned.ts)
helper. The env fallbacks remain in play **only** in shared-stack
mode, where they target the same single-tenant Docker stack that owns
both keys. See [`services/project-backend.service.ts`](functions/services/project-backend.service.ts)
for the code and `tests/services/project-backend-service-test.ts` for
the regression cases.

### 404-for-both anti-enumeration policy 

Every route that takes a `{ref}` path segment resolves it via
`getProjectByRef(pool, ref, profileId)`, which returns `null` in **two
observationally indistinguishable** cases:

1. The `traffic.projects` row for `ref` does not exist at all.
2. The row exists, but the authenticated caller is not a member of the
   owning organization (the query joins `traffic.organization_members` on
   `profile_id`).

All handlers translate `null → 404 { message: "Project not found" }`.
We deliberately do **not** distinguish these two cases with different
HTTP status codes (e.g. `404` vs `403`) because doing so would leak
existence of other tenants' project refs to any authenticated user: a
`403` response would confirm the ref exists in some other organization,
allowing an attacker with a cheap dictionary of candidate refs to map
the tenant graph. The same policy applies to malformed refs (L4) —
those return `400 invalid_project_ref` _before_ any DB lookup so the
resolver never observes them.

This is a deliberate departure from hosted Supabase, which emits
distinct `403`s for cross-tenant reads on some admin surfaces. If
you add a new `/{ref}/*` handler, follow suit: collapse both branches
into a single `404` response. The regression tests in
`tests/projects-test.ts` assert that a well-formed-but-unknown ref,
a cross-tenant-membership ref, and a malformed ref all produce the
expected 400/404 triple without structurally-different bodies.

### Which routes dispatch via `ProjectBackend`

Every handler below runs `getProjectByRef(pool, ref, profileId)` _first_ and
only calls `getProjectBackend(ref, pool)` if the caller passed the
membership check. That second call never races the first — both read from
the same `pool` — so a cross-tenant ref cannot leak a `ProjectBackend`
even under concurrent requests.

| Route handler                                                                                                                                                                      | Surface dispatched to                                                                                                                                   | Backend field(s) consumed                                             | Membership gate                                                      |
| ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------- | --------------------------------------------------------------------- | -------------------------------------------------------------------- |
| [`auth-config.ts`](functions/routes/auth-config.ts)                                                                                                                                | GoTrue admin `/auth/v1/admin/settings` + `/admin/config`                                                                                                | `endpoint`, `serviceKey`                                              | `getProjectByRef`                                                    |
| [`project-auth-admin.ts`](functions/routes/project-auth-admin.ts)                                                                                                                  | GoTrue admin `/auth/v1/admin/users*`, `/invite`, `/magiclink`, `/otp`, …                                                                                | `endpoint`, `serviceKey`                                              | `getProjectByRef`                                                    |
| [`project-analytics.ts`](functions/routes/project-analytics.ts)                                                                                                                    | Logflare SQL endpoint + PostgREST OpenAPI + pg_graphql introspection                                                                                    | `logflareUrl`, `logflareToken`, `endpoint`, `anonKey`, `serviceKey`   | `getProjectByRef`                                                    |
| [`project-lifecycle.ts`](functions/routes/project-lifecycle.ts)                                                                                                                    | pg-meta `/generators/typescript`                                                                                                                        | `pgMetaUrl`, `serviceKey`                                             | `getProjectByRef`                                                    |
| [`project-pg-meta.ts`](functions/routes/project-pg-meta.ts)                                                                                                                        | pg-meta `/query` + read-only surfaces                                                                                                                   | `pgMetaUrl`, `serviceKey`                                             | `getProjectByRef`                                                    |
| [`project-config.ts`](functions/routes/project-config.ts) (`/db-password`)                                                                                                         | Project's Postgres (one-shot `Pool`; `ALTER ROLE postgres PASSWORD`)                                                                                    | `connectionString`                                                    | `getProjectByRef`                                                    |
| [`projects.ts`](functions/routes/projects.ts) (`/{ref}/config/supavisor`, **H2**)                                                                                                  | Composes pooler DSN + metadata from the resolved backend (not env)                                                                                      | `dbHost`, `dbPort`, `dbUser`, `dbName` (or parsed `connectionString`) | `getProjectByRef`                                                    |
| [`jit.ts`](functions/routes/jit.ts)                                                                                                                                                | Project's Postgres (one-shot `Pool`; `CREATE ROLE` / `DROP ROLE`)                                                                                       | `connectionString`, `dbHost`, `dbPort`, `dbName`                      | `getProjectByRef`                                                    |
| [`edge-function-mutations.ts`](functions/routes/edge-function-mutations.ts) (POST/PATCH/DELETE) + **edge-function GETs in** [`projects.ts`](functions/routes/projects.ts) (**C1**) | `{functionsApiUrl}/_meta[...]` + `/_deploy` (when `!isSharedStack(backend)`) or filesystem writes at `/home/deno/functions/{slug}/` (when shared-stack) | `functionsApiUrl`, `endpoint`, `serviceKey`                           | `getProjectByRef` (mutations + `resolveFunctionsBackend` GETs alike) |
| [`project-api-keys.ts`](functions/routes/project-api-keys.ts) (`/api-keys/legacy`)                                                                                                 | None; reads anon + service keys straight off the backend                                                                                                | `anonKey`, `serviceKey`                                               | `getProjectByRef`                                                    |
| [`organizations.ts`](functions/routes/organizations.ts) (`/{slug}/usage*`, **H1**)                                                                                                 | Logflare SQL endpoint (only when `?project_ref=` is present)                                                                                            | `logflareUrl`, `logflareToken`                                        | Two-step: (1) caller in `{slug}` org, (2) `project_ref` in same org  |

**Three explicit callouts from the review:**

- **C1 — edge function GETs.** `resolveFunctionsBackend` + the three `GET /{ref}/functions*` handlers in [`projects.ts`](functions/routes/projects.ts) now gate through `getProjectByRef` before ever calling `getProjectBackend`. Pre-C1 they loaded the backend straight from the row, which was an IDOR: any authenticated user could list / read another tenant's functions by guessing the ref.
- **H1 — usage endpoints.** `/api/platform/organizations/{slug}/usage[/daily]` accepts an optional `?project_ref=` query parameter. [`organizations.ts`](functions/routes/organizations.ts) now verifies that the ref resolves to a project whose `organization_id` matches the slug's org **before** fetching the backend for Logflare. A ref that belongs to a different org collapses into the same `404` as a nonexistent ref (see the [404-for-both policy](#404-for-both-anti-enumeration-policy-m7) above).
- **H2 — `/{ref}/config/supavisor`.** The previous implementation composed the pooler DSN from platform-global `POOLER_*` / `POSTGRES_DB` env vars, which is wrong in api-mode (every tenant would have gotten the shared pooler). The handler now runs through `getProjectByRef` for membership and reads the pooler components off the resolved `ProjectBackend` only.

Everything else (profile, organizations, members, billing, notifications,
access tokens, feedback, cli, content, replication, backups read-model, log
drains CRUD, etc.) stays on the `traffic.*` schema and therefore reads from
the shared `pool` only — no `ProjectBackend` resolution required.

**Studio Next stubs are now unreachable via Kong.** The platform-auth and
platform-pg-meta Kong routes (`strip_path: false`) catch every request under
`/api/platform/auth/` and `/api/platform/pg-meta/` and forward them to
`traffic-one`. The Studio files under
`apps/studio/pages/api/platform/auth/[ref]/*` and
`apps/studio/pages/api/platform/pg-meta/[ref]/*` still compile — they remain
in the tree as an escape hatch for legacy / non-Kong deployments — but in
any stack that mounts this repo's `docker/volumes/api/kong.yml` they will
never receive traffic from the browser.

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

| Kong service              | Paths                          | `strip_path` | Notes                                                                                                                                                                                                                                                                                                                                                                                                                               |
| ------------------------- | ------------------------------ | ------------ | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `platform-profile`        | `/api/platform/profile`        | true         | —                                                                                                                                                                                                                                                                                                                                                                                                                                   |
| `platform-update-email`   | `/api/platform/update-email`   | true         | —                                                                                                                                                                                                                                                                                                                                                                                                                                   |
| `platform-signup`         | `/api/platform/signup`         | true         | Unauthenticated                                                                                                                                                                                                                                                                                                                                                                                                                     |
| `platform-reset-password` | `/api/platform/reset-password` | true         | Unauthenticated                                                                                                                                                                                                                                                                                                                                                                                                                     |
| `platform-organizations`  | `/api/platform/organizations`  | true         | Dispatches sub-resources (billing, members, audit, sso, usage, documents, tax-ids, etc.) inside the function worker                                                                                                                                                                                                                                                                                                                 |
| `platform-notifications`  | `/api/platform/notifications`  | true         | Replaces the previously defined `platform-notifications-stub` (see below)                                                                                                                                                                                                                                                                                                                                                           |
| `platform-auth`           | `/api/platform/auth/`          | false        | Covers both the config surface (`/{ref}/config[/hooks]`) and the GoTrue admin surface (`/{ref}/users*`, `/invite`, `/magiclink`, `/recover`, `/otp`, `/users/{id}/factors`, `/validate/spam`). traffic-one dispatches to `handleAuthConfig` for config paths and `handleProjectAuthAdmin` for everything else; the Studio Next stubs under `apps/studio/pages/api/platform/auth/[ref]/*` are unreachable via Kong                   |
| `platform-pg-meta`        | `/api/platform/pg-meta/`       | false        | Dispatches `POST /{ref}/query` (SQL runner; audited as `project.pg_meta.query`) and the read-only GET surfaces (`tables`, `triggers`, `types`, `policies`, `extensions`, `foreign-tables`, `materialized-views`, `views`, `column-privileges`, `publications`) to `backend.pgMetaUrl` signed with the project service_role key; Studio's Next stubs under `apps/studio/pages/api/platform/pg-meta/[ref]/*` are unreachable via Kong |
| `platform-database`       | `/api/platform/database`       | true         | Dispatches `/backups*`, `/{ref}/backups/*`, etc.                                                                                                                                                                                                                                                                                                                                                                                    |
| `platform-replication`    | `/api/platform/replication`    | true         | Read-only stubs; mutations are 501                                                                                                                                                                                                                                                                                                                                                                                                  |
| `platform-feedback`       | `/api/platform/feedback`       | true         | `traffic.feedback`                                                                                                                                                                                                                                                                                                                                                                                                                  |
| `platform-cli`            | `/api/platform/cli`            | true         | CLI-login handshake backed by `traffic.scoped_access_tokens`                                                                                                                                                                                                                                                                                                                                                                        |
| `platform-telemetry`      | `/api/platform/telemetry`      | true         | Sink for Studio telemetry events                                                                                                                                                                                                                                                                                                                                                                                                    |
| `v1-organizations`        | `/api/v1/organizations`        | true         | V1 organization endpoints separate from the platform API                                                                                                                                                                                                                                                                                                                                                                            |
| `v1-branches`             | `/api/v1/branches`             | true         | Global branch endpoints (diff, push, merge, reset, restore, delete) — per-project CRUD is served under `/api/v1/projects/{ref}/branches` via `platform-projects`                                                                                                                                                                                                                                                                    |

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

- **traffic.schema_migrations** — `id SERIAL PK`, `project_ref TEXT`, `version TEXT`, `name TEXT`, `statements TEXT[]`, `inserted_at`, `UNIQUE(project_ref, version)`. Append-only log of DDL batches applied through `POST /api/v1/projects/{ref}/database/migrations` (routed via the `v1-projects-health` Kong service to [`routes/database-migrations.ts`](functions/routes/database-migrations.ts)). The handler does **not** live under the `/api/platform/pg-meta/*` proxy — an earlier draft of this doc cited that path, but it was never correct.

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

The following additional actions are emitted by feature-specific services beyond the core profile / organization / project flows. Every action lives under one of four namespaces: `profile.*`, `project.*`, `auth_config.*`, or `schema_migrations.*`. (M5: the previous `auth_admin.*` namespace was renamed to `project.app_user_*` so that every tenant-scoped admin action lives under a single namespace alongside `project.pg_meta.query` and the other `project.*` rows. Existing rows in `traffic.audit_logs` that still carry the `auth_admin.*` prefix were written pre-M5 and are preserved as-is; new writes use `project.app_user_*`.)

| Action                                | When                                                                                                                                                                                                                                                                          |
| ------------------------------------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `profile.email_updated`               | `PUT /update-email` success                                                                                                                                                                                                                                                   |
| `profile.feedback_submitted`          | `POST /feedback/send` success                                                                                                                                                                                                                                                 |
| `profile.feedback_updated`            | `PATCH /feedback/conversations/{id}/custom-fields`                                                                                                                                                                                                                            |
| `auth_config.update`                  | `PATCH /api/platform/auth/{ref}/config`                                                                                                                                                                                                                                       |
| `project.app_user_create`             | `POST /api/platform/auth/{ref}/users` succeeded at `{backend.endpoint}/auth/v1/admin/users`                                                                                                                                                                                   |
| `project.app_user_update`             | `PATCH /api/platform/auth/{ref}/users/{id}` succeeded at `{backend.endpoint}/auth/v1/admin/users/{id}`                                                                                                                                                                        |
| `project.app_user_delete`             | `DELETE /api/platform/auth/{ref}/users/{id}` succeeded at `{backend.endpoint}/auth/v1/admin/users/{id}`                                                                                                                                                                       |
| `project.app_user_mfa_factors_delete` | `DELETE /api/platform/auth/{ref}/users/{id}/factors` — one audit row summarising every factor listed + deleted (H5: success-only; 502 on upstream `list` failure skips the audit)                                                                                             |
| `project.app_user_invite`             | `POST /api/platform/auth/{ref}/invite` succeeded at `{backend.endpoint}/auth/v1/invite`                                                                                                                                                                                       |
| `project.app_user_magiclink`          | `POST /api/platform/auth/{ref}/magiclink` succeeded at `{backend.endpoint}/auth/v1/magiclink`                                                                                                                                                                                 |
| `project.app_user_recover`            | `POST /api/platform/auth/{ref}/recover` succeeded at `{backend.endpoint}/auth/v1/recover`                                                                                                                                                                                     |
| `project.app_user_otp`                | `POST /api/platform/auth/{ref}/otp` succeeded at `{backend.endpoint}/auth/v1/otp`                                                                                                                                                                                             |
| `project.app_user_validate_spam`      | `POST /api/platform/auth/{ref}/validate/spam` — local heuristic only; GoTrue has no native endpoint (see README "Known gaps" and L6)                                                                                                                                          |
| `project.pg_meta.query`               | `POST /api/platform/pg-meta/{ref}/query` — emitted regardless of upstream outcome; `action_metadata` records byte size + SHA-256 `sql_sha256` fingerprint + `disable_statement_timeout` (M12 replaced the pre-existing 512-char SQL preview to avoid secret-in-audit leakage) |
| `schema_migrations.insert`            | `POST /api/v1/projects/{ref}/database/migrations` applied a migration (via the `v1-projects-health` Kong service, NOT the `/api/platform/pg-meta/*` proxy — an earlier draft cited the wrong path)                                                                            |
| `project.api_key_created`             | `POST /v1/projects/{ref}/api-keys` (publishable or secret)                                                                                                                                                                                                                    |
| `project.api_key_updated`             | `PATCH /v1/projects/{ref}/api-keys/{id}`                                                                                                                                                                                                                                      |
| `project.api_key_revoked`             | `DELETE /v1/projects/{ref}/api-keys/{id}` (soft-delete)                                                                                                                                                                                                                       |
| `project.signing_key_rotated`         | `POST /v1/projects/{ref}/config/auth/signing-keys` and `POST /.../signing-keys/{id}/rotate` — both paths share the rotation code that moves `in_use → previously_used` and promotes `standby → in_use`                                                                        |
| `project.signing_key_revoked`         | `DELETE /v1/projects/{ref}/config/auth/signing-keys/{id}`                                                                                                                                                                                                                     |
| `project.log_drain_created`           | `POST /projects/{ref}/analytics/log-drains`                                                                                                                                                                                                                                   |
| `project.log_drain_updated`           | `PUT /projects/{ref}/analytics/log-drains/{token}`                                                                                                                                                                                                                            |
| `project.log_drain_deleted`           | `DELETE /projects/{ref}/analytics/log-drains/{token}`                                                                                                                                                                                                                         |
| `project.content_folder_created`      | `POST /projects/{ref}/content/folders`                                                                                                                                                                                                                                        |
| `project.content_folder_updated`      | `PATCH /projects/{ref}/content/folders/{id}`                                                                                                                                                                                                                                  |
| `project.content_folder_deleted`      | `DELETE /projects/{ref}/content/folders/{id}`                                                                                                                                                                                                                                 |
| `project.content_created`             | `POST /projects/{ref}/content` (SQL / report / log-sql item)                                                                                                                                                                                                                  |
| `project.content_updated`             | `PATCH /projects/{ref}/content/{id}` + bulk `PATCH /projects/{ref}/content`                                                                                                                                                                                                   |
| `project.content_deleted`             | `DELETE /projects/{ref}/content/{id}`                                                                                                                                                                                                                                         |
| `project.config_updated`              | `PATCH /config/{postgrest,storage,realtime,pgbouncer,secrets}` + `PATCH /settings/sensitivity`                                                                                                                                                                                |
| `project.db_password_rotated`         | `POST /projects/{ref}/db-password`                                                                                                                                                                                                                                            |
| `project.branch_created`              | `POST /projects/{ref}/branches`                                                                                                                                                                                                                                               |
| `project.branch_updated`              | `PATCH /v1/branches/{id}` (fields listed in `target_metadata.keys`)                                                                                                                                                                                                           |
| `project.branch_pushed`               | `POST /v1/branches/{id}/push`                                                                                                                                                                                                                                                 |
| `project.branch_merged`               | `POST /v1/branches/{id}/merge`                                                                                                                                                                                                                                                |
| `project.branch_reset`                | `POST /v1/branches/{id}/reset`                                                                                                                                                                                                                                                |
| `project.branch_restored`             | `POST /v1/branches/{id}/restore` (soft-delete reversal)                                                                                                                                                                                                                       |
| `project.branch_deleted`              | `DELETE /v1/branches/{id}`                                                                                                                                                                                                                                                    |
| `project.custom_hostname_initialized` | `POST /projects/{ref}/custom-hostname/initialize`                                                                                                                                                                                                                             |
| `project.jit_policy_updated`          | `PUT /projects/{ref}/jit-access` (policy JSON)                                                                                                                                                                                                                                |
| `project.jit_grant_issued`            | `PUT /projects/{ref}/database/jit` (real PG role created or `pending` fallback)                                                                                                                                                                                               |
| `project.jit_grant_revoked`           | `DELETE /projects/{ref}/database/jit/{id}` (or `cleanupExpiredGrants` tick)                                                                                                                                                                                                   |
| `project.third_party_auth_added`      | `POST /projects/{ref}/config/auth/third-party-auth`                                                                                                                                                                                                                           |
| `project.third_party_auth_removed`    | `DELETE /projects/{ref}/config/auth/third-party-auth/{id}`                                                                                                                                                                                                                    |
| `project.ssl_enforcement_updated`     | `PUT /projects/{ref}/ssl-enforcement`                                                                                                                                                                                                                                         |
| `project.secret_set`                  | `POST /projects/{ref}/secrets`                                                                                                                                                                                                                                                |
| `project.secret_deleted`              | `DELETE /projects/{ref}/secrets`                                                                                                                                                                                                                                              |
| `project.edge_function_deployed`      | `POST /v1/projects/{ref}/functions/deploy`                                                                                                                                                                                                                                    |
| `project.edge_function_updated`       | `PATCH /v1/projects/{ref}/functions/{slug}`                                                                                                                                                                                                                                   |
| `project.edge_function_deleted`       | `DELETE /v1/projects/{ref}/functions/{slug}`                                                                                                                                                                                                                                  |

Enumerate the shipped action set at any point via:

```
rg "'(profile|project|auth_config|schema_migrations)\\.[a-z_]+'" traffic-one/functions
```

(the `auth_admin.*` namespace was retired; if the grep finds any
remaining `auth_admin.*` strings in `functions/`, that's a regression and
should be renamed to `project.app_user_*`.)

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

Read opportunistically by `gotrue-admin.service.ts` and the `getProjectBackend` resolver. The env values act as **shared-stack-only defaults** — when a project row carries a provisioner-issued `endpoint` that is not `SUPABASE_URL`, `traffic-one` signs outbound GoTrue admin calls with the project's own `serviceKey` and targets `{backend.endpoint}/auth/v1` instead of `GOTRUE_URL`. The variables below are only consulted when the project backend resolves to the shared local stack or when `traffic.auth_config_overrides` has no row and the live `GET {backend.endpoint}/auth/v1/admin/settings` fetch is empty or fails.

| Variable                       | Purpose                                                                                                                                            |
| ------------------------------ | -------------------------------------------------------------------------------------------------------------------------------------------------- |
| `GOTRUE_URL`                   | Shared-stack fallback for the GoTrue admin HTTP API (e.g. `http://auth:9999`); ignored once the project backend resolves to a non-shared endpoint. |
| `SITE_URL`, `API_EXTERNAL_URL` | URL config defaults.                                                                                                                               |
| `MAILER_*`, `SMTP_*`           | Mailer/SMTP defaults exposed to Studio's auth config UI.                                                                                           |
| `EXTERNAL_*`                   | Per-provider OAuth defaults (e.g. `EXTERNAL_GOOGLE_ENABLED`, `EXTERNAL_GOOGLE_CLIENT_ID`, ...).                                                    |
| `MAILER_TEMPLATES_*`           | Template URL overrides (confirmation, recovery, magic-link, invite, email-change).                                                                 |
| `RATE_LIMIT_*`                 | GoTrue rate-limit knobs surfaced as read-only defaults.                                                                                            |
| Every other `GOTRUE_*`         | Any additional GoTrue env var is forwarded transparently to the merge.                                                                             |

### Analytics / log drains

Per-project Logflare **URL** is resolved from `endpoint` when the row points at a per-project backend — see [§ Project-backend dispatch](#project-backend-dispatch). The **private access token** is **always** the platform-global env value, even in api mode (M9 Phase 6 limitation).

| Variable                        | Required                      | Description                                                                                                                                                                                                                                                                                                                                                                                                                                             |
| ------------------------------- | ----------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `LOGFLARE_URL`                  | Shared-stack                  | Logflare analytics endpoint used as the fallback `backend.logflareUrl` when the resolved `backend.endpoint` equals `SUPABASE_URL` (default: `http://analytics:4000`). Per-project mode composes `{endpoint}/analytics/v1` instead.                                                                                                                                                                                                                      |
| `LOGFLARE_PRIVATE_ACCESS_TOKEN` | **All modes (platform-wide)** | Token sent as `x-api-key` on every Logflare SQL-endpoint call — in **both** shared-stack and api mode. There is no per-project `logflare_access_token_secret_id` column on `traffic.projects` today (M9). Multi-tenant api-mode deployments must configure every downstream Logflare instance to accept the same platform-wide token, or ship the Phase 6 per-project token migration before per-tenant isolation of analytics credentials is possible. |

### Types / pg-meta

Shared-stack-only fallback. When `getProjectBackend(ref)` returns a per-project `pgMetaUrl`, that value is used instead; see [§ Project-backend dispatch](#project-backend-dispatch).

| Variable      | Required     | Description                                                                                                                                                                                                                                                                      |
| ------------- | ------------ | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `PG_META_URL` | Shared-stack | Fallback `backend.pgMetaUrl` for the shared local stack — used by `GET /v1/projects/{ref}/types/typescript`, the `/api/platform/pg-meta/{ref}/*` dispatcher, and the pg-meta surfaces (`tables`, `extensions`, `policies`, …) when the project backend points at `SUPABASE_URL`. |

### Disk / versions

| Variable                     | Required | Description                                                               |
| ---------------------------- | -------- | ------------------------------------------------------------------------- |
| `LOCAL_DISK_SIZE_GB`         | No       | Value returned by `GET /projects/{ref}/disk` for `size_gb` (default `8`). |
| `LOCAL_DISK_TYPE`            | No       | Value returned for `type` (default `gp3`).                                |
| `LOCAL_DISK_IOPS`            | No       | Value returned for `iops` (default `3000`).                               |
| `LOCAL_DISK_THROUGHPUT_MBPS` | No       | Value returned for `throughput_mbps` (default `125`).                     |
| `POSTGRES_VERSION`           | No       | Shown under `GET /projects/{ref}/restore/versions` (default `15`).        |

### JIT

Shared-stack-only fallbacks. JIT's `createPostgresRole` / `dropPostgresRole` target `backend.connectionString` via a one-shot `Pool` that is opened and closed per request; the env variables below only seed `backend.dbHost` / `backend.dbPort` / `backend.dbName` when the project backend resolves to the shared local stack (no provisioner-provided DSN). See [§ Project-backend dispatch](#project-backend-dispatch).

| Variable            | Required     | Description                                                                                                           |
| ------------------- | ------------ | --------------------------------------------------------------------------------------------------------------------- |
| `POSTGRES_HOST`     | Shared-stack | Fallback `backend.dbHost` used to compose the human-readable connection string surfaced to Studio on grant issue.     |
| `POSTGRES_PORT`     | Shared-stack | Fallback `backend.dbPort`.                                                                                            |
| `POSTGRES_USER`     | Shared-stack | Superuser-capable username (needs `CREATEROLE`); used to seed `backend.connectionString` when the provisioner didn't. |
| `POSTGRES_PASSWORD` | Shared-stack | Superuser password; used alongside `POSTGRES_USER` above.                                                             |
| `POSTGRES_DB`       | Shared-stack | Fallback `backend.dbName` (also reused by the pgbouncer config handler).                                              |

If `backend.connectionString` is empty (provisioner produced no DSN and no env fallback applied) or the controlling role cannot `CREATEROLE`, `jit.service.ts` falls back to `status='pending'` grants (row persists, no real PG role). `updateDbPassword` swallows the `ALTER ROLE` failure in the same way and still returns `{ result: "acknowledged" }` so Studio's rotate-password button never surfaces a 5xx.

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

**External provisioner response contract.** When `PROJECT_PROVISIONER=api`, the orchestrator's `POST /projects` response MUST return the five fields documented under [§ ApiProvisioner response shape contract](#apiprovisioner-response-shape-contract): `endpoint`, `anon_key`, `service_key`, `db_host`, `db_pass`. Any other fields in the response body (e.g. `pg_meta_url`, `logflare_token`, `functions_api_url`) are **silently ignored** today — `api.provisioner.ts` does not read them and they are not persisted to `traffic.projects` or Vault. The downstream URL fields (`pgMetaUrl`, `logflareUrl`, `functionsApiUrl`) are derived from `endpoint` at dispatch time; `logflareToken` is always `LOGFLARE_PRIVATE_ACCESS_TOKEN` (M9, see [§ Analytics / log drains](#analytics--log-drains) above); and `dbPort`/`dbUser`/`dbName` come from `POSTGRES_*` env or `SUPABASE_DB_URL`. The missing Phase 6 work to round-trip those fields through the provisioner is tracked under [§ ApiProvisioner response shape contract](#apiprovisioner-response-shape-contract).

In api mode, `getProjectBackend` will **not** fall back to the shared `SUPABASE_ANON_KEY` / `SUPABASE_SERVICE_ROLE_KEY` env vars when the project row's `anon_key` / Vault `service_key_secret_id` is missing — see the [C2 caveat](#the-projectbackend-object) in the ProjectBackend section. That missing-credential case surfaces as a `501 { code: "project_backend_not_provisioned", missing: [...] }` response. Shared-stack (`PROJECT_PROVISIONER=local`) mode continues to use the env-var fallbacks because all tenants resolve to the same Docker stack that owns both keys.

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
- **Studio Next stubs unreachable via Kong.** The files under `apps/studio/pages/api/platform/auth/[ref]/*` and `apps/studio/pages/api/platform/pg-meta/[ref]/*` are shadowed by the `platform-auth` and `platform-pg-meta` Kong routes and therefore never receive traffic in any stack that mounts this repo's `docker/volumes/api/kong.yml`. They remain in the Studio source tree as an escape hatch for legacy / non-Kong deployments only. See [§ Project-backend dispatch](#project-backend-dispatch).

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
