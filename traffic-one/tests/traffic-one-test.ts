import { assert, assertEquals, assertExists } from 'jsr:@std/assert@1'
import { createClient } from 'npm:@supabase/supabase-js@2'

import 'jsr:@std/dotenv/load'

const supabaseUrl = Deno.env.get('SUPABASE_URL')!
const supabaseKey = Deno.env.get('SUPABASE_ANON_KEY')!
const supabase = createClient(supabaseUrl, supabaseKey, {
  auth: { autoRefreshToken: false, persistSession: false, detectSessionInUrl: false },
})

const PROFILE_URL = `${supabaseUrl}/api/platform/profile`

// ── Auth ─────────────────────────────────────────────────

Deno.test('GET /profile returns 401 without auth', async () => {
  const res = await fetch(PROFILE_URL)
  assertEquals(res.status, 401)
  await res.body?.cancel()
})

Deno.test('GET /profile returns 401 with invalid JWT', async () => {
  const res = await fetch(PROFILE_URL, {
    headers: { Authorization: 'Bearer invalid-token-here' },
  })
  assertEquals(res.status, 401)
  await res.body?.cancel()
})

// ── CORS ─────────────────────────────────────────────────

Deno.test('OPTIONS returns CORS headers', async () => {
  const res = await fetch(PROFILE_URL, { method: 'OPTIONS' })
  assertEquals(res.status, 200)
  assertExists(res.headers.get('access-control-allow-origin'))
  await res.body?.cancel()
})

// ── Helper: get session ──────────────────────────────────

async function getTestSession() {
  const {
    data: { session },
    error,
  } = await supabase.auth.signInWithPassword({
    email: 'test@example.com',
    password: 'test-password',
  })
  if (error || !session) {
    throw new Error(`Failed to sign in test user: ${error?.message ?? 'no session'}`)
  }
  return session
}

function authHeaders(token: string): Record<string, string> {
  return {
    Authorization: `Bearer ${token}`,
    'Content-Type': 'application/json',
  }
}

// ── Profile ──────────────────────────────────────────────

Deno.test('GET /profile returns ProfileResponse shape', async () => {
  const session = await getTestSession()
  const res = await fetch(PROFILE_URL, {
    headers: authHeaders(session.access_token),
  })
  assertEquals(res.status, 200)

  const profile = await res.json()
  assertExists(profile.id)
  assertExists(profile.gotrue_id)
  assertExists(profile.primary_email)
  assertExists(profile.username)
  assertEquals(typeof profile.is_alpha_user, 'boolean')
  assertEquals(typeof profile.is_sso_user, 'boolean')
  assert(Array.isArray(profile.disabled_features))
  assertExists(profile.auth0_id)
})

Deno.test('PUT /profile/update updates fields', async () => {
  const session = await getTestSession()
  const res = await fetch(`${PROFILE_URL}/update`, {
    method: 'PUT',
    headers: authHeaders(session.access_token),
    body: JSON.stringify({ first_name: 'IntegrationTest' }),
  })
  assertEquals(res.status, 200)

  const profile = await res.json()
  assertEquals(profile.first_name, 'IntegrationTest')
})

// ── Access Tokens ────────────────────────────────────────

let createdTokenId: number | null = null

Deno.test('POST /access-tokens creates token and returns raw token', async () => {
  const session = await getTestSession()
  const res = await fetch(`${PROFILE_URL}/access-tokens`, {
    method: 'POST',
    headers: authHeaders(session.access_token),
    body: JSON.stringify({ name: 'integration-test-token' }),
  })
  assertEquals(res.status, 201)

  const token = await res.json()
  assertExists(token.id)
  assertExists(token.token)
  assertExists(token.token_alias)
  assertEquals(token.name, 'integration-test-token')
  createdTokenId = token.id
})

Deno.test('GET /access-tokens lists tokens without raw token', async () => {
  const session = await getTestSession()
  const res = await fetch(`${PROFILE_URL}/access-tokens`, {
    headers: authHeaders(session.access_token),
  })
  assertEquals(res.status, 200)

  const tokens = await res.json()
  assert(Array.isArray(tokens))
  if (tokens.length > 0) {
    assertExists(tokens[0].id)
    assertExists(tokens[0].name)
    assertExists(tokens[0].token_alias)
    assertEquals(tokens[0].token, undefined)
  }
})

Deno.test('DELETE /access-tokens/:id revokes token', async () => {
  if (!createdTokenId) return
  const session = await getTestSession()
  const res = await fetch(`${PROFILE_URL}/access-tokens/${createdTokenId}`, {
    method: 'DELETE',
    headers: authHeaders(session.access_token),
  })
  assertEquals(res.status, 200)
  await res.body?.cancel()
})

// ── Scoped Access Tokens ─────────────────────────────────

let createdScopedTokenId: string | null = null

Deno.test('POST /scoped-access-tokens creates scoped token', async () => {
  const session = await getTestSession()
  const res = await fetch(`${PROFILE_URL}/scoped-access-tokens`, {
    method: 'POST',
    headers: authHeaders(session.access_token),
    body: JSON.stringify({
      name: 'integration-scoped-token',
      permissions: ['organizations_read', 'projects_read'],
    }),
  })
  assertEquals(res.status, 201)

  const token = await res.json()
  assertExists(token.id)
  assertExists(token.token)
  assertExists(token.token_alias)
  assert(Array.isArray(token.permissions))
  createdScopedTokenId = token.id
})

Deno.test('GET /scoped-access-tokens lists scoped tokens', async () => {
  const session = await getTestSession()
  const res = await fetch(`${PROFILE_URL}/scoped-access-tokens`, {
    headers: authHeaders(session.access_token),
  })
  assertEquals(res.status, 200)

  const tokens = await res.json()
  assert(Array.isArray(tokens))
})

Deno.test('DELETE /scoped-access-tokens/:id revokes scoped token', async () => {
  if (!createdScopedTokenId) return
  const session = await getTestSession()
  const res = await fetch(`${PROFILE_URL}/scoped-access-tokens/${createdScopedTokenId}`, {
    method: 'DELETE',
    headers: authHeaders(session.access_token),
  })
  assertEquals(res.status, 200)
  await res.body?.cancel()
})

// ── Notifications via /profile (backward-compat alias) ───
//
// Historical note: before Wave 1 landed `platform-notifications`, Studio hit
// notifications under `/api/platform/profile/notifications` via the
// `platform-notifications-stub` Kong route (see H7 in the fork-review plan).
// That stub is gone, but the handler still dispatches the profile-prefixed
// path internally (`functions/index.ts` matches `/notifications` regardless of
// whether it arrived via `platform-profile` or `platform-notifications`). The
// following two tests are kept intentionally to pin that alias so a future
// refactor removing `/profile/notifications` forwarding doesn't silently
// break old Studio builds. Canonical `/api/platform/notifications` coverage
// lives in `notifications-test.ts` and in the Kong smoke section at the
// bottom of this file.

Deno.test('GET /profile/notifications alias still works', async () => {
  const session = await getTestSession()
  const res = await fetch(`${PROFILE_URL}/notifications`, {
    headers: authHeaders(session.access_token),
  })
  assertEquals(res.status, 200)

  const notifications = await res.json()
  assert(Array.isArray(notifications))
})

Deno.test('PATCH /profile/notifications alias updates status', async () => {
  const session = await getTestSession()
  const res = await fetch(`${PROFILE_URL}/notifications`, {
    method: 'PATCH',
    headers: authHeaders(session.access_token),
    body: JSON.stringify({ ids: [], status: 'seen' }),
  })
  assertEquals(res.status, 200)

  const result = await res.json()
  assert(Array.isArray(result))
})

// ── Permissions ──────────────────────────────────────────

Deno.test('GET /permissions returns permissions array', async () => {
  const session = await getTestSession()
  const res = await fetch(`${PROFILE_URL}/permissions`, {
    headers: authHeaders(session.access_token),
  })
  assertEquals(res.status, 200)

  const permissions = await res.json()
  assert(Array.isArray(permissions))
  assert(permissions.length > 0)
  assert(permissions.includes('organizations_read'))
})

// ── Audit ────────────────────────────────────────────────

Deno.test('POST /audit-login records login event', async () => {
  const session = await getTestSession()
  const res = await fetch(`${PROFILE_URL}/audit-login`, {
    method: 'POST',
    headers: authHeaders(session.access_token),
  })
  assertEquals(res.status, 201)
  await res.body?.cancel()
})

Deno.test('GET /audit returns audit logs with date filter', async () => {
  const session = await getTestSession()
  const now = new Date()
  const start = new Date(now.getTime() - 24 * 60 * 60 * 1000).toISOString()
  const end = now.toISOString()

  const res = await fetch(
    `${PROFILE_URL}/audit?iso_timestamp_start=${start}&iso_timestamp_end=${end}`,
    { headers: authHeaders(session.access_token) }
  )
  assertEquals(res.status, 200)

  const body = await res.json()
  assertExists(body.result)
  assert(Array.isArray(body.result))
  assertEquals(typeof body.retention_period, 'number')
})

// ── Signup (unauthenticated) ─────────────────────────────

const SIGNUP_URL = `${supabaseUrl}/api/platform/signup`

Deno.test('POST /signup returns 201 for new user', async () => {
  const uniqueEmail = `test-signup-${Date.now()}@example.com`
  const res = await fetch(SIGNUP_URL, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({
      email: uniqueEmail,
      password: 'Test1234!',
      hcaptchaToken: null,
      redirectTo: 'http://localhost:8000',
    }),
  })
  assertEquals(res.status, 201)
  await res.body?.cancel()
})

Deno.test('POST /signup returns error for invalid email', async () => {
  const res = await fetch(SIGNUP_URL, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({
      email: 'not-an-email',
      password: 'Test1234!',
      hcaptchaToken: null,
      redirectTo: 'http://localhost:8000',
    }),
  })
  assert(res.status >= 400)
  const body = await res.json()
  assertExists(body.message)
})

Deno.test('POST /signup does not require Authorization header', async () => {
  const res = await fetch(SIGNUP_URL, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({
      email: `no-auth-${Date.now()}@example.com`,
      password: 'Test1234!',
      hcaptchaToken: null,
      redirectTo: 'http://localhost:8000',
    }),
  })
  assert(res.status !== 401, 'Signup should not require auth')
  await res.body?.cancel()
})

Deno.test('OPTIONS /signup returns CORS headers', async () => {
  const res = await fetch(SIGNUP_URL, { method: 'OPTIONS' })
  assertEquals(res.status, 200)
  assertExists(res.headers.get('access-control-allow-origin'))
  await res.body?.cancel()
})

// ── Reset Password (unauthenticated) ─────────────────────

const RESET_URL = `${supabaseUrl}/api/platform/reset-password`

Deno.test('POST /reset-password returns 200', async () => {
  const res = await fetch(RESET_URL, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({
      email: 'test@example.com',
      hcaptchaToken: null,
      redirectTo: 'http://localhost:8000',
    }),
  })
  assertEquals(res.status, 200)
  await res.body?.cancel()
})

Deno.test('POST /reset-password does not require Authorization header', async () => {
  const res = await fetch(RESET_URL, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({
      email: 'test@example.com',
      hcaptchaToken: null,
      redirectTo: 'http://localhost:8000',
    }),
  })
  assert(res.status !== 401, 'Reset password should not require auth')
  await res.body?.cancel()
})

Deno.test('OPTIONS /reset-password returns CORS headers', async () => {
  const res = await fetch(RESET_URL, { method: 'OPTIONS' })
  assertEquals(res.status, 200)
  assertExists(res.headers.get('access-control-allow-origin'))
  await res.body?.cancel()
})

// ── 404 ──────────────────────────────────────────────────

Deno.test('GET /nonexistent returns 404', async () => {
  const session = await getTestSession()
  const res = await fetch(`${PROFILE_URL}/nonexistent`, {
    headers: authHeaders(session.access_token),
  })
  assertEquals(res.status, 404)
  await res.body?.cancel()
})

// ── Profile PATCH / POST (Bundle A) ──────────────────────

Deno.test('PATCH /profile returns 401 without auth', async () => {
  const res = await fetch(PROFILE_URL, {
    method: 'PATCH',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ first_name: 'NoAuth' }),
  })
  assertEquals(res.status, 401)
  await res.body?.cancel()
})

Deno.test('PATCH /profile with invalid JWT returns 401', async () => {
  const res = await fetch(PROFILE_URL, {
    method: 'PATCH',
    headers: {
      'Content-Type': 'application/json',
      Authorization: 'Bearer not-a-real-token',
    },
    body: JSON.stringify({ first_name: 'Invalid' }),
  })
  assertEquals(res.status, 401)
  await res.body?.cancel()
})

Deno.test('PATCH /profile with partial body updates first_name', async () => {
  const session = await getTestSession()
  const uniqueFirstName = `PatchTest${Date.now()}`
  const res = await fetch(PROFILE_URL, {
    method: 'PATCH',
    headers: authHeaders(session.access_token),
    body: JSON.stringify({ first_name: uniqueFirstName }),
  })
  assertEquals(res.status, 200)

  const profile = await res.json()
  assertEquals(profile.first_name, uniqueFirstName)

  const getRes = await fetch(PROFILE_URL, {
    headers: authHeaders(session.access_token),
  })
  assertEquals(getRes.status, 200)
  const fetched = await getRes.json()
  assertEquals(fetched.first_name, uniqueFirstName)
})

Deno.test(
  'PATCH /profile with {primary_email} is accepted but does not change primary_email',
  async () => {
    const session = await getTestSession()

    const beforeRes = await fetch(PROFILE_URL, {
      headers: authHeaders(session.access_token),
    })
    assertEquals(beforeRes.status, 200)
    const before = await beforeRes.json()
    const originalEmail: string = before.primary_email

    const patchRes = await fetch(PROFILE_URL, {
      method: 'PATCH',
      headers: authHeaders(session.access_token),
      body: JSON.stringify({ primary_email: 'should-be-ignored@example.com' }),
    })
    assertEquals(patchRes.status, 200)
    await patchRes.body?.cancel()

    const afterRes = await fetch(PROFILE_URL, {
      headers: authHeaders(session.access_token),
    })
    assertEquals(afterRes.status, 200)
    const after = await afterRes.json()
    assertEquals(after.primary_email, originalEmail)
  }
)

Deno.test('POST /profile returns ProfileResponse shape', async () => {
  const session = await getTestSession()
  const res = await fetch(PROFILE_URL, {
    method: 'POST',
    headers: authHeaders(session.access_token),
  })
  assertEquals(res.status, 200)

  const profile = await res.json()
  assertExists(profile.id)
  assertExists(profile.gotrue_id)
  assertExists(profile.primary_email)
  assertExists(profile.username)
  assertEquals(typeof profile.is_alpha_user, 'boolean')
  assertEquals(typeof profile.is_sso_user, 'boolean')
  assert(Array.isArray(profile.disabled_features))
  assertExists(profile.auth0_id)
})

Deno.test('POST /profile is idempotent (returns same id on repeat calls)', async () => {
  const session = await getTestSession()
  const firstRes = await fetch(PROFILE_URL, {
    method: 'POST',
    headers: authHeaders(session.access_token),
  })
  assertEquals(firstRes.status, 200)
  const first = await firstRes.json()

  const secondRes = await fetch(PROFILE_URL, {
    method: 'POST',
    headers: authHeaders(session.access_token),
  })
  assertEquals(secondRes.status, 200)
  const second = await secondRes.json()

  assertEquals(first.id, second.id)
  assertEquals(first.gotrue_id, second.gotrue_id)
})

// ─────────────────────────────────────────────────────────────────────────────
// Kong Route Smoke Tests
// ─────────────────────────────────────────────────────────────────────────────
//
// One minimal probe per Kong service that forwards to traffic-one. The point
// of these is *NOT* to re-cover each bundle's business logic (that's what
// tests/<bundle>-test.ts does). The point is to fail loudly if Kong routing
// breaks — e.g. a path typo in `docker/volumes/api/kong.yml`, a missed
// `strip_path`, a conflicting regex, or an upstream URL pointing at a stale
// function name. Every test here asserts that the response body is shaped
// like traffic-one (either a known success shape OR a specific 404/405/400
// message). Kong's default miss (`{"message":"no Route matched with those
// values"}`, 404) therefore fails the shape assertion.
//
// Scope of this suite tracks what the Wave-1/2/3 plan added on top of the
// upstream Studio Kong config: auth-config, update-email, backups,
// replication, feedback, cli, v1-organizations, v1-branches, plus the
// platform-level notifications / organizations / projects / stripe /
// projects-resource-warnings / telemetry mounts.
//
// Some probes intentionally target a non-existent ref/slug/id. Any 404
// returned in that case must originate from traffic-one (recognized via its
// specific `{message}` text), never from Kong.

const PLATFORM_URL = `${supabaseUrl}/api/platform`
const V1_URL = `${supabaseUrl}/api/v1`

function assertTrafficOneMessage(body: unknown, allowed: string[]): void {
  assert(body && typeof body === 'object', 'expected JSON object response body')
  const message = (body as { message?: unknown }).message
  assertEquals(typeof message, 'string', 'expected a string `message` field')
  assert(
    typeof message === 'string' && !/^no Route matched/i.test(message),
    `Kong default 404 leaked through — Kong did not route to traffic-one (got: ${message})`
  )
  if (allowed.length > 0) {
    assert(
      typeof message === 'string' && allowed.includes(message),
      `expected message in [${allowed.join(', ')}], got: ${message}`
    )
  }
}

Deno.test('Kong → platform-organizations → GET /organizations returns array', async () => {
  const session = await getTestSession()
  const res = await fetch(`${PLATFORM_URL}/organizations`, {
    headers: authHeaders(session.access_token),
  })
  assertEquals(res.status, 200)
  const body = await res.json()
  assert(Array.isArray(body), 'expected an array of organizations')
})

Deno.test('Kong → platform-projects → GET /projects returns paginated list shape', async () => {
  const session = await getTestSession()
  const res = await fetch(`${PLATFORM_URL}/projects?limit=1`, {
    headers: authHeaders(session.access_token),
  })
  assertEquals(res.status, 200)
  const body = await res.json()
  assert(typeof body === 'object' && body !== null, 'expected paginated object')
  assert(
    'projects' in body || Array.isArray((body as { data?: unknown }).data),
    'expected projects[] or data[]'
  )
})

Deno.test('Kong → platform-projects-resource-warnings → GET returns array', async () => {
  const session = await getTestSession()
  const res = await fetch(`${PLATFORM_URL}/projects-resource-warnings`, {
    headers: authHeaders(session.access_token),
  })
  assertEquals(res.status, 200)
  const body = await res.json()
  assert(Array.isArray(body), 'expected an array (empty or otherwise)')
})

Deno.test(
  'Kong → platform-notifications → GET /notifications returns array (canonical mount)',
  async () => {
    const session = await getTestSession()
    const res = await fetch(`${PLATFORM_URL}/notifications`, {
      headers: authHeaders(session.access_token),
    })
    assertEquals(res.status, 200)
    const body = await res.json()
    assert(Array.isArray(body), 'expected a notifications array')
  }
)

Deno.test(
  'Kong → platform-telemetry → GET /telemetry/feature-flags returns empty map (unauth)',
  async () => {
    const res = await fetch(`${PLATFORM_URL}/telemetry/feature-flags`)
    assertEquals(res.status, 200)
    const body = await res.json()
    assert(body && typeof body === 'object' && !Array.isArray(body), 'expected an object')
  }
)

Deno.test(
  'Kong → platform-telemetry → POST /telemetry/event returns {success:true} (unauth)',
  async () => {
    const res = await fetch(`${PLATFORM_URL}/telemetry/event`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ event: 'smoke-test' }),
    })
    assertEquals(res.status, 200)
    const body = await res.json()
    assertEquals((body as { success?: boolean }).success, true)
  }
)

Deno.test('Kong → platform-stripe → GET /stripe/customer returns 200 shape', async () => {
  const session = await getTestSession()
  const res = await fetch(`${PLATFORM_URL}/stripe/customer?slug=does-not-exist`, {
    headers: authHeaders(session.access_token),
  })
  // Kong must route to traffic-one; the handler decides what 200 body to emit
  // (real Stripe off → stub customer; on → live lookup). Accept any 2xx/4xx
  // as long as the body originated from traffic-one.
  assert(res.status < 500, `unexpected 5xx: ${res.status}`)
  const body = await res.json()
  assert(body !== null && typeof body === 'object', 'expected JSON object')
  // If the handler returned a {message} error, it must not be Kong's default.
  if ('message' in (body as Record<string, unknown>)) {
    assertTrafficOneMessage(body, [])
  }
})

Deno.test(
  'Kong → platform-auth → GET /auth/{ref}/config returns traffic-one 404 for unknown ref',
  async () => {
    const session = await getTestSession()
    const res = await fetch(`${PLATFORM_URL}/auth/does-not-exist/config`, {
      headers: authHeaders(session.access_token),
    })
    assertEquals(res.status, 404)
    const body = await res.json()
    assertTrafficOneMessage(body, ['Project not found'])
  }
)

Deno.test(
  'Kong → platform-update-email → PUT /update-email validates body (not a Kong miss)',
  async () => {
    const session = await getTestSession()
    const res = await fetch(`${PLATFORM_URL}/update-email`, {
      method: 'PUT',
      headers: authHeaders(session.access_token),
      body: JSON.stringify({}),
    })
    // Handler rejects empty body with 400 (or succeeds with 200 on some
    // environments); either way it must NOT be a Kong "no Route matched".
    assert(res.status < 500, `unexpected 5xx: ${res.status}`)
    const body = await res.json()
    if ('message' in (body as Record<string, unknown>)) {
      assertTrafficOneMessage(body, [])
    }
  }
)

Deno.test(
  'Kong → platform-database → GET /database/{ref}/backups returns traffic-one 404 for unknown ref',
  async () => {
    const session = await getTestSession()
    const res = await fetch(`${PLATFORM_URL}/database/does-not-exist/backups`, {
      headers: authHeaders(session.access_token),
    })
    // Accept 200 (some builds return empty) or 404 (project-scoped 404).
    assert(res.status === 200 || res.status === 404, `unexpected status: ${res.status}`)
    const body = await res.json()
    if (res.status === 404) {
      assertTrafficOneMessage(body, ['Project not found', 'Not Found', 'Not found'])
    }
  }
)

Deno.test(
  'Kong → platform-replication → GET /replication/{ref}/sources returns traffic-one shape',
  async () => {
    const session = await getTestSession()
    const res = await fetch(`${PLATFORM_URL}/replication/does-not-exist/sources`, {
      headers: authHeaders(session.access_token),
    })
    assert(res.status < 500, `unexpected 5xx: ${res.status}`)
    const body = await res.json()
    // Read-only stub returns [] for any ref; some routes 404 when project
    // membership is checked. Either is fine — verify it's traffic-one.
    if (!Array.isArray(body) && 'message' in (body as Record<string, unknown>)) {
      assertTrafficOneMessage(body, [])
    }
  }
)

Deno.test('Kong → platform-feedback → POST /feedback/send returns traffic-one shape', async () => {
  const session = await getTestSession()
  const res = await fetch(`${PLATFORM_URL}/feedback/send`, {
    method: 'POST',
    headers: authHeaders(session.access_token),
    body: JSON.stringify({}),
  })
  // Handler will either accept empty and 201, or reject with 400 — both are
  // traffic-one responses.
  assert(res.status < 500, `unexpected 5xx: ${res.status}`)
  const body = await res.json()
  if ('message' in (body as Record<string, unknown>)) {
    assertTrafficOneMessage(body, [])
  }
})

Deno.test('Kong → platform-cli → POST /cli/login issues a scoped access token', async () => {
  const session = await getTestSession()
  const res = await fetch(`${PLATFORM_URL}/cli/login`, {
    method: 'POST',
    headers: authHeaders(session.access_token),
    body: JSON.stringify({ token_name: `smoke-cli-${Date.now()}` }),
  })
  assertEquals(res.status, 201)
  const body = await res.json()
  assertExists((body as { id?: unknown }).id)
  assertExists((body as { token?: unknown }).token)

  // Clean up so the smoke test doesn't pile up scoped tokens across runs.
  const id = (body as { id: string }).id
  await fetch(`${PROFILE_URL}/scoped-access-tokens/${id}`, {
    method: 'DELETE',
    headers: authHeaders(session.access_token),
  }).then((r) => r.body?.cancel())
})

Deno.test(
  'Kong → v1-organizations → GET /v1/organizations/{slug}/project-claim/{token} returns traffic-one 404',
  async () => {
    const session = await getTestSession()
    const res = await fetch(
      `${V1_URL}/organizations/definitely-not-an-org/project-claim/fake-token`,
      { headers: authHeaders(session.access_token) }
    )
    assertEquals(res.status, 404)
    const body = await res.json()
    assertTrafficOneMessage(body, ['Organization not found'])
  }
)

Deno.test(
  'Kong → v1-branches → GET /v1/branches/{uuid}/diff returns traffic-one 404 for unknown branch',
  async () => {
    const session = await getTestSession()
    // Well-formed but not-in-DB UUID — exercises the valid-UUID path, so we
    // get the "Branch not found" branch instead of the invalid-UUID branch.
    const missingUuid = '00000000-0000-4000-8000-000000000000'
    const res = await fetch(`${V1_URL}/branches/${missingUuid}/diff`, {
      headers: authHeaders(session.access_token),
    })
    assertEquals(res.status, 404)
    const body = await res.json()
    assertTrafficOneMessage(body, ['Branch not found'])
  }
)

Deno.test(
  'Kong → v1-projects → GET /v1/projects/{ref}/health returns traffic-one 404 for unknown ref',
  async () => {
    const session = await getTestSession()
    const res = await fetch(`${V1_URL}/projects/does-not-exist/health`, {
      headers: authHeaders(session.access_token),
    })
    assertEquals(res.status, 404)
    const body = await res.json()
    assertTrafficOneMessage(body, ['Project not found'])
  }
)
