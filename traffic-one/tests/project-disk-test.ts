import { assert, assertEquals, assertExists } from 'jsr:@std/assert@1'
import { createClient } from 'npm:@supabase/supabase-js@2'

import 'jsr:@std/dotenv/load'

const supabaseUrl = Deno.env.get('SUPABASE_URL')!
const supabaseKey = Deno.env.get('SUPABASE_ANON_KEY')!
const supabase = createClient(supabaseUrl, supabaseKey, {
  auth: { autoRefreshToken: false, persistSession: false, detectSessionInUrl: false },
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

Deno.test('GET /projects/{ref}/disk returns 401 without auth', async () => {
  const res = await fetch(`${PROJECTS_URL}/some-ref/disk`)
  assertEquals(res.status, 401)
  await res.body?.cancel()
})

Deno.test('POST /projects/{ref}/disk returns 401 without auth', async () => {
  const res = await fetch(`${PROJECTS_URL}/some-ref/disk`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: '{}',
  })
  assertEquals(res.status, 401)
  await res.body?.cancel()
})

Deno.test('GET /projects/available-regions returns 401 without auth', async () => {
  const res = await fetch(`${PROJECTS_URL}/available-regions`)
  assertEquals(res.status, 401)
  await res.body?.cancel()
})

Deno.test('GET /projects/{ref}/restore/versions returns 401 without auth', async () => {
  const res = await fetch(`${PROJECTS_URL}/some-ref/restore/versions`)
  assertEquals(res.status, 401)
  await res.body?.cancel()
})

// ── Setup test project ──────────────────────────────────

let testOrgSlug: string | null = null
let testRef: string | null = null

Deno.test('setup: create test org and project for disk tests', async () => {
  const session = await getTestSession()

  const orgName = `Disk Test Org ${Date.now()}`
  const orgRes = await fetch(ORG_URL, {
    method: 'POST',
    headers: authHeaders(session.access_token),
    body: JSON.stringify({ name: orgName, tier: 'tier_free' }),
  })
  assertEquals(orgRes.status, 201)
  const org = await orgRes.json()
  testOrgSlug = org.slug

  const projectName = `Disk Test Project ${Date.now()}`
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

// ── GET /disk ────────────────────────────────────────────

Deno.test('GET /projects/{ref}/disk returns local disk defaults', async () => {
  if (!testRef) return
  const session = await getTestSession()
  const res = await fetch(`${PROJECTS_URL}/${testRef}/disk`, {
    headers: authHeaders(session.access_token),
  })
  assertEquals(res.status, 200)

  const body = await res.json()
  assertEquals(typeof body.size_gb, 'number')
  assertEquals(typeof body.type, 'string')
  assertEquals(typeof body.iops, 'number')
  assertEquals(typeof body.throughput_mbps, 'number')
  assert(body.size_gb > 0)
  assert(body.type.length > 0)
})

// ── GET /disk/util ───────────────────────────────────────

Deno.test('GET /projects/{ref}/disk/util returns { used_gb, total_gb, percent_used }', async () => {
  if (!testRef) return
  const session = await getTestSession()
  const res = await fetch(`${PROJECTS_URL}/${testRef}/disk/util`, {
    headers: authHeaders(session.access_token),
  })
  assertEquals(res.status, 200)

  const body = await res.json()
  assertEquals(typeof body.used_gb, 'number')
  assertEquals(typeof body.total_gb, 'number')
  assertEquals(typeof body.percent_used, 'number')
  assert(Number.isFinite(body.used_gb))
  assert(Number.isFinite(body.total_gb))
  assert(Number.isFinite(body.percent_used))
  assert(body.total_gb >= 0)
  assert(body.percent_used >= 0)
})

// ── GET /disk/custom-config ──────────────────────────────

Deno.test('GET /projects/{ref}/disk/custom-config returns custom-config shape', async () => {
  if (!testRef) return
  const session = await getTestSession()
  const res = await fetch(`${PROJECTS_URL}/${testRef}/disk/custom-config`, {
    headers: authHeaders(session.access_token),
  })
  assertEquals(res.status, 200)

  const body = await res.json()
  assertExists(body.compute_size)
  assertEquals(typeof body.compute_size, 'string')
  assertEquals(typeof body.provisioned_iops, 'number')
  assertEquals(typeof body.provisioned_throughput_mbps, 'number')
})

// ── POST mutations → 501 ─────────────────────────────────

const UNSUPPORTED_POST_PATHS = ['/disk', '/disk/custom-config', '/resize']

for (const subPath of UNSUPPORTED_POST_PATHS) {
  Deno.test(`POST /projects/{ref}${subPath} returns 501 self_hosted_unsupported`, async () => {
    if (!testRef) return
    const session = await getTestSession()
    const res = await fetch(`${PROJECTS_URL}/${testRef}${subPath}`, {
      method: 'POST',
      headers: authHeaders(session.access_token),
      body: '{}',
    })
    assertEquals(res.status, 501)
    const body = await res.json()
    assertEquals(body.code, 'self_hosted_unsupported')
    assertExists(body.message)
  })
}

// ── GET /available-regions ───────────────────────────────

Deno.test("GET /projects/available-regions returns [{ region: 'local', ... }]", async () => {
  const session = await getTestSession()
  const res = await fetch(`${PROJECTS_URL}/available-regions`, {
    headers: authHeaders(session.access_token),
  })
  assertEquals(res.status, 200)

  const body = await res.json()
  assert(Array.isArray(body))
  assert(body.length >= 1)
  assertEquals(body[0].region, 'local')
  assertExists(body[0].name)
  assertExists(body[0].country_code)
})

// ── GET /restore/versions ────────────────────────────────

Deno.test('GET /projects/{ref}/restore/versions returns [{ postgres_version }]', async () => {
  if (!testRef) return
  const session = await getTestSession()
  const res = await fetch(`${PROJECTS_URL}/${testRef}/restore/versions`, {
    headers: authHeaders(session.access_token),
  })
  assertEquals(res.status, 200)

  const body = await res.json()
  assert(Array.isArray(body))
  assert(body.length > 0)
  assertExists(body[0].postgres_version)
  assertEquals(typeof body[0].postgres_version, 'string')
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
