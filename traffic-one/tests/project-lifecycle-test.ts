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

const V1_PROJECTS_URL = `${supabaseUrl}/api/v1/projects`
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

// ── Auth ─────────────────────────────────────────────────

Deno.test('GET /v1/projects/{ref}/upgrade/eligibility returns 401 without auth', async () => {
  const res = await fetch(`${V1_PROJECTS_URL}/some-ref/upgrade/eligibility`)
  assertEquals(res.status, 401)
  await res.body?.cancel()
})

Deno.test('GET /v1/projects/{ref}/upgrade/status returns 401 without auth', async () => {
  const res = await fetch(`${V1_PROJECTS_URL}/some-ref/upgrade/status`)
  assertEquals(res.status, 401)
  await res.body?.cancel()
})

Deno.test('POST /v1/projects/{ref}/upgrade returns 401 without auth', async () => {
  const res = await fetch(`${V1_PROJECTS_URL}/some-ref/upgrade`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: '{}',
  })
  assertEquals(res.status, 401)
  await res.body?.cancel()
})

Deno.test(
  'POST /v1/projects/{ref}/readonly/temporary-disable returns 401 without auth',
  async () => {
    const res = await fetch(
      `${V1_PROJECTS_URL}/some-ref/readonly/temporary-disable`,
      {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: '{}',
      },
    )
    assertEquals(res.status, 401)
    await res.body?.cancel()
  },
)

Deno.test('GET /v1/projects/{ref}/actions returns 401 without auth', async () => {
  const res = await fetch(`${V1_PROJECTS_URL}/some-ref/actions`)
  assertEquals(res.status, 401)
  await res.body?.cancel()
})

Deno.test('GET /v1/projects/{ref}/types/typescript returns 401 without auth', async () => {
  const res = await fetch(`${V1_PROJECTS_URL}/some-ref/types/typescript`)
  assertEquals(res.status, 401)
  await res.body?.cancel()
})

// ── Setup test project ───────────────────────────────────

let testOrgSlug: string | null = null
let testRef: string | null = null

Deno.test('setup: create test org and project for lifecycle tests', async () => {
  const session = await getTestSession()

  const orgName = `Lifecycle Test Org ${Date.now()}`
  const orgRes = await fetch(ORG_URL, {
    method: 'POST',
    headers: authHeaders(session.access_token),
    body: JSON.stringify({ name: orgName, tier: 'tier_free' }),
  })
  assertEquals(orgRes.status, 201)
  const org = await orgRes.json()
  testOrgSlug = org.slug

  const projectName = `Lifecycle Test Project ${Date.now()}`
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

Deno.test('GET /v1/projects/{unknownRef}/upgrade/eligibility returns 404', async () => {
  const session = await getTestSession()
  const res = await fetch(
    `${V1_PROJECTS_URL}/nonexistent00000000/upgrade/eligibility`,
    {
      headers: authHeaders(session.access_token),
    },
  )
  assertEquals(res.status, 404)
  await res.body?.cancel()
})

// ── /upgrade/eligibility ─────────────────────────────────

Deno.test('GET /v1/projects/{ref}/upgrade/eligibility returns documented shape', async () => {
  if (!testRef) return
  const session = await getTestSession()
  const res = await fetch(`${V1_PROJECTS_URL}/${testRef}/upgrade/eligibility`, {
    headers: authHeaders(session.access_token),
  })
  assertEquals(res.status, 200)

  const body = await res.json()
  assertEquals(body.eligible, false)
  assert(Array.isArray(body.target_upgrade_versions))
  assertEquals(body.target_upgrade_versions.length, 0)
  assert(Array.isArray(body.potential_breaking_changes))
  assert(Array.isArray(body.extension_dependent_objects))
})

// ── /upgrade/status ──────────────────────────────────────

Deno.test('GET /v1/projects/{ref}/upgrade/status returns documented shape', async () => {
  if (!testRef) return
  const session = await getTestSession()
  const res = await fetch(`${V1_PROJECTS_URL}/${testRef}/upgrade/status`, {
    headers: authHeaders(session.access_token),
  })
  assertEquals(res.status, 200)

  const body = await res.json()
  assertEquals(body.progress, 'complete')
  assertEquals(body.target_version, null)
  assertEquals(body.target_version_is_latest, true)
  assertEquals(body.initiated_at, null)
})

// ── POST /upgrade → 501 ──────────────────────────────────

Deno.test('POST /v1/projects/{ref}/upgrade returns 501 self_hosted_unsupported', async () => {
  if (!testRef) return
  const session = await getTestSession()
  const res = await fetch(`${V1_PROJECTS_URL}/${testRef}/upgrade`, {
    method: 'POST',
    headers: authHeaders(session.access_token),
    body: '{}',
  })
  assertEquals(res.status, 501)
  const body = await res.json()
  assertEquals(body.code, 'self_hosted_unsupported')
  assertExists(body.message)
})

// ── /readonly/temporary-disable ──────────────────────────

Deno.test(
  'POST /v1/projects/{ref}/readonly/temporary-disable returns 200 { success: true }',
  async () => {
    if (!testRef) return
    const session = await getTestSession()
    const res = await fetch(
      `${V1_PROJECTS_URL}/${testRef}/readonly/temporary-disable`,
      {
        method: 'POST',
        headers: authHeaders(session.access_token),
        body: '{}',
      },
    )
    assertEquals(res.status, 200)
    const body = await res.json()
    assertEquals(body.success, true)
  },
)

// ── /actions ─────────────────────────────────────────────

Deno.test('GET /v1/projects/{ref}/actions returns { runs: [] }', async () => {
  if (!testRef) return
  const session = await getTestSession()
  const res = await fetch(`${V1_PROJECTS_URL}/${testRef}/actions`, {
    headers: authHeaders(session.access_token),
  })
  assertEquals(res.status, 200)

  const body = await res.json()
  assert(Array.isArray(body.runs))
  assertEquals(body.runs.length, 0)
})

Deno.test('GET /v1/projects/{ref}/actions/{run_id} returns 404 Run not found', async () => {
  if (!testRef) return
  const session = await getTestSession()
  const res = await fetch(`${V1_PROJECTS_URL}/${testRef}/actions/xyz`, {
    headers: authHeaders(session.access_token),
  })
  assertEquals(res.status, 404)
  const body = await res.json()
  assertExists(body.message)
})

Deno.test('GET /v1/projects/{ref}/actions/{run_id}/logs returns 404 Run not found', async () => {
  if (!testRef) return
  const session = await getTestSession()
  const res = await fetch(`${V1_PROJECTS_URL}/${testRef}/actions/xyz/logs`, {
    headers: authHeaders(session.access_token),
  })
  assertEquals(res.status, 404)
  const body = await res.json()
  assertExists(body.message)
})

// ── /types/typescript ────────────────────────────────────

// Whether pg-meta is reachable or not, the handler must always respond 200
// with `{ types: string }` — on failure it serves the stub fallback so the
// Studio download button never sees a 5xx.
Deno.test(
  'GET /v1/projects/{ref}/types/typescript returns 200 with { types: string }',
  async () => {
    if (!testRef) return
    const session = await getTestSession()
    const res = await fetch(`${V1_PROJECTS_URL}/${testRef}/types/typescript`, {
      headers: authHeaders(session.access_token),
    })
    assertEquals(res.status, 200)
    const body = await res.json()
    assertExists(body.types)
    assertEquals(typeof body.types, 'string')
    // Studio feeds the `types` string straight into the CLI-compatible
    // .d.ts download. Both the real pg-meta output and the stub fallback
    // must expose a top-level `export type Database` declaration.
    assert(
      (body.types as string).includes('export type Database'),
      'types output must include `export type Database`',
    )
  },
)

Deno.test(
  'GET /v1/projects/{ref}/types/typescript?included_schemas=public returns { types: string }',
  async () => {
    if (!testRef) return
    const session = await getTestSession()
    const res = await fetch(
      `${V1_PROJECTS_URL}/${testRef}/types/typescript?included_schemas=public`,
      { headers: authHeaders(session.access_token) },
    )
    assertEquals(res.status, 200)
    const body = await res.json()
    assertExists(body.types)
    assertEquals(typeof body.types, 'string')
  },
)

// ── Method-not-allowed sanity ────────────────────────────

Deno.test('PUT /v1/projects/{ref}/upgrade/eligibility returns 405', async () => {
  if (!testRef) return
  const session = await getTestSession()
  const res = await fetch(`${V1_PROJECTS_URL}/${testRef}/upgrade/eligibility`, {
    method: 'PUT',
    headers: authHeaders(session.access_token),
    body: '{}',
  })
  assertEquals(res.status, 405)
  await res.body?.cancel()
})

Deno.test('GET /v1/projects/{ref}/readonly/temporary-disable returns 405', async () => {
  if (!testRef) return
  const session = await getTestSession()
  const res = await fetch(
    `${V1_PROJECTS_URL}/${testRef}/readonly/temporary-disable`,
    {
      headers: authHeaders(session.access_token),
    },
  )
  assertEquals(res.status, 405)
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
