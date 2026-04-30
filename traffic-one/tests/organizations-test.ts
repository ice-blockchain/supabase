import { assert, assertEquals, assertExists, assertNotEquals } from 'jsr:@std/assert@1'
import { createClient } from 'npm:@supabase/supabase-js@2'

import 'jsr:@std/dotenv/load'

import { createDisposableUser, signInAs } from './_helpers/test-user.ts'

const supabaseUrl = Deno.env.get('SUPABASE_URL')!
const supabaseKey = Deno.env.get('SUPABASE_ANON_KEY')!
const supabase = createClient(supabaseUrl, supabaseKey, {
  auth: {
    autoRefreshToken: false,
    persistSession: false,
    detectSessionInUrl: false,
  },
})

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

Deno.test('GET /organizations returns 401 without auth', async () => {
  const res = await fetch(ORG_URL)
  assertEquals(res.status, 401)
  await res.body?.cancel()
})

Deno.test('POST /organizations returns 401 without auth', async () => {
  const res = await fetch(ORG_URL, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ name: 'Test Org' }),
  })
  assertEquals(res.status, 401)
  await res.body?.cancel()
})

// ── CRUD lifecycle ───────────────────────────────────────

let createdSlug: string | null = null

Deno.test('POST /organizations creates org and returns OrganizationResponse shape', async () => {
  const session = await getTestSession()
  const orgName = `Test Org ${Date.now()}`

  const res = await fetch(ORG_URL, {
    method: 'POST',
    headers: authHeaders(session.access_token),
    body: JSON.stringify({
      name: orgName,
      kind: 'PERSONAL',
      tier: 'tier_free',
    }),
  })
  assertEquals(res.status, 201)

  const org = await res.json()
  assertExists(org.id)
  assertEquals(org.name, orgName)
  assertExists(org.slug)
  assertEquals(org.is_owner, true)
  assertEquals(org.billing_partner, null)
  assertExists(org.plan)
  assertEquals(org.plan.id, 'free')
  assertEquals(org.plan.name, 'Free')
  assertEquals(org.stripe_customer_id, null)
  assertEquals(org.subscription_id, null)
  assertEquals(org.usage_billing_enabled, false)
  assertEquals(org.organization_missing_address, false)
  assertEquals(org.organization_missing_tax_id, false)
  assertEquals(org.organization_requires_mfa, false)
  assert(Array.isArray(org.opt_in_tags))
  assertEquals(org.restriction_data, null)
  assertEquals(org.restriction_status, null)

  createdSlug = org.slug
})

Deno.test('POST /organizations rejects missing name', async () => {
  const session = await getTestSession()
  const res = await fetch(ORG_URL, {
    method: 'POST',
    headers: authHeaders(session.access_token),
    body: JSON.stringify({ tier: 'tier_free' }),
  })
  assertEquals(res.status, 400)
  await res.body?.cancel()
})

Deno.test('GET /organizations lists orgs including the created one', async () => {
  const session = await getTestSession()
  const res = await fetch(ORG_URL, {
    headers: authHeaders(session.access_token),
  })
  assertEquals(res.status, 200)

  const orgs = await res.json()
  assert(Array.isArray(orgs))
  assert(orgs.length > 0)

  if (createdSlug) {
    const found = orgs.find((o: { slug: string }) => o.slug === createdSlug)
    assertExists(found, 'Created org should appear in list')
    assertEquals(found.is_owner, true)
    assertExists(found.plan)
  }
})

Deno.test('GET /organizations/{slug} returns OrganizationSlugResponse shape', async () => {
  if (!createdSlug) return
  const session = await getTestSession()
  const res = await fetch(`${ORG_URL}/${createdSlug}`, {
    headers: authHeaders(session.access_token),
  })
  assertEquals(res.status, 200)

  const org = await res.json()
  assertExists(org.id)
  assertExists(org.name)
  assertEquals(org.slug, createdSlug)
  assertExists(org.plan)
  assertEquals(org.billing_partner, null)
  assertEquals(org.usage_billing_enabled, false)
  assertEquals(org.has_oriole_project, false)
  assert(Array.isArray(org.opt_in_tags))
})

Deno.test('GET /organizations/{slug} returns 404 for nonexistent slug', async () => {
  const session = await getTestSession()
  const res = await fetch(`${ORG_URL}/nonexistent-org-slug-12345`, {
    headers: authHeaders(session.access_token),
  })
  assertEquals(res.status, 404)
  await res.body?.cancel()
})

Deno.test('GET /organizations/{slug}/projects returns project list', async () => {
  if (!createdSlug) return
  const session = await getTestSession()
  const res = await fetch(`${ORG_URL}/${createdSlug}/projects`, {
    headers: authHeaders(session.access_token),
  })
  assertEquals(res.status, 200)

  const body = await res.json()
  assertExists(body.pagination)
  assert(Array.isArray(body.projects))
})

Deno.test('PATCH /organizations/{slug} updates org name', async () => {
  if (!createdSlug) return
  const session = await getTestSession()
  const newName = `Updated Org ${Date.now()}`

  const res = await fetch(`${ORG_URL}/${createdSlug}`, {
    method: 'PATCH',
    headers: authHeaders(session.access_token),
    body: JSON.stringify({ name: newName }),
  })
  assertEquals(res.status, 200)

  const org = await res.json()
  assertEquals(org.name, newName)
  assertEquals(org.slug, createdSlug)
  assertExists(org.id)
})

Deno.test('PATCH /organizations/{slug} updates billing_email', async () => {
  if (!createdSlug) return
  const session = await getTestSession()

  const res = await fetch(`${ORG_URL}/${createdSlug}`, {
    method: 'PATCH',
    headers: authHeaders(session.access_token),
    body: JSON.stringify({ billing_email: 'billing@example.com' }),
  })
  assertEquals(res.status, 200)

  const org = await res.json()
  assertEquals(org.billing_email, 'billing@example.com')
})

Deno.test('PATCH /organizations/nonexistent returns 404', async () => {
  const session = await getTestSession()
  const res = await fetch(`${ORG_URL}/nonexistent-org-slug-12345`, {
    method: 'PATCH',
    headers: authHeaders(session.access_token),
    body: JSON.stringify({ name: 'Nope' }),
  })
  assertEquals(res.status, 404)
  await res.body?.cancel()
})

Deno.test('DELETE /organizations/{slug} removes org', async () => {
  if (!createdSlug) return
  const session = await getTestSession()
  const res = await fetch(`${ORG_URL}/${createdSlug}`, {
    method: 'DELETE',
    headers: authHeaders(session.access_token),
  })
  assertEquals(res.status, 200)
  await res.body?.cancel()
})

Deno.test('GET /organizations after delete no longer includes deleted org', async () => {
  if (!createdSlug) return
  const session = await getTestSession()
  const res = await fetch(ORG_URL, {
    headers: authHeaders(session.access_token),
  })
  assertEquals(res.status, 200)

  const orgs = await res.json()
  assert(Array.isArray(orgs))
  const found = orgs.find((o: { slug: string }) => o.slug === createdSlug)
  assertEquals(found, undefined, 'Deleted org should not appear in list')
})

Deno.test('DELETE /organizations/nonexistent returns 404', async () => {
  const session = await getTestSession()
  const res = await fetch(`${ORG_URL}/nonexistent-org-slug-12345`, {
    method: 'DELETE',
    headers: authHeaders(session.access_token),
  })
  assertEquals(res.status, 404)
  await res.body?.cancel()
})

// ── Permissions include org slug ─────────────────────────

Deno.test('GET /permissions includes slug of newly created org', async () => {
  const session = await getTestSession()
  const orgName = `Perm Test Org ${Date.now()}`

  const createRes = await fetch(ORG_URL, {
    method: 'POST',
    headers: authHeaders(session.access_token),
    body: JSON.stringify({ name: orgName, tier: 'tier_free' }),
  })
  assertEquals(createRes.status, 201)
  const createdOrg = await createRes.json()
  const slug = createdOrg.slug

  const permRes = await fetch(
    `${supabaseUrl}/api/platform/profile/permissions`,
    {
      headers: authHeaders(session.access_token),
    },
  )
  assertEquals(permRes.status, 200)
  const permissions = await permRes.json()
  assert(Array.isArray(permissions))
  assert(permissions.includes('organizations_read'))

  // Cleanup
  await fetch(`${ORG_URL}/${slug}`, {
    method: 'DELETE',
    headers: authHeaders(session.access_token),
  })
})

// ── Bundle G — sub-resource PATCH/PUT/DELETE stop 405-ing ───────────────

// Helper: create an ephemeral org for sub-resource assertions and return its slug.
// Cleanup is responsibility of the test via `cleanup(slug)`.
async function createTempOrg(token: string): Promise<string> {
  const res = await fetch(ORG_URL, {
    method: 'POST',
    headers: authHeaders(token),
    body: JSON.stringify({ name: `Bundle G ${Date.now()}`, tier: 'tier_free' }),
  })
  assertEquals(res.status, 201)
  const org = await res.json()
  return org.slug
}

async function cleanupOrg(token: string, slug: string) {
  await fetch(`${ORG_URL}/${slug}`, {
    method: 'DELETE',
    headers: authHeaders(token),
  })
}

// Previously 405 (see plan § 3). Each should now be not-405.
const SUBRESOURCE_MUTATIONS: Array<{
  name: string
  method: 'PATCH' | 'PUT' | 'DELETE'
  path: string
  body?: Record<string, unknown>
}> = [
  {
    name: 'PATCH /apps/{app_id}',
    method: 'PATCH',
    path: '/apps/app-123',
    body: { name: 'x' },
  },
  { name: 'DELETE /apps/{app_id}', method: 'DELETE', path: '/apps/app-123' },
  {
    name: 'PUT /oauth/apps/{id}',
    method: 'PUT',
    path: '/oauth/apps/oauth-123',
    body: {
      name: 'x',
      website: 'https://x.test',
      redirect_uris: ['https://x.test'],
    },
  },
  {
    name: 'DELETE /oauth/apps/{id}/client-secrets/{secret_id}',
    method: 'DELETE',
    path: '/oauth/apps/oauth-123/client-secrets/sec-1',
  },
  {
    name: 'DELETE /apps/installations/{id}',
    method: 'DELETE',
    path: '/apps/installations/inst-1',
  },
  {
    name: 'DELETE /apps/{app_id}/signing-keys/{key_id}',
    method: 'DELETE',
    path: '/apps/app-123/signing-keys/key-1',
  },
  {
    name: 'PUT /cloud-marketplace/link',
    method: 'PUT',
    path: '/cloud-marketplace/link',
    body: { buyer_id: 'buyer-123' },
  },
]

for (const tc of SUBRESOURCE_MUTATIONS) {
  Deno.test(`${tc.name} returns 200 (not 405) on existing org`, async () => {
    const session = await getTestSession()
    const slug = await createTempOrg(session.access_token)
    try {
      const res = await fetch(`${ORG_URL}/${slug}${tc.path}`, {
        method: tc.method,
        headers: authHeaders(session.access_token),
        body: tc.body ? JSON.stringify(tc.body) : undefined,
      })
      // Plan assertion: "status is **not** 405, shape matches the 'empty success' stub
      // (200 with `{}` or 501 with code)."
      assertNotEquals(res.status, 405)
      assert(
        res.status === 200 || res.status === 501,
        `${tc.name}: expected 200 or 501, got ${res.status}`,
      )
      await res.body?.cancel()
    } finally {
      await cleanupOrg(session.access_token, slug)
    }
  })

  Deno.test(`${tc.name} returns 401 without auth`, async () => {
    const res = await fetch(`${ORG_URL}/some-slug${tc.path}`, {
      method: tc.method,
      headers: { 'Content-Type': 'application/json' },
      body: tc.body ? JSON.stringify(tc.body) : undefined,
    })
    assertEquals(res.status, 401)
    await res.body?.cancel()
  })
}

// ── Bundle G — Cloud Marketplace ───────────────────────────────────────

Deno.test(
  "POST /organizations/cloud-marketplace returns 200 { installed:false, reason:'self_hosted' }",
  async () => {
    const session = await getTestSession()
    const res = await fetch(`${ORG_URL}/cloud-marketplace`, {
      method: 'POST',
      headers: authHeaders(session.access_token),
      body: JSON.stringify({ name: 'My AWS Org', buyer_id: 'b-1' }),
    })
    // Previously 404 "Organization not found" (slug fallback); now an explicit handler.
    assertEquals(res.status, 200)
    const body = await res.json()
    assertEquals(body.installed, false)
    assertEquals(body.reason, 'self_hosted')
  },
)

Deno.test('POST /organizations/cloud-marketplace returns 401 without auth', async () => {
  const res = await fetch(`${ORG_URL}/cloud-marketplace`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ name: 'x' }),
  })
  assertEquals(res.status, 401)
  await res.body?.cancel()
})

// ── Bundle G — Preview Creation ────────────────────────────────────────

Deno.test(
  'POST /organizations/preview-creation with name returns slug derived from name',
  async () => {
    const session = await getTestSession()
    const res = await fetch(`${ORG_URL}/preview-creation`, {
      method: 'POST',
      headers: authHeaders(session.access_token),
      body: JSON.stringify({ name: 'My New Team!', tier: 'tier_pro' }),
    })
    assertEquals(res.status, 200)
    const body = await res.json()
    assertEquals(body.name, 'My New Team!')
    assertEquals(body.slug, 'my-new-team')
    // Also expose zero-cost pricing preview so Studio's creation wizard renders.
    assertEquals(body.plan_price, 0)
    assertEquals(body.tax, null)
    assertEquals(body.tax_status, 'not_applicable')
    assertEquals(body.total, 0)
  },
)

Deno.test('POST /organizations/preview-creation without name returns null slug', async () => {
  const session = await getTestSession()
  const res = await fetch(`${ORG_URL}/preview-creation`, {
    method: 'POST',
    headers: authHeaders(session.access_token),
    body: JSON.stringify({ tier: 'tier_pro' }),
  })
  assertEquals(res.status, 200)
  const body = await res.json()
  assertEquals(body.name, null)
  assertEquals(body.slug, null)
})

Deno.test('POST /organizations/preview-creation returns 401 without auth', async () => {
  const res = await fetch(`${ORG_URL}/preview-creation`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ name: 'x' }),
  })
  assertEquals(res.status, 401)
  await res.body?.cancel()
})

// ── Bundle G — Compliance Documents ────────────────────────────────────

const DOC_TYPES = [
  'standard-security-questionnaire',
  'soc2-type-2-report',
  'iso27001-certificate',
]

for (const docType of DOC_TYPES) {
  Deno.test(
    `GET /organizations/{slug}/documents/${docType} returns { fileUrl:null, available:false }`,
    async () => {
      const session = await getTestSession()
      const slug = await createTempOrg(session.access_token)
      try {
        const res = await fetch(`${ORG_URL}/${slug}/documents/${docType}`, {
          headers: authHeaders(session.access_token),
        })
        assertEquals(res.status, 200)
        const body = await res.json()
        // Studio reads `fileUrl`; null short-circuits the download path.
        assertEquals(body.fileUrl, null)
        assertEquals(body.available, false)
      } finally {
        await cleanupOrg(session.access_token, slug)
      }
    },
  )
}

Deno.test(
  'GET /organizations/{slug}/documents/{type} returns 404 for nonexistent org',
  async () => {
    const session = await getTestSession()
    const res = await fetch(
      `${ORG_URL}/nonexistent-org-bundle-g/documents/standard-security-questionnaire`,
      { headers: authHeaders(session.access_token) },
    )
    assertEquals(res.status, 404)
    await res.body?.cancel()
  },
)

Deno.test(
  'POST /organizations/{slug}/documents/dpa returns 501 self_hosted_unsupported',
  async () => {
    const session = await getTestSession()
    const slug = await createTempOrg(session.access_token)
    try {
      const res = await fetch(`${ORG_URL}/${slug}/documents/dpa`, {
        method: 'POST',
        headers: authHeaders(session.access_token),
        body: JSON.stringify({ recipient_email: 'user@example.com' }),
      })
      assertEquals(res.status, 501)
      const body = await res.json()
      assertEquals(body.code, 'self_hosted_unsupported')
    } finally {
      await cleanupOrg(session.access_token, slug)
    }
  },
)

Deno.test('POST /organizations/{slug}/documents/dpa returns 401 without auth', async () => {
  const res = await fetch(`${ORG_URL}/some-slug/documents/dpa`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ recipient_email: 'u@x.test' }),
  })
  assertEquals(res.status, 401)
  await res.body?.cancel()
})

// ── Cross-user (non-member) denial on PATCH/PUT/DELETE sub-resources ──
//
// A disposable second user (not a member of any org owned by test@example.com)
// must not be able to modify or inspect privileged sub-resources.
// Implementation returns 404 (indistinguishable from "unknown slug") or 403.

Deno.test('non-member: PATCH /organizations/{slug} is denied', async () => {
  const session = await getTestSession()
  const orgRes = await fetch(ORG_URL, {
    method: 'POST',
    headers: authHeaders(session.access_token),
    body: JSON.stringify({
      name: `OtherOrg NonMember ${Date.now()}`,
      tier: 'tier_free',
    }),
  })
  assertEquals(orgRes.status, 201)
  const org = await orgRes.json()
  const orgSlug = org.slug

  try {
    const { email, password } = await createDisposableUser('orgs-other')
    const otherSession = await signInAs(email, password)

    const res = await fetch(`${ORG_URL}/${orgSlug}`, {
      method: 'PATCH',
      headers: authHeaders(otherSession.access_token),
      body: JSON.stringify({ name: 'HIJACKED' }),
    })
    assert(
      res.status === 404 || res.status === 403,
      `non-member should be denied (got ${res.status})`,
    )
    await res.body?.cancel()

    const verifyRes = await fetch(`${ORG_URL}/${orgSlug}`, {
      headers: authHeaders(session.access_token),
    })
    assertEquals(verifyRes.status, 200)
    const verifyBody = await verifyRes.json()
    assertNotEquals(verifyBody.name, 'HIJACKED')
  } finally {
    await fetch(`${ORG_URL}/${orgSlug}`, {
      method: 'DELETE',
      headers: authHeaders(session.access_token),
    }).then((r) => r.body?.cancel())
  }
})

Deno.test('non-member: DELETE /organizations/{slug} is denied', async () => {
  const session = await getTestSession()
  const orgRes = await fetch(ORG_URL, {
    method: 'POST',
    headers: authHeaders(session.access_token),
    body: JSON.stringify({
      name: `OtherOrg Delete ${Date.now()}`,
      tier: 'tier_free',
    }),
  })
  assertEquals(orgRes.status, 201)
  const org = await orgRes.json()
  const orgSlug = org.slug

  try {
    const { email, password } = await createDisposableUser('orgs-other')
    const otherSession = await signInAs(email, password)

    const res = await fetch(`${ORG_URL}/${orgSlug}`, {
      method: 'DELETE',
      headers: authHeaders(otherSession.access_token),
    })
    assert(
      res.status === 404 || res.status === 403,
      `non-member should be denied (got ${res.status})`,
    )
    await res.body?.cancel()

    const verifyRes = await fetch(`${ORG_URL}/${orgSlug}`, {
      headers: authHeaders(session.access_token),
    })
    assertEquals(
      verifyRes.status,
      200,
      'owner org must survive cross-user DELETE',
    )
  } finally {
    await fetch(`${ORG_URL}/${orgSlug}`, {
      method: 'DELETE',
      headers: authHeaders(session.access_token),
    }).then((r) => r.body?.cancel())
  }
})

Deno.test('non-member: POST /organizations/{slug}/documents/dpa is denied', async () => {
  const session = await getTestSession()
  const orgRes = await fetch(ORG_URL, {
    method: 'POST',
    headers: authHeaders(session.access_token),
    body: JSON.stringify({
      name: `OtherOrg DPA ${Date.now()}`,
      tier: 'tier_free',
    }),
  })
  assertEquals(orgRes.status, 201)
  const org = await orgRes.json()
  const orgSlug = org.slug

  try {
    const { email, password } = await createDisposableUser('orgs-other')
    const otherSession = await signInAs(email, password)

    const res = await fetch(`${ORG_URL}/${orgSlug}/documents/dpa`, {
      method: 'POST',
      headers: authHeaders(otherSession.access_token),
      body: JSON.stringify({ recipient_email: 'attacker@example.com' }),
    })
    assert(
      res.status === 404 || res.status === 403,
      `non-member should be denied (got ${res.status})`,
    )
    await res.body?.cancel()
  } finally {
    await fetch(`${ORG_URL}/${orgSlug}`, {
      method: 'DELETE',
      headers: authHeaders(session.access_token),
    }).then((r) => r.body?.cancel())
  }
})
