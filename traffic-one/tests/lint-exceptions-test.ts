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

// ── Auth ────────────────────────────────────────────────

Deno.test(
  'GET /projects/{ref}/notifications/advisor/exceptions returns 401 without auth',
  async () => {
    const res = await fetch(
      `${PROJECTS_URL}/some-ref/notifications/advisor/exceptions`,
    )
    assertEquals(res.status, 401)
    await res.body?.cancel()
  },
)

Deno.test(
  'POST /projects/{ref}/notifications/advisor/exceptions returns 401 without auth',
  async () => {
    const res = await fetch(
      `${PROJECTS_URL}/some-ref/notifications/advisor/exceptions`,
      {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ lint_name: 'x', disabled: true }),
      },
    )
    assertEquals(res.status, 401)
    await res.body?.cancel()
  },
)

Deno.test(
  'DELETE /projects/{ref}/notifications/advisor/exceptions returns 401 without auth',
  async () => {
    const res = await fetch(
      `${PROJECTS_URL}/some-ref/notifications/advisor/exceptions?lint_name=x`,
      { method: 'DELETE' },
    )
    assertEquals(res.status, 401)
    await res.body?.cancel()
  },
)

// ── Setup ───────────────────────────────────────────────

let testOrgSlug: string | null = null
let testRef: string | null = null

Deno.test('setup: create test org and project for lint-exceptions tests', async () => {
  const session = await getTestSession()

  const orgName = `Lint Exceptions Test Org ${Date.now()}`
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
      name: `Lint Exceptions Test Project ${Date.now()}`,
      organization_slug: testOrgSlug,
      db_region: 'local',
    }),
  })
  assertEquals(projRes.status, 201)
  const project = await projRes.json()
  testRef = project.ref
})

// ── 403 via unknown ref ─────────────────────────────────

Deno.test(
  'GET /projects/{unknownRef}/notifications/advisor/exceptions returns 404 for non-member',
  async () => {
    const session = await getTestSession()
    const res = await fetch(
      `${PROJECTS_URL}/nonexistent00000000/notifications/advisor/exceptions`,
      { headers: authHeaders(session.access_token) },
    )
    assertEquals(res.status, 404)
    await res.body?.cancel()
  },
)

// ── GET empty ───────────────────────────────────────────

Deno.test('GET /notifications/advisor/exceptions returns empty array before any POST', async () => {
  if (!testRef) return
  const session = await getTestSession()
  const res = await fetch(
    `${PROJECTS_URL}/${testRef}/notifications/advisor/exceptions`,
    {
      headers: authHeaders(session.access_token),
    },
  )
  assertEquals(res.status, 200)
  const body = await res.json()
  assert(Array.isArray(body))
  assertEquals(body.length, 0)
})

// ── POST + GET round-trip ───────────────────────────────

Deno.test('POST /notifications/advisor/exceptions persists and later GET returns it', async () => {
  if (!testRef) return
  const session = await getTestSession()
  const lintName = `unindexed_foreign_keys_${Date.now()}`

  const postRes = await fetch(
    `${PROJECTS_URL}/${testRef}/notifications/advisor/exceptions`,
    {
      method: 'POST',
      headers: authHeaders(session.access_token),
      body: JSON.stringify({
        lint_name: lintName,
        disabled: true,
        metadata: { note: 'acknowledged by admin' },
      }),
    },
  )
  assertEquals(postRes.status, 201)
  const created = await postRes.json()
  assertEquals(created.lint_name, lintName)
  assertEquals(created.disabled, true)
  assertExists(created.inserted_at)

  const getRes = await fetch(
    `${PROJECTS_URL}/${testRef}/notifications/advisor/exceptions`,
    {
      headers: authHeaders(session.access_token),
    },
  )
  assertEquals(getRes.status, 200)
  const body = await getRes.json()
  assert(Array.isArray(body))
  const found = body.find((e: { lint_name: string }) => e.lint_name === lintName)
  assertExists(found, 'Created exception must appear in GET list')
  assertEquals(found.disabled, true)
  const metadata = found.metadata as { note?: string }
  assertEquals(metadata.note, 'acknowledged by admin')
})

Deno.test(
  'POST same lint_name twice upserts (no duplicate row) and reflects latest disabled value',
  async () => {
    if (!testRef) return
    const session = await getTestSession()
    const lintName = `rls_disabled_${Date.now()}`

    const firstRes = await fetch(
      `${PROJECTS_URL}/${testRef}/notifications/advisor/exceptions`,
      {
        method: 'POST',
        headers: authHeaders(session.access_token),
        body: JSON.stringify({ lint_name: lintName, disabled: true }),
      },
    )
    assertEquals(firstRes.status, 201)
    await firstRes.body?.cancel()

    const secondRes = await fetch(
      `${PROJECTS_URL}/${testRef}/notifications/advisor/exceptions`,
      {
        method: 'POST',
        headers: authHeaders(session.access_token),
        body: JSON.stringify({ lint_name: lintName, disabled: false }),
      },
    )
    assertEquals(secondRes.status, 201)
    const second = await secondRes.json()
    assertEquals(second.disabled, false)

    const getRes = await fetch(
      `${PROJECTS_URL}/${testRef}/notifications/advisor/exceptions`,
      {
        headers: authHeaders(session.access_token),
      },
    )
    const body = await getRes.json()
    const matches = body.filter((e: { lint_name: string }) => e.lint_name === lintName)
    assertEquals(matches.length, 1)
    assertEquals(matches[0].disabled, false)
  },
)

Deno.test('POST /notifications/advisor/exceptions without lint_name returns 400', async () => {
  if (!testRef) return
  const session = await getTestSession()
  const res = await fetch(
    `${PROJECTS_URL}/${testRef}/notifications/advisor/exceptions`,
    {
      method: 'POST',
      headers: authHeaders(session.access_token),
      body: JSON.stringify({ disabled: true }),
    },
  )
  assertEquals(res.status, 400)
  await res.body?.cancel()
})

// ── DELETE removes the row ──────────────────────────────

Deno.test('DELETE /notifications/advisor/exceptions by lint_name query removes row', async () => {
  if (!testRef) return
  const session = await getTestSession()
  const lintName = `auth_allow_anonymous_sign_ins_${Date.now()}`

  const postRes = await fetch(
    `${PROJECTS_URL}/${testRef}/notifications/advisor/exceptions`,
    {
      method: 'POST',
      headers: authHeaders(session.access_token),
      body: JSON.stringify({ lint_name: lintName, disabled: true }),
    },
  )
  assertEquals(postRes.status, 201)
  await postRes.body?.cancel()

  const delRes = await fetch(
    `${PROJECTS_URL}/${testRef}/notifications/advisor/exceptions?lint_name=${lintName}`,
    {
      method: 'DELETE',
      headers: authHeaders(session.access_token),
    },
  )
  assertEquals(delRes.status, 200)
  const delBody = await delRes.json()
  assertEquals(delBody.deleted, true)

  const getRes = await fetch(
    `${PROJECTS_URL}/${testRef}/notifications/advisor/exceptions`,
    {
      headers: authHeaders(session.access_token),
    },
  )
  const body = await getRes.json()
  const remaining = body.find((e: { lint_name: string }) => e.lint_name === lintName)
  assertEquals(
    remaining,
    undefined,
    'Deleted exception must not appear in GET',
  )
})

Deno.test(
  'DELETE /notifications/advisor/exceptions for unknown lint_name returns 404',
  async () => {
    if (!testRef) return
    const session = await getTestSession()
    const res = await fetch(
      `${PROJECTS_URL}/${testRef}/notifications/advisor/exceptions?lint_name=does_not_exist_${Date.now()}`,
      {
        method: 'DELETE',
        headers: authHeaders(session.access_token),
      },
    )
    assertEquals(res.status, 404)
    await res.body?.cancel()
  },
)

Deno.test('DELETE /notifications/advisor/exceptions without lint_name returns 400', async () => {
  if (!testRef) return
  const session = await getTestSession()
  const res = await fetch(
    `${PROJECTS_URL}/${testRef}/notifications/advisor/exceptions`,
    {
      method: 'DELETE',
      headers: authHeaders(session.access_token),
    },
  )
  assertEquals(res.status, 400)
  await res.body?.cancel()
})

// ── Cleanup ─────────────────────────────────────────────

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
