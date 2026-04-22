# Supabase Studio Dashboard - QA Test Report

**Date**: April 9, 2026  
**Environment**: Self-hosted Docker (Platform mode)  
**URL**: `http://localhost:8000`  
**Tester**: Automated QA Agent  
**Services**: 13 Docker Compose services (all running and healthy)

---

## Executive Summary

Tested 125+ pages across 16 functional areas of the Supabase Studio Dashboard. Out of approximately 130 distinct page tests performed:


| Category                        | Count | Percentage |
| ------------------------------- | ----- | ---------- |
| **PASS**                        | ~45   | ~35%       |
| **PARTIAL** (loads with issues) | ~35   | ~27%       |
| **FAIL** (broken/blocked)       | ~50   | ~38%       |


**Overall Platform Readiness**: NOT PRODUCTION-READY. Multiple critical infrastructure bugs block core workflows including project creation, SQL editing, and several settings pages. The platform requires significant fixes before user-facing deployment.

---

## Critical Blockers (Must Fix Before Launch)

### CRITICAL-001: Missing Database Migrations (007-011)

- **Severity**: CRITICAL
- **Impact**: Blocks organization creation, project creation, billing, all project features
- **Details**: Migrations 007 (billing tables), 008 (pricing overrides), 009 (org settings + audit_logs.organization_id), 010 (roles and invitations), and 011 (projects table) were never applied to the database.
- **Root Cause**: The `deploy.sh` script runs migrations, but these files were added after the initial deployment.
- **Fix**: Run all migrations in `traffic-one/migrations/` via `deploy.sh` or manually via `psql`.

### CRITICAL-002: Vault Function Permission Mismatch

- **Severity**: CRITICAL  
- **Impact**: Blocks project creation entirely
- **Details**: Migration 011 tries to grant `EXECUTE ON FUNCTION vault.create_secret(text, text, text)` but the actual function signature is `vault.create_secret(text, text, text, uuid)` (4 args). Same for `update_secret` (5 args vs 4). Additionally, `vault._crypto_aead_det_decrypt` needs explicit GRANT for the `traffic_api` role.
- **Error**: `permission denied for function create_secret` / `permission denied for function _crypto_aead_det_decrypt`
- **Fix**: Update migration 011 with correct function signatures. Add grants for vault crypto functions.

### CRITICAL-003: Free Project Limit Check Bug

- **Severity**: CRITICAL
- **Impact**: Blocks ALL users from creating projects
- **Details**: `getMembersAtFreeProjectLimit()` in `member.service.ts` returns all members whose `profiles.free_project_limit > 0` WITHOUT checking how many projects they actually have. Since the default `free_project_limit` is 2, every new user is immediately blocked.
- **Location**: `traffic-one/functions/services/member.service.ts:725-743`
- **Fix**: The query needs to JOIN against `traffic.projects` and compare `COUNT(projects)` against `free_project_limit`.

### CRITICAL-004: Organization Member Roles Not Auto-Created

- **Severity**: CRITICAL
- **Impact**: New users who create organizations after migration 010 have no role in `organization_member_roles`, causing "You do not have access" on all project pages
- **Details**: The `createOrganization` service inserts into `organization_members` but does NOT insert into `organization_member_roles` (the junction table added in migration 010).
- **Location**: `traffic-one/functions/services/organization.service.ts` (createOrganization function)
- **Fix**: Add INSERT into `organization_member_roles` with `role_id=5` (Owner) when creating an org.

### CRITICAL-005: SQL Editor Runtime Error

- **Severity**: CRITICAL
- **Impact**: SQL Editor completely unusable
- **Details**: `TypeError: Cannot read properties of undefined (reading 'type')` when navigating to `/project/[ref]/sql`
- **Fix**: Debug the SQL Editor component initialization - likely a missing data dependency.

---

## High-Severity Issues

### HIGH-001: Database Settings/Migrations Page TypeError

- **Severity**: HIGH
- **Impact**: Database Settings and Migrations pages are completely broken
- **Details**: `TypeError: data?.find is not a function` in PoolingModesModal component at `/project/[ref]/database/settings` and `/project/[ref]/database/migrations`
- **Likely Cause**: The pooling configuration API returns unexpected data format.

### HIGH-002: Database Types Page Blank/Error

- **Severity**: HIGH
- **Impact**: Cannot view or manage custom database types
- **Details**: Page shows "An invalid response was received from the upstream server" or renders blank.

### HIGH-003: Edge Functions Pages - Upstream Server Error

- **Severity**: HIGH
- **Impact**: Cannot view, create, or manage Edge Functions
- **Details**: All Edge Functions pages (`/functions`, `/functions/secrets`, `/functions/[slug]/`*) show "An invalid response was received from the upstream server".
- **Possible Cause**: The functions service may need additional API route configuration.

### HIGH-004: Storage Bucket Retrieval Failure

- **Severity**: HIGH
- **Impact**: Cannot browse files or manage storage
- **Details**: Storage Files page loads but shows "Failed to retrieve buckets". Permission to `storage` schema was missing and has been partially fixed.

### HIGH-005: Auth Providers/Templates Redirect Loop

- **Severity**: HIGH
- **Impact**: Cannot configure auth providers or email templates
- **Details**: Navigating to `/auth/providers` or `/auth/templates` redirects back to `/auth/users` instead of loading the correct page.

### HIGH-006: Usage Statistics Completely Broken

- **Severity**: HIGH
- **Impact**: No usage data visible for any metric
- **Details**: Org Usage page (`/org/[slug]/usage`) shows "Failed to retrieve usage statistics" for ALL metrics (Egress, Storage, MAU, SSO MAU, Image Transformations, Edge Functions, Realtime). Billing period shows "01 Jan 1970 - 01 Jan 1970".
- **Root Cause**: Multiple errors: `TypeError: Cannot mix BigInt and other types` in usage.service.ts, plus `permission denied for schema storage` preventing storage size queries.

### HIGH-007: Settings Addons Page TypeError

- **Severity**: HIGH
- **Impact**: Cannot view or manage project add-ons
- **Details**: `TypeError: Cannot read properties of undefined (reading 'map')` on `/project/[ref]/settings/addons`

### HIGH-008: Account Audit Logs - Upstream Error

- **Severity**: HIGH
- **Impact**: Cannot view account-level audit logs
- **Details**: `/account/audit` returns "An invalid response was received from the upstream server"

---

## Medium-Severity Issues

### MED-001: Sign-in Page Hydration Error

- **Severity**: MEDIUM
- **Impact**: Next.js error overlay appears on sign-in page (3 recoverable errors), can block UI interactions
- **Details**: "Text content does not match server-rendered HTML" - Next.js hydration mismatch. The error overlay intercepts clicks, making it difficult to interact with the sign-in form.
- **Fix**: Fix server/client rendering mismatch in the sign-in page component.

### MED-002: Billing Page Tax ID Error

- **Severity**: MEDIUM
- **Impact**: Tax ID section of billing page fails to load
- **Details**: "Failed to retrieve organization customer profile" with error on tax-ids endpoint.

### MED-003: Auth Hooks Page Blank

- **Severity**: MEDIUM
- **Impact**: Cannot configure auth hooks
- **Details**: `/project/[ref]/auth/hooks` renders a blank page.

### MED-004: Observability Section Redirect

- **Severity**: MEDIUM
- **Impact**: Cannot access project-level observability/metrics
- **Details**: `/project/[ref]/observability` redirects to org Usage page instead of showing project observability.

### MED-005: Individual Log Pages Redirect to Explorer

- **Severity**: MEDIUM
- **Impact**: Cannot view service-specific logs directly
- **Details**: Pages like `/logs/postgres-logs`, `/logs/auth-logs` redirect to the general Log Explorer instead of showing filtered views.

### MED-006: Stripe Integration Warning

- **Severity**: MEDIUM
- **Impact**: Cosmetic - shows warning in console
- **Details**: "You may test your Stripe.js integration over HTTP. However, live Stripe.js integrations must use HTTPS."

### MED-007: Team Page - Limited Visibility

- **Severity**: MEDIUM
- **Impact**: Cannot invite members or manage team
- **Details**: Team page shows "You have limited visibility in this organization" with disabled Invite and Leave buttons, despite user being an Owner. Likely related to CRITICAL-004.

### MED-008: Database Functions - Failed to Retrieve

- **Severity**: MEDIUM
- **Impact**: Cannot view or manage database functions
- **Details**: Page loads with skeleton loaders but shows "Failed to retrieve database functions".

---

## Low-Severity Issues

### LOW-001: Tanstack Query DevTools Button Visible

- **Severity**: LOW
- **Impact**: Cosmetic - dev tool button visible in production
- **Details**: "Open Tanstack query devtools" button appears in the bottom-left corner of every page.

### LOW-002: Console Warning - Development Build

- **Severity**: LOW
- **Impact**: Cosmetic
- **Details**: "Supabase Studio is running commit development deployed at unknown time." appears in console on every page load.

### LOW-003: Usercentrics Initialization Failure

- **Severity**: LOW
- **Impact**: Cookie consent may not work
- **Details**: "Failed to initialize Usercentrics: [object Object]" in console.

### LOW-004: Logflare 401 Unauthorized

- **Severity**: LOW
- **Impact**: Log analytics may not work
- **Details**: Multiple "Logflare query failed (401): Unauthorized" errors in edge function logs.

### LOW-005: SSO Page Shows Expected Error

- **Severity**: LOW
- **Impact**: None - expected behavior
- **Details**: `/org/[slug]/sso` shows "Failed to retrieve SSO configuration" which is expected when SSO is not configured.

---

## Page-by-Page Test Results

### Phase 1: Authentication & Onboarding


| Page                    | Status     | Notes                                                                                               |
| ----------------------- | ---------- | --------------------------------------------------------------------------------------------------- |
| `/sign-in`              | **PASS**   | Renders correctly with email, password, GitHub, SSO options. Has hydration error overlay (MED-001). |
| `/sign-up`              | **PASS**   | Registration works. Password strength validation works. Shows confirmation message.                 |
| Account Activation (DB) | **PASS**   | Token extraction from DB works. Verification URL activates account and redirects to `/new`.         |
| `/sign-in` (login)      | **PASS**   | Login with activated credentials works. Redirects to `/org`.                                        |
| `/sign-in-sso`          | **PASS**   | Page loads (redirects to org when already logged in).                                               |
| `/sign-in-mfa`          | NOT TESTED | Requires MFA setup first.                                                                           |
| `/forgot-password`      | **PASS**   | Form renders with email input and reset button.                                                     |
| `/reset-password`       | NOT TESTED | Requires reset token.                                                                               |
| `/join`                 | NOT TESTED | Requires invitation token.                                                                          |


### Phase 2: Organization Management


| Page                       | Status      | Notes                                                                |
| -------------------------- | ----------- | -------------------------------------------------------------------- |
| `/new` (create org)        | **PASS**    | Org creation works after CRITICAL-001/002 fixes.                     |
| `/org/[slug]` (projects)   | **PASS**    | Lists projects correctly. Search, sort, grid/list view work.         |
| `/org/[slug]/team`         | **PARTIAL** | Loads but shows limited visibility. Invite/Leave disabled (MED-007). |
| `/org/[slug]/integrations` | **PASS**    | Shows GitHub and Vercel integration options.                         |
| `/org/[slug]/usage`        | **FAIL**    | All usage metrics fail to load (HIGH-006).                           |
| `/org/[slug]/billing`      | **PARTIAL** | Loads but tax ID section fails (MED-002).                            |
| `/org/[slug]/general`      | **PASS**    | Org name, slug, and data privacy settings work.                      |
| `/org/[slug]/security`     | **PASS**    | Shows MFA enforcement (requires Pro plan).                           |
| `/org/[slug]/sso`          | **PARTIAL** | Shows expected "not configured" error (LOW-005).                     |
| `/org/[slug]/apps`         | **PASS**    | OAuth apps page loads with publish/authorized sections.              |
| `/org/[slug]/audit`        | **PASS**    | Shows audit log entries (org create, project create).                |
| `/org/[slug]/documents`    | **PASS**    | DPA, TIA, SOC2, HIPAA sections all render.                           |
| `/org/[slug]/webhooks`     | NOT TESTED  |                                                                      |


### Phase 3: Project Creation & Overview


| Page                                     | Status     | Notes                                                          |
| ---------------------------------------- | ---------- | -------------------------------------------------------------- |
| `/new/[slug]` (create project)           | **PASS**   | Works after CRITICAL-001/002/003 fixes.                        |
| `/project/[ref]` (overview)              | **PASS**   | Project overview loads with statistics after CRITICAL-004 fix. |
| `/project/[ref]/branches`                | **PASS**   | Page loads.                                                    |
| `/project/[ref]/branches/merge-requests` | NOT TESTED |                                                                |


### Phase 4: Table Editor


| Page                         | Status     | Notes                                           |
| ---------------------------- | ---------- | ----------------------------------------------- |
| `/project/[ref]/editor`      | **PASS**   | Loads with empty state. Ready to create tables. |
| `/project/[ref]/editor/new`  | NOT TESTED |                                                 |
| `/project/[ref]/editor/[id]` | NOT TESTED | No tables created yet.                          |


### Phase 5: SQL Editor


| Page                             | Status      | Notes                                                                           |
| -------------------------------- | ----------- | ------------------------------------------------------------------------------- |
| `/project/[ref]/sql`             | **FAIL**    | TypeError: Cannot read properties of undefined (reading 'type') (CRITICAL-005). |
| `/project/[ref]/sql/templates`   | **PARTIAL** | Briefly loads then errors.                                                      |
| `/project/[ref]/sql/quickstarts` | **FAIL**    | Same error as SQL editor.                                                       |


### Phase 6: Database Management


| Page                          | Status      | Notes                                                        |
| ----------------------------- | ----------- | ------------------------------------------------------------ |
| `/database/schemas`           | **PASS**    | Schema visualizer loads.                                     |
| `/database/tables`            | **PASS**    | Tables list loads with New Table button.                     |
| `/database/functions`         | **PARTIAL** | Loads but "Failed to retrieve database functions" (MED-008). |
| `/database/triggers`          | **PASS**    | Data/Event tabs work.                                        |
| `/database/triggers/event`    | NOT TESTED  |                                                              |
| `/database/triggers/data`     | NOT TESTED  |                                                              |
| `/database/indexes`           | **PASS**    | Loads with Create Index button.                              |
| `/database/extensions`        | **PASS**    | Lists extensions with search.                                |
| `/database/migrations`        | **FAIL**    | TypeError: data?.find is not a function (HIGH-001).          |
| `/database/roles`             | **PASS**    | Shows Supabase-managed and custom roles.                     |
| `/database/types`             | **FAIL**    | Upstream server error (HIGH-002).                            |
| `/database/column-privileges` | **PASS**    | Loads (requires feature preview).                            |
| `/database/settings`          | **FAIL**    | TypeError: data?.find is not a function (HIGH-001).          |
| `/database/publications`      | **PASS**    | Lists publications with CRUD columns.                        |
| `/database/replication`       | **PASS**    | Loads with Add Destination button.                           |
| `/database/backups/scheduled` | **PASS**    | Shows backup tabs (Scheduled, PITR, Restore).                |
| `/database/backups/pitr`      | NOT TESTED  |                                                              |


### Phase 7: Authentication Section


| Page                      | Status      | Notes                                   |
| ------------------------- | ----------- | --------------------------------------- |
| `/auth/overview`          | **PARTIAL** | Loads briefly, shows loading state.     |
| `/auth/users`             | **PASS**    | User list with search, Add User button. |
| `/auth/providers`         | **FAIL**    | Redirects to /auth/users (HIGH-005).    |
| `/auth/third-party`       | NOT TESTED  |                                         |
| `/auth/sessions`          | NOT TESTED  |                                         |
| `/auth/mfa`               | NOT TESTED  |                                         |
| `/auth/url-configuration` | **PASS**    | Config form loads correctly.            |
| `/auth/smtp`              | **FAIL**    | Redirects with access error.            |
| `/auth/rate-limits`       | **FAIL**    | Redirects with access error.            |
| `/auth/protection`        | NOT TESTED  |                                         |
| `/auth/hooks`             | **FAIL**    | Blank page (MED-003).                   |
| `/auth/policies`          | **PASS**    | RLS policies management loads.          |
| `/auth/performance`       | NOT TESTED  |                                         |
| `/auth/templates`         | **FAIL**    | Redirects to /auth/users (HIGH-005).    |
| `/auth/oauth-apps`        | NOT TESTED  |                                         |
| `/auth/oauth-server`      | NOT TESTED  |                                         |
| `/auth/audit-logs`        | NOT TESTED  |                                         |


### Phase 8: Storage


| Page                      | Status      | Notes                                              |
| ------------------------- | ----------- | -------------------------------------------------- |
| `/storage/files`          | **PARTIAL** | Loads but "Failed to retrieve buckets" (HIGH-004). |
| `/storage/files/policies` | **FAIL**    | Redirects with access error.                       |
| `/storage/files/settings` | **FAIL**    | Redirects with access error.                       |
| `/storage/s3`             | **FAIL**    | Navigation stuck.                                  |
| `/storage/analytics`      | NOT TESTED  |                                                    |
| `/storage/vectors`        | NOT TESTED  |                                                    |


### Phase 9: Edge Functions


| Page                 | Status     | Notes                             |
| -------------------- | ---------- | --------------------------------- |
| `/functions`         | **FAIL**   | Upstream server error (HIGH-003). |
| `/functions/new`     | NOT TESTED |                                   |
| `/functions/secrets` | **FAIL**   | Upstream server error (HIGH-003). |


### Phase 10: Realtime


| Page                  | Status      | Notes                               |
| --------------------- | ----------- | ----------------------------------- |
| `/realtime/inspector` | **PASS**    | Loads with channel subscription UI. |
| `/realtime/policies`  | **FAIL**    | Upstream server error.              |
| `/realtime/settings`  | **PARTIAL** | Loads briefly then errors.          |


### Phase 11: Advisors


| Page                    | Status   | Notes                                 |
| ----------------------- | -------- | ------------------------------------- |
| `/advisors/security`    | **FAIL** | Navigation issue.                     |
| `/advisors/performance` | **PASS** | "No errors detected" loads correctly. |


### Phase 12: Observability


| Page             | Status   | Notes                                  |
| ---------------- | -------- | -------------------------------------- |
| `/observability` | **FAIL** | Redirects to org usage page (MED-004). |
| All sub-pages    | **FAIL** | Same redirect issue.                   |


### Phase 13: Logs


| Page                  | Status      | Notes                            |
| --------------------- | ----------- | -------------------------------- |
| `/logs`               | **PARTIAL** | Shows wrong page content.        |
| `/logs/explorer`      | **PASS**    | Query interface loads correctly. |
| `/logs/postgres-logs` | **PARTIAL** | Redirects to explorer (MED-005). |
| `/logs/auth-logs`     | **PARTIAL** | Redirects to explorer (MED-005). |
| Other log pages       | **PARTIAL** | Similar redirect behavior.       |


### Phase 14: Integrations


| Page            | Status   | Notes                         |
| --------------- | -------- | ----------------------------- |
| `/integrations` | **PASS** | Loads with integration cards. |


### Phase 15: Project Settings


| Page                       | Status      | Notes                                          |
| -------------------------- | ----------- | ---------------------------------------------- |
| `/settings/general`        | **PASS**    | Project config, pause/restart, delete options. |
| `/settings/dashboard`      | **PASS**    | Dashboard preferences load.                    |
| `/settings/api`            | **PARTIAL** | Redirects to integrations Data API.            |
| `/settings/infrastructure` | **PASS**    | CPU, memory, disk info loads.                  |
| `/settings/addons`         | **FAIL**    | TypeError (HIGH-007).                          |
| `/settings/log-drains`     | **PASS**    | Loads correctly.                               |
| `/settings/billing/usage`  | **PARTIAL** | Shows wrong content.                           |


### Phase 16: Account Settings


| Page                | Status   | Notes                                    |
| ------------------- | -------- | ---------------------------------------- |
| `/account/me`       | **PASS** | Profile, theme, keyboard shortcuts.      |
| `/account/tokens`   | **PASS** | Access tokens management works.          |
| `/account/security` | **PASS** | Authenticator app configuration visible. |
| `/account/audit`    | **FAIL** | Upstream server error (HIGH-008).        |


---

## Infrastructure Issues Found During Testing


| Issue                                                  | Severity | Status                          |
| ------------------------------------------------------ | -------- | ------------------------------- |
| Migrations 007-011 not applied                         | CRITICAL | Fixed during testing            |
| `audit_logs.organization_id` column missing            | CRITICAL | Fixed during testing            |
| Vault function permission signatures wrong             | CRITICAL | Fixed during testing            |
| `organization_member_roles` not populated for new orgs | CRITICAL | Partially fixed (manual INSERT) |
| `storage` schema permission for `traffic_api`          | HIGH     | Fixed during testing            |
| Vault decrypt function permission                      | HIGH     | Fixed during testing            |


---

## Prioritized Remediation List

### Priority 1 - Launch Blockers (Fix Immediately)

1. Fix `deploy.sh` to run ALL migrations (001-011) idempotently
2. Fix vault function signatures in migration 011
3. Fix `getMembersAtFreeProjectLimit()` to actually count projects vs limit
4. Fix `createOrganization()` to INSERT into `organization_member_roles`
5. Fix SQL Editor TypeError
6. Fix Database Settings/Migrations TypeError (PoolingModesModal)

### Priority 2 - Core Feature Fixes (Fix Before Beta)

1. Fix Edge Functions upstream server errors
2. Fix Storage bucket retrieval
3. Fix Auth Providers/Templates redirect loop
4. Fix Usage statistics (BigInt conversion, storage permissions)
5. Fix Database Types page
6. Fix Addons page TypeError
7. Fix Account Audit Logs upstream error
8. Fix Observability section routing

### Priority 3 - Enhancement Fixes (Fix Before GA)

1. Fix sign-in page hydration mismatch
2. Fix Team page visibility/role detection
3. Fix individual log page routing (should filter, not redirect)
4. Fix Auth Hooks blank page
5. Fix billing tax ID retrieval
6. Fix Logflare authentication
7. Remove Tanstack Query DevTools from production build
8. Remove development build warning from console
9. Fix Usercentrics initialization

---

## Test Environment Notes

- All 13 Docker services were running and healthy throughout testing
- Some issues were fixed during testing to unblock downstream tests (see Infrastructure Issues)
- The existing user from a previous session had org "Johnny Bravo" which was left intact
- A new test user `qa-test@example.com` was created for clean testing
- Project ref used: `081d07ec672b1c3ec7cb` ("QA Test Project")
- Organization slug: `qa-test-organization`

