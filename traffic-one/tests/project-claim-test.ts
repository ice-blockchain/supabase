import { assertEquals, assertExists } from 'jsr:@std/assert@1'
import { createClient } from 'npm:@supabase/supabase-js@2'

import 'jsr:@std/dotenv/load'

const supabaseUrl = Deno.env.get('SUPABASE_URL')!
const supabaseKey = Deno.env.get('SUPABASE_ANON_KEY')!
const supabase = createClient(supabaseUrl, supabaseKey, {
  auth: { autoRefreshToken: false, persistSession: false, detectSessionInUrl: false },
})

// Served by the new `v1-organizations` Kong service (Bundle G).
const V1_ORG_URL = `${supabaseUrl}/api/v1/organizations`
const PLATFORM_ORG_URL = `${supabaseUrl}/api/platform/organizations`

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

// Create an ephemeral org so we have a real slug to hit. Cleanup via `cleanupOrg`.
async function createTempOrg(token: string): Promise<string> {
  const res = await fetch(PLATFORM_ORG_URL, {
    method: 'POST',
    headers: authHeaders(token),
    body: JSON.stringify({ name: `ProjectClaim Test ${Date.now()}`, tier: 'tier_free' }),
  })
  assertEquals(res.status, 201)
  const org = await res.json()
  return org.slug
}

async function cleanupOrg(token: string, slug: string) {
  await fetch(`${PLATFORM_ORG_URL}/${slug}`, {
    method: 'DELETE',
    headers: authHeaders(token),
  })
}

// ── Auth ────────────────────────────────────────────────

Deno.test(
  'GET /v1/organizations/{slug}/project-claim/{token} returns 401 without auth',
  async () => {
    const res = await fetch(`${V1_ORG_URL}/anything/project-claim/token-abc`)
    assertEquals(res.status, 401)
    await res.body?.cancel()
  }
)

Deno.test(
  'POST /v1/organizations/{slug}/project-claim/{token} returns 401 without auth',
  async () => {
    const res = await fetch(`${V1_ORG_URL}/anything/project-claim/token-abc`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
    })
    assertEquals(res.status, 401)
    await res.body?.cancel()
  }
)

// ── Kong routing smoke test ─────────────────────────────

Deno.test(
  'Kong routes /api/v1/organizations/** to traffic-one (not 404 from dashboard)',
  async () => {
    const session = await getTestSession()
    // Even with a bogus slug we should hit traffic-one (which returns 404 with a JSON
    // body), *not* Kong's catch-all dashboard route (which returns a Next.js 404 HTML
    // page). A JSON content-type confirms the new v1-organizations service is wired.
    const res = await fetch(`${V1_ORG_URL}/no-such-org/project-claim/abc`, {
      headers: authHeaders(session.access_token),
    })
    const contentType = res.headers.get('content-type') ?? ''
    assertEquals(
      contentType.includes('application/json'),
      true,
      `expected JSON response from traffic-one, got ${contentType}`
    )
    await res.body?.cancel()
  }
)

// ── Happy path (self-hosted stub) ───────────────────────

Deno.test(
  'GET /v1/organizations/{slug}/project-claim/{token} returns { valid: false } (not 404)',
  async () => {
    const session = await getTestSession()
    const slug = await createTempOrg(session.access_token)
    try {
      const res = await fetch(`${V1_ORG_URL}/${slug}/project-claim/any-token`, {
        headers: authHeaders(session.access_token),
      })
      assertEquals(res.status, 200)
      const body = await res.json()
      assertEquals(body.valid, false)
    } finally {
      await cleanupOrg(session.access_token, slug)
    }
  }
)

Deno.test(
  'POST /v1/organizations/{slug}/project-claim/{token} returns 501 self_hosted_unsupported',
  async () => {
    const session = await getTestSession()
    const slug = await createTempOrg(session.access_token)
    try {
      const res = await fetch(`${V1_ORG_URL}/${slug}/project-claim/any-token`, {
        method: 'POST',
        headers: authHeaders(session.access_token),
      })
      assertEquals(res.status, 501)
      const body = await res.json()
      assertEquals(body.code, 'self_hosted_unsupported')
      assertExists(body.message)
    } finally {
      await cleanupOrg(session.access_token, slug)
    }
  }
)

// ── 404 on unknown org / unknown path ───────────────────

Deno.test('GET /v1/organizations/{unknown-slug}/project-claim/{token} returns 404', async () => {
  const session = await getTestSession()
  const res = await fetch(`${V1_ORG_URL}/does-not-exist-bundle-g/project-claim/any-token`, {
    headers: authHeaders(session.access_token),
  })
  assertEquals(res.status, 404)
  await res.body?.cancel()
})

Deno.test('GET /v1/organizations/{slug}/unknown-subpath returns 404', async () => {
  const session = await getTestSession()
  const slug = await createTempOrg(session.access_token)
  try {
    const res = await fetch(`${V1_ORG_URL}/${slug}/not-a-real-endpoint`, {
      headers: authHeaders(session.access_token),
    })
    assertEquals(res.status, 404)
    await res.body?.cancel()
  } finally {
    await cleanupOrg(session.access_token, slug)
  }
})

Deno.test('PUT /v1/organizations/{slug}/project-claim/{token} returns 405', async () => {
  const session = await getTestSession()
  const slug = await createTempOrg(session.access_token)
  try {
    const res = await fetch(`${V1_ORG_URL}/${slug}/project-claim/any-token`, {
      method: 'PUT',
      headers: authHeaders(session.access_token),
    })
    assertEquals(res.status, 405)
    await res.body?.cancel()
  } finally {
    await cleanupOrg(session.access_token, slug)
  }
})
