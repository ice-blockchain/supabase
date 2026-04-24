# traffic-one

Platform Profile & Auth API implemented as a Supabase Edge Function. Provides user signup, password reset, profile management, access token CRUD, notifications, permissions, and audit logging.

## Quick Start

```bash
# Prerequisites: Docker running with local Supabase stack (docker compose up)

# Deploy the function, run migrations, restart containers
./deploy.sh
```

## Architecture

See [ARCHITECTURE.md](ARCHITECTURE.md) for the full request flow, design decisions, and database schema.

**Request flow:** Browser → Kong → Edge Runtime → traffic-one worker → GoTrue (JWT verification) → Postgres

## Project Structure

```
traffic-one/
  functions/                   # Edge function source (deployed to docker/volumes/functions/traffic-one/)
    index.ts                   # Deno.serve entry + URL router + auth
    db.ts                      # Postgres pool (TRAFFIC_DB_URL)
    deno.json                  # Import map
    deno.lock                  # Canonical lockfile for traffic-one Deno commands
    routes/                    # HTTP route handlers
      auth.ts                  # POST /signup, POST /reset-password (unauthenticated)
      profile.ts               # GET/PUT /
      access-tokens.ts         # CRUD /access-tokens
      scoped-access-tokens.ts  # CRUD /scoped-access-tokens
      notifications.ts         # GET/PATCH /notifications
      organizations.ts         # CRUD /organizations, /organizations/{slug}
      members.ts               # Members, invitations, roles, MFA
      billing.ts               # Billing, payments, customer, tax, addons
      permissions.ts           # GET /permissions
      audit.ts                 # GET /audit, POST /audit-login
      auth-config.ts           # GET/PATCH /auth/{ref}/config + /config/hooks
      project-auth-admin.ts    # GoTrue admin proxy (users/invite/magiclink/recover/otp/factors/validate-spam)
      project-pg-meta.ts       # pg-meta proxy (query + tables/types/policies/extensions/…)
    services/                  # Business logic + DB queries
      profile.service.ts
      access-token.service.ts
      notification.service.ts
      organization.service.ts
      project.service.ts       # Project CRUD, status, transfer, membership enforcement
      project-backend.service.ts # getProjectBackend(ref) + fetchProjectJson / fetchProjectUrl
      member.service.ts        # Members, invitations, roles, MFA enforcement
      billing.service.ts       # DB queries for billing operations
      stripe.service.ts        # Stripe API wrapper (graceful degradation)
      usage.service.ts         # Usage metrics from Postgres + Logflare
      pricing.config.ts        # Default pricing per plan for all metrics
      logflare.client.ts       # Logflare SQL endpoint HTTP client (per-project aware)
      gotrue-admin.service.ts  # Backend-scoped GoTrue /admin/settings + /admin/config
      permission.service.ts
      org-settings.service.ts  # MFA enforcement, SSO provider CRUD, org audit logs
      provisioners/
        local.provisioner.ts   # Reads Docker env vars (local dev mode)
        api.provisioner.ts     # Calls external orchestration API (production mode)
    types/
      api.ts                   # Response types matching platform.d.ts
      billing.ts               # Billing response types
  migrations/                  # SQL migrations (run as postgres superuser)
    001_create_schema_and_role.sql
    002_create_profiles.sql
    003_create_access_tokens.sql
    004_create_notifications.sql
    005_create_audit_logs.sql
    006_create_organizations.sql
    007_create_billing_tables.sql
    008_create_pricing_overrides.sql
    009_create_org_settings.sql
    010_create_roles_and_invitations.sql
    011_create_projects.sql
  kong/
    platform-routes.yml        # Kong config snippet (reference)
  tests/
    .env                       # Test env vars
    traffic-one-test.ts        # Integration tests (full HTTP round-trip)
    organizations-test.ts      # Organization integration tests
    services/                  # Unit tests (direct DB)
  deploy.sh                    # Deployment script
```

## API Endpoints

### Auth Endpoints (unauthenticated)

Served via Kong at `/api/platform/signup` and `/api/platform/reset-password`. No Authorization header required.

| Kong Path                      | Method | Description               |
| ------------------------------ | ------ | ------------------------- |
| `/api/platform/signup`         | POST   | Create new user account   |
| `/api/platform/reset-password` | POST   | Send password reset email |

### Profile Endpoints

All paths are relative to `/api/platform/profile` (Kong strips the prefix before forwarding):

| Path                         | Method | Description                           |
| ---------------------------- | ------ | ------------------------------------- |
| `/`                          | GET    | Get or create profile                 |
| `/` or `/update`             | PUT    | Update profile fields                 |
| `/access-tokens`             | GET    | List access tokens                    |
| `/access-tokens`             | POST   | Create access token                   |
| `/access-tokens/{id}`        | DELETE | Delete access token                   |
| `/scoped-access-tokens`      | GET    | List scoped tokens                    |
| `/scoped-access-tokens`      | POST   | Create scoped token                   |
| `/scoped-access-tokens/{id}` | DELETE | Delete scoped token                   |
| `/notifications`             | GET    | List notifications                    |
| `/notifications`             | PATCH  | Bulk update notification status       |
| `/notifications/{id}`        | PATCH  | Update single notification            |
| `/permissions`               | GET    | Get user permissions                  |
| `/audit`                     | GET    | Get audit logs (requires date params) |
| `/audit-login`               | POST   | Record login event                    |

### Organization Endpoints

Served via Kong at `/api/platform/organizations` (Kong strips the prefix before forwarding):

| Path                              | Method | Description                                                                       |
| --------------------------------- | ------ | --------------------------------------------------------------------------------- |
| `/`                               | GET    | List user's organizations                                                         |
| `/`                               | POST   | Create organization                                                               |
| `/{slug}`                         | GET    | Get organization detail by slug                                                   |
| `/{slug}`                         | PATCH  | Update organization (name, billing_email, opt_in_tags, additional_billing_emails) |
| `/{slug}`                         | DELETE | Delete organization (owner only)                                                  |
| `/{slug}/projects`                | GET    | List organization projects                                                        |
| `/{slug}/audit`                   | GET    | Get org audit logs (requires date params)                                         |
| `/{slug}/members/mfa/enforcement` | GET    | Get MFA enforcement status                                                        |
| `/{slug}/members/mfa/enforcement` | PATCH  | Toggle MFA enforcement                                                            |
| `/{slug}/sso`                     | GET    | Get SSO provider config                                                           |
| `/{slug}/sso`                     | POST   | Create SSO provider config                                                        |
| `/{slug}/sso`                     | PUT    | Update SSO provider config                                                        |
| `/{slug}/sso`                     | DELETE | Delete SSO provider config                                                        |
| `/{slug}/usage`                   | GET    | Get aggregate usage with billing metadata                                         |
| `/{slug}/usage/daily`             | GET    | Get daily time-series usage                                                       |

### Team / Members Endpoints

Served via Kong at `/api/platform/organizations` (sub-paths of `/{slug}`):

| Path                                          | Method | Description                                     |
| --------------------------------------------- | ------ | ----------------------------------------------- |
| `/{slug}/members`                             | GET    | List org members with profile data and role_ids |
| `/{slug}/members/{gotrue_id}`                 | DELETE | Remove a member (admin/owner only)              |
| `/{slug}/members/{gotrue_id}`                 | PATCH  | Assign role to member (Version 2)               |
| `/{slug}/members/{gotrue_id}/roles/{role_id}` | PUT    | Update a member's role (project scoping)        |
| `/{slug}/members/{gotrue_id}/roles/{role_id}` | DELETE | Unassign a role from member                     |
| `/{slug}/members/invitations`                 | GET    | List pending invitations                        |
| `/{slug}/members/invitations`                 | POST   | Create invitation (email + role_id)             |
| `/{slug}/members/invitations/{id}`            | DELETE | Delete a pending invitation                     |
| `/{slug}/members/invitations/{token}`         | GET    | Get invitation details by token                 |
| `/{slug}/members/invitations/{token}`         | POST   | Accept invitation (adds member)                 |
| `/{slug}/members/reached-free-project-limit`  | GET    | Check free project limits                       |
| `/{slug}/members/mfa/enforcement`             | GET    | Get MFA enforcement state                       |
| `/{slug}/members/mfa/enforcement`             | PATCH  | Update MFA enforcement state                    |
| `/{slug}/roles`                               | GET    | List available roles (org + project scoped)     |

#### Usage Query Parameters

| Parameter     | Endpoint | Description                                           |
| ------------- | -------- | ----------------------------------------------------- |
| `project_ref` | Both     | Filter by project (default: `default`)                |
| `start`       | Both     | ISO 8601 start date (default: start of current month) |
| `end`         | Both     | ISO 8601 end date (default: now)                      |

### Billing Endpoints

Served via Kong at `/api/platform/organizations` and `/api/platform/projects`:

| Path                                         | Method | Description                   |
| -------------------------------------------- | ------ | ----------------------------- |
| `/{slug}/billing/subscription`               | GET    | Get org subscription details  |
| `/{slug}/billing/subscription`               | PUT    | Change plan/tier              |
| `/{slug}/billing/subscription/preview`       | POST   | Preview plan change cost      |
| `/{slug}/billing/subscription/confirm`       | POST   | Confirm pending payment       |
| `/{slug}/billing/plans`                      | GET    | List available plans          |
| `/{slug}/billing/invoices`                   | GET    | List invoices (paginated)     |
| `/{slug}/billing/invoices`                   | HEAD   | Invoice count (X-Total-Count) |
| `/{slug}/billing/invoices/upcoming`          | GET    | Upcoming invoice preview      |
| `/{slug}/billing/invoices/{id}`              | GET    | Single invoice                |
| `/{slug}/billing/invoices/{id}/receipt`      | GET    | Invoice receipt               |
| `/{slug}/billing/invoices/{id}/payment-link` | GET    | Payment link                  |
| `/{slug}/customer`                           | GET    | Get billing profile           |
| `/{slug}/customer`                           | PUT    | Update billing profile        |
| `/{slug}/tax-ids`                            | GET    | List tax IDs                  |
| `/{slug}/tax-ids`                            | PUT    | Add tax ID                    |
| `/{slug}/tax-ids`                            | DELETE | Remove tax ID                 |
| `/{slug}/payments`                           | GET    | List payment methods          |
| `/{slug}/payments`                           | DELETE | Detach payment method         |
| `/{slug}/payments/setup-intent`              | POST   | Create Stripe SetupIntent     |
| `/{slug}/payments/default`                   | PUT    | Set default payment method    |
| `/{slug}/billing/credits/top-up`             | POST   | Purchase credits              |
| `/{slug}/billing/credits/redeem`             | POST   | Redeem credit code            |
| `/{slug}/billing/upgrade-request`            | POST   | Request plan upgrade          |

### Project Endpoints

Served via Kong at `/api/platform/projects` (Kong strips the prefix before forwarding):

| Path                          | Method | Description                                         |
| ----------------------------- | ------ | --------------------------------------------------- |
| `/`                           | GET    | List all user's projects (paginated)                |
| `/`                           | POST   | Create project (name, organization_slug, db_region) |
| `/{ref}`                      | GET    | Get project detail by ref                           |
| `/{ref}`                      | PATCH  | Update project (name)                               |
| `/{ref}`                      | DELETE | Delete project                                      |
| `/{ref}/status`               | GET    | Get project status                                  |
| `/{ref}/pause/status`         | GET    | Get pause status                                    |
| `/{ref}/pause`                | POST   | Pause project (sets INACTIVE)                       |
| `/{ref}/restore`              | POST   | Restore project (sets ACTIVE_HEALTHY)               |
| `/{ref}/restart`              | POST   | Restart project (no-op)                             |
| `/{ref}/restart-services`     | POST   | Restart services (no-op)                            |
| `/{ref}/service-versions`     | GET    | Get service versions (stub)                         |
| `/{ref}/transfer/preview`     | POST   | Preview project transfer                            |
| `/{ref}/transfer`             | POST   | Transfer project to another org                     |
| `/projects-resource-warnings` | GET    | Resource warnings (empty array)                     |

Health endpoint (separate Kong route at `/api/v1/projects`):

| Path            | Method | Description          |
| --------------- | ------ | -------------------- |
| `/{ref}/health` | GET    | Project health check |

### Project Billing Endpoints

| Path                                       | Method | Description         |
| ------------------------------------------ | ------ | ------------------- |
| `/projects/{ref}/billing/addons`           | GET    | List project addons |
| `/projects/{ref}/billing/addons`           | POST   | Apply addon         |
| `/projects/{ref}/billing/addons/{variant}` | DELETE | Remove addon        |

### Stripe Endpoints

| Path                                  | Method | Description                |
| ------------------------------------- | ------ | -------------------------- |
| `/stripe/invoices/overdue`            | GET    | Count overdue invoices     |
| `/stripe/setup-intent`                | POST   | Create generic SetupIntent |
| `/organizations/confirm-subscription` | POST   | Confirm org subscription   |

### Project-scoped GoTrue admin proxy

Served via Kong at `/api/platform/auth/` with `strip_path: false`. The traffic-one dispatcher resolves the per-project GoTrue backend via `getProjectBackend(ref)` and signs every outbound call with that project's `service_role` key — a single Studio can therefore manage users across many independently provisioned project backends.

Config paths (`/config`, `/config/hooks`) stay on the env-merge + override-table flow (see [`routes/auth-config.ts`](functions/routes/auth-config.ts)); everything else dispatches via [`routes/project-auth-admin.ts`](functions/routes/project-auth-admin.ts) to `{backend.endpoint}/auth/v1/admin/*`.

| Path                        | Method | Description                                                        |
| --------------------------- | ------ | ------------------------------------------------------------------ |
| `/{ref}/config`             | GET    | Get merged GoTrue config (defaults ← live ← overrides)             |
| `/{ref}/config`             | PATCH  | Update GoTrue config (live + overrides)                            |
| `/{ref}/config/hooks`       | GET    | Same shape as `/config`, scoped to webhook fields                  |
| `/{ref}/config/hooks`       | PATCH  | Same behaviour as `PATCH /config`                                  |
| `/{ref}/users`              | POST   | Create a user in the project's GoTrue                              |
| `/{ref}/users/{id}`         | PATCH  | Update a user (email, phone, ban duration, metadata, …)            |
| `/{ref}/users/{id}`         | DELETE | Delete a user                                                      |
| `/{ref}/users/{id}/factors` | DELETE | Delete every MFA factor on a user                                  |
| `/{ref}/invite`             | POST   | Send an admin-invite email                                         |
| `/{ref}/magiclink`          | POST   | Send a magic-link email                                            |
| `/{ref}/recover`            | POST   | Send a password-recovery email                                     |
| `/{ref}/otp`                | POST   | Trigger an OTP flow                                                |
| `/{ref}/validate/spam`      | POST   | Local heuristic stub (GoTrue has no native validate/spam endpoint) |

Studio's fallback Next.js stubs under `apps/studio/pages/api/platform/auth/[ref]/*` are **unreachable** once this repo's `docker/volumes/api/kong.yml` is mounted — the Kong `platform-auth` route (`strip_path: false`) wins.

### Project-scoped pg-meta proxy

Served via Kong at `/api/platform/pg-meta/` with `strip_path: false`. The traffic-one dispatcher ([`routes/project-pg-meta.ts`](functions/routes/project-pg-meta.ts)) resolves the per-project backend via `getProjectBackend(ref)` and forwards every surface to `{backend.pgMetaUrl}/<surface>` using the project `service_role` key.

| Path                        | Method | Description                                                                                                          |
| --------------------------- | ------ | -------------------------------------------------------------------------------------------------------------------- |
| `/{ref}/query`              | POST   | Run an arbitrary SQL query (body: `{ query, disable_statement_timeout? }`). Audit-logged as `project.pg_meta.query`. |
| `/{ref}/tables`             | GET    | List tables                                                                                                          |
| `/{ref}/triggers`           | GET    | List triggers                                                                                                        |
| `/{ref}/types`              | GET    | List user-defined types                                                                                              |
| `/{ref}/policies`           | GET    | List row-level-security policies                                                                                     |
| `/{ref}/extensions`         | GET    | List extensions                                                                                                      |
| `/{ref}/foreign-tables`     | GET    | List foreign tables                                                                                                  |
| `/{ref}/materialized-views` | GET    | List materialized views                                                                                              |
| `/{ref}/views`              | GET    | List views                                                                                                           |
| `/{ref}/column-privileges`  | GET    | List column privileges                                                                                               |
| `/{ref}/publications`       | GET    | List logical-replication publications                                                                                |

Studio's fallback Next.js stubs under `apps/studio/pages/api/platform/pg-meta/[ref]/*` are **unreachable** once this repo's `docker/volumes/api/kong.yml` is mounted — the Kong `platform-pg-meta` route (`strip_path: false`) wins.

## Authentication

Most routes require an `Authorization: Bearer <JWT>` header. The function verifies the JWT via `supabase.auth.getUser()` and extracts the user's GoTrue ID for database lookups.

**Exception:** `/signup` and `/reset-password` are unauthenticated -- they proxy to GoTrue's public signup and recovery endpoints via the supabase-js SDK.

## Database

Uses a dedicated `traffic` schema with a restricted `traffic_api` Postgres role:

- **Full CRUD**: `traffic.profiles`, `traffic.organizations`, `traffic.organization_members`, `traffic.projects`
- **Create + Read + Delete**: `traffic.access_tokens`, `traffic.scoped_access_tokens`
- **Create + Read + Update**: `traffic.notifications`
- **Append-only**: `traffic.audit_logs` (INSERT + SELECT only, no UPDATE/DELETE)
- **Full CRUD**: `traffic.pricing_overrides`
- **Full CRUD**: `traffic.sso_providers`
- **Read-only**: `traffic.roles` (seeded catalog)
- **Full CRUD**: `traffic.organization_member_roles`
- **Full CRUD**: `traffic.invitations`

### Pricing / Discount System

The `traffic.pricing_overrides` table enables per-organization and per-metric pricing customization:

| Column                  | Description                                                   |
| ----------------------- | ------------------------------------------------------------- |
| `metric`                | Specific metric name (NULL = global discount for all metrics) |
| `discount_percent`      | Percentage off overage price (e.g. 10.00 = 10%)               |
| `custom_free_units`     | Override included quota (NULL = use plan default)             |
| `custom_per_unit_price` | Override per-unit price (NULL = use plan default)             |

**Override priority**: per-metric > global > default plan pricing.

**Default pricing** per plan is in `pricing.config.ts` covering all 44 metrics. Three strategies: `UNIT` (overage × price), `PACKAGE` (ceil(overage/size) × package_price), `NONE` (not billed).

## Known gaps / deliberate stubs

Things traffic-one **does not** do the way hosted Supabase does, but intentionally. Each item links to the route / service that owns it so reviewers know what NOT to file bugs on.

- **`POST /auth/{ref}/validate/spam` is a local heuristic, not a GoTrue call.** GoTrue itself exposes no `validate/spam` admin endpoint. [`routes/project-auth-admin.ts`](functions/routes/project-auth-admin.ts) scores the submitted `{ email, metadata }` pair locally (disposable-email list + structural heuristics) and returns `{ decision: 'allowed' | 'disallowed' }`. It does NOT consult the project's GoTrue, which means toggling anti-spam in the GoTrue config has no effect here and the heuristic is identical across projects. If hosted-parity ever ships an admin-surface endpoint we should switch to proxying it (M4).
- **`LOGFLARE_PRIVATE_ACCESS_TOKEN` is platform-global even in `api` mode.** The per-project backend resolver returns a Logflare endpoint from env (`LOGFLARE_URL`) but does NOT return a per-project access token — `logflare.client.ts` signs every query with the platform-wide token read from `Deno.env`. Multi-tenant Logflare deployments would need a new secret column (`logflare_access_token_secret_id`) on `traffic.projects` and a resolver change. Tracked as a Phase 6 follow-up in [ARCHITECTURE.md § Env-var fallback](ARCHITECTURE.md#environment-variables) (M9).
- **Edge-function mutations talk to a very specific HTTP contract.** When the project backend is NOT the shared Docker stack, [`services/edge-functions.service.ts`](functions/services/edge-functions.service.ts) calls `POST {functionsApiUrl}/_deploy`, `PATCH {functionsApiUrl}/_meta/{slug}`, `DELETE {functionsApiUrl}/_meta/{slug}`, and `GET {functionsApiUrl}/_meta[/...]`. The orchestrator that runs remote edge-function runtimes MUST expose that exact surface signed with the project `service_role` key — see [ARCHITECTURE.md § Edge function deploy HTTP contract](ARCHITECTURE.md#edge-function-deploy-http-contract-api-mode) (L2).

## Testing

### Required `tests/.env`

`tests/.env` is committed with placeholder values; before running anything
locally fill in the matching credentials from your deployed VM's
`docker/.env`:

| Var                         | Where to find it                                                                                                               |
| --------------------------- | ------------------------------------------------------------------------------------------------------------------------------ |
| `SUPABASE_ANON_KEY`         | `docker/.env` → `ANON_KEY` (must be signed with the same `JWT_SECRET` GoTrue is running with).                                 |
| `SUPABASE_SERVICE_ROLE_KEY` | `docker/.env` → `SERVICE_ROLE_KEY`. **Required** by the disposable-user helper (admin API calls bypass `GOTRUE_RATE_LIMIT_*`). |
| `TRAFFIC_DB_URL`            | `docker/.env` → `traffic_api` role DSN (host = `127.0.0.1` when tunnelling, port = Supavisor's 5432).                          |
| `SUPERUSER_DB_URL`          | `docker/.env` → `postgres` role DSN, same host/port form as above. Used to force-confirm test users + write fixture rows.      |
| `SUPABASE_PUBLIC_DB_HOST`   | Externally resolvable DB host (defaults to `127.0.0.1` in `tests/.env`). Production leaves this **unset**.                     |

The disposable-user helper (`tests/_helpers/test-user.ts`) calls
`auth.admin.createUser({ email_confirm: true })` instead of the public
`/signup` endpoint, so a single suite run no longer eats into the GoTrue
hourly email-sent quota — but it does require `SUPABASE_SERVICE_ROLE_KEY`
to be present, otherwise the helper throws on import.

### Running suites

```bash
# Always use the function-local Deno config + lock for reproducible resolution.
DENO_TEST='deno test --config functions/deno.json --lock functions/deno.lock --frozen --allow-all'

# Unit tests (require DB access with traffic_api role)
$DENO_TEST tests/services/

# Billing unit tests
$DENO_TEST tests/services/billing-service-test.ts

# Integration tests (require running Supabase stack + test user)
$DENO_TEST tests/traffic-one-test.ts

# Billing integration tests
$DENO_TEST tests/billing-test.ts

# Usage integration tests
$DENO_TEST tests/usage-test.ts

# Usage unit tests
$DENO_TEST tests/services/usage-service-test.ts

# Org settings integration tests
$DENO_TEST tests/org-settings-test.ts

# Org settings unit tests
$DENO_TEST tests/services/org-settings-service-test.ts

# Projects integration tests
$DENO_TEST tests/projects-test.ts

# Projects unit tests
$DENO_TEST tests/services/project-service-test.ts

# Members integration tests
$DENO_TEST tests/members-test.ts

# Members unit tests
$DENO_TEST tests/services/member-service-test.ts
```

## Environment Variables

See [ARCHITECTURE.md § Environment Variables](ARCHITECTURE.md#environment-variables) for the full list. Short version:

| Variable                                                                                  | Description                                                                                                                                                                                                                            |
| ----------------------------------------------------------------------------------------- | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `TRAFFIC_DB_URL`                                                                          | Postgres connection for traffic_api role                                                                                                                                                                                               |
| `SUPABASE_URL`                                                                            | Supabase URL for JWT verification                                                                                                                                                                                                      |
| `SUPABASE_ANON_KEY`                                                                       | Anon key for supabase-js client                                                                                                                                                                                                        |
| `TRAFFIC_API_PASSWORD`                                                                    | Password for the traffic_api Postgres role                                                                                                                                                                                             |
| `SUPABASE_SERVICE_ROLE_KEY`                                                               | Service role key (used by local provisioner for project creation)                                                                                                                                                                      |
| `PROJECT_PROVISIONER`                                                                     | `local` (default) or `api` — selects project provisioning backend                                                                                                                                                                      |
| `PROVISIONER_API_URL`                                                                     | (Required when `PROJECT_PROVISIONER=api`) External orchestration API URL                                                                                                                                                               |
| `STRIPE_API_KEY`                                                                          | (Optional) Stripe secret key; billing works without it in local-only mode                                                                                                                                                              |
| `STRIPE_WEBHOOK_SIGNING_SECRET`                                                           | (Optional) Stripe webhook signing secret                                                                                                                                                                                               |
| `LOGFLARE_URL`                                                                            | Logflare analytics endpoint (default: `http://analytics:4000`)                                                                                                                                                                         |
| `LOGFLARE_PRIVATE_ACCESS_TOKEN`                                                           | Private access token for Logflare SQL queries                                                                                                                                                                                          |
| `GOTRUE_URL`                                                                              | Shared-stack fallback GoTrue admin URL (ignored when per-project backend resolves)                                                                                                                                                     |
| `PG_META_URL`                                                                             | Shared-stack fallback pg-meta URL (ignored when per-project backend resolves)                                                                                                                                                          |
| `POSTGRES_HOST` / `POSTGRES_PORT` / `POSTGRES_USER` / `POSTGRES_PASSWORD` / `POSTGRES_DB` | Shared-stack fallbacks used by the project-backend resolver when the provisioner didn't return a DSN                                                                                                                                   |
| `SUPABASE_PUBLIC_DB_HOST`                                                                 | (Optional) Externally resolvable DB host substituted into JIT `connection_string` results so external clients (psql, future cloud Studio) get a hostname they can reach. Leave unset in production to keep the in-container `db` host. |

Many of the variables above act as **shared-stack-only fallbacks** — when `getProjectBackend(ref)` resolves per-project URLs + credentials from `traffic.projects` / Vault, those values win. See [ARCHITECTURE.md § Project-backend dispatch](ARCHITECTURE.md#project-backend-dispatch) for the full precedence rules.
