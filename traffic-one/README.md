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
    services/                  # Business logic + DB queries
      profile.service.ts
      access-token.service.ts
      notification.service.ts
      organization.service.ts
      project.service.ts       # Project CRUD, status, transfer, membership enforcement
      member.service.ts        # Members, invitations, roles, MFA enforcement
      billing.service.ts       # DB queries for billing operations
      stripe.service.ts        # Stripe API wrapper (graceful degradation)
      usage.service.ts         # Usage metrics from Postgres + Logflare
      pricing.config.ts        # Default pricing per plan for all metrics
      logflare.client.ts       # Logflare SQL endpoint HTTP client
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

## Testing

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

| Variable                        | Description                                                               |
| ------------------------------- | ------------------------------------------------------------------------- |
| `TRAFFIC_DB_URL`                | Postgres connection for traffic_api role                                  |
| `SUPABASE_URL`                  | Supabase URL for JWT verification                                         |
| `SUPABASE_ANON_KEY`             | Anon key for supabase-js client                                           |
| `TRAFFIC_API_PASSWORD`          | Password for the traffic_api Postgres role                                |
| `SUPABASE_SERVICE_ROLE_KEY`     | Service role key (used by local provisioner for project creation)         |
| `PROJECT_PROVISIONER`           | `local` (default) or `api` — selects project provisioning backend         |
| `PROVISIONER_API_URL`           | (Required when `PROJECT_PROVISIONER=api`) External orchestration API URL  |
| `STRIPE_API_KEY`                | (Optional) Stripe secret key; billing works without it in local-only mode |
| `STRIPE_WEBHOOK_SIGNING_SECRET` | (Optional) Stripe webhook signing secret                                  |
| `LOGFLARE_URL`                  | Logflare analytics endpoint (default: `http://analytics:4000`)            |
| `LOGFLARE_PRIVATE_ACCESS_TOKEN` | Private access token for Logflare SQL queries                             |
