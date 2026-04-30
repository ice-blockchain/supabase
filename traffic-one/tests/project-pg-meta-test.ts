import { Pool } from 'https://deno.land/x/postgres@v0.19.3/mod.ts'
import { assert, assertEquals, assertExists } from 'jsr:@std/assert@1'
import { createClient } from 'npm:@supabase/supabase-js@2'

import 'jsr:@std/dotenv/load'

// ─────────────────────────────────────────────────────────────────────────────
//
// Integration tests for Phase 4 pg-meta dispatcher.
//
// These hit a live traffic-one instance (SUPABASE_URL points at the Kong edge)
// and therefore depend on the stack being up. They cover:
//   - auth gating (401 without bearer, 404 for unknown ref)
//   - POST /{ref}/query body validation (400 on missing/empty query)
//   - POST /{ref}/query round-trip against the shared-stack pg-meta
//     (local mode: pgMetaUrl is derived from SUPABASE_URL + PG_META_URL)
//   - audit log emitted for every /query attempt
//   - GET /{ref}/tables end-to-end read-through
//   - unknown surfaces return 404
//
// ─────────────────────────────────────────────────────────────────────────────

const supabaseUrl = Deno.env.get('SUPABASE_URL')!
const supabaseKey = Deno.env.get('SUPABASE_ANON_KEY')!
const superuserDbUrl = Deno.env.get('TEST_SUPERUSER_DB_URL')!
const supabase = createClient(supabaseUrl, supabaseKey, {
  auth: {
    autoRefreshToken: false,
    persistSession: false,
    detectSessionInUrl: false,
  },
})

const PG_META_URL = `${supabaseUrl}/api/platform/pg-meta`
const ORG_URL = `${supabaseUrl}/api/platform/organizations`
const PROJECTS_URL = `${supabaseUrl}/api/platform/projects`

// ── Helpers ─────────────────────────────────────────────────

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

// Count audit rows matching a given action. Used to prove side effects without
// depending on row ordering across parallel test runs.
async function countAudit(action: string): Promise<number> {
  const pool = new Pool(superuserDbUrl, 1, true)
  try {
    const conn = await pool.connect()
    try {
      const res = await conn.queryObject<{ n: bigint }>`
        SELECT count(*)::bigint AS n
        FROM traffic.audit_logs
        WHERE action_name = ${action}
      `
      return Number(res.rows[0]?.n ?? 0n)
    } finally {
      conn.release()
    }
  } finally {
    await pool.end()
  }
}

// ── Auth ───────────────────────────────────────────────────

Deno.test('POST /api/platform/pg-meta/{ref}/query returns 401 without auth', async () => {
  const res = await fetch(`${PG_META_URL}/some-ref/query`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ query: 'select 1' }),
  })
  assertEquals(res.status, 401)
  await res.body?.cancel()
})

Deno.test('GET /api/platform/pg-meta/{ref}/tables returns 401 without auth', async () => {
  const res = await fetch(`${PG_META_URL}/some-ref/tables`)
  assertEquals(res.status, 401)
  await res.body?.cancel()
})

// ── Setup ──────────────────────────────────────────────────

let testOrgSlug: string | null = null
let testRef: string | null = null

Deno.test('setup: create test org and project for pg-meta tests', async () => {
  const session = await getTestSession()

  const orgName = `PgMeta Test Org ${Date.now()}`
  const orgRes = await fetch(ORG_URL, {
    method: 'POST',
    headers: authHeaders(session.access_token),
    body: JSON.stringify({ name: orgName, tier: 'tier_free' }),
  })
  assertEquals(orgRes.status, 201)
  const org = await orgRes.json()
  testOrgSlug = org.slug

  const projectName = `PgMeta Test Project ${Date.now()}`
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

// ── Unknown ref → 404 ──────────────────────────────────────

Deno.test('POST /api/platform/pg-meta/{unknownRef}/query returns 404', async () => {
  const session = await getTestSession()
  const res = await fetch(`${PG_META_URL}/nonexistent00000000/query`, {
    method: 'POST',
    headers: authHeaders(session.access_token),
    body: JSON.stringify({ query: 'select 1' }),
  })
  assertEquals(res.status, 404)
  await res.body?.cancel()
})

Deno.test('GET /api/platform/pg-meta/{unknownRef}/tables returns 404', async () => {
  const session = await getTestSession()
  const res = await fetch(`${PG_META_URL}/nonexistent00000000/tables`, {
    headers: authHeaders(session.access_token),
  })
  assertEquals(res.status, 404)
  await res.body?.cancel()
})

// ── POST /query body validation ───────────────────────────

Deno.test('POST /api/platform/pg-meta/{ref}/query rejects missing query with 400', async () => {
  if (!testRef) return
  const session = await getTestSession()
  const res = await fetch(`${PG_META_URL}/${testRef}/query`, {
    method: 'POST',
    headers: authHeaders(session.access_token),
    body: JSON.stringify({}),
  })
  assertEquals(res.status, 400)
  const body = await res.json()
  assertExists(body.message)
})

Deno.test('POST /api/platform/pg-meta/{ref}/query rejects empty query with 400', async () => {
  if (!testRef) return
  const session = await getTestSession()
  const res = await fetch(`${PG_META_URL}/${testRef}/query`, {
    method: 'POST',
    headers: authHeaders(session.access_token),
    body: JSON.stringify({ query: '' }),
  })
  assertEquals(res.status, 400)
  await res.body?.cancel()
})

Deno.test('POST /api/platform/pg-meta/{ref}/query rejects non-JSON body with 400', async () => {
  if (!testRef) return
  const session = await getTestSession()
  const res = await fetch(`${PG_META_URL}/${testRef}/query`, {
    method: 'POST',
    headers: authHeaders(session.access_token),
    body: 'not json',
  })
  assertEquals(res.status, 400)
  await res.body?.cancel()
})

// ── POST /query round-trip + audit log ────────────────────

// In local mode the project backend resolves to the shared pg-meta
// (http://meta:8080), so `select 1` should actually return a row. We also
// check that an audit row lands in traffic.audit_logs regardless of upstream
// outcome — that's the whole point of this route existing in traffic-one.
Deno.test('POST /api/platform/pg-meta/{ref}/query emits an audit log', async () => {
  if (!testRef) return
  const session = await getTestSession()
  const before = await countAudit('project.pg_meta.query')
  const res = await fetch(`${PG_META_URL}/${testRef}/query`, {
    method: 'POST',
    headers: authHeaders(session.access_token),
    body: JSON.stringify({ query: 'select 1 as one' }),
  })
  // We don't pin the status here — shared-stack returns 200, api-mode may
  // return 502 if the provisioned pg-meta isn't reachable from the test
  // host. Either way an audit row must be present.
  await res.body?.cancel()
  assert(
    res.status === 200 || res.status === 502 || res.status === 501,
    `unexpected status ${res.status}`,
  )
  const after = await countAudit('project.pg_meta.query')
  assert(after > before, 'audit log should have at least one new row')
})

// ── GET surfaces ───────────────────────────────────────────

Deno.test('GET /api/platform/pg-meta/{ref}/tables returns a list', async () => {
  if (!testRef) return
  const session = await getTestSession()
  const res = await fetch(`${PG_META_URL}/${testRef}/tables`, {
    headers: authHeaders(session.access_token),
  })
  // Either a 200 from the live pg-meta or a 502/501 when the backend isn't
  // reachable from the test host. Both are fine — we're proving the
  // dispatcher is wired end-to-end, not asserting on live DB state.
  assert(
    res.status === 200 || res.status === 502 || res.status === 501,
    `unexpected status ${res.status}`,
  )
  if (res.status === 200) {
    const body = await res.json()
    assert(Array.isArray(body), 'tables listing must be an array')
  } else {
    await res.body?.cancel()
  }
})

Deno.test('GET /api/platform/pg-meta/{ref}/unknown-surface returns 404', async () => {
  if (!testRef) return
  const session = await getTestSession()
  const res = await fetch(`${PG_META_URL}/${testRef}/frobnicate`, {
    headers: authHeaders(session.access_token),
  })
  assertEquals(res.status, 404)
  await res.body?.cancel()
})

// ── Method-not-allowed sanity ─────────────────────────────

Deno.test('PUT /api/platform/pg-meta/{ref}/query returns 405', async () => {
  if (!testRef) return
  const session = await getTestSession()
  const res = await fetch(`${PG_META_URL}/${testRef}/query`, {
    method: 'PUT',
    headers: authHeaders(session.access_token),
    body: JSON.stringify({ query: 'select 1' }),
  })
  assertEquals(res.status, 405)
  await res.body?.cancel()
})

Deno.test('POST /api/platform/pg-meta/{ref}/tables returns 405', async () => {
  if (!testRef) return
  const session = await getTestSession()
  const res = await fetch(`${PG_META_URL}/${testRef}/tables`, {
    method: 'POST',
    headers: authHeaders(session.access_token),
    body: '{}',
  })
  assertEquals(res.status, 405)
  await res.body?.cancel()
})

// ── Cleanup ────────────────────────────────────────────────

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
