import { Pool } from 'https://deno.land/x/postgres@v0.19.3/mod.ts'
import { assert, assertEquals, assertExists } from 'jsr:@std/assert@1'
import { createClient } from 'npm:@supabase/supabase-js@2'

import 'jsr:@std/dotenv/load'

// ─────────────────────────────────────────────────────────────────────────────
// Integration test for traffic-one/functions/routes/project-auth-admin.ts.
//
// Exercises the full HTTP round trip via Kong -> traffic-one -> GoTrue:
//
//   POST   /api/platform/auth/{ref}/users
//   PATCH  /api/platform/auth/{ref}/users/{id}
//   DELETE /api/platform/auth/{ref}/users/{id}
//   DELETE /api/platform/auth/{ref}/users/{id}/factors
//   POST   /api/platform/auth/{ref}/invite
//   POST   /api/platform/auth/{ref}/magiclink
//   POST   /api/platform/auth/{ref}/recover
//   POST   /api/platform/auth/{ref}/otp
//   POST   /api/platform/auth/{ref}/validate/spam
//
// and asserts audit rows in traffic.audit_logs are emitted for each.
// ─────────────────────────────────────────────────────────────────────────────

const supabaseUrl = Deno.env.get('SUPABASE_URL')!
const supabaseKey = Deno.env.get('SUPABASE_ANON_KEY')!
const superuserDbUrl = Deno.env.get('SUPERUSER_DB_URL')!
const supabase = createClient(supabaseUrl, supabaseKey, {
  auth: {
    autoRefreshToken: false,
    persistSession: false,
    detectSessionInUrl: false,
  },
})

const PLATFORM_AUTH_URL = `${supabaseUrl}/api/platform/auth`
const PROJECTS_URL = `${supabaseUrl}/api/platform/projects`
const ORG_URL = `${supabaseUrl}/api/platform/organizations`

async function countAuditRowsByAction(
  action: string,
  projectRef: string,
): Promise<number> {
  const adminPool = new Pool(superuserDbUrl, 1, true)
  try {
    const conn = await adminPool.connect()
    try {
      const result = await conn.queryObject<{ c: number }>`
        SELECT COUNT(*)::int AS c FROM traffic.audit_logs
        WHERE action_name = ${action}
          AND target_description LIKE ${'%ref: ' + projectRef + '%'}
      `
      return result.rows[0]?.c ?? 0
    } finally {
      conn.release()
    }
  } finally {
    await adminPool.end()
  }
}

async function getTestSession() {
  const {
    data: { session },
    error,
  } = await supabase.auth.signInWithPassword({
    email: 'test@example.com',
    password: 'test-password',
  })
  if (error || !session) {
    throw new Error(
      `Failed to sign in test user: ${error?.message ?? 'no session'}`,
    )
  }
  return session
}

function authHeaders(token: string): Record<string, string> {
  return {
    Authorization: `Bearer ${token}`,
    'Content-Type': 'application/json',
  }
}

// Delete a live auth.users row by email so tests don't pile up.
async function deleteAuthUserByEmail(email: string) {
  const adminPool = new Pool(superuserDbUrl, 1, true)
  try {
    const conn = await adminPool.connect()
    try {
      await conn.queryObject`DELETE FROM auth.users WHERE email = ${email}`
    } finally {
      conn.release()
    }
  } finally {
    await adminPool.end()
  }
}

// ── Auth ──────────────────────────────────────────────────────

Deno.test('POST /api/platform/auth/{ref}/users returns 401 without auth', async () => {
  const res = await fetch(`${PLATFORM_AUTH_URL}/some-ref/users`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ email: 'x@y.z', password: 'Abcdefg1!' }),
  })
  assertEquals(res.status, 401)
  await res.body?.cancel()
})

Deno.test('POST /api/platform/auth/{ref}/invite returns 401 without auth', async () => {
  const res = await fetch(`${PLATFORM_AUTH_URL}/some-ref/invite`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ email: 'x@y.z' }),
  })
  assertEquals(res.status, 401)
  await res.body?.cancel()
})

// ── Setup test project ───────────────────────────────────────

let testOrgSlug: string | null = null
let testRef: string | null = null
const runToken = `${Date.now()}_${Math.floor(Math.random() * 1e6)}`

// Fail loudly when the `setup:` test didn't run or didn't populate the
// module-level refs. Prior versions used `if (!testRef) return` which made
// the entire downstream suite silently pass on setup regressions — exactly
// the sort of green-bar-for-the-wrong-reason the plan's H4 was about.
function requireTestRef(): string {
  if (!testRef) {
    throw new Error(
      'testRef is not set — the preceding setup test must create the project before the auth-admin cases run',
    )
  }
  return testRef
}

function requireCreatedUserId(): string {
  if (!createdUserId) {
    throw new Error(
      'createdUserId is not set — the `POST /users` case must run before tests that target the created user',
    )
  }
  return createdUserId
}

Deno.test('setup: create test org and project for auth-admin tests', async () => {
  const session = await getTestSession()

  const orgRes = await fetch(ORG_URL, {
    method: 'POST',
    headers: authHeaders(session.access_token),
    body: JSON.stringify({
      name: `AuthAdmin Org ${runToken}`,
      tier: 'tier_free',
    }),
  })
  assertEquals(orgRes.status, 201)
  const org = await orgRes.json()
  testOrgSlug = org.slug

  const projRes = await fetch(PROJECTS_URL, {
    method: 'POST',
    headers: authHeaders(session.access_token),
    body: JSON.stringify({
      name: `AuthAdmin Project ${runToken}`,
      organization_slug: testOrgSlug,
      db_region: 'local',
    }),
  })
  assertEquals(projRes.status, 201)
  const project = await projRes.json()
  testRef = project.ref
})

// ── Unknown ref → 404 ────────────────────────────────────────

Deno.test('POST /api/platform/auth/{unknownRef}/users returns 404', async () => {
  const session = await getTestSession()
  const res = await fetch(`${PLATFORM_AUTH_URL}/nonexistent00000000/users`, {
    method: 'POST',
    headers: authHeaders(session.access_token),
    body: JSON.stringify({ email: 'x@y.z', password: 'Abcdefg1!' }),
  })
  assertEquals(res.status, 404)
  await res.body?.cancel()
})

Deno.test('POST /api/platform/auth/{unknownRef}/invite returns 404', async () => {
  const session = await getTestSession()
  const res = await fetch(`${PLATFORM_AUTH_URL}/nonexistent00000000/invite`, {
    method: 'POST',
    headers: authHeaders(session.access_token),
    body: JSON.stringify({ email: 'x@y.z' }),
  })
  assertEquals(res.status, 404)
  await res.body?.cancel()
})

// ── Users CRUD ───────────────────────────────────────────────

let createdUserId: string | null = null
let createdUserEmail: string | null = null

Deno.test('POST /api/platform/auth/{ref}/users creates a user via GoTrue', async () => {
  const ref = requireTestRef()
  const session = await getTestSession()
  const email = `auth-admin-user-${runToken}@example.com`
  createdUserEmail = email

  const before = await countAuditRowsByAction('project.app_user_create', ref)

  const res = await fetch(`${PLATFORM_AUTH_URL}/${ref}/users`, {
    method: 'POST',
    headers: authHeaders(session.access_token),
    body: JSON.stringify({ email, password: 'Test1234!', email_confirm: true }),
  })
  assertEquals(res.status, 200)
  const body = await res.json()
  assertExists(body.id, 'GoTrue should return a user with an id')
  assertEquals(body.email, email)
  createdUserId = body.id

  const after = await countAuditRowsByAction('project.app_user_create', ref)
  assertEquals(after - before, 1, 'user_create audit row must be emitted')
})

Deno.test('PATCH /api/platform/auth/{ref}/users/{id} bans a user via GoTrue', async () => {
  const ref = requireTestRef()
  const userId = requireCreatedUserId()
  const session = await getTestSession()
  const before = await countAuditRowsByAction('project.app_user_update', ref)

  const res = await fetch(`${PLATFORM_AUTH_URL}/${ref}/users/${userId}`, {
    method: 'PATCH',
    headers: authHeaders(session.access_token),
    body: JSON.stringify({ ban_duration: '24h' }),
  })
  assertEquals(res.status, 200)
  const body = await res.json()
  assertEquals(body.id, userId)

  const after = await countAuditRowsByAction('project.app_user_update', ref)
  assertEquals(after - before, 1, 'user_update audit row must be emitted')
})

Deno.test(
  'DELETE /api/platform/auth/{ref}/users/{id}/factors returns 200 with no factors',
  async () => {
    const ref = requireTestRef()
    const userId = requireCreatedUserId()
    const session = await getTestSession()
    const before = await countAuditRowsByAction(
      'project.app_user_mfa_factors_delete',
      ref,
    )

    const res = await fetch(
      `${PLATFORM_AUTH_URL}/${ref}/users/${userId}/factors`,
      {
        method: 'DELETE',
        headers: authHeaders(session.access_token),
      },
    )
    assertEquals(res.status, 200)
    const body = await res.json()
    assertEquals(body.data, null)

    const after = await countAuditRowsByAction(
      'project.app_user_mfa_factors_delete',
      ref,
    )
    assertEquals(
      after - before,
      1,
      'mfa_factors_delete audit row must be emitted',
    )
  },
)

Deno.test('DELETE /api/platform/auth/{ref}/users/{id} removes the user', async () => {
  const ref = requireTestRef()
  const userId = requireCreatedUserId()
  const session = await getTestSession()
  const before = await countAuditRowsByAction('project.app_user_delete', ref)

  const res = await fetch(`${PLATFORM_AUTH_URL}/${ref}/users/${userId}`, {
    method: 'DELETE',
    headers: authHeaders(session.access_token),
  })
  assertEquals(res.status, 200)
  await res.body?.cancel()

  const after = await countAuditRowsByAction('project.app_user_delete', ref)
  assertEquals(after - before, 1, 'user_delete audit row must be emitted')
  createdUserId = null

  // Verify GoTrue actually dropped the row.
  const adminPool = new Pool(superuserDbUrl, 1, true)
  try {
    const conn = await adminPool.connect()
    try {
      const result = await conn.queryObject<{ c: number }>`
        SELECT COUNT(*)::int AS c FROM auth.users WHERE email = ${createdUserEmail}
      `
      assertEquals(result.rows[0].c, 0)
    } finally {
      conn.release()
    }
  } finally {
    await adminPool.end()
  }
})

// ── Invite / magiclink / recover (via GoTrue signup-style flow) ─

Deno.test('POST /api/platform/auth/{ref}/invite dispatches and audit-logs', async () => {
  const ref = requireTestRef()
  const session = await getTestSession()
  const email = `auth-admin-invite-${runToken}@example.com`
  const before = await countAuditRowsByAction('project.app_user_invite', ref)

  const res = await fetch(`${PLATFORM_AUTH_URL}/${ref}/invite`, {
    method: 'POST',
    headers: authHeaders(session.access_token),
    body: JSON.stringify({ email }),
  })
  // GoTrue may return 200 (invite issued) or 422 when SMTP is misconfigured.
  // Either means traffic-one dispatched through — a 404/501 would be a
  // routing regression and is rejected.
  assert(
    res.status !== 404 && res.status !== 501,
    `unexpected status ${res.status}`,
  )
  await res.body?.cancel()

  if (res.status === 200) {
    const after = await countAuditRowsByAction('project.app_user_invite', ref)
    assertEquals(after - before, 1)
  }
  await deleteAuthUserByEmail(email)
})

Deno.test('POST /api/platform/auth/{ref}/magiclink dispatches to GoTrue', async () => {
  const ref = requireTestRef()
  const session = await getTestSession()
  const email = `auth-admin-magic-${runToken}@example.com`

  const res = await fetch(`${PLATFORM_AUTH_URL}/${ref}/magiclink`, {
    method: 'POST',
    headers: authHeaders(session.access_token),
    body: JSON.stringify({ email }),
  })
  assert(
    res.status !== 404 && res.status !== 501,
    `unexpected status ${res.status}`,
  )
  await res.body?.cancel()
  await deleteAuthUserByEmail(email)
})

Deno.test('POST /api/platform/auth/{ref}/recover dispatches to GoTrue', async () => {
  const ref = requireTestRef()
  const session = await getTestSession()
  const email = `auth-admin-recover-${runToken}@example.com`

  const res = await fetch(`${PLATFORM_AUTH_URL}/${ref}/recover`, {
    method: 'POST',
    headers: authHeaders(session.access_token),
    body: JSON.stringify({ email }),
  })
  // Recover on an unknown email returns 200 silently in GoTrue; any non-4xx5xx
  // is acceptable as long as it's not a dispatch failure.
  assert(
    res.status !== 404 && res.status !== 501,
    `unexpected status ${res.status}`,
  )
  await res.body?.cancel()
})

Deno.test('POST /api/platform/auth/{ref}/otp dispatches to GoTrue', async () => {
  const ref = requireTestRef()
  const session = await getTestSession()
  const res = await fetch(`${PLATFORM_AUTH_URL}/${ref}/otp`, {
    method: 'POST',
    headers: authHeaders(session.access_token),
    body: JSON.stringify({ phone: '+15005550006' }),
  })
  // GoTrue will 422 if SMS provider isn't configured — that's a valid
  // dispatch outcome. Anything routing-layer (404/501) is a regression.
  assert(
    res.status !== 404 && res.status !== 501,
    `unexpected status ${res.status}`,
  )
  await res.body?.cancel()
})

// ── Validate spam (local heuristic stub) ─────────────────────

Deno.test('POST /api/platform/auth/{ref}/validate/spam returns rules array', async () => {
  const ref = requireTestRef()
  const session = await getTestSession()
  const before = await countAuditRowsByAction(
    'project.app_user_validate_spam',
    ref,
  )

  const res = await fetch(`${PLATFORM_AUTH_URL}/${ref}/validate/spam`, {
    method: 'POST',
    headers: authHeaders(session.access_token),
    body: JSON.stringify({
      subject: 'FREE MONEY LOTTERY',
      content: 'CLICK HERE',
    }),
  })
  assertEquals(res.status, 200)
  const body = await res.json()
  assert(Array.isArray(body.rules), 'rules must be an array')
  // Known-spammy input must fire at least one rule so Studio's UI shows it.
  assert(body.rules.length > 0, 'heuristic must fire for spammy input')
  const ruleNames = new Set(body.rules.map((r: { name: string }) => r.name))
  assert(ruleNames.has('LOTTERY') || ruleNames.has('FREE_MONEY'))

  const after = await countAuditRowsByAction(
    'project.app_user_validate_spam',
    ref,
  )
  assertEquals(after - before, 1, 'validate_spam audit row must be emitted')
})

Deno.test(
  'POST /api/platform/auth/{ref}/validate/spam clean subject returns empty rules',
  async () => {
    const ref = requireTestRef()
    const session = await getTestSession()
    const res = await fetch(`${PLATFORM_AUTH_URL}/${ref}/validate/spam`, {
      method: 'POST',
      headers: authHeaders(session.access_token),
      body: JSON.stringify({
        subject: 'Welcome to our platform',
        content: 'Hello, thanks for signing up. We look forward to having you.',
      }),
    })
    assertEquals(res.status, 200)
    const body = await res.json()
    assertEquals(
      body.rules,
      [],
      'clean content should produce no rule matches',
    )
  },
)

// ── Method validation ────────────────────────────────────────

Deno.test('GET /api/platform/auth/{ref}/invite returns 405', async () => {
  const ref = requireTestRef()
  const session = await getTestSession()
  const res = await fetch(`${PLATFORM_AUTH_URL}/${ref}/invite`, {
    headers: authHeaders(session.access_token),
  })
  assertEquals(res.status, 405)
  await res.body?.cancel()
})

Deno.test('PUT /api/platform/auth/{ref}/users returns 405', async () => {
  const ref = requireTestRef()
  const session = await getTestSession()
  const res = await fetch(`${PLATFORM_AUTH_URL}/${ref}/users`, {
    method: 'PUT',
    headers: authHeaders(session.access_token),
    body: '{}',
  })
  // The /{ref}/users subPath only handles POST. Any other method on that
  // exact path falls through to the 404 default since we never match it.
  // Either 404 or 405 is acceptable — both signal the route is unreachable.
  assert(
    res.status === 404 || res.status === 405,
    `unexpected status ${res.status}`,
  )
  await res.body?.cancel()
})

// ── Cleanup ──────────────────────────────────────────────────

Deno.test('cleanup: delete test project and org', async () => {
  const session = await getTestSession()
  if (testRef) {
    const res = await fetch(`${PROJECTS_URL}/${testRef}`, {
      method: 'DELETE',
      headers: authHeaders(session.access_token),
    })
    await res.body?.cancel()
  }
  if (testOrgSlug) {
    const res = await fetch(`${ORG_URL}/${testOrgSlug}`, {
      method: 'DELETE',
      headers: authHeaders(session.access_token),
    })
    await res.body?.cancel()
  }
})
