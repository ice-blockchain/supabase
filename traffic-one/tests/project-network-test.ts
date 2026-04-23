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

// ── Auth: 401 on every endpoint without Authorization ────

type AuthCase = {
  label: string
  url: string
  method: string
  body?: string
}

const UNAUTH_CASES: AuthCase[] = [
  {
    label: 'GET /v1/projects/{ref}/network-restrictions',
    url: `${V1_PROJECTS_URL}/some-ref/network-restrictions`,
    method: 'GET',
  },
  {
    label: 'POST /v1/projects/{ref}/network-restrictions/apply',
    url: `${V1_PROJECTS_URL}/some-ref/network-restrictions/apply`,
    method: 'POST',
    body: '{}',
  },
  {
    label: 'POST /v1/projects/{ref}/network-bans/retrieve',
    url: `${V1_PROJECTS_URL}/some-ref/network-bans/retrieve`,
    method: 'POST',
    body: '{}',
  },
  {
    label: 'DELETE /v1/projects/{ref}/network-bans',
    url: `${V1_PROJECTS_URL}/some-ref/network-bans`,
    method: 'DELETE',
  },
  {
    label: 'POST /v1/projects/{ref}/read-replicas/setup',
    url: `${V1_PROJECTS_URL}/some-ref/read-replicas/setup`,
    method: 'POST',
    body: '{}',
  },
  {
    label: 'POST /v1/projects/{ref}/read-replicas/remove',
    url: `${V1_PROJECTS_URL}/some-ref/read-replicas/remove`,
    method: 'POST',
    body: '{}',
  },
  {
    label: 'GET /platform/projects/{ref}/privatelink/associations',
    url: `${PROJECTS_URL}/some-ref/privatelink/associations`,
    method: 'GET',
  },
  {
    label: 'POST /platform/projects/{ref}/privatelink/associations/aws-account',
    url: `${PROJECTS_URL}/some-ref/privatelink/associations/aws-account`,
    method: 'POST',
    body: '{}',
  },
  {
    label: 'DELETE /platform/projects/{ref}/privatelink/associations/aws-account/{id}',
    url: `${PROJECTS_URL}/some-ref/privatelink/associations/aws-account/acct-123`,
    method: 'DELETE',
  },
]

for (const authCase of UNAUTH_CASES) {
  Deno.test(`${authCase.label} returns 401 without auth`, async () => {
    const init: RequestInit = { method: authCase.method }
    if (authCase.body !== undefined) {
      init.headers = { 'Content-Type': 'application/json' }
      init.body = authCase.body
    }
    const res = await fetch(authCase.url, init)
    assertEquals(res.status, 401)
    await res.body?.cancel()
  })
}

// ── Setup test org + project ─────────────────────────────

let testOrgSlug: string | null = null
let testRef: string | null = null

Deno.test('setup: create test org and project for project-network tests', async () => {
  const session = await getTestSession()

  const orgName = `Network Test Org ${Date.now()}`
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
      name: `Network Test Project ${Date.now()}`,
      organization_slug: testOrgSlug,
      db_region: 'local',
    }),
  })
  assertEquals(projRes.status, 201)
  const project = await projRes.json()
  testRef = project.ref
})

// ── v1: network-restrictions ─────────────────────────────

Deno.test('GET /v1/projects/{ref}/network-restrictions returns documented shape', async () => {
  if (!testRef) return
  const session = await getTestSession()
  const res = await fetch(`${V1_PROJECTS_URL}/${testRef}/network-restrictions`, {
    headers: authHeaders(session.access_token),
  })
  assertEquals(res.status, 200)

  const body = await res.json()
  assertExists(body.entries)
  assert(Array.isArray(body.entries.dbAllowedCidrs))
  assertEquals(body.entries.dbAllowedCidrs.length, 0)
  assert(Array.isArray(body.entries.dbAllowedCidrsV6))
  assertEquals(body.entries.dbAllowedCidrsV6.length, 0)

  assertExists(body.old_config)
  assert(Array.isArray(body.old_config.dbAllowedCidrs))
  assert(Array.isArray(body.old_config.dbAllowedCidrsV6))

  assertExists(body.new_config)
  assert(Array.isArray(body.new_config.dbAllowedCidrs))
  assert(Array.isArray(body.new_config.dbAllowedCidrsV6))

  assertEquals(body.status, 'applied')
})

Deno.test(
  'POST /v1/projects/{ref}/network-restrictions/apply returns 501 self_hosted_unsupported',
  async () => {
    if (!testRef) return
    const session = await getTestSession()
    const res = await fetch(`${V1_PROJECTS_URL}/${testRef}/network-restrictions/apply`, {
      method: 'POST',
      headers: authHeaders(session.access_token),
      body: JSON.stringify({
        dbAllowedCidrs: ['0.0.0.0/0'],
        dbAllowedCidrsV6: [],
      }),
    })
    assertEquals(res.status, 501)
    const body = await res.json()
    assertEquals(body.code, 'self_hosted_unsupported')
    assertExists(body.message)
  }
)

// ── v1: network-bans ─────────────────────────────────────

Deno.test(
  'POST /v1/projects/{ref}/network-bans/retrieve returns empty ipv4/ipv6 arrays',
  async () => {
    if (!testRef) return
    const session = await getTestSession()
    const res = await fetch(`${V1_PROJECTS_URL}/${testRef}/network-bans/retrieve`, {
      method: 'POST',
      headers: authHeaders(session.access_token),
      body: '{}',
    })
    assertEquals(res.status, 200)
    const body = await res.json()
    assert(Array.isArray(body.banned_ipv4_addresses))
    assertEquals(body.banned_ipv4_addresses.length, 0)
    assert(Array.isArray(body.banned_ipv6_addresses))
    assertEquals(body.banned_ipv6_addresses.length, 0)
  }
)

Deno.test('DELETE /v1/projects/{ref}/network-bans returns 200 with { success: true }', async () => {
  if (!testRef) return
  const session = await getTestSession()
  const res = await fetch(`${V1_PROJECTS_URL}/${testRef}/network-bans`, {
    method: 'DELETE',
    headers: authHeaders(session.access_token),
  })
  assertEquals(res.status, 200)
  const body = await res.json()
  assertEquals(body.success, true)
})

// ── v1: read-replicas ────────────────────────────────────

for (const action of ['setup', 'remove'] as const) {
  Deno.test(
    `POST /v1/projects/{ref}/read-replicas/${action} returns 501 self_hosted_unsupported`,
    async () => {
      if (!testRef) return
      const session = await getTestSession()
      const res = await fetch(`${V1_PROJECTS_URL}/${testRef}/read-replicas/${action}`, {
        method: 'POST',
        headers: authHeaders(session.access_token),
        body: '{}',
      })
      assertEquals(res.status, 501)
      const body = await res.json()
      assertEquals(body.code, 'self_hosted_unsupported')
      assertExists(body.message)
    }
  )
}

// ── Platform: privatelink associations ───────────────────

Deno.test(
  'GET /platform/projects/{ref}/privatelink/associations returns { associations: [] }',
  async () => {
    if (!testRef) return
    const session = await getTestSession()
    const res = await fetch(`${PROJECTS_URL}/${testRef}/privatelink/associations`, {
      headers: authHeaders(session.access_token),
    })
    assertEquals(res.status, 200)
    const body = await res.json()
    assert(Array.isArray(body.associations))
    assertEquals(body.associations.length, 0)
  }
)

Deno.test(
  'POST /platform/projects/{ref}/privatelink/associations/aws-account returns 501 self_hosted_unsupported',
  async () => {
    if (!testRef) return
    const session = await getTestSession()
    const res = await fetch(`${PROJECTS_URL}/${testRef}/privatelink/associations/aws-account`, {
      method: 'POST',
      headers: authHeaders(session.access_token),
      body: JSON.stringify({ aws_account_id: '123456789012' }),
    })
    assertEquals(res.status, 501)
    const body = await res.json()
    assertEquals(body.code, 'self_hosted_unsupported')
    assertExists(body.message)
  }
)

Deno.test(
  'DELETE /platform/projects/{ref}/privatelink/associations/aws-account/{id} returns 501 self_hosted_unsupported',
  async () => {
    if (!testRef) return
    const session = await getTestSession()
    const res = await fetch(
      `${PROJECTS_URL}/${testRef}/privatelink/associations/aws-account/acct-123`,
      {
        method: 'DELETE',
        headers: authHeaders(session.access_token),
      }
    )
    assertEquals(res.status, 501)
    const body = await res.json()
    assertEquals(body.code, 'self_hosted_unsupported')
    assertExists(body.message)
  }
)

// ── Unknown ref → 404 (spot-check one endpoint per dispatch side) ────────

Deno.test('GET /v1/projects/{unknownRef}/network-restrictions returns 404', async () => {
  const session = await getTestSession()
  const res = await fetch(`${V1_PROJECTS_URL}/nonexistent00000000/network-restrictions`, {
    headers: authHeaders(session.access_token),
  })
  assertEquals(res.status, 404)
  await res.body?.cancel()
})

Deno.test('GET /platform/projects/{unknownRef}/privatelink/associations returns 404', async () => {
  const session = await getTestSession()
  const res = await fetch(`${PROJECTS_URL}/nonexistent00000000/privatelink/associations`, {
    headers: authHeaders(session.access_token),
  })
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
