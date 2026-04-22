# Architecture

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

## Usage APIs

### Data Sources

All usage metrics are derived from real data via two backends:

| Backend | Metrics | Query Method |
|---------|---------|-------------|
| Postgres | `DATABASE_SIZE` | `pg_database_size(current_database())` |
| Postgres | `STORAGE_SIZE` | `SUM((metadata->>'size')::bigint) FROM storage.objects` |
| Logflare | `FUNCTION_INVOCATIONS` | `COUNT(DISTINCT id) FROM function_edge_logs` |
| Logflare | `EGRESS` | `SUM(content_length) FROM edge_logs` with UNNEST on metadata |
| Logflare | `MONTHLY_ACTIVE_USERS` | `COUNT(DISTINCT actor_id) FROM auth_logs` |
| Logflare | `REALTIME_MESSAGE_COUNT` | `COUNT(*) FROM realtime_logs` |
| Logflare | `REALTIME_PEAK_CONNECTIONS` | Derived from `realtime_logs` connection events |
| Logflare | `STORAGE_IMAGES_TRANSFORMED` | `COUNT(*) FROM edge_logs WHERE path LIKE '/storage/v1/render/%'` |

Logflare is queried via its SQL endpoint: `GET http://analytics:4000/api/endpoints/query/logs.all?project=default&sql=<SQL>&iso_timestamp_start=<ISO>&iso_timestamp_end=<ISO>` with `x-api-key: LOGFLARE_PRIVATE_ACCESS_TOKEN`.

### Pricing Model

Default pricing is hardcoded in `pricing.config.ts` per plan (free/pro/team/enterprise). Three pricing strategies:

| Strategy | Cost Calculation |
|----------|-----------------|
| `UNIT` | `overage × per_unit_price` where `overage = max(0, usage - free_units)` |
| `PACKAGE` | `ceil(overage / package_size) × package_price` |
| `NONE` | Always $0 (metric tracked but not billed) |

### Discount System

Per-organization pricing overrides via `traffic.pricing_overrides`:

| Column | Purpose |
|--------|---------|
| `metric` | Specific metric (NULL = global discount for all metrics) |
| `discount_percent` | Percentage off the overage price (e.g. 10.00 = 10%) |
| `custom_free_units` | Override included quota (NULL = use plan default) |
| `custom_per_unit_price` | Override per-unit price (NULL = use plan default) |

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

| Route | Kong service | Upstream |
|-------|-------------|----------|
| `POST /auth/v1/token` | `auth-v1-open-token` | `http://auth:9999/token` |
| `GET/PUT /auth/v1/user` | `auth-v1-open-user` | `http://auth:9999/user` |
| `POST /auth/v1/logout` | `auth-v1-open-logout` | `http://auth:9999/logout` |
| `POST /auth/v1/signup` | `auth-v1-open-signup` | `http://auth:9999/signup` |
| `POST /auth/v1/recover` | `auth-v1-open-recover` | `http://auth:9999/recover` |

All five use `strip_path: true`, a single CORS plugin, and forward any body/headers verbatim to the GoTrue upstream.

**Why they are open.** Studio's platform-mode `AuthClient` (see `traffic-one/studio-patches/gotrue.ts`) is constructed with only `NEXT_PUBLIC_GOTRUE_URL` and does not attach an `apikey` header on login/refresh/logout/signup/recover calls, matching supabase.com's production dashboard behavior. Gating these endpoints behind `key-auth` in Kong would break the sign-in form, the refresh-token loop, sign-up, and password recovery in self-hosted platform mode. The endpoints themselves remain safe because GoTrue performs its own authentication (password, refresh token, JWT Bearer, or recovery nonce) and enforces rate limits / captcha internally.

**Scope of exposure.** The `paths:` entries use prefix matching, so `POST /auth/v1/token?grant_type=refresh_token` and `PATCH /auth/v1/user` both route through. Other GoTrue endpoints (admin APIs, SSO, MFA) continue to flow through `auth-v1-*` which still requires the dashboard apikey.

### CORS
Returns `Access-Control-Allow-Origin: *` and `Access-Control-Allow-Headers` on all responses and handles OPTIONS preflight.

### Self-contained
Each edge function contains all its own code. No `_shared/` folder. No cross-function imports. `corsHeaders` is exported from `index.ts` and imported by route handlers to avoid duplication.

## Database Schema

All tables live in the `traffic` schema.

### traffic_api Role Permissions

| Table | SELECT | INSERT | UPDATE | DELETE |
|-------|--------|--------|--------|--------|
| profiles | ✓ | ✓ | ✓ | ✓ |
| organizations | ✓ | ✓ | ✓ | ✓ |
| organization_members | ✓ | ✓ | ✓ | ✓ |
| projects | ✓ | ✓ | ✓ | ✓ |
| access_tokens | ✓ | ✓ | ✗ | ✓ |
| scoped_access_tokens | ✓ | ✓ | ✗ | ✓ |
| notifications | ✓ | ✓ | ✓ | ✗ |
| audit_logs | ✓ | ✓ | ✗ | ✗ |
| products | ✓ | ✓ | ✓ | ✓ |
| prices | ✓ | ✓ | ✓ | ✓ |
| subscriptions | ✓ | ✓ | ✓ | ✓ |
| customers | ✓ | ✓ | ✓ | ✓ |
| payment_methods | ✓ | ✓ | ✓ | ✓ |
| invoices | ✓ | ✓ | ✓ | ✓ |
| tax_ids | ✓ | ✓ | ✓ | ✓ |
| credits | ✓ | ✓ | ✓ | ✓ |
| credit_transactions | ✓ | ✓ | ✓ | ✓ |
| project_addons | ✓ | ✓ | ✓ | ✓ |
| upgrade_requests | ✓ | ✓ | ✓ | ✓ |
| pricing_overrides | ✓ | ✓ | ✓ | ✓ |
| sso_providers | ✓ | ✓ | ✓ | ✓ |
| roles | ✓ | ✗ | ✗ | ✗ |
| organization_member_roles | ✓ | ✓ | ✓ | ✓ |
| invitations | ✓ | ✓ | ✓ | ✓ |

### Other Permissions

| Object | Permission | Purpose |
|--------|-----------|---------|
| `pg_database_size(name)` | EXECUTE | Usage API: query database size |
| `storage.objects` | SELECT | Usage API: query storage size |
| `vault.create_secret(text,text,text)` | EXECUTE | Projects: store credentials |
| `vault.update_secret(uuid,text,text,text)` | EXECUTE | Projects: update credentials |
| `vault.decrypted_secrets` | SELECT | Projects: read decrypted secrets |
| `vault.secrets` | DELETE | Projects: remove secrets on delete |

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

## Audit Logging

Audit log inserts are done in application code (not database triggers) so the function has full access to HTTP context (method, route, client IP, email). Every mutating operation wraps the table change and audit log insert in a single Postgres transaction.

**Action names** follow `<table_name>.<operation>`:

| Action | When |
|--------|------|
| `profiles.insert` | Profile created (first login) |
| `profiles.update` | Profile fields updated |
| `access_tokens.insert` | Access token created |
| `access_tokens.delete` | Access token revoked |
| `scoped_access_tokens.insert` | Scoped token created |
| `scoped_access_tokens.delete` | Scoped token revoked |
| `organizations.insert` | Organization created |
| `organizations.update` | Organization name/billing_email updated |
| `organizations.delete` | Organization deleted |
| `projects.insert` | Project created |
| `projects.update` | Project name updated |
| `projects.delete` | Project deleted |
| `projects.pause` | Project paused (status → INACTIVE) |
| `projects.restore` | Project restored (status → ACTIVE_HEALTHY) |
| `projects.transfer` | Project transferred to another org |
| `organizations.mfa_update` | MFA enforcement toggled |
| `sso_providers.insert` | SSO provider created |
| `sso_providers.update` | SSO provider updated |
| `sso_providers.delete` | SSO provider deleted |
| `organization_members.delete` | Member removed from organization |
| `organization_member_roles.insert` | Role assigned to member |
| `organization_member_roles.update` | Member role updated (project scoping) |
| `organization_member_roles.delete` | Role unassigned from member |
| `invitations.insert` | Invitation created |
| `invitations.delete` | Invitation deleted |
| `invitations.accept` | Invitation accepted (member joined) |
| `notifications.update` | Notification status changed |
| `account.login` | Login event recorded |
| `subscriptions.update` | Subscription plan changed |
| `customers.upsert` | Customer billing profile updated |
| `tax_ids.insert` | Tax ID added |
| `tax_ids.delete` | Tax ID removed |
| `credits.redeem` | Credits redeemed |
| `credits.top_up` | Credits purchased |
| `upgrade_requests.insert` | Upgrade request submitted |

If the audit insert fails, the entire transaction rolls back.

## Permissions

The permission service (`permission.service.ts`) queries `traffic.organization_members` joined with `traffic.organizations` to return one wildcard permission entry per organization the user belongs to. Each entry grants `actions: ["%"]` and `resources: ["%"]` for the corresponding `organization_slug`. If the user has no organizations, a fallback "default" slug is returned for backwards compatibility.

## Authorization Rules (Members)

| Operation | Required Role |
|-----------|--------------|
| List members / invitations / roles | Any org member |
| Create invitation | Owner or Administrator (role_id ≥ 4) |
| Delete invitation | Owner or Administrator |
| Accept invitation | Any authenticated user (token validation) |
| Delete member | Owner or Administrator (cannot remove last owner) |
| Assign / update / unassign role | Owner or Administrator (cannot demote last owner) |
| MFA enforcement toggle | Owner or Administrator |

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

| Host path | Container path | Purpose |
|-----------|----------------|---------|
| `traffic-one/studio-patches/gotrue.ts` | `/app/packages/common/gotrue.ts` | Replace the shared `AuthClient` constructor so Studio talks directly to GoTrue via `NEXT_PUBLIC_GOTRUE_URL` without forwarding the dashboard apikey (pairs with [§ Kong Open Auth Routes](#kong-open-auth-routes)). |
| `traffic-one/studio-patches/apiHelpers.ts` | `/app/apps/studio/lib/api/apiHelpers.ts` | Strip the `x-connection-encrypted` header in self-hosted platform mode so `pg-meta` falls back to its default `PG_CONNECTION`. |
| `traffic-one/studio-patches/.env.local` | `/app/apps/studio/.env.local` | Inject platform-mode env values that Next.js reads at dev-server startup. |
| `apps/studio/lib/api/incident-banner.ts` | `/app/apps/studio/lib/api/incident-banner.ts` | Same file as the committed source edit; mounted read-only so platform-mode containers pick up the committed version of the file instead of whatever version shipped with the image. |
| `apps/studio/proxy.ts` | `/app/apps/studio/proxy.ts` | Same rationale as `incident-banner.ts`. |
| `apps/studio/lib/api/self-hosted/util.ts` | `/app/apps/studio/lib/api/self-hosted/util.ts` | Same rationale as above. |

### 2. Source modifications (permanent)

For `.tsx` React components and any file that must be baked into the image at build time, the change is committed to `apps/studio/*` so that a future Studio rebuild preserves the fix. These are the committed Studio edits listed in [§ Files Changed (Outside traffic-one/)](#files-changed-outside-traffic-one). Three of them (`incident-banner.ts`, `proxy.ts`, `self-hosted/util.ts`) are *also* mounted as read-only overlays by `docker-compose.platform.yml` so that the currently pinned `supabase/studio` image — which was built before these fixes existed — picks them up at runtime without waiting for a rebuild.

### Dev-mode assumption

The whole strategy rests on the prebuilt `supabase/studio:2026.04.08-sha-205cbe7` image running Next.js in **dev mode** (`next dev -p 8082`), where modules are re-bundled on demand from the mounted `.ts` files. If that image (or a replacement) is ever switched to a production build (`next start` against a prebaked `.next/`), the bind mounts in `docker-compose.platform.yml` will silently have no effect — the bundled JavaScript in the image will be served instead. Upgrading the pinned image tag therefore requires re-validating that it still runs `next dev`, or migrating every overlay into the source tree and rebuilding the image from this repo.

## Environment Variables (Usage)

| Variable | Required | Description |
|----------|----------|-------------|
| `LOGFLARE_URL` | Yes | Logflare analytics endpoint (default: `http://analytics:4000`) |
| `LOGFLARE_PRIVATE_ACCESS_TOKEN` | Yes | Private access token for Logflare SQL queries |

## Environment Variables (Billing)

| Variable | Required | Description |
|----------|----------|-------------|
| `STRIPE_API_KEY` | No | Stripe secret key. If not set, billing works in local-only mode (DB-backed, no Stripe sync) |
| `STRIPE_WEBHOOK_SIGNING_SECRET` | No | Stripe webhook endpoint signing secret for verifying webhook events |

## Invariants

- Studio source is patched only for (a) defensive null-checks that are upstream-worthy correctness fixes and (b) self-hosted-platform-mode gates; every patched file is enumerated in [§ Files Changed (Outside traffic-one/)](#files-changed-outside-traffic-one). For the split between source edits and volume overlays, see [§ Studio Patch Strategy](#studio-patch-strategy).
- All response shapes match `packages/api-types/types/platform.d.ts`
- The dashboard catch-all route in Kong continues to work
- `VERIFY_JWT` remains `false`; the function handles auth itself
- Existing edge functions (`hello`, etc.) are unaffected

## Known Gaps / Remaining Work

The following issues were identified by self-hosted platform-mode QA passes against the current `traffic-one` branch and are **not yet addressed**. Each entry notes the likely landing spot in `traffic-one/` for a future fix; landing spots are suggestions, not commitments.

### High severity

- **`GET /api/platform/auth/{ref}/config` returns 404** — breaks `/auth/providers`, `/auth/hooks`, and `/auth/url-configuration`. Studio error: "Failed to retrieve auth configuration for hooks". Fix requires a new route (e.g. `traffic-one/functions/routes/auth-config.ts`) or an extension to `routes/auth.ts` that proxies the relevant subset of the GoTrue admin API (providers, hooks, URL settings) or returns a stub, plus a new Kong route.
- **`/settings/infrastructure` crashes with `TypeError: Cannot read properties of undefined (reading 'map')`** — thrown inside Studio's `InfrastructureActivity.tsx` because `infra-monitoring-queries.ts` expects monitoring data that self-hosted does not produce. Fix options: add a client-side null guard (Studio source) or stub the `GET /api/platform/projects/{ref}/infra-monitoring` endpoint in traffic-one (`routes/projects.ts`) returning an empty dataset.
- **`GET /api/platform/database/{ref}/backups` returns 404** — breaks `/database/backups/scheduled`. Fix: add `traffic-one/functions/routes/backups.ts` (or fold into `routes/projects.ts`) returning an empty scheduled-backups array + a Kong route.

### Medium severity

- **`GET /api/platform/replication/{ref}/{destinations,pipelines,sources}` all return 404** — breaks `/database/replication`. Fix: add `traffic-one/functions/routes/replication.ts` returning empty arrays for each subpath + Kong routes.
- **Tax IDs query key `["organizations",<slug>,"tax-ids"]` reports `data is undefined`** — even though `GET /api/platform/organizations/{slug}/tax-ids` is handled in `routes/billing.ts` and `services/billing.service.ts#listTaxIds`. The response shape (or a sibling `/customer` call on the same page) is likely not matching what Studio's hook expects. Fix: audit `billing.service.ts` / `routes/billing.ts` tax-ids response against `packages/api-types/types/platform.d.ts`.
- **Sign-in SSR hydration mismatch in `LastSignInWrapper`** — Next.js dev overlay surfaces "Text content does not match server-rendered HTML" on `/sign-in`. The login form still works but the overlay must be dismissed. Fix lives in Studio source (`apps/studio/components/.../LastSignInWrapper.tsx`), not traffic-one.

### Low severity

- **TanStack Query DevTools button visible in platform mode** — the "Open TanStack query devtools" button renders in the bottom-left corner on every page. Fix: gate the devtools mount on `NEXT_PUBLIC_IS_PLATFORM !== 'true'` or a dedicated env flag in Studio source.
- **Studio healthcheck port asymmetry** (also noted under [§ Routing](#routing)) — base `docker/docker-compose.yml` healthcheck probes `localhost:8082`, which only matches a Studio build running `next dev` / `next start` on port 8082. Non-platform self-hosted users whose Studio binary listens on 3000 will see the healthcheck fail; platform mode disables the healthcheck entirely so is unaffected.
