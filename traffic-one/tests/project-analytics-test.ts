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

const PROJECTS_URL = `${supabaseUrl}/api/platform/projects`
const ORG_URL = `${supabaseUrl}/api/platform/organizations`

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

// ── Auth ─────────────────────────────────────────────────

Deno.test('GET /projects/{ref}/infra-monitoring returns 401 without auth', async () => {
  const res = await fetch(`${PROJECTS_URL}/some-ref/infra-monitoring`)
  assertEquals(res.status, 401)
  await res.body?.cancel()
})

Deno.test(
  'POST /projects/{ref}/analytics/endpoints/logs.all returns 401 without auth',
  async () => {
    const res = await fetch(`${PROJECTS_URL}/some-ref/analytics/endpoints/logs.all`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: '{}',
    })
    assertEquals(res.status, 401)
    await res.body?.cancel()
  }
)

Deno.test('GET /projects/{ref}/analytics/log-drains returns 401 without auth', async () => {
  const res = await fetch(`${PROJECTS_URL}/some-ref/analytics/log-drains`)
  assertEquals(res.status, 401)
  await res.body?.cancel()
})

Deno.test('GET /projects/{ref}/api/rest returns 401 without auth', async () => {
  const res = await fetch(`${PROJECTS_URL}/some-ref/api/rest`)
  assertEquals(res.status, 401)
  await res.body?.cancel()
})

Deno.test('GET /projects/{ref}/api/graphql returns 401 without auth', async () => {
  const res = await fetch(`${PROJECTS_URL}/some-ref/api/graphql`)
  assertEquals(res.status, 401)
  await res.body?.cancel()
})

// ── Setup test project ───────────────────────────────────

let testOrgSlug: string | null = null
let testRef: string | null = null

Deno.test('setup: create test org and project for analytics tests', async () => {
  const session = await getTestSession()

  const orgName = `Analytics Test Org ${Date.now()}`
  const orgRes = await fetch(ORG_URL, {
    method: 'POST',
    headers: authHeaders(session.access_token),
    body: JSON.stringify({ name: orgName, tier: 'tier_free' }),
  })
  assertEquals(orgRes.status, 201)
  const org = await orgRes.json()
  testOrgSlug = org.slug

  const projectName = `Analytics Test Project ${Date.now()}`
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

Deno.test('GET /projects/{unknownRef}/infra-monitoring returns 404', async () => {
  const session = await getTestSession()
  const res = await fetch(`${PROJECTS_URL}/nonexistent00000000/infra-monitoring`, {
    headers: authHeaders(session.access_token),
  })
  assertEquals(res.status, 404)
  await res.body?.cancel()
})

// ── Infra-monitoring ─────────────────────────────────────

Deno.test('GET /projects/{ref}/infra-monitoring returns defined series keys', async () => {
  if (!testRef) return
  const session = await getTestSession()
  const res = await fetch(
    `${PROJECTS_URL}/${testRef}/infra-monitoring?attributes=cpu_usage&attributes=ram_usage&startDate=2024-01-01&endDate=2024-01-02&interval=1h`,
    { headers: authHeaders(session.access_token) }
  )
  assertEquals(res.status, 200)

  const body = await res.json()
  assert(Array.isArray(body.data), 'data should be an array')

  // All required series keys must be defined so Studio's `.map` cannot throw
  // "Cannot read properties of undefined".
  assertExists(body.series, 'series should be present')
  const requiredKeys = [
    'cpu_usage',
    'ram_usage',
    'disk_io_budget',
    'swap_usage',
    'max_db_connections',
  ]
  for (const key of requiredKeys) {
    assertExists(body.series[key], `series.${key} must be defined`)
    assertEquals(typeof body.series[key].yAxisLimit, 'number')
    assertEquals(typeof body.series[key].format, 'string')
    assertEquals(typeof body.series[key].total, 'number')
    assertExists(body.series[key].totalAverage)
  }

  // Simulating the UI's mapResponseToAnalyticsData for each requested attribute
  // must NOT throw on undefined.
  for (const attribute of ['cpu_usage', 'ram_usage']) {
    const metadata = body.series?.[attribute]
    assertExists(metadata, `metadata for ${attribute} must be defined`)
    const mapped = (
      body.data as { period_start: string; values?: Record<string, string | undefined> }[]
    ).map((point) => ({
      period_start: point.period_start,
      [attribute]: point.values?.[attribute] ?? 0,
    }))
    assert(Array.isArray(mapped))
  }
})

// ── Logflare endpoints proxy ─────────────────────────────

Deno.test(
  'POST /projects/{ref}/analytics/endpoints/logs.all returns { result: [...] }',
  async () => {
    if (!testRef) return
    const session = await getTestSession()
    const res = await fetch(
      `${PROJECTS_URL}/${testRef}/analytics/endpoints/logs.all?project=${testRef}&sql=select 1&iso_timestamp_start=2024-01-01T00:00:00Z&iso_timestamp_end=2024-01-02T00:00:00Z`,
      {
        method: 'POST',
        headers: authHeaders(session.access_token),
        body: JSON.stringify({ sql: 'select 1', project: testRef }),
      }
    )
    // Must always be 200 — Logflare reachability is not required.
    assertEquals(res.status, 200)
    const body = await res.json()
    assert(Array.isArray(body.result), 'result should be an array')
  }
)

Deno.test(
  'GET /projects/{ref}/analytics/endpoints/logs.all also returns { result: [...] }',
  async () => {
    if (!testRef) return
    const session = await getTestSession()
    const res = await fetch(
      `${PROJECTS_URL}/${testRef}/analytics/endpoints/logs.all?project=${testRef}&sql=select 1&iso_timestamp_start=2024-01-01T00:00:00Z&iso_timestamp_end=2024-01-02T00:00:00Z`,
      { headers: authHeaders(session.access_token) }
    )
    assertEquals(res.status, 200)
    const body = await res.json()
    assert(Array.isArray(body.result))
  }
)

// ── /api/rest OpenAPI proxy ──────────────────────────────

Deno.test('GET /projects/{ref}/api/rest returns OpenAPI-shaped JSON', async () => {
  if (!testRef) return
  const session = await getTestSession()
  const res = await fetch(`${PROJECTS_URL}/${testRef}/api/rest`, {
    headers: authHeaders(session.access_token),
  })
  assertEquals(res.status, 200)
  const body = await res.json()
  // The spec MAY come from PostgREST (swagger 2.0) or the fallback (openapi 3.0.0).
  // We require at least one of openapi/info/paths to be present (swagger specs
  // carry `info`, `paths`; OpenAPI also adds `openapi`).
  const hasAnyKey = 'openapi' in body || 'info' in body || 'paths' in body
  assert(hasAnyKey, 'response should include openapi/info/paths keys')
})

// ── /api/graphql introspection proxy ─────────────────────

Deno.test('GET /projects/{ref}/api/graphql returns introspection-shaped JSON', async () => {
  if (!testRef) return
  const session = await getTestSession()
  const res = await fetch(`${PROJECTS_URL}/${testRef}/api/graphql`, {
    headers: authHeaders(session.access_token),
  })
  assertEquals(res.status, 200)
  const body = await res.json()
  assertExists(body.data, 'response should have a data property')
  assertExists(body.data.__schema, 'response.data.__schema should be defined')
})

// ── Log drain CRUD ───────────────────────────────────────

let createdDrainToken: string | null = null

Deno.test('GET /projects/{ref}/analytics/log-drains starts empty', async () => {
  if (!testRef) return
  const session = await getTestSession()
  const res = await fetch(`${PROJECTS_URL}/${testRef}/analytics/log-drains`, {
    headers: authHeaders(session.access_token),
  })
  assertEquals(res.status, 200)
  const body = await res.json()
  assert(Array.isArray(body))
  assertEquals(body.length, 0)
})

Deno.test('POST /projects/{ref}/analytics/log-drains creates a drain', async () => {
  if (!testRef) return
  const session = await getTestSession()
  const res = await fetch(`${PROJECTS_URL}/${testRef}/analytics/log-drains`, {
    method: 'POST',
    headers: authHeaders(session.access_token),
    body: JSON.stringify({
      name: 'test-drain-1',
      description: 'A test drain',
      type: 'webhook',
      config: { url: 'https://example.test/hook' },
    }),
  })
  assertEquals(res.status, 201)
  const body = await res.json()
  assertExists(body.id)
  assertExists(body.token)
  assertEquals(body.name, 'test-drain-1')
  assertEquals(body.type, 'webhook')
  assertEquals(body.metadata?.project_ref, testRef)
  assertEquals(body.metadata?.type, 'log-drain')
  createdDrainToken = body.token
})

Deno.test('POST /projects/{ref}/analytics/log-drains with duplicate name returns 409', async () => {
  if (!testRef) return
  const session = await getTestSession()
  const res = await fetch(`${PROJECTS_URL}/${testRef}/analytics/log-drains`, {
    method: 'POST',
    headers: authHeaders(session.access_token),
    body: JSON.stringify({
      name: 'test-drain-1',
      type: 'webhook',
      config: { url: 'https://example.test/hook-2' },
    }),
  })
  assertEquals(res.status, 409)
  const body = await res.json()
  assertEquals(body.code, 'conflict')
  assertExists(body.message)
})

Deno.test('GET /projects/{ref}/analytics/log-drains now lists created drain', async () => {
  if (!testRef) return
  const session = await getTestSession()
  const res = await fetch(`${PROJECTS_URL}/${testRef}/analytics/log-drains`, {
    headers: authHeaders(session.access_token),
  })
  assertEquals(res.status, 200)
  const body = await res.json()
  assert(Array.isArray(body))
  assertEquals(body.length, 1)
  assertEquals(body[0].name, 'test-drain-1')
})

Deno.test('PUT /projects/{ref}/analytics/log-drains/{token} updates drain', async () => {
  if (!testRef || !createdDrainToken) return
  const session = await getTestSession()
  const before = await countAuditRowsByAction('project.log_drain_updated', testRef)

  const res = await fetch(`${PROJECTS_URL}/${testRef}/analytics/log-drains/${createdDrainToken}`, {
    method: 'PUT',
    headers: authHeaders(session.access_token),
    body: JSON.stringify({
      name: 'test-drain-1-renamed',
      description: 'updated',
      type: 'webhook',
      config: { url: 'https://example.test/hook-v2' },
    }),
  })
  assertEquals(res.status, 200)
  const body = await res.json()
  assertEquals(body.name, 'test-drain-1-renamed')
  assertEquals(body.description, 'updated')

  const after = await countAuditRowsByAction('project.log_drain_updated', testRef)
  assertEquals(after - before, 1, 'PUT must emit one project.log_drain_updated audit row')
})

Deno.test('DELETE /projects/{ref}/analytics/log-drains/{token} soft-deletes drain', async () => {
  if (!testRef || !createdDrainToken) return
  const session = await getTestSession()
  const res = await fetch(`${PROJECTS_URL}/${testRef}/analytics/log-drains/${createdDrainToken}`, {
    method: 'DELETE',
    headers: authHeaders(session.access_token),
  })
  assertEquals(res.status, 200)

  const listRes = await fetch(`${PROJECTS_URL}/${testRef}/analytics/log-drains`, {
    headers: authHeaders(session.access_token),
  })
  const body = await listRes.json()
  assertEquals(body.length, 0, 'soft-deleted drain should not appear in list')
})

Deno.test('GET /projects/{ref}/analytics/log-drains/{unknownToken} returns 404', async () => {
  if (!testRef) return
  const session = await getTestSession()
  const res = await fetch(
    `${PROJECTS_URL}/${testRef}/analytics/log-drains/00000000-0000-0000-0000-000000000000`,
    { headers: authHeaders(session.access_token) }
  )
  assertEquals(res.status, 404)
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
