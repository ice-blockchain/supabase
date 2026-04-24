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

const ORG_URL = `${supabaseUrl}/api/platform/organizations`
const STRIPE_URL = `${supabaseUrl}/api/platform/stripe`
const PROJECTS_URL = `${supabaseUrl}/api/platform/projects`

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

// ── Auth checks ──────────────────────────────────────────

Deno.test('GET /organizations/{slug}/billing/subscription returns 401 without auth', async () => {
  const res = await fetch(`${ORG_URL}/default/billing/subscription`)
  assertEquals(res.status, 401)
  await res.body?.cancel()
})

// ── Setup: create a test org for billing tests ───────────

let testSlug: string | null = null

Deno.test('setup: create org for billing tests', async () => {
  const session = await getTestSession()
  const orgName = `Billing Test Org ${Date.now()}`
  const res = await fetch(ORG_URL, {
    method: 'POST',
    headers: authHeaders(session.access_token),
    body: JSON.stringify({ name: orgName, tier: 'tier_free' }),
  })
  assertEquals(res.status, 201)
  const org = await res.json()
  testSlug = org.slug
  assertExists(testSlug)
})

// ── Subscription ─────────────────────────────────────────

Deno.test('GET /organizations/{slug}/billing/subscription returns correct shape', async () => {
  if (!testSlug) return
  const session = await getTestSession()
  const res = await fetch(`${ORG_URL}/${testSlug}/billing/subscription`, {
    headers: authHeaders(session.access_token),
  })
  assertEquals(res.status, 200)

  const sub = await res.json()
  assertExists(sub.plan)
  assertEquals(sub.plan.id, 'free')
  assertEquals(sub.plan.name, 'Free')
  assert(Array.isArray(sub.addons))
  assert(Array.isArray(sub.project_addons))
  assertEquals(typeof sub.billing_cycle_anchor, 'number')
  assertEquals(typeof sub.current_period_start, 'number')
  assertEquals(typeof sub.current_period_end, 'number')
  assertEquals(typeof sub.usage_billing_enabled, 'boolean')
})

Deno.test('PUT /organizations/{slug}/billing/subscription changes tier', async () => {
  if (!testSlug) return
  const session = await getTestSession()
  const res = await fetch(`${ORG_URL}/${testSlug}/billing/subscription`, {
    method: 'PUT',
    headers: authHeaders(session.access_token),
    body: JSON.stringify({
      tier: 'tier_pro',
      plan_id: 'pro',
      plan_name: 'Pro',
    }),
  })
  assertEquals(res.status, 200)

  const sub = await res.json()
  assertEquals(sub.plan.id, 'pro')
  assertEquals(sub.plan.name, 'Pro')
})

Deno.test('POST /organizations/{slug}/billing/subscription/preview returns preview', async () => {
  if (!testSlug) return
  const session = await getTestSession()
  const res = await fetch(
    `${ORG_URL}/${testSlug}/billing/subscription/preview`,
    {
      method: 'POST',
      headers: authHeaders(session.access_token),
      body: JSON.stringify({ target_plan: 'team' }),
    },
  )
  assertEquals(res.status, 200)

  const preview = await res.json()
  assertEquals(typeof preview.amount_due, 'number')
})

// ── Plans ────────────────────────────────────────────────

Deno.test('GET /organizations/{slug}/billing/plans returns plans', async () => {
  if (!testSlug) return
  const session = await getTestSession()
  const res = await fetch(`${ORG_URL}/${testSlug}/billing/plans`, {
    headers: authHeaders(session.access_token),
  })
  assertEquals(res.status, 200)

  const body = await res.json()
  assertExists(body.plans)
  assert(Array.isArray(body.plans))
  assert(body.plans.length > 0)
})

// ── Invoices ─────────────────────────────────────────────

Deno.test('GET /organizations/{slug}/billing/invoices returns array', async () => {
  if (!testSlug) return
  const session = await getTestSession()
  const res = await fetch(`${ORG_URL}/${testSlug}/billing/invoices`, {
    headers: authHeaders(session.access_token),
  })
  assertEquals(res.status, 200)

  const invoices = await res.json()
  assert(Array.isArray(invoices))
})

Deno.test('HEAD /organizations/{slug}/billing/invoices returns X-Total-Count', async () => {
  if (!testSlug) return
  const session = await getTestSession()
  const res = await fetch(`${ORG_URL}/${testSlug}/billing/invoices`, {
    method: 'HEAD',
    headers: authHeaders(session.access_token),
  })
  assertEquals(res.status, 200)
  const count = res.headers.get('X-Total-Count')
  assertExists(count)
  assertEquals(count, '0')
  await res.body?.cancel()
})

Deno.test('GET /organizations/{slug}/billing/invoices/upcoming returns upcoming', async () => {
  if (!testSlug) return
  const session = await getTestSession()
  const res = await fetch(`${ORG_URL}/${testSlug}/billing/invoices/upcoming`, {
    headers: authHeaders(session.access_token),
  })
  assertEquals(res.status, 200)

  const upcoming = await res.json()
  assertEquals(typeof upcoming.amount_due, 'number')
})

// ── Customer ─────────────────────────────────────────────

Deno.test('GET /organizations/{slug}/customer returns customer profile', async () => {
  if (!testSlug) return
  const session = await getTestSession()
  const res = await fetch(`${ORG_URL}/${testSlug}/customer`, {
    headers: authHeaders(session.access_token),
  })
  assertEquals(res.status, 200)

  const customer = await res.json()
  assertEquals(typeof customer, 'object')
})

Deno.test('PUT /organizations/{slug}/customer updates billing profile', async () => {
  if (!testSlug) return
  const session = await getTestSession()
  const res = await fetch(`${ORG_URL}/${testSlug}/customer`, {
    method: 'PUT',
    headers: authHeaders(session.access_token),
    body: JSON.stringify({
      billing_name: 'Test Corp',
      country: 'US',
      city: 'SF',
    }),
  })
  assertEquals(res.status, 200)

  const customer = await res.json()
  assertEquals(customer.billing_name, 'Test Corp')
  assertEquals(customer.country, 'US')
  assertEquals(customer.city, 'SF')
})

// ── Tax IDs ──────────────────────────────────────────────
//
// GET / PUT must return the OpenAPI `TaxIdResponse` envelope
// `{ tax_id: { country, type, value } | null }` — not a bare array or a
// flat `{ id, type, value }` object — so Studio's `useOrganizationTaxIdQuery`
// can read `.tax_id` directly. (Regression test for H2.)

Deno.test(
  'GET /organizations/{slug}/tax-ids returns TaxIdResponse envelope (not array)',
  async () => {
    if (!testSlug) return
    const session = await getTestSession()
    const res = await fetch(`${ORG_URL}/${testSlug}/tax-ids`, {
      headers: authHeaders(session.access_token),
    })
    assertEquals(res.status, 200)

    const body = await res.json()
    assert(
      !Array.isArray(body),
      'tax-ids must return an object envelope, not a bare array',
    )
    assertEquals(typeof body, 'object')
    assert(
      'tax_id' in body,
      'response must have a `tax_id` field (per TaxIdResponse schema)',
    )
    assert(
      body.tax_id === null || typeof body.tax_id === 'object',
      'tax_id must be object or null',
    )
  },
)

Deno.test(
  'PUT /organizations/{slug}/tax-ids creates a tax ID in TaxIdResponse envelope',
  async () => {
    if (!testSlug) return
    const session = await getTestSession()
    const res = await fetch(`${ORG_URL}/${testSlug}/tax-ids`, {
      method: 'PUT',
      headers: authHeaders(session.access_token),
      body: JSON.stringify({
        type: 'eu_vat',
        value: 'DE123456789',
        country: 'DE',
      }),
    })
    assertEquals(res.status, 200)

    const body = await res.json()
    assertExists(
      body.tax_id,
      'PUT must echo the persisted tax id as `{ tax_id: {...} }`',
    )
    assertEquals(body.tax_id.type, 'eu_vat')
    assertEquals(body.tax_id.value, 'DE123456789')
    assertEquals(body.tax_id.country, 'DE')
  },
)

// ── Payment Methods ──────────────────────────────────────

Deno.test('GET /organizations/{slug}/payments returns array', async () => {
  if (!testSlug) return
  const session = await getTestSession()
  const res = await fetch(`${ORG_URL}/${testSlug}/payments`, {
    headers: authHeaders(session.access_token),
  })
  assertEquals(res.status, 200)

  const methods = await res.json()
  assert(Array.isArray(methods))
})

// ── Credits ──────────────────────────────────────────────

Deno.test('POST /organizations/{slug}/billing/credits/redeem redeems credits', async () => {
  if (!testSlug) return
  const session = await getTestSession()
  const res = await fetch(`${ORG_URL}/${testSlug}/billing/credits/redeem`, {
    method: 'POST',
    headers: authHeaders(session.access_token),
    body: JSON.stringify({ amount: 100, code: 'TEST100' }),
  })
  assertEquals(res.status, 200)

  const result = await res.json()
  assertEquals(typeof result.balance, 'number')
})

// ── Project Addons ───────────────────────────────────────

Deno.test('GET /projects/{ref}/billing/addons returns addons shape', async () => {
  const session = await getTestSession()
  const res = await fetch(`${PROJECTS_URL}/default/billing/addons`, {
    headers: authHeaders(session.access_token),
  })
  assertEquals(res.status, 200)

  const addons = await res.json()
  assertExists(addons.selected_addons)
  assertExists(addons.available_addons)
  assert(Array.isArray(addons.selected_addons))
  assert(Array.isArray(addons.available_addons))
})

// ── Stripe routes ────────────────────────────────────────

Deno.test('GET /stripe/invoices/overdue returns count', async () => {
  const session = await getTestSession()
  const res = await fetch(`${STRIPE_URL}/invoices/overdue`, {
    headers: authHeaders(session.access_token),
  })
  assertEquals(res.status, 200)

  const body = await res.json()
  assertEquals(typeof body.count, 'number')
})

// ── 404 for non-member org ───────────────────────────────

Deno.test('GET billing endpoint returns 404 for nonexistent org', async () => {
  const session = await getTestSession()
  const res = await fetch(
    `${ORG_URL}/nonexistent-org-12345/billing/subscription`,
    {
      headers: authHeaders(session.access_token),
    },
  )
  assertEquals(res.status, 404)
  await res.body?.cancel()
})

// ── Cleanup ──────────────────────────────────────────────

Deno.test('cleanup: delete billing test org', async () => {
  if (!testSlug) return
  const session = await getTestSession()
  const res = await fetch(`${ORG_URL}/${testSlug}`, {
    method: 'DELETE',
    headers: authHeaders(session.access_token),
  })
  assertEquals(res.status, 200)
  await res.body?.cancel()
})
