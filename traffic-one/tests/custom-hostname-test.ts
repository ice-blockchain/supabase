import { assert, assertEquals, assertExists } from 'jsr:@std/assert@1'
import { createClient } from 'npm:@supabase/supabase-js@2'

import 'jsr:@std/dotenv/load'

const supabaseUrl = Deno.env.get('SUPABASE_URL')!
const supabaseKey = Deno.env.get('SUPABASE_ANON_KEY')!
const supabase = createClient(supabaseUrl, supabaseKey, {
  auth: { autoRefreshToken: false, persistSession: false, detectSessionInUrl: false },
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

// ── Auth ─────────────────────────────────────────────────

Deno.test('GET /v1/projects/{ref}/custom-hostname returns 401 without auth', async () => {
  const res = await fetch(`${V1_PROJECTS_URL}/some-ref/custom-hostname`)
  assertEquals(res.status, 401)
  await res.body?.cancel()
})

Deno.test(
  'POST /v1/projects/{ref}/custom-hostname/initialize returns 401 without auth',
  async () => {
    const res = await fetch(`${V1_PROJECTS_URL}/some-ref/custom-hostname/initialize`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ custom_hostname: 'foo.example.com' }),
    })
    assertEquals(res.status, 401)
    await res.body?.cancel()
  }
)

Deno.test('POST /v1/projects/{ref}/custom-hostname/activate returns 401 without auth', async () => {
  const res = await fetch(`${V1_PROJECTS_URL}/some-ref/custom-hostname/activate`, {
    method: 'POST',
  })
  assertEquals(res.status, 401)
  await res.body?.cancel()
})

Deno.test('POST /v1/projects/{ref}/custom-hostname/reverify returns 401 without auth', async () => {
  const res = await fetch(`${V1_PROJECTS_URL}/some-ref/custom-hostname/reverify`, {
    method: 'POST',
  })
  assertEquals(res.status, 401)
  await res.body?.cancel()
})

// ── Setup ────────────────────────────────────────────────

let testOrgSlug: string | null = null
let testRef: string | null = null

Deno.test('setup: create test org and project for custom-hostname tests', async () => {
  const session = await getTestSession()

  const orgName = `Custom Hostname Org ${Date.now()}`
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
      name: `Custom Hostname Project ${Date.now()}`,
      organization_slug: testOrgSlug,
      db_region: 'local',
    }),
  })
  assertEquals(projRes.status, 201)
  const project = await projRes.json()
  testRef = project.ref
})

// ── Unknown ref → 404 ────────────────────────────────────

Deno.test('GET /v1/projects/{unknownRef}/custom-hostname returns 404', async () => {
  const session = await getTestSession()
  const res = await fetch(`${V1_PROJECTS_URL}/nonexistent00000000/custom-hostname`, {
    headers: authHeaders(session.access_token),
  })
  assertEquals(res.status, 404)
  await res.body?.cancel()
})

// ── GET before initialize → not_configured stub ──────────

Deno.test(
  'GET /v1/projects/{ref}/custom-hostname without a stored row returns not_configured stub',
  async () => {
    if (!testRef) return
    const session = await getTestSession()
    const res = await fetch(`${V1_PROJECTS_URL}/${testRef}/custom-hostname`, {
      headers: authHeaders(session.access_token),
    })
    assertEquals(res.status, 200)
    const body = await res.json()
    assertEquals(body.status, 'not_configured')
    assertEquals(body.custom_hostname, null)
    assert(Array.isArray(body.verification_errors))
    assertEquals(body.verification_errors.length, 0)
  }
)

// ── Initialize persists the row ──────────────────────────

const initialHostname = `app-${Date.now()}.example.com`

Deno.test(
  'POST /v1/projects/{ref}/custom-hostname/initialize persists with status=pending',
  async () => {
    if (!testRef) return
    const session = await getTestSession()
    const res = await fetch(`${V1_PROJECTS_URL}/${testRef}/custom-hostname/initialize`, {
      method: 'POST',
      headers: authHeaders(session.access_token),
      body: JSON.stringify({ custom_hostname: initialHostname }),
    })
    assertEquals(res.status, 200)
    const body = await res.json()
    assertEquals(body.status, 'pending')
    assertEquals(body.custom_hostname, initialHostname)
    assert(Array.isArray(body.verification_errors))
  }
)

Deno.test(
  'POST /v1/projects/{ref}/custom-hostname/initialize without body returns 400',
  async () => {
    if (!testRef) return
    const session = await getTestSession()
    const res = await fetch(`${V1_PROJECTS_URL}/${testRef}/custom-hostname/initialize`, {
      method: 'POST',
      headers: authHeaders(session.access_token),
      body: JSON.stringify({}),
    })
    assertEquals(res.status, 400)
    await res.body?.cancel()
  }
)

Deno.test(
  'GET /v1/projects/{ref}/custom-hostname returns stored row after initialize',
  async () => {
    if (!testRef) return
    const session = await getTestSession()
    const res = await fetch(`${V1_PROJECTS_URL}/${testRef}/custom-hostname`, {
      headers: authHeaders(session.access_token),
    })
    assertEquals(res.status, 200)
    const body = await res.json()
    assertEquals(body.status, 'pending')
    assertEquals(body.custom_hostname, initialHostname)
    assertExists(body.inserted_at)
    assertExists(body.updated_at)
  }
)

// ── Re-initialize upserts the row ────────────────────────

Deno.test(
  'POST /v1/projects/{ref}/custom-hostname/initialize overwrites custom_hostname on re-initialize',
  async () => {
    if (!testRef) return
    const session = await getTestSession()
    const nextHostname = `app-${Date.now()}-next.example.com`
    const res = await fetch(`${V1_PROJECTS_URL}/${testRef}/custom-hostname/initialize`, {
      method: 'POST',
      headers: authHeaders(session.access_token),
      body: JSON.stringify({ custom_hostname: nextHostname }),
    })
    assertEquals(res.status, 200)
    const body = await res.json()
    assertEquals(body.custom_hostname, nextHostname)
    assertEquals(body.status, 'pending')
  }
)

// ── Activate / Reverify → 501 self_hosted_unsupported ────

Deno.test(
  'POST /v1/projects/{ref}/custom-hostname/activate returns 501 self_hosted_unsupported',
  async () => {
    if (!testRef) return
    const session = await getTestSession()
    const res = await fetch(`${V1_PROJECTS_URL}/${testRef}/custom-hostname/activate`, {
      method: 'POST',
      headers: authHeaders(session.access_token),
    })
    assertEquals(res.status, 501)
    const body = await res.json()
    assertEquals(body.code, 'self_hosted_unsupported')
    assertExists(body.message)
  }
)

Deno.test(
  'POST /v1/projects/{ref}/custom-hostname/reverify returns 501 self_hosted_unsupported',
  async () => {
    if (!testRef) return
    const session = await getTestSession()
    const res = await fetch(`${V1_PROJECTS_URL}/${testRef}/custom-hostname/reverify`, {
      method: 'POST',
      headers: authHeaders(session.access_token),
    })
    assertEquals(res.status, 501)
    const body = await res.json()
    assertEquals(body.code, 'self_hosted_unsupported')
    assertExists(body.message)
  }
)

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
