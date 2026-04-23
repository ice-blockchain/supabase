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

// Sign up + force-confirm a disposable second user for cross-user
// (non-member) tests. Mirrors the pattern in project-api-keys-test.ts.
async function signUpDisposableUser(): Promise<{ email: string; password: string }> {
  const email = `projauth-other-${Date.now()}-${Math.floor(Math.random() * 1e6)}@example.com`
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
  } = await supabase.auth.signInWithPassword({ email, password })
  if (error || !session) {
    throw new Error(`sign-in failed for ${email}: ${error?.message ?? 'no session'}`)
  }
  return session
}

// ── Auth ─────────────────────────────────────────────────

Deno.test(
  'GET /v1/projects/{ref}/config/auth/third-party-auth returns 401 without auth',
  async () => {
    const res = await fetch(`${V1_PROJECTS_URL}/some-ref/config/auth/third-party-auth`)
    assertEquals(res.status, 401)
    await res.body?.cancel()
  }
)

Deno.test(
  'POST /v1/projects/{ref}/config/auth/third-party-auth returns 401 without auth',
  async () => {
    const res = await fetch(`${V1_PROJECTS_URL}/some-ref/config/auth/third-party-auth`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ oidc_issuer_url: 'https://example.com' }),
    })
    assertEquals(res.status, 401)
    await res.body?.cancel()
  }
)

Deno.test('GET /v1/projects/{ref}/ssl-enforcement returns 401 without auth', async () => {
  const res = await fetch(`${V1_PROJECTS_URL}/some-ref/ssl-enforcement`)
  assertEquals(res.status, 401)
  await res.body?.cancel()
})

Deno.test('GET /v1/projects/{ref}/secrets returns 401 without auth', async () => {
  const res = await fetch(`${V1_PROJECTS_URL}/some-ref/secrets`)
  assertEquals(res.status, 401)
  await res.body?.cancel()
})

// ── Setup ────────────────────────────────────────────────

let testOrgSlug: string | null = null
let testRef: string | null = null

Deno.test('setup: create test org and project for project-auth tests', async () => {
  const session = await getTestSession()

  const orgRes = await fetch(ORG_URL, {
    method: 'POST',
    headers: authHeaders(session.access_token),
    body: JSON.stringify({ name: `ProjectAuth Test Org ${Date.now()}`, tier: 'tier_free' }),
  })
  assertEquals(orgRes.status, 201)
  const org = await orgRes.json()
  testOrgSlug = org.slug

  const projRes = await fetch(PROJECTS_URL, {
    method: 'POST',
    headers: authHeaders(session.access_token),
    body: JSON.stringify({
      name: `ProjectAuth Test Project ${Date.now()}`,
      organization_slug: testOrgSlug,
      db_region: 'local',
    }),
  })
  assertEquals(projRes.status, 201)
  const project = await projRes.json()
  testRef = project.ref
})

// ── Unknown ref → 404 ────────────────────────────────────

Deno.test('GET /v1/projects/{unknownRef}/config/auth/third-party-auth returns 404', async () => {
  const session = await getTestSession()
  const res = await fetch(`${V1_PROJECTS_URL}/nonexistent00000000/config/auth/third-party-auth`, {
    headers: authHeaders(session.access_token),
  })
  assertEquals(res.status, 404)
  await res.body?.cancel()
})

Deno.test('GET /v1/projects/{unknownRef}/ssl-enforcement returns 404', async () => {
  const session = await getTestSession()
  const res = await fetch(`${V1_PROJECTS_URL}/nonexistent00000000/ssl-enforcement`, {
    headers: authHeaders(session.access_token),
  })
  assertEquals(res.status, 404)
  await res.body?.cancel()
})

Deno.test('GET /v1/projects/{unknownRef}/secrets returns 404', async () => {
  const session = await getTestSession()
  const res = await fetch(`${V1_PROJECTS_URL}/nonexistent00000000/secrets`, {
    headers: authHeaders(session.access_token),
  })
  assertEquals(res.status, 404)
  await res.body?.cancel()
})

// ── Third-party auth: POST + GET + DELETE round-trip ─────

let createdIntegrationId: string | null = null

Deno.test('GET /third-party-auth returns empty list initially', async () => {
  if (!testRef) return
  const session = await getTestSession()
  const res = await fetch(`${V1_PROJECTS_URL}/${testRef}/config/auth/third-party-auth`, {
    headers: authHeaders(session.access_token),
  })
  assertEquals(res.status, 200)
  const body = await res.json()
  assert(Array.isArray(body))
  assertEquals(body.length, 0)
})

Deno.test('POST /third-party-auth creates OIDC integration', async () => {
  if (!testRef) return
  const session = await getTestSession()
  const res = await fetch(`${V1_PROJECTS_URL}/${testRef}/config/auth/third-party-auth`, {
    method: 'POST',
    headers: authHeaders(session.access_token),
    body: JSON.stringify({ oidc_issuer_url: 'https://accounts.example.com' }),
  })
  assertEquals(res.status, 201)
  const body = await res.json()
  assertExists(body.id)
  assertEquals(body.type, 'oidc')
  assertEquals(body.oidc_issuer_url, 'https://accounts.example.com')
  assertEquals(body.jwks_url, null)
  assertEquals(body.custom_jwks, null)
  createdIntegrationId = body.id
})

Deno.test('POST /third-party-auth rejects empty body with 400', async () => {
  if (!testRef) return
  const session = await getTestSession()
  const res = await fetch(`${V1_PROJECTS_URL}/${testRef}/config/auth/third-party-auth`, {
    method: 'POST',
    headers: authHeaders(session.access_token),
    body: JSON.stringify({}),
  })
  assertEquals(res.status, 400)
  await res.body?.cancel()
})

Deno.test('POST /third-party-auth creates custom_jwks integration', async () => {
  if (!testRef) return
  const session = await getTestSession()
  const res = await fetch(`${V1_PROJECTS_URL}/${testRef}/config/auth/third-party-auth`, {
    method: 'POST',
    headers: authHeaders(session.access_token),
    body: JSON.stringify({ custom_jwks: { keys: [{ kty: 'RSA', kid: 'demo' }] } }),
  })
  assertEquals(res.status, 201)
  const body = await res.json()
  assertEquals(body.type, 'custom_jwks')
  assertEquals(body.oidc_issuer_url, null)
  assertExists(body.custom_jwks)
})

Deno.test('GET /third-party-auth lists created integrations', async () => {
  if (!testRef) return
  const session = await getTestSession()
  const res = await fetch(`${V1_PROJECTS_URL}/${testRef}/config/auth/third-party-auth`, {
    headers: authHeaders(session.access_token),
  })
  assertEquals(res.status, 200)
  const body = await res.json()
  assert(Array.isArray(body))
  assertEquals(body.length, 2)
})

Deno.test('GET /third-party-auth/{id} returns the OIDC integration', async () => {
  if (!testRef || !createdIntegrationId) return
  const session = await getTestSession()
  const res = await fetch(
    `${V1_PROJECTS_URL}/${testRef}/config/auth/third-party-auth/${createdIntegrationId}`,
    { headers: authHeaders(session.access_token) }
  )
  assertEquals(res.status, 200)
  const body = await res.json()
  assertEquals(body.id, createdIntegrationId)
  assertEquals(body.oidc_issuer_url, 'https://accounts.example.com')
})

Deno.test('GET /third-party-auth/{unknownId} returns 404', async () => {
  if (!testRef) return
  const session = await getTestSession()
  const res = await fetch(
    `${V1_PROJECTS_URL}/${testRef}/config/auth/third-party-auth/00000000-0000-0000-0000-000000000000`,
    { headers: authHeaders(session.access_token) }
  )
  assertEquals(res.status, 404)
  await res.body?.cancel()
})

Deno.test('DELETE /third-party-auth/{id} removes the integration', async () => {
  if (!testRef || !createdIntegrationId) return
  const session = await getTestSession()
  const res = await fetch(
    `${V1_PROJECTS_URL}/${testRef}/config/auth/third-party-auth/${createdIntegrationId}`,
    { method: 'DELETE', headers: authHeaders(session.access_token) }
  )
  assertEquals(res.status, 200)
  const body = await res.json()
  assertEquals(body.id, createdIntegrationId)

  const listRes = await fetch(`${V1_PROJECTS_URL}/${testRef}/config/auth/third-party-auth`, {
    headers: authHeaders(session.access_token),
  })
  const listBody = await listRes.json()
  assertEquals(listBody.length, 1)
})

// ── SSL enforcement: GET default, PUT persists, GET reflects ─

Deno.test("GET /ssl-enforcement returns default 'enforced'", async () => {
  if (!testRef) return
  const session = await getTestSession()
  const res = await fetch(`${V1_PROJECTS_URL}/${testRef}/ssl-enforcement`, {
    headers: authHeaders(session.access_token),
  })
  assertEquals(res.status, 200)
  const body = await res.json()
  assertEquals(body.currentConfig.database, 'enforced')
  assertEquals(body.appliedSuccessfully, true)
})

Deno.test("PUT /ssl-enforcement persists 'not_enforced'", async () => {
  if (!testRef) return
  const session = await getTestSession()
  const res = await fetch(`${V1_PROJECTS_URL}/${testRef}/ssl-enforcement`, {
    method: 'PUT',
    headers: authHeaders(session.access_token),
    body: JSON.stringify({ requestedConfig: { database: 'not_enforced' } }),
  })
  assertEquals(res.status, 200)
  const body = await res.json()
  assertEquals(body.currentConfig.database, 'not_enforced')
  assertEquals(body.appliedSuccessfully, true)
})

Deno.test('GET /ssl-enforcement reflects persisted value', async () => {
  if (!testRef) return
  const session = await getTestSession()
  const res = await fetch(`${V1_PROJECTS_URL}/${testRef}/ssl-enforcement`, {
    headers: authHeaders(session.access_token),
  })
  assertEquals(res.status, 200)
  const body = await res.json()
  assertEquals(body.currentConfig.database, 'not_enforced')
})

Deno.test('PUT /ssl-enforcement rejects invalid mode with 400', async () => {
  if (!testRef) return
  const session = await getTestSession()
  const res = await fetch(`${V1_PROJECTS_URL}/${testRef}/ssl-enforcement`, {
    method: 'PUT',
    headers: authHeaders(session.access_token),
    body: JSON.stringify({ requestedConfig: { database: 'maybe' } }),
  })
  assertEquals(res.status, 400)
  await res.body?.cancel()
})

// ── Secrets: POST → GET (no plaintext) → DELETE ──────────

Deno.test('GET /secrets returns empty list initially', async () => {
  if (!testRef) return
  const session = await getTestSession()
  const res = await fetch(`${V1_PROJECTS_URL}/${testRef}/secrets`, {
    headers: authHeaders(session.access_token),
  })
  assertEquals(res.status, 200)
  const body = await res.json()
  assert(Array.isArray(body))
  assertEquals(body.length, 0)
})

Deno.test('POST /secrets with single {name,value} creates secret', async () => {
  if (!testRef) return
  const session = await getTestSession()
  const res = await fetch(`${V1_PROJECTS_URL}/${testRef}/secrets`, {
    method: 'POST',
    headers: authHeaders(session.access_token),
    body: JSON.stringify({ name: 'STRIPE_KEY', value: 'sk_test_abc123' }),
  })
  assertEquals(res.status, 201)
  const body = await res.json()
  assert(Array.isArray(body.secrets))
  assertEquals(body.secrets.length, 1)
  assertEquals(body.secrets[0].name, 'STRIPE_KEY')
  assertEquals(body.secrets[0].status, 'created')
})

Deno.test('POST /secrets with array body creates multiple secrets', async () => {
  if (!testRef) return
  const session = await getTestSession()
  const res = await fetch(`${V1_PROJECTS_URL}/${testRef}/secrets`, {
    method: 'POST',
    headers: authHeaders(session.access_token),
    body: JSON.stringify([
      { name: 'SENDGRID_KEY', value: 'SG.xyz' },
      { name: 'OPENAI_KEY', value: 'sk-proj-...' },
    ]),
  })
  assertEquals(res.status, 201)
  const body = await res.json()
  assertEquals(body.secrets.length, 2)
})

Deno.test('GET /secrets lists secret names without plaintext', async () => {
  if (!testRef) return
  const session = await getTestSession()
  const res = await fetch(`${V1_PROJECTS_URL}/${testRef}/secrets`, {
    headers: authHeaders(session.access_token),
  })
  assertEquals(res.status, 200)
  const body = await res.json()
  assert(Array.isArray(body))
  assertEquals(body.length, 3)

  const names = body.map((row: { name: string }) => row.name).sort()
  assertEquals(names, ['OPENAI_KEY', 'SENDGRID_KEY', 'STRIPE_KEY'])

  for (const row of body as Array<Record<string, unknown>>) {
    assertEquals('value' in row, false)
    assertEquals('decrypted_secret' in row, false)
    assertEquals('secret_id' in row, false)
  }
})

Deno.test("POST /secrets with existing name upserts (status 'updated')", async () => {
  if (!testRef) return
  const session = await getTestSession()
  const res = await fetch(`${V1_PROJECTS_URL}/${testRef}/secrets`, {
    method: 'POST',
    headers: authHeaders(session.access_token),
    body: JSON.stringify({ name: 'STRIPE_KEY', value: 'sk_test_rotated' }),
  })
  assertEquals(res.status, 201)
  const body = await res.json()
  assertEquals(body.secrets[0].status, 'updated')

  const listRes = await fetch(`${V1_PROJECTS_URL}/${testRef}/secrets`, {
    headers: authHeaders(session.access_token),
  })
  const listBody = await listRes.json()
  assertEquals(listBody.length, 3)
})

Deno.test('POST /secrets rejects invalid body with 400', async () => {
  if (!testRef) return
  const session = await getTestSession()
  const res = await fetch(`${V1_PROJECTS_URL}/${testRef}/secrets`, {
    method: 'POST',
    headers: authHeaders(session.access_token),
    body: JSON.stringify({ name: 'NO_VALUE' }),
  })
  assertEquals(res.status, 400)
  await res.body?.cancel()
})

Deno.test('DELETE /secrets with array body removes named secrets', async () => {
  if (!testRef) return
  const session = await getTestSession()
  const res = await fetch(`${V1_PROJECTS_URL}/${testRef}/secrets`, {
    method: 'DELETE',
    headers: authHeaders(session.access_token),
    body: JSON.stringify(['STRIPE_KEY']),
  })
  assertEquals(res.status, 200)
  const body = await res.json()
  assertEquals(body.deleted, ['STRIPE_KEY'])

  const listRes = await fetch(`${V1_PROJECTS_URL}/${testRef}/secrets`, {
    headers: authHeaders(session.access_token),
  })
  const listBody = await listRes.json()
  const names = listBody.map((row: { name: string }) => row.name).sort()
  assertEquals(names, ['OPENAI_KEY', 'SENDGRID_KEY'])
})

Deno.test('DELETE /secrets with { names } object form removes named secrets', async () => {
  if (!testRef) return
  const session = await getTestSession()
  const res = await fetch(`${V1_PROJECTS_URL}/${testRef}/secrets`, {
    method: 'DELETE',
    headers: authHeaders(session.access_token),
    body: JSON.stringify({ names: ['SENDGRID_KEY', 'OPENAI_KEY'] }),
  })
  assertEquals(res.status, 200)
  const body = await res.json()
  const deletedSorted = [...body.deleted].sort()
  assertEquals(deletedSorted, ['OPENAI_KEY', 'SENDGRID_KEY'])

  const listRes = await fetch(`${V1_PROJECTS_URL}/${testRef}/secrets`, {
    headers: authHeaders(session.access_token),
  })
  const listBody = await listRes.json()
  assertEquals(listBody.length, 0)
})

// ── Cross-user access: non-member → 403/404 ─────────────
//
// A second disposable user is not a member of testOrg, so any request for
// testRef's auth/secrets/ssl-enforcement sub-resources must be denied.
// `getProjectByRef` membership-joins on traffic.organization_members, so
// 404 is also acceptable (indistinguishable from missing ref).

Deno.test(
  'GET /v1/projects/{ref}/config/auth/third-party-auth from non-member is denied',
  async () => {
    if (!testRef) return
    const { email, password } = await signUpDisposableUser()
    const otherSession = await signIn(email, password)
    const res = await fetch(`${V1_PROJECTS_URL}/${testRef}/config/auth/third-party-auth`, {
      headers: authHeaders(otherSession.access_token),
    })
    assert(
      res.status === 404 || res.status === 403,
      `non-member should be denied (got ${res.status})`
    )
    await res.body?.cancel()
  }
)

Deno.test(
  'POST /v1/projects/{ref}/config/auth/third-party-auth from non-member is denied',
  async () => {
    if (!testRef) return
    const { email, password } = await signUpDisposableUser()
    const otherSession = await signIn(email, password)
    const res = await fetch(`${V1_PROJECTS_URL}/${testRef}/config/auth/third-party-auth`, {
      method: 'POST',
      headers: authHeaders(otherSession.access_token),
      body: JSON.stringify({ oidc_issuer_url: 'https://accounts.example.com' }),
    })
    assert(
      res.status === 404 || res.status === 403,
      `non-member should be denied (got ${res.status})`
    )
    await res.body?.cancel()
  }
)

Deno.test('GET /v1/projects/{ref}/ssl-enforcement from non-member is denied', async () => {
  if (!testRef) return
  const { email, password } = await signUpDisposableUser()
  const otherSession = await signIn(email, password)
  const res = await fetch(`${V1_PROJECTS_URL}/${testRef}/ssl-enforcement`, {
    headers: authHeaders(otherSession.access_token),
  })
  assert(
    res.status === 404 || res.status === 403,
    `non-member should be denied (got ${res.status})`
  )
  await res.body?.cancel()
})

Deno.test('PUT /v1/projects/{ref}/ssl-enforcement from non-member is denied', async () => {
  if (!testRef) return
  const { email, password } = await signUpDisposableUser()
  const otherSession = await signIn(email, password)
  const res = await fetch(`${V1_PROJECTS_URL}/${testRef}/ssl-enforcement`, {
    method: 'PUT',
    headers: authHeaders(otherSession.access_token),
    body: JSON.stringify({ requestedConfig: { database: 'not-enforced' } }),
  })
  assert(
    res.status === 404 || res.status === 403,
    `non-member should be denied (got ${res.status})`
  )
  await res.body?.cancel()
})

Deno.test('GET /v1/projects/{ref}/secrets from non-member is denied', async () => {
  if (!testRef) return
  const { email, password } = await signUpDisposableUser()
  const otherSession = await signIn(email, password)
  const res = await fetch(`${V1_PROJECTS_URL}/${testRef}/secrets`, {
    headers: authHeaders(otherSession.access_token),
  })
  assert(
    res.status === 404 || res.status === 403,
    `non-member should be denied (got ${res.status})`
  )
  await res.body?.cancel()
})

Deno.test('POST /v1/projects/{ref}/secrets from non-member is denied', async () => {
  if (!testRef) return
  const { email, password } = await signUpDisposableUser()
  const otherSession = await signIn(email, password)
  const res = await fetch(`${V1_PROJECTS_URL}/${testRef}/secrets`, {
    method: 'POST',
    headers: authHeaders(otherSession.access_token),
    body: JSON.stringify({ name: 'X', value: 'y' }),
  })
  assert(
    res.status === 404 || res.status === 403,
    `non-member should be denied (got ${res.status})`
  )
  await res.body?.cancel()
})

// ── Cross-org ref mismatch: using one org's ref under another → 404 ──
//
// Even as an org member, attempting to interact with a project whose ref
// belongs to a different organization must still be denied.

Deno.test('GET /v1/projects/{crossOrgRef}/ssl-enforcement returns 404', async () => {
  const session = await getTestSession()
  const otherOrgRes = await fetch(ORG_URL, {
    method: 'POST',
    headers: authHeaders(session.access_token),
    body: JSON.stringify({ name: `ProjAuth Cross Org ${Date.now()}`, tier: 'tier_free' }),
  })
  assertEquals(otherOrgRes.status, 201)
  const otherOrg = await otherOrgRes.json()
  const otherOrgSlug = otherOrg.slug

  try {
    const otherProjRes = await fetch(PROJECTS_URL, {
      method: 'POST',
      headers: authHeaders(session.access_token),
      body: JSON.stringify({
        name: `ProjAuth Cross Project ${Date.now()}`,
        organization_slug: otherOrgSlug,
        db_region: 'local',
      }),
    })
    assertEquals(otherProjRes.status, 201)
    const otherProject = await otherProjRes.json()

    const { email, password } = await signUpDisposableUser()
    const otherSession = await signIn(email, password)

    const res = await fetch(`${V1_PROJECTS_URL}/${otherProject.ref}/ssl-enforcement`, {
      headers: authHeaders(otherSession.access_token),
    })
    assert(
      res.status === 404 || res.status === 403,
      `ref-mismatch non-member should be denied (got ${res.status})`
    )
    await res.body?.cancel()

    await fetch(`${PROJECTS_URL}/${otherProject.ref}`, {
      method: 'DELETE',
      headers: authHeaders(session.access_token),
    }).then((r) => r.body?.cancel())
  } finally {
    await fetch(`${ORG_URL}/${otherOrgSlug}`, {
      method: 'DELETE',
      headers: authHeaders(session.access_token),
    }).then((r) => r.body?.cancel())
  }
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
