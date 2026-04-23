import { Pool } from 'https://deno.land/x/postgres@v0.17.0/mod.ts'
import { assert, assertEquals, assertExists } from 'jsr:@std/assert@1'
import { createClient } from 'npm:@supabase/supabase-js@2'

import 'jsr:@std/dotenv/load'

const supabaseUrl = Deno.env.get('SUPABASE_URL')!
const supabaseKey = Deno.env.get('SUPABASE_ANON_KEY')!
const superuserDbUrl = Deno.env.get('SUPERUSER_DB_URL')!

const supabase = createClient(supabaseUrl, supabaseKey, {
  auth: { autoRefreshToken: false, persistSession: false, detectSessionInUrl: false },
})

const V1_PROJECTS_URL = `${supabaseUrl}/api/v1/projects`
const PROJECTS_URL = `${supabaseUrl}/api/platform/projects`
const ORG_URL = `${supabaseUrl}/api/platform/organizations`
const SIGNUP_URL = `${supabaseUrl}/api/platform/signup`

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

// Sign up a disposable second user we use for cross-user (non-member) tests.
// Mirrors the pattern in update-email-test.ts so we can force-confirm the
// account and sign in immediately even when ENABLE_EMAIL_AUTOCONFIRM is false.
async function signUpDisposableUser(): Promise<{ email: string; password: string }> {
  const email = `apikeys-other-${Date.now()}-${Math.floor(Math.random() * 1e6)}@example.com`
  const password = 'Test1234!'

  const res = await fetch(SIGNUP_URL, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({
      email,
      password,
      hcaptchaToken: null,
      redirectTo: 'http://localhost:8000',
    }),
  })
  await res.body?.cancel()
  assert(res.status === 201 || res.status === 200, `signup failed: ${res.status}`)

  const adminPool = new Pool(superuserDbUrl, 1, true)
  try {
    const connection = await adminPool.connect()
    try {
      await connection.queryObject`
        UPDATE auth.users
        SET email_confirmed_at = COALESCE(email_confirmed_at, now()),
            confirmed_at = COALESCE(confirmed_at, now())
        WHERE email = ${email}
      `
    } finally {
      connection.release()
    }
  } finally {
    await adminPool.end()
  }

  return { email, password }
}

async function signIn(email: string, password: string) {
  const {
    data: { session },
    error,
  } = await supabase.auth.signInWithPassword({
    email,
    password,
  })
  if (error || !session) {
    throw new Error(`sign-in failed for ${email}: ${error?.message ?? 'no session'}`)
  }
  return session
}

async function countAuditRowsByAction(action: string, projectRef: string): Promise<number> {
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

// ── Auth ─────────────────────────────────────────────────

Deno.test('GET /v1/projects/{ref}/api-keys returns 401 without auth', async () => {
  const res = await fetch(`${V1_PROJECTS_URL}/some-ref/api-keys`)
  assertEquals(res.status, 401)
  await res.body?.cancel()
})

Deno.test('POST /v1/projects/{ref}/api-keys returns 401 without auth', async () => {
  const res = await fetch(`${V1_PROJECTS_URL}/some-ref/api-keys`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ name: 'x', type: 'secret' }),
  })
  assertEquals(res.status, 401)
  await res.body?.cancel()
})

Deno.test('GET /v1/projects/{ref}/config/auth/signing-keys returns 401 without auth', async () => {
  const res = await fetch(`${V1_PROJECTS_URL}/some-ref/config/auth/signing-keys`)
  assertEquals(res.status, 401)
  await res.body?.cancel()
})

// ── Setup test project ──────────────────────────────────

let testOrgSlug: string | null = null
let testRef: string | null = null

Deno.test('setup: create test org and project for api-keys tests', async () => {
  const session = await getTestSession()

  const orgName = `Api Keys Test Org ${Date.now()}`
  const orgRes = await fetch(ORG_URL, {
    method: 'POST',
    headers: authHeaders(session.access_token),
    body: JSON.stringify({ name: orgName, tier: 'tier_free' }),
  })
  assertEquals(orgRes.status, 201)
  const org = await orgRes.json()
  testOrgSlug = org.slug

  const projectName = `Api Keys Test Project ${Date.now()}`
  const projRes = await fetch(PROJECTS_URL, {
    method: 'POST',
    headers: authHeaders(session.access_token),
    body: JSON.stringify({
      name: projectName,
      organization_slug: testOrgSlug,
      db_region: 'local',
    }),
  })
  assertEquals(projRes.status, 201)
  const project = await projRes.json()
  testRef = project.ref
})

// ── Unknown ref → 404 ────────────────────────────────────

Deno.test('GET /v1/projects/{unknownRef}/api-keys returns 404', async () => {
  const session = await getTestSession()
  const res = await fetch(`${V1_PROJECTS_URL}/nonexistent00000000/api-keys`, {
    headers: authHeaders(session.access_token),
  })
  assertEquals(res.status, 404)
  await res.body?.cancel()
})

// ── POST creates + returns plaintext exactly once ────────

let createdApiKeyId: number | null = null

Deno.test('POST /v1/projects/{ref}/api-keys creates key and returns plaintext once', async () => {
  if (!testRef) return
  const session = await getTestSession()

  const res = await fetch(`${V1_PROJECTS_URL}/${testRef}/api-keys`, {
    method: 'POST',
    headers: authHeaders(session.access_token),
    body: JSON.stringify({
      name: 'ci-secret',
      description: 'used by CI',
      type: 'secret',
      tags: ['ci'],
    }),
  })
  assertEquals(res.status, 201)

  const body = await res.json()
  assertExists(body.id)
  assertEquals(body.name, 'ci-secret')
  assertEquals(body.description, 'used by CI')
  assertEquals(body.type, 'secret')
  assert(Array.isArray(body.tags))
  assert(body.tags.includes('ci'))
  assertExists(body.api_key)
  assert(
    typeof body.api_key === 'string' && body.api_key.startsWith('sb_secret_'),
    'plaintext api_key should be returned on create with sb_secret_ prefix'
  )
  assertExists(body.api_key_alias)
  assert(body.api_key_alias !== body.api_key, 'alias must differ from plaintext')
  assert(body.api_key_alias.includes('...'), "alias should use '...' as the ellipsis")

  createdApiKeyId = body.id
})

Deno.test('POST /v1/projects/{ref}/api-keys rejects missing name', async () => {
  if (!testRef) return
  const session = await getTestSession()
  const res = await fetch(`${V1_PROJECTS_URL}/${testRef}/api-keys`, {
    method: 'POST',
    headers: authHeaders(session.access_token),
    body: JSON.stringify({ type: 'secret' }),
  })
  assertEquals(res.status, 400)
  await res.body?.cancel()
})

Deno.test('POST /v1/projects/{ref}/api-keys rejects invalid type', async () => {
  if (!testRef) return
  const session = await getTestSession()
  const res = await fetch(`${V1_PROJECTS_URL}/${testRef}/api-keys`, {
    method: 'POST',
    headers: authHeaders(session.access_token),
    body: JSON.stringify({ name: 'x', type: 'bogus' }),
  })
  assertEquals(res.status, 400)
  await res.body?.cancel()
})

// ── Subsequent GET omits plaintext ───────────────────────

Deno.test('GET /v1/projects/{ref}/api-keys lists metadata without plaintext', async () => {
  if (!testRef || createdApiKeyId === null) return
  const session = await getTestSession()
  const res = await fetch(`${V1_PROJECTS_URL}/${testRef}/api-keys`, {
    headers: authHeaders(session.access_token),
  })
  assertEquals(res.status, 200)

  const body = await res.json()
  assert(Array.isArray(body))
  const found = body.find((k: { id: number }) => k.id === createdApiKeyId)
  assertExists(found, 'created key should appear in list')
  assertEquals(found.name, 'ci-secret')
  assertEquals(found.type, 'secret')
  assertExists(found.api_key_alias)
  assertEquals(found.api_key, undefined, 'plaintext api_key must not be returned on list')
})

Deno.test(
  'GET /v1/projects/{ref}/api-keys/{id} returns single key metadata without plaintext',
  async () => {
    if (!testRef || createdApiKeyId === null) return
    const session = await getTestSession()
    const res = await fetch(`${V1_PROJECTS_URL}/${testRef}/api-keys/${createdApiKeyId}`, {
      headers: authHeaders(session.access_token),
    })
    assertEquals(res.status, 200)
    const body = await res.json()
    assertEquals(body.id, createdApiKeyId)
    assertEquals(body.api_key, undefined, 'plaintext api_key must not be returned on detail read')
  }
)

// ── PATCH description update ─────────────────────────────

Deno.test('PATCH /v1/projects/{ref}/api-keys/{id} updates description', async () => {
  if (!testRef || createdApiKeyId === null) return
  const session = await getTestSession()
  const before = await countAuditRowsByAction('project.api_key_updated', testRef)

  const res = await fetch(`${V1_PROJECTS_URL}/${testRef}/api-keys/${createdApiKeyId}`, {
    method: 'PATCH',
    headers: authHeaders(session.access_token),
    body: JSON.stringify({ description: 'updated by test' }),
  })
  assertEquals(res.status, 200)
  const body = await res.json()
  assertEquals(body.description, 'updated by test')

  const after = await countAuditRowsByAction('project.api_key_updated', testRef)
  assertEquals(after - before, 1, 'PATCH must emit one project.api_key_updated audit row')
})

// ── DELETE removes (soft-delete excludes from list) ──────

Deno.test('DELETE /v1/projects/{ref}/api-keys/{id} removes the key', async () => {
  if (!testRef || createdApiKeyId === null) return
  const session = await getTestSession()
  const res = await fetch(`${V1_PROJECTS_URL}/${testRef}/api-keys/${createdApiKeyId}`, {
    method: 'DELETE',
    headers: authHeaders(session.access_token),
  })
  assertEquals(res.status, 200)

  const listRes = await fetch(`${V1_PROJECTS_URL}/${testRef}/api-keys`, {
    headers: authHeaders(session.access_token),
  })
  const list = await listRes.json()
  const found = list.find((k: { id: number }) => k.id === createdApiKeyId)
  assertEquals(found, undefined, 'deleted key must not appear in active list')

  const detailRes = await fetch(`${V1_PROJECTS_URL}/${testRef}/api-keys/${createdApiKeyId}`, {
    headers: authHeaders(session.access_token),
  })
  assertEquals(detailRes.status, 404)
  await detailRes.body?.cancel()
})

// ── /api-keys/legacy ─────────────────────────────────────

Deno.test(
  'GET /v1/projects/{ref}/api-keys/legacy returns env-derived anon + service keys',
  async () => {
    if (!testRef) return
    const session = await getTestSession()
    const res = await fetch(`${V1_PROJECTS_URL}/${testRef}/api-keys/legacy`, {
      headers: authHeaders(session.access_token),
    })
    assertEquals(res.status, 200)
    const body = await res.json()
    assert(Array.isArray(body))
    assertEquals(body.length, 2)

    const anon = body.find((k: { name: string }) => k.name === 'anon')
    const service = body.find((k: { name: string }) => k.name === 'service_role')
    assertExists(anon)
    assertExists(service)
    assertEquals(typeof anon.api_key, 'string')
    assertEquals(typeof service.api_key, 'string')
    assert(anon.tags.includes('anon'))
    assert(service.tags.includes('service_role'))
  }
)

Deno.test(
  'PUT /v1/projects/{ref}/api-keys/legacy returns 501 self_hosted_unsupported',
  async () => {
    if (!testRef) return
    const session = await getTestSession()
    const res = await fetch(`${V1_PROJECTS_URL}/${testRef}/api-keys/legacy`, {
      method: 'PUT',
      headers: authHeaders(session.access_token),
      body: '{}',
    })
    assertEquals(res.status, 501)
    const body = await res.json()
    assertEquals(body.code, 'self_hosted_unsupported')
    assertExists(body.message)
  }
)

// ── /api-keys/temporary ──────────────────────────────────

Deno.test('POST /platform/projects/{ref}/api-keys/temporary returns short-lived key', async () => {
  if (!testRef) return
  const session = await getTestSession()
  const res = await fetch(`${PROJECTS_URL}/${testRef}/api-keys/temporary`, {
    method: 'POST',
    headers: authHeaders(session.access_token),
    body: JSON.stringify({ ttl_seconds: 120 }),
  })
  assertEquals(res.status, 201)
  const body = await res.json()
  assertExists(body.api_key)
  assert(
    typeof body.api_key === 'string' && body.api_key.startsWith('sb_temp_'),
    'temporary key should carry sb_temp_ prefix'
  )
  assertExists(body.api_key_alias)
  assertExists(body.expires_at)
  assertEquals(body.type, 'secret')

  const expiresMs = Date.parse(body.expires_at)
  assert(!Number.isNaN(expiresMs))
  assert(expiresMs > Date.now(), 'expires_at must be in the future')
})

// ── Signing keys ─────────────────────────────────────────

let signingKeyAId: number | null = null
let signingKeyBId: number | null = null

Deno.test('POST /v1/projects/{ref}/config/auth/signing-keys creates first in_use key', async () => {
  if (!testRef) return
  const session = await getTestSession()
  const res = await fetch(`${V1_PROJECTS_URL}/${testRef}/config/auth/signing-keys`, {
    method: 'POST',
    headers: authHeaders(session.access_token),
    body: JSON.stringify({
      algorithm: 'HS256',
      status: 'in_use',
      public_jwk: { kty: 'oct', alg: 'HS256', kid: 'key-a' },
    }),
  })
  assertEquals(res.status, 201)
  const body = await res.json()
  assertExists(body.id)
  assertEquals(body.algorithm, 'HS256')
  assertEquals(body.status, 'in_use')
  signingKeyAId = body.id
})

Deno.test(
  'POST /v1/projects/{ref}/config/auth/signing-keys rejects missing algorithm',
  async () => {
    if (!testRef) return
    const session = await getTestSession()
    const res = await fetch(`${V1_PROJECTS_URL}/${testRef}/config/auth/signing-keys`, {
      method: 'POST',
      headers: authHeaders(session.access_token),
      body: JSON.stringify({ status: 'standby' }),
    })
    assertEquals(res.status, 400)
    await res.body?.cancel()
  }
)

Deno.test('POST second in_use signing key demotes the previous one (active swap)', async () => {
  if (!testRef || signingKeyAId === null) return
  const session = await getTestSession()

  const res = await fetch(`${V1_PROJECTS_URL}/${testRef}/config/auth/signing-keys`, {
    method: 'POST',
    headers: authHeaders(session.access_token),
    body: JSON.stringify({
      algorithm: 'HS256',
      active: true,
      public_jwk: { kty: 'oct', alg: 'HS256', kid: 'key-b' },
    }),
  })
  assertEquals(res.status, 201)
  const bodyB = await res.json()
  assertEquals(bodyB.status, 'in_use')
  signingKeyBId = bodyB.id

  const listRes = await fetch(`${V1_PROJECTS_URL}/${testRef}/config/auth/signing-keys`, {
    headers: authHeaders(session.access_token),
  })
  assertEquals(listRes.status, 200)
  const list = await listRes.json()
  assert(Array.isArray(list))
  const inUse = list.filter((k: { status: string }) => k.status === 'in_use')
  assertEquals(inUse.length, 1, 'exactly one signing key must be in_use per project')
  assertEquals(inUse[0].id, signingKeyBId)

  const previous = list.find((k: { id: number }) => k.id === signingKeyAId)
  assertExists(previous)
  assertEquals(previous.status, 'previously_used')
})

Deno.test('GET /v1/projects/{ref}/config/auth/signing-keys/{id} returns single key', async () => {
  if (!testRef || signingKeyBId === null) return
  const session = await getTestSession()
  const res = await fetch(
    `${V1_PROJECTS_URL}/${testRef}/config/auth/signing-keys/${signingKeyBId}`,
    { headers: authHeaders(session.access_token) }
  )
  assertEquals(res.status, 200)
  const body = await res.json()
  assertEquals(body.id, signingKeyBId)
  assertEquals(body.status, 'in_use')
})

Deno.test(
  'PATCH /v1/projects/{ref}/config/auth/signing-keys/{id} swaps active key back to A',
  async () => {
    if (!testRef || signingKeyAId === null || signingKeyBId === null) return
    const session = await getTestSession()

    const res = await fetch(
      `${V1_PROJECTS_URL}/${testRef}/config/auth/signing-keys/${signingKeyAId}`,
      {
        method: 'PATCH',
        headers: authHeaders(session.access_token),
        body: JSON.stringify({ active: true }),
      }
    )
    assertEquals(res.status, 200)
    const body = await res.json()
    assertEquals(body.status, 'in_use')

    const listRes = await fetch(`${V1_PROJECTS_URL}/${testRef}/config/auth/signing-keys`, {
      headers: authHeaders(session.access_token),
    })
    const list = await listRes.json()
    const inUse = list.filter((k: { status: string }) => k.status === 'in_use')
    assertEquals(inUse.length, 1)
    assertEquals(inUse[0].id, signingKeyAId)

    const other = list.find((k: { id: number }) => k.id === signingKeyBId)
    assertEquals(other.status, 'previously_used')
  }
)

Deno.test('DELETE /v1/projects/{ref}/config/auth/signing-keys/{id} revokes the key', async () => {
  if (!testRef || signingKeyBId === null) return
  const session = await getTestSession()
  const before = await countAuditRowsByAction('project.signing_key_revoked', testRef)

  const res = await fetch(
    `${V1_PROJECTS_URL}/${testRef}/config/auth/signing-keys/${signingKeyBId}`,
    { method: 'DELETE', headers: authHeaders(session.access_token) }
  )
  assertEquals(res.status, 200)
  const body = await res.json()
  assertEquals(body.status, 'revoked')

  const after = await countAuditRowsByAction('project.signing_key_revoked', testRef)
  assertEquals(after - before, 1, 'DELETE must emit one project.signing_key_revoked audit row')
})

Deno.test(
  'GET /v1/projects/{ref}/config/auth/signing-keys/legacy returns env-derived HS256 entry',
  async () => {
    if (!testRef) return
    const session = await getTestSession()
    const res = await fetch(`${V1_PROJECTS_URL}/${testRef}/config/auth/signing-keys/legacy`, {
      headers: authHeaders(session.access_token),
    })
    assertEquals(res.status, 200)
    const body = await res.json()
    assert(Array.isArray(body))
    assert(body.length >= 1)
    assertEquals(body[0].algorithm, 'HS256')
    assertEquals(body[0].status, 'in_use')
  }
)

Deno.test('POST /v1/projects/{ref}/config/auth/signing-keys/legacy returns 501', async () => {
  if (!testRef) return
  const session = await getTestSession()
  const res = await fetch(`${V1_PROJECTS_URL}/${testRef}/config/auth/signing-keys/legacy`, {
    method: 'POST',
    headers: authHeaders(session.access_token),
    body: '{}',
  })
  assertEquals(res.status, 501)
  const body = await res.json()
  assertEquals(body.code, 'self_hosted_unsupported')
})

// ── Cross-user access: non-member → 404 ─────────────────
//
// `getProjectByRef` membership-joins on traffic.organization_members, so a
// request from a second user (not a member of testOrg) for testRef's keys is
// indistinguishable from a missing ref and returns 404. We assert the
// stronger "is NOT 200" so that either 404 (current) or a future 403 change
// would still satisfy this test's intent.

Deno.test('GET /v1/projects/{ref}/api-keys from non-member user is denied', async () => {
  if (!testRef) return
  const { email, password } = await signUpDisposableUser()
  const otherSession = await signIn(email, password)

  const res = await fetch(`${V1_PROJECTS_URL}/${testRef}/api-keys`, {
    headers: authHeaders(otherSession.access_token),
  })
  assert(
    res.status === 404 || res.status === 403,
    `non-member should be denied (got ${res.status})`
  )
  await res.body?.cancel()
})

Deno.test('POST /v1/projects/{ref}/api-keys from non-member user is denied', async () => {
  if (!testRef) return
  const { email, password } = await signUpDisposableUser()
  const otherSession = await signIn(email, password)

  const res = await fetch(`${V1_PROJECTS_URL}/${testRef}/api-keys`, {
    method: 'POST',
    headers: authHeaders(otherSession.access_token),
    body: JSON.stringify({ name: 'x', type: 'secret' }),
  })
  assert(
    res.status === 404 || res.status === 403,
    `non-member should be denied (got ${res.status})`
  )
  await res.body?.cancel()
})

// ── Cleanup ──────────────────────────────────────────────

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
