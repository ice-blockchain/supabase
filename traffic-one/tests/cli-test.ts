import { Pool } from 'https://deno.land/x/postgres@v0.19.3/mod.ts'
import { assert, assertEquals, assertExists, assertNotEquals } from 'jsr:@std/assert@1'
import { createClient } from 'npm:@supabase/supabase-js@2'

import 'jsr:@std/dotenv/load'

const supabaseUrl = Deno.env.get('SUPABASE_URL')!
const supabaseKey = Deno.env.get('SUPABASE_ANON_KEY')!
const trafficDbUrl = Deno.env.get('TRAFFIC_DB_URL')!

const supabase = createClient(supabaseUrl, supabaseKey, {
  auth: {
    autoRefreshToken: false,
    persistSession: false,
    detectSessionInUrl: false,
  },
})

const pool = new Pool(trafficDbUrl, 1, true)

const CLI_URL = `${supabaseUrl}/api/platform/cli`

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

interface ScopedTokenDbRow {
  id: string
  name: string
  token_alias: string
  permissions: string[]
  profile_id: number
}

async function fetchScopedTokenById(
  id: string,
): Promise<ScopedTokenDbRow | null> {
  const connection = await pool.connect()
  try {
    const result = await connection.queryObject<ScopedTokenDbRow>`
      SELECT id, name, token_alias, permissions, profile_id
      FROM traffic.scoped_access_tokens WHERE id = ${id}::uuid
    `
    return result.rows[0] ?? null
  } finally {
    connection.release()
  }
}

// ── Auth ─────────────────────────────────────────────────

Deno.test('POST /cli/login returns 401 without auth', async () => {
  const res = await fetch(`${CLI_URL}/login`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({
      session_id: '00000000-0000-0000-0000-000000000001',
    }),
  })
  assertEquals(res.status, 401)
  await res.body?.cancel()
})

Deno.test('POST /cli/login returns 401 with invalid JWT', async () => {
  const res = await fetch(`${CLI_URL}/login`, {
    method: 'POST',
    headers: {
      Authorization: 'Bearer invalid-token-here',
      'Content-Type': 'application/json',
    },
    body: JSON.stringify({}),
  })
  assertEquals(res.status, 401)
  await res.body?.cancel()
})

// ── Happy path ───────────────────────────────────────────

Deno.test('POST /cli/login issues scoped access token', async () => {
  const session = await getTestSession()
  const res = await fetch(`${CLI_URL}/login`, {
    method: 'POST',
    headers: authHeaders(session.access_token),
    body: JSON.stringify({
      token_name: `cli-test-${Date.now()}`,
      session_id: '00000000-0000-0000-0000-000000000002',
    }),
  })
  assertEquals(res.status, 201)

  const body = await res.json()
  assertExists(body.id)
  assertExists(body.token)
  assertExists(body.token_alias)
  assertExists(body.name)
  assert(Array.isArray(body.permissions))
  assert(body.permissions.includes('organizations_read'))
  assert(body.permissions.includes('projects_read'))
  assert(body.permissions.includes('organization_admin_read'))
  assert(body.permissions.includes('project_admin_read'))

  const row = await fetchScopedTokenById(body.id)
  assertExists(row)
  assertEquals(row!.name, body.name)
  assertEquals(row!.token_alias, body.token_alias)
  assert(row!.permissions.includes('organizations_read'))
})

Deno.test('POST /cli/login defaults name to cli-<timestamp> when omitted', async () => {
  const session = await getTestSession()
  const res = await fetch(`${CLI_URL}/login`, {
    method: 'POST',
    headers: authHeaders(session.access_token),
    body: JSON.stringify({}),
  })
  assertEquals(res.status, 201)

  const body = await res.json()
  assertExists(body.name)
  assert(
    typeof body.name === 'string' && body.name.startsWith('cli-'),
    `expected name to start with 'cli-', got ${body.name}`,
  )
})

Deno.test(
  'POST /cli/login repeated calls issue fresh tokens with different token values',
  async () => {
    const session = await getTestSession()

    const firstRes = await fetch(`${CLI_URL}/login`, {
      method: 'POST',
      headers: authHeaders(session.access_token),
      body: JSON.stringify({ token_name: `cli-a-${Date.now()}` }),
    })
    assertEquals(firstRes.status, 201)
    const first = await firstRes.json()

    const secondRes = await fetch(`${CLI_URL}/login`, {
      method: 'POST',
      headers: authHeaders(session.access_token),
      body: JSON.stringify({ token_name: `cli-b-${Date.now()}` }),
    })
    assertEquals(secondRes.status, 201)
    const second = await secondRes.json()

    assertNotEquals(first.id, second.id)
    assertNotEquals(first.token, second.token)
    assertNotEquals(first.token_alias, second.token_alias)
  },
)

// ── Method routing ───────────────────────────────────────

Deno.test('GET /cli/login returns 405', async () => {
  const session = await getTestSession()
  const res = await fetch(`${CLI_URL}/login`, {
    headers: authHeaders(session.access_token),
  })
  assertEquals(res.status, 405)
  await res.body?.cancel()
})

Deno.test('POST /cli/nonexistent returns 405', async () => {
  const session = await getTestSession()
  const res = await fetch(`${CLI_URL}/nonexistent`, {
    method: 'POST',
    headers: authHeaders(session.access_token),
    body: JSON.stringify({}),
  })
  assertEquals(res.status, 405)
  await res.body?.cancel()
})
