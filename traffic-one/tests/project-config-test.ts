import { assert, assertEquals, assertExists } from 'jsr:@std/assert@1'
import { createClient } from 'npm:@supabase/supabase-js@2'

import 'jsr:@std/dotenv/load'

const supabaseUrl = Deno.env.get('SUPABASE_URL')!
const supabaseKey = Deno.env.get('SUPABASE_ANON_KEY')!
const supabase = createClient(supabaseUrl, supabaseKey, {
  auth: {
    autoRefreshToken: false,
    persistSession: false,
    detectSessionInUrl: false,
  },
})

const PROJECTS_URL = `${supabaseUrl}/api/platform/projects`
const ORG_URL = `${supabaseUrl}/api/platform/organizations`

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

// ── Auth (no project needed) ─────────────────────────────

Deno.test('GET /projects/{ref}/config/postgrest returns 401 without auth', async () => {
  const res = await fetch(`${PROJECTS_URL}/some-ref/config/postgrest`)
  assertEquals(res.status, 401)
  await res.body?.cancel()
})

Deno.test('PATCH /projects/{ref}/config/storage returns 401 without auth', async () => {
  const res = await fetch(`${PROJECTS_URL}/some-ref/config/storage`, {
    method: 'PATCH',
    headers: { 'Content-Type': 'application/json' },
    body: '{}',
  })
  assertEquals(res.status, 401)
  await res.body?.cancel()
})

Deno.test('PATCH /projects/{ref}/db-password returns 401 without auth', async () => {
  const res = await fetch(`${PROJECTS_URL}/some-ref/db-password`, {
    method: 'PATCH',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ password: 'x' }),
  })
  assertEquals(res.status, 401)
  await res.body?.cancel()
})

// ── Setup ─────────────────────────────────────────────────

let testOrgSlug: string | null = null
let testRef: string | null = null

Deno.test('setup: create test org and project for project-config tests', async () => {
  const session = await getTestSession()

  const orgName = `Project Config Test Org ${Date.now()}`
  const orgRes = await fetch(ORG_URL, {
    method: 'POST',
    headers: authHeaders(session.access_token),
    body: JSON.stringify({ name: orgName, tier: 'tier_free' }),
  })
  assertEquals(orgRes.status, 201)
  const org = await orgRes.json()
  testOrgSlug = org.slug

  const projRes = await fetch(PROJECTS_URL, {
    method: 'POST',
    headers: authHeaders(session.access_token),
    body: JSON.stringify({
      name: `Project Config Test ${Date.now()}`,
      organization_slug: testOrgSlug,
      db_region: 'local',
    }),
  })
  assertEquals(projRes.status, 201)
  const project = await projRes.json()
  testRef = project.ref
})

// ── Unknown ref → 404 ────────────────────────────────────

Deno.test('GET /projects/{unknownRef}/config/postgrest returns 404', async () => {
  const session = await getTestSession()
  const res = await fetch(
    `${PROJECTS_URL}/nonexistent0000000x/config/postgrest`,
    {
      headers: authHeaders(session.access_token),
    },
  )
  assertEquals(res.status, 404)
  await res.body?.cancel()
})

// ── /config/postgrest ────────────────────────────────────

Deno.test('GET /config/postgrest returns documented defaults before any PATCH', async () => {
  if (!testRef) return
  const session = await getTestSession()
  const res = await fetch(`${PROJECTS_URL}/${testRef}/config/postgrest`, {
    headers: authHeaders(session.access_token),
  })
  assertEquals(res.status, 200)
  const body = await res.json()
  assertEquals(body.db_schema, 'public')
  assertEquals(body.max_rows, 1000)
  assertEquals(body.db_extra_search_path, 'public, extensions')
  assertEquals(body.db_pool, 100)
  assertEquals(body.jwt_secret, '***')
})

Deno.test('PATCH /config/postgrest persists override and subsequent GET merges', async () => {
  if (!testRef) return
  const session = await getTestSession()
  const res = await fetch(`${PROJECTS_URL}/${testRef}/config/postgrest`, {
    method: 'PATCH',
    headers: authHeaders(session.access_token),
    body: JSON.stringify({ max_rows: 555, db_schema: 'public,custom' }),
  })
  assertEquals(res.status, 200)
  const patched = await res.json()
  assertEquals(patched.max_rows, 555)
  assertEquals(patched.db_schema, 'public,custom')
  assertEquals(patched.db_pool, 100)

  const getRes = await fetch(`${PROJECTS_URL}/${testRef}/config/postgrest`, {
    headers: authHeaders(session.access_token),
  })
  assertEquals(getRes.status, 200)
  const full = await getRes.json()
  assertEquals(full.max_rows, 555)
  assertEquals(full.db_schema, 'public,custom')
  assertEquals(full.db_extra_search_path, 'public, extensions')
})

// ── /config/storage ──────────────────────────────────────

Deno.test('GET /config/storage returns default storage shape', async () => {
  if (!testRef) return
  const session = await getTestSession()
  const res = await fetch(`${PROJECTS_URL}/${testRef}/config/storage`, {
    headers: authHeaders(session.access_token),
  })
  assertEquals(res.status, 200)
  const body = await res.json()
  assertEquals(body.fileSizeLimit, 52428800)
  assertEquals(body.isFreeTier, true)
  assertExists(body.features)
  assertEquals(body.features.imageTransformation.enabled, false)
  assertEquals(body.features.list_v2.enabled, true)
})

Deno.test('PATCH /config/storage persists fileSizeLimit override', async () => {
  if (!testRef) return
  const session = await getTestSession()
  const res = await fetch(`${PROJECTS_URL}/${testRef}/config/storage`, {
    method: 'PATCH',
    headers: authHeaders(session.access_token),
    body: JSON.stringify({ fileSizeLimit: 104857600 }),
  })
  assertEquals(res.status, 200)
  await res.body?.cancel()

  const getRes = await fetch(`${PROJECTS_URL}/${testRef}/config/storage`, {
    headers: authHeaders(session.access_token),
  })
  const body = await getRes.json()
  assertEquals(body.fileSizeLimit, 104857600)
  assertEquals(body.isFreeTier, true)
})

// ── /config/realtime ─────────────────────────────────────

Deno.test('GET /config/realtime returns enabled=true and default publication', async () => {
  if (!testRef) return
  const session = await getTestSession()
  const res = await fetch(`${PROJECTS_URL}/${testRef}/config/realtime`, {
    headers: authHeaders(session.access_token),
  })
  assertEquals(res.status, 200)
  const body = await res.json()
  assertEquals(body.enabled, true)
  assert(Array.isArray(body.db_publications))
  assert(body.db_publications.includes('supabase_realtime'))
})

Deno.test('PATCH /config/realtime persists override', async () => {
  if (!testRef) return
  const session = await getTestSession()
  const res = await fetch(`${PROJECTS_URL}/${testRef}/config/realtime`, {
    method: 'PATCH',
    headers: authHeaders(session.access_token),
    body: JSON.stringify({ enabled: false }),
  })
  assertEquals(res.status, 200)
  await res.body?.cancel()

  const getRes = await fetch(`${PROJECTS_URL}/${testRef}/config/realtime`, {
    headers: authHeaders(session.access_token),
  })
  const body = await getRes.json()
  assertEquals(body.enabled, false)
  assert(Array.isArray(body.db_publications))
})

// ── /config/pgbouncer ────────────────────────────────────

Deno.test('GET /config/pgbouncer returns defaults', async () => {
  if (!testRef) return
  const session = await getTestSession()
  const res = await fetch(`${PROJECTS_URL}/${testRef}/config/pgbouncer`, {
    headers: authHeaders(session.access_token),
  })
  assertEquals(res.status, 200)
  const body = await res.json()
  assertEquals(body.default_pool_size, 20)
  assertEquals(body.max_client_conn, 100)
  assertEquals(body.pool_mode, 'transaction')
})

Deno.test('PATCH /config/pgbouncer persists override', async () => {
  if (!testRef) return
  const session = await getTestSession()
  const res = await fetch(`${PROJECTS_URL}/${testRef}/config/pgbouncer`, {
    method: 'PATCH',
    headers: authHeaders(session.access_token),
    body: JSON.stringify({ default_pool_size: 42 }),
  })
  assertEquals(res.status, 200)
  const body = await res.json()
  assertEquals(body.default_pool_size, 42)
  assertEquals(body.pool_mode, 'transaction')
})

// ── /config/pgbouncer/status ─────────────────────────────

Deno.test('GET /config/pgbouncer/status returns { enabled: true }', async () => {
  if (!testRef) return
  const session = await getTestSession()
  const res = await fetch(
    `${PROJECTS_URL}/${testRef}/config/pgbouncer/status`,
    {
      headers: authHeaders(session.access_token),
    },
  )
  assertEquals(res.status, 200)
  const body = await res.json()
  assertEquals(body.enabled, true)
})

// ── /config/secrets + rotation simulator ─────────────────

Deno.test('GET /config/secrets returns masked defaults', async () => {
  if (!testRef) return
  const session = await getTestSession()
  const res = await fetch(`${PROJECTS_URL}/${testRef}/config/secrets`, {
    headers: authHeaders(session.access_token),
  })
  assertEquals(res.status, 200)
  const body = await res.json()
  assertEquals(body.jwt_secret, '***')
  assertEquals(body.service_role_key, '***')
})

Deno.test(
  'PATCH /config/secrets then repeated GET update-status advances pending→running→succeeded',
  async () => {
    if (!testRef) return
    const session = await getTestSession()

    const patchRes = await fetch(`${PROJECTS_URL}/${testRef}/config/secrets`, {
      method: 'PATCH',
      headers: authHeaders(session.access_token),
      body: JSON.stringify({}),
    })
    assertEquals(patchRes.status, 200)
    const patched = await patchRes.json()
    assertEquals(patched.status, 'pending')
    assertExists(patched.request_id)
    assertExists(patched.requested_at)

    const reqId = patched.request_id as string

    const first = await fetch(
      `${PROJECTS_URL}/${testRef}/config/secrets/update-status?request_id=${reqId}`,
      { headers: authHeaders(session.access_token) },
    )
    assertEquals(first.status, 200)
    const firstBody = await first.json()
    assertEquals(firstBody.status, 'running')
    assertEquals(firstBody.request_id, reqId)

    const second = await fetch(
      `${PROJECTS_URL}/${testRef}/config/secrets/update-status?request_id=${reqId}`,
      { headers: authHeaders(session.access_token) },
    )
    assertEquals(second.status, 200)
    const secondBody = await second.json()
    assertEquals(secondBody.status, 'succeeded')

    const third = await fetch(
      `${PROJECTS_URL}/${testRef}/config/secrets/update-status?request_id=${reqId}`,
      { headers: authHeaders(session.access_token) },
    )
    const thirdBody = await third.json()
    assertEquals(thirdBody.status, 'succeeded')
  },
)

// ── /settings/sensitivity ────────────────────────────────

Deno.test('PATCH /settings/sensitivity rejects invalid enum with 400', async () => {
  if (!testRef) return
  const session = await getTestSession()
  const res = await fetch(`${PROJECTS_URL}/${testRef}/settings/sensitivity`, {
    method: 'PATCH',
    headers: authHeaders(session.access_token),
    body: JSON.stringify({ sensitivity: 'SUPER_CRITICAL' }),
  })
  assertEquals(res.status, 400)
  const body = await res.json()
  assertExists(body.message)
})

Deno.test('PATCH /settings/sensitivity rejects missing sensitivity with 400', async () => {
  if (!testRef) return
  const session = await getTestSession()
  const res = await fetch(`${PROJECTS_URL}/${testRef}/settings/sensitivity`, {
    method: 'PATCH',
    headers: authHeaders(session.access_token),
    body: JSON.stringify({}),
  })
  assertEquals(res.status, 400)
  await res.body?.cancel()
})

Deno.test('PATCH /settings/sensitivity accepts HIGH and returns updated value', async () => {
  if (!testRef) return
  const session = await getTestSession()
  const res = await fetch(`${PROJECTS_URL}/${testRef}/settings/sensitivity`, {
    method: 'PATCH',
    headers: authHeaders(session.access_token),
    body: JSON.stringify({ sensitivity: 'HIGH' }),
  })
  assertEquals(res.status, 200)
  const body = await res.json()
  assertEquals(body.sensitivity, 'HIGH')
  assertEquals(body.ref, testRef)
})

// ── /db-password ─────────────────────────────────────────

Deno.test('PATCH /db-password returns 200 with acknowledged even on failure', async () => {
  if (!testRef) return
  const session = await getTestSession()
  const res = await fetch(`${PROJECTS_URL}/${testRef}/db-password`, {
    method: 'PATCH',
    headers: authHeaders(session.access_token),
    body: JSON.stringify({ password: `rotated-${Date.now()}-!@#'"\\` }),
  })
  assertEquals(res.status, 200)
  const body = await res.json()
  assertEquals(body.result, 'acknowledged')
  // H3: the route now surfaces `applied` so Studio can tell whether the
  // `ALTER ROLE ... WITH PASSWORD` actually reached the project DB (true)
  // or whether the request fell through to a Vault-only rotation (false).
  // We don't assert on the exact value — either outcome is acceptable
  // depending on whether the ALTER ROLE path is reachable from this test
  // run — but the field MUST be present and boolean-typed.
  assert(
    typeof body.applied === 'boolean',
    '`applied` must be a boolean (H3 contract)',
  )
})

Deno.test('PATCH /db-password rejects missing password with 400', async () => {
  if (!testRef) return
  const session = await getTestSession()
  const res = await fetch(`${PROJECTS_URL}/${testRef}/db-password`, {
    method: 'PATCH',
    headers: authHeaders(session.access_token),
    body: JSON.stringify({}),
  })
  assertEquals(res.status, 400)
  await res.body?.cancel()
})

// ── Method routing ──────────────────────────────────────

Deno.test('POST /config/postgrest returns 405', async () => {
  if (!testRef) return
  const session = await getTestSession()
  const res = await fetch(`${PROJECTS_URL}/${testRef}/config/postgrest`, {
    method: 'POST',
    headers: authHeaders(session.access_token),
    body: '{}',
  })
  assertEquals(res.status, 405)
  await res.body?.cancel()
})

Deno.test('GET /db-password returns 405', async () => {
  if (!testRef) return
  const session = await getTestSession()
  const res = await fetch(`${PROJECTS_URL}/${testRef}/db-password`, {
    headers: authHeaders(session.access_token),
  })
  assertEquals(res.status, 405)
  await res.body?.cancel()
})

// ── Cleanup ─────────────────────────────────────────────

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
