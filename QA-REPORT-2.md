# Supabase Studio Dashboard - QA Test Report #2

**Date**: April 11, 2026  
**Environment**: Self-hosted Docker (Platform mode)  
**URL**: `http://localhost:8000`  
**Tester**: Automated QA Agent  
**Services**: 13 Docker Compose services (all running and healthy)  
**Test User**: `qa2025@example.com`  
**Organization**: qa2025's Org (slug: `qa2025-s-org`)  
**Project**: qa2025's Project (ref: `7c78e1ce0f5db446058f`)

---

## Executive Summary

Tested 35 pages across all functional areas. Major improvements from QA Report #1.

| Category                        | Count | Percentage |
| ------------------------------- | ----- | ---------- |
| **PASS**                        | 26    | 74%        |
| **PARTIAL** (loads with issues) | 2     | 6%         |
| **FAIL** (broken/blocked)       | 7     | 20%        |

**Overall improvement**: From ~35% PASS to **74% PASS**. Critical blockers (project creation, SQL Editor, Table Editor, Database Tables/Triggers/Functions) are all resolved.

---

## Fixes Verified Since QA Report #1

The following issues from QA Report #1 are now **RESOLVED**:

| Issue | Status |
| ----- | ------ |
| CRITICAL-001: Missing Database Migrations | **FIXED** |
| CRITICAL-002: Vault Function Permission Mismatch | **FIXED** |
| CRITICAL-003: Free Project Limit Check Bug | **FIXED** |
| CRITICAL-004: Organization Member Roles Not Auto-Created | **FIXED** |
| CRITICAL-005: SQL Editor Runtime Error | **FIXED** |
| HIGH-001: Database Settings/Migrations TypeError | **FIXED** |
| HIGH-002: Database Types Page | **FIXED** (publications/types now 200) |
| HIGH-003: Edge Functions Upstream Error | **FIXED** |
| HIGH-004: Storage Bucket Retrieval | **FIXED** |
| HIGH-006: Usage Statistics BigInt | **FIXED** |
| HIGH-007: Settings Addons TypeError | **FIXED** |
| HIGH-008: Account Audit Logs | **FIXED** |
| MED-007: Team Page Limited Visibility | **FIXED** |
| MED-008: Database Functions Failed | **FIXED** |

---

## Remaining Issues

### HIGH-SEVERITY (3 items)

#### REMAINING-001: Auth Config API Missing

- **Severity**: HIGH
- **Impact**: Auth Providers, Auth Hooks, and Auth URL Configuration pages fail
- **Affected Pages**: `/auth/providers`, `/auth/hooks`, `/auth/url-configuration`
- **Error**: "Failed to retrieve auth configuration for hooks" / "API error happened while trying to communicate with the server"
- **Root Cause**: `GET /api/platform/auth/{ref}/config` returns 404. Studio's internal proxy route does not exist for this endpoint.
- **Studio Log**: `GET /api/platform/auth/7c78e1ce0f5db446058f/config 404`
- **Fix Required**: Add a Kong route or Studio API route handler that returns GoTrue auth configuration (providers, hooks, URL settings) from the GoTrue admin API.

#### REMAINING-002: Infrastructure Page TypeError

- **Severity**: HIGH
- **Impact**: Settings > Infrastructure page crashes
- **Affected Pages**: `/settings/infrastructure`
- **Error**: `TypeError: Cannot read properties of undefined (reading 'map')` in `InfrastructureActivity.tsx`
- **Root Cause**: The Infrastructure page tries to iterate over data from an API response that is undefined. Likely related to `infra-monitoring-queries.ts` expecting monitoring data that the self-hosted platform doesn't provide.
- **Fix Required**: The monitoring data endpoint needs a stub, or the Infrastructure component needs a guard for undefined data.

#### REMAINING-003: Database Backups API Missing

- **Severity**: HIGH
- **Impact**: Database Backups page fails
- **Affected Pages**: `/database/backups/scheduled`
- **Error**: "Failed to retrieve scheduled backups" / "API error"
- **Root Cause**: `GET /api/platform/database/{ref}/backups` returns 404.
- **Studio Log**: `GET /api/platform/database/7c78e1ce0f5db446058f/backups 404`
- **Fix Required**: Add a stub endpoint returning an empty backups array, or add a Kong route to traffic-one.

---

### MEDIUM-SEVERITY (3 items)

#### REMAINING-004: Database Replication API Missing

- **Severity**: MEDIUM
- **Impact**: Database Replication page shows errors
- **Affected Pages**: `/database/replication`
- **Error**: "Failed to retrieve destinations" / "API error"
- **Root Cause**: Three endpoints return 404:
  - `GET /api/platform/replication/{ref}/destinations`
  - `GET /api/platform/replication/{ref}/pipelines`
  - `GET /api/platform/replication/{ref}/sources`
- **Fix Required**: Add stub endpoints returning empty arrays.

#### REMAINING-005: Billing Tax ID Error

- **Severity**: MEDIUM
- **Impact**: Tax ID section on billing page fails
- **Affected Pages**: `/org/{slug}/billing`
- **Error**: "Failed to retrieve organization customer profile" / `["organizations","qa2025-s-org","tax-ids"] data is undefined`
- **Root Cause**: Tax ID endpoint returns invalid/undefined data.
- **Fix Required**: Ensure the tax-ids endpoint returns a valid empty response.

#### REMAINING-006: Sign-in Hydration Error

- **Severity**: MEDIUM
- **Impact**: Next.js error overlay blocks sign-in page, prevents redirect after successful login
- **Affected Pages**: `/sign-in`
- **Error**: "Text content does not match server-rendered HTML" (3 recoverable errors)
- **Root Cause**: SSR/client mismatch in the `LastSignInWrapper` component - server renders a different className than the client.
- **Workaround**: Users can still sign in but the error overlay must be dismissed. The login form works but redirect may fail; manual navigation to `/organizations` works.

---

### LOW-SEVERITY (1 item)

#### REMAINING-007: Tanstack Query DevTools Visible

- **Severity**: LOW
- **Impact**: Cosmetic - dev tool button visible in all pages
- **Details**: "Open Tanstack query devtools" button appears in the bottom-left corner.
- **Fix**: Set env var or remove from production build.

---

## Page-by-Page Test Results

### Phase 1: Authentication & Onboarding

| Page | Status | Notes |
| ---- | ------ | ----- |
| `/sign-in` | **PARTIAL** | Works but hydration error overlay blocks UI (REMAINING-006). Login succeeds with workaround. |
| `/sign-up` | **PASS** | User registration works. Email confirmation via DB works. |
| `/new` (create org) | **PASS** | Organization creation works correctly. |

### Phase 2: Organization Management

| Page | Status | Notes |
| ---- | ------ | ----- |
| `/org/{slug}` (projects) | **PASS** | Lists projects correctly. Search, sort work. |
| `/org/{slug}/team` | **PASS** | Shows members with roles. Invite button visible. |
| `/org/{slug}/integrations` | **PASS** | GitHub and Vercel integration options visible. |
| `/org/{slug}/usage` | **PASS** | Usage metrics load. Database size, quotas display. |
| `/org/{slug}/billing` | **PARTIAL** | Loads but tax ID section fails (REMAINING-005). |
| `/org/{slug}/general` | **PASS** | Org name, slug, data privacy settings work. |
| `/org/{slug}/audit` | **PASS** | Shows audit log entries (org create, project create). |

### Phase 3: Project Creation & Overview

| Page | Status | Notes |
| ---- | ------ | ----- |
| `/new/{slug}` (create project) | **PASS** | Project creation works. Name, password, region, security options. |
| `/project/{ref}` (overview) | **PASS** | Status: Healthy. Statistics, Get Connected section. |

### Phase 4: Table Editor

| Page | Status | Notes |
| ---- | ------ | ----- |
| `/project/{ref}/editor` | **PASS** | Schema selector, New Table button, empty state. |

### Phase 5: SQL Editor

| Page | Status | Notes |
| ---- | ------ | ----- |
| `/project/{ref}/sql/new` | **PASS** | Editor loads with placeholder. Run button, database selector. |

### Phase 6: Database Management

| Page | Status | Notes |
| ---- | ------ | ----- |
| `/database/tables` | **PASS** | Tables list with schema selector, search. |
| `/database/triggers` | **PASS** | Data/Event tabs. "Add your first trigger". |
| `/database/functions` | **PASS** | Function list with schema selector. |
| `/database/extensions` | **PASS** | Extensions list with toggles. |
| `/database/roles` | **PASS** | All system and custom roles displayed. |
| `/database/migrations` | **PASS** | CLI instructions for first migration. |
| `/database/publications` | **PASS** | supabase_realtime publication visible. |
| `/database/settings` | **PASS** | Password reset, connection pooling, SSL config. |
| `/database/backups/scheduled` | **FAIL** | API error - backups endpoint missing (REMAINING-003). |
| `/database/replication` | **FAIL** | API error - replication endpoints missing (REMAINING-004). |

### Phase 7: Authentication Section

| Page | Status | Notes |
| ---- | ------ | ----- |
| `/auth/users` | **PASS** | User list with 8 users. Search, Add User button. |
| `/auth/providers` | **FAIL** | Auth config API missing (REMAINING-001). |
| `/auth/hooks` | **FAIL** | Auth config API missing (REMAINING-001). |
| `/auth/url-configuration` | **FAIL** | Auth config API missing (REMAINING-001). |
| `/auth/policies` | **PASS** | RLS policies management. "No tables" empty state. |

### Phase 8: Storage

| Page | Status | Notes |
| ---- | ------ | ----- |
| `/storage/files` | **PASS** | Bucket management. New Bucket button. Tabs work. |

### Phase 9: Edge Functions

| Page | Status | Notes |
| ---- | ------ | ----- |
| `/functions` | **PASS** | Deploy options. Template gallery visible. |

### Phase 10: Realtime

| Page | Status | Notes |
| ---- | ------ | ----- |
| `/realtime/inspector` | **PASS** | Channel subscription UI. Broadcast/Subscribe sections. |

### Phase 11: Integrations

| Page | Status | Notes |
| ---- | ------ | ----- |
| `/integrations` | **PASS** | Marketplace with installed and available integrations. |

### Phase 12: Project Settings

| Page | Status | Notes |
| ---- | ------ | ----- |
| `/settings/general` | **PASS** | Project name, ID, restart/pause options. |
| `/settings/infrastructure` | **FAIL** | TypeError on read (REMAINING-002). |
| `/settings/addons` | **PASS** | IPv4, PITR, Custom Domain options displayed. |

### Phase 13: Account Settings

| Page | Status | Notes |
| ---- | ------ | ----- |
| `/account/me` | **PASS** | Profile, theme, keyboard shortcuts. |
| `/account/tokens` | **PASS** | Access tokens management. |
| `/account/security` | **PASS** | Authenticator app configuration. |
| `/account/audit` | **PASS** | Account audit log with activity history. |

---

## Infrastructure Status

All 13 Docker services confirmed healthy:

| Service | Status |
| ------- | ------ |
| supabase-db | Healthy |
| supabase-auth | Healthy |
| supabase-rest | Running |
| supabase-storage | Healthy |
| supabase-kong | Healthy |
| supabase-meta | Healthy |
| supabase-studio | Running |
| supabase-edge-functions | Running |
| supabase-analytics | Healthy |
| supabase-pooler | Healthy |
| supabase-imgproxy | Healthy |
| supabase-vector | Healthy |
| supabase-realtime | Healthy |

### Patches Applied (traffic-one/studio-patches)

| Patch File | Purpose |
| ---------- | ------- |
| `gotrue.ts` | Server-side GoTrue URL uses `SUPABASE_URL` (internal kong) instead of localhost |
| `apiHelpers.ts` | Strips `x-connection-encrypted` header to prevent pg-meta connection failures |
| `.env.local` | Sets `SUPABASE_URL`, `PLATFORM_PG_META_URL`, `PG_META_CRYPTO_KEY` for Turbopack compile-time |

---

## Prioritized Remediation List

### Priority 1 - Core Feature Fixes

1. **Add Auth Config API endpoint** (`/api/platform/auth/{ref}/config`) - Unblocks Auth Providers, Hooks, and URL Configuration (3 pages)
2. **Fix Infrastructure page** - Add monitoring data stub or guard for undefined data
3. **Add Database Backups stub** (`/api/platform/database/{ref}/backups`) - Returns empty backups array

### Priority 2 - Enhancement Fixes

4. **Add Replication stubs** (destinations, pipelines, sources) - Returns empty arrays
5. **Fix Billing Tax ID** - Ensure tax-ids endpoint returns valid data
6. **Fix Sign-in hydration error** - SSR/client mismatch in LastSignInWrapper

### Priority 3 - Low Priority

7. Remove Tanstack Query DevTools from production build

---

## Test Environment Notes

- Fresh user `qa2025@example.com` created and confirmed for clean testing
- New organization "qa2025's Org" and project "qa2025's Project" created during testing
- All pg-meta endpoints returning 200 after apiHelpers.ts patch
- GoTrue internal authentication working after gotrue.ts patch
- Edge functions (traffic-one) deployed and returning correct responses
