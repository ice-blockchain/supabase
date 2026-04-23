import { Pool } from 'https://deno.land/x/postgres@v0.17.0/mod.ts'
import { assert, assertEquals, assertExists } from 'jsr:@std/assert@1'
import { createClient } from 'npm:@supabase/supabase-js@2'

import 'jsr:@std/dotenv/load'

const supabaseUrl = Deno.env.get('SUPABASE_URL')!
const supabaseKey = Deno.env.get('SUPABASE_ANON_KEY')!
const trafficDbUrl = Deno.env.get('TRAFFIC_DB_URL')!

const supabase = createClient(supabaseUrl, supabaseKey, {
  auth: { autoRefreshToken: false, persistSession: false, detectSessionInUrl: false },
})

const pool = new Pool(trafficDbUrl, 1, true)

const FEEDBACK_URL = `${supabaseUrl}/api/platform/feedback`

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

interface FeedbackDbRow {
  id: number
  category: string
  message: string
  project_ref: string | null
  organization_slug: string | null
  tags: string[]
  metadata: Record<string, unknown>
  custom_fields: Record<string, unknown>
}

async function fetchFeedbackRow(id: number): Promise<FeedbackDbRow | null> {
  const connection = await pool.connect()
  try {
    const result = await connection.queryObject<FeedbackDbRow>`
      SELECT id, category, message, project_ref, organization_slug,
             tags, metadata, custom_fields
      FROM traffic.feedback WHERE id = ${id}
    `
    return result.rows[0] ?? null
  } finally {
    connection.release()
  }
}

// ── Auth ─────────────────────────────────────────────────

Deno.test('POST /feedback/send returns 401 without auth', async () => {
  const res = await fetch(`${FEEDBACK_URL}/send`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ message: 'no auth' }),
  })
  assertEquals(res.status, 401)
  await res.body?.cancel()
})

Deno.test('POST /feedback/upgrade returns 401 without auth', async () => {
  const res = await fetch(`${FEEDBACK_URL}/upgrade`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ additionalFeedback: 'no auth', reasons: [] }),
  })
  assertEquals(res.status, 401)
  await res.body?.cancel()
})

Deno.test('POST /feedback/downgrade returns 401 without auth', async () => {
  const res = await fetch(`${FEEDBACK_URL}/downgrade`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({
      additionalFeedback: 'no auth',
      reasons: '',
      exitAction: 'downgrade',
    }),
  })
  assertEquals(res.status, 401)
  await res.body?.cancel()
})

Deno.test('PATCH /feedback/conversations/:id/custom-fields returns 401 without auth', async () => {
  const res = await fetch(`${FEEDBACK_URL}/conversations/1/custom-fields`, {
    method: 'PATCH',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ anything: true }),
  })
  assertEquals(res.status, 401)
  await res.body?.cancel()
})

// ── Validation ───────────────────────────────────────────

Deno.test('POST /feedback/send without message returns 400', async () => {
  const session = await getTestSession()
  const res = await fetch(`${FEEDBACK_URL}/send`, {
    method: 'POST',
    headers: authHeaders(session.access_token),
    body: JSON.stringify({ tags: ['dashboard-feedback'] }),
  })
  assertEquals(res.status, 400)
  const body = await res.json()
  assertExists(body.message)
})

Deno.test('POST /feedback/upgrade without message/additionalFeedback returns 400', async () => {
  const session = await getTestSession()
  const res = await fetch(`${FEEDBACK_URL}/upgrade`, {
    method: 'POST',
    headers: authHeaders(session.access_token),
    body: JSON.stringify({ reasons: ['perf'] }),
  })
  assertEquals(res.status, 400)
  await res.body?.cancel()
})

// ── Happy path ───────────────────────────────────────────

Deno.test('POST /feedback/send persists general feedback', async () => {
  const session = await getTestSession()
  const uniqueMessage = `dashboard feedback ${Date.now()}`
  const res = await fetch(`${FEEDBACK_URL}/send`, {
    method: 'POST',
    headers: authHeaders(session.access_token),
    body: JSON.stringify({
      message: uniqueMessage,
      category: 'Feedback',
      tags: ['dashboard-feedback'],
      organizationSlug: 'test-org',
      projectRef: 'test-ref',
      pathname: '/project/test-ref',
    }),
  })
  assertEquals(res.status, 201)

  const body = await res.json()
  assertExists(body.id)
  assertExists(body.created_at)

  const row = await fetchFeedbackRow(body.id)
  assertExists(row)
  assertEquals(row!.category, 'general')
  assertEquals(row!.message, uniqueMessage)
  assertEquals(row!.organization_slug, 'test-org')
  assertEquals(row!.project_ref, 'test-ref')
  assert(Array.isArray(row!.tags))
  assert(row!.tags.includes('dashboard-feedback'))
  assertEquals((row!.metadata as { pathname?: string }).pathname, '/project/test-ref')
})

Deno.test('POST /feedback/upgrade persists with category=upgrade_survey', async () => {
  const session = await getTestSession()
  const uniqueMessage = `upgrade survey ${Date.now()}`
  const res = await fetch(`${FEEDBACK_URL}/upgrade`, {
    method: 'POST',
    headers: authHeaders(session.access_token),
    body: JSON.stringify({
      additionalFeedback: uniqueMessage,
      reasons: ['team', 'scale'],
      prevPlan: 'free',
      currentPlan: 'pro',
      orgSlug: 'test-org',
    }),
  })
  assertEquals(res.status, 201)

  const body = await res.json()
  assertExists(body.id)

  const row = await fetchFeedbackRow(body.id)
  assertExists(row)
  assertEquals(row!.category, 'upgrade_survey')
  assertEquals(row!.message, uniqueMessage)
  assertEquals(row!.organization_slug, 'test-org')
  const metadata = row!.metadata as { reasons?: string[]; prevPlan?: string; currentPlan?: string }
  assertEquals(metadata.prevPlan, 'free')
  assertEquals(metadata.currentPlan, 'pro')
  assert(Array.isArray(metadata.reasons))
})

Deno.test('POST /feedback/downgrade persists with category=downgrade_survey', async () => {
  const session = await getTestSession()
  const uniqueMessage = `exit survey ${Date.now()}`
  const res = await fetch(`${FEEDBACK_URL}/downgrade`, {
    method: 'POST',
    headers: authHeaders(session.access_token),
    body: JSON.stringify({
      additionalFeedback: uniqueMessage,
      reasons: 'too_expensive',
      exitAction: 'downgrade',
      orgSlug: 'test-org',
      projectRef: 'test-ref',
    }),
  })
  assertEquals(res.status, 201)

  const body = await res.json()
  assertExists(body.id)

  const row = await fetchFeedbackRow(body.id)
  assertExists(row)
  assertEquals(row!.category, 'downgrade_survey')
  assertEquals(row!.message, uniqueMessage)
  assertEquals(row!.project_ref, 'test-ref')
  const metadata = row!.metadata as { exitAction?: string }
  assertEquals(metadata.exitAction, 'downgrade')
})

// ── Custom fields (PATCH) ────────────────────────────────

Deno.test(
  'PATCH /feedback/conversations/:id/custom-fields returns 404 for unknown id',
  async () => {
    const session = await getTestSession()
    const res = await fetch(`${FEEDBACK_URL}/conversations/99999999/custom-fields`, {
      method: 'PATCH',
      headers: authHeaders(session.access_token),
      body: JSON.stringify({ org_id: 1, category: 'Billing' }),
    })
    assertEquals(res.status, 404)
    const body = await res.json()
    assertExists(body.message)
  }
)

Deno.test(
  'PATCH /feedback/conversations/:id/custom-fields returns 404 for non-numeric id',
  async () => {
    const session = await getTestSession()
    const res = await fetch(`${FEEDBACK_URL}/conversations/abc-conversation/custom-fields`, {
      method: 'PATCH',
      headers: authHeaders(session.access_token),
      body: JSON.stringify({ org_id: 1 }),
    })
    assertEquals(res.status, 404)
    await res.body?.cancel()
  }
)

Deno.test('PATCH /feedback/conversations/:id/custom-fields merges onto existing row', async () => {
  const session = await getTestSession()

  // Create a feedback row first via /send so we have a real id to patch.
  const createRes = await fetch(`${FEEDBACK_URL}/send`, {
    method: 'POST',
    headers: authHeaders(session.access_token),
    body: JSON.stringify({ message: `patch target ${Date.now()}` }),
  })
  assertEquals(createRes.status, 201)
  const created = await createRes.json()
  const id: number = created.id

  const patchRes = await fetch(`${FEEDBACK_URL}/conversations/${id}/custom-fields`, {
    method: 'PATCH',
    headers: authHeaders(session.access_token),
    body: JSON.stringify({
      org_id: 42,
      project_ref: 'patched-ref',
      category: 'Billing',
      allow_support_access: true,
    }),
  })
  assertEquals(patchRes.status, 200)
  const patched = await patchRes.json()
  assertEquals(patched.id, id)

  const row = await fetchFeedbackRow(id)
  assertExists(row)
  const cf = row!.custom_fields as {
    org_id?: number
    project_ref?: string
    category?: string
    allow_support_access?: boolean
  }
  assertEquals(cf.org_id, 42)
  assertEquals(cf.project_ref, 'patched-ref')
  assertEquals(cf.category, 'Billing')
  assertEquals(cf.allow_support_access, true)

  // Subsequent PATCH merges (does not replace) earlier custom_fields.
  const secondPatchRes = await fetch(`${FEEDBACK_URL}/conversations/${id}/custom-fields`, {
    method: 'PATCH',
    headers: authHeaders(session.access_token),
    body: JSON.stringify({ hubspot_owner_id: 7 }),
  })
  assertEquals(secondPatchRes.status, 200)
  await secondPatchRes.body?.cancel()

  const merged = await fetchFeedbackRow(id)
  const mergedCf = merged!.custom_fields as {
    org_id?: number
    hubspot_owner_id?: number
    project_ref?: string
  }
  assertEquals(mergedCf.org_id, 42)
  assertEquals(mergedCf.hubspot_owner_id, 7)
  assertEquals(mergedCf.project_ref, 'patched-ref')
})

// ── Method routing ───────────────────────────────────────

Deno.test('GET /feedback/send returns 405', async () => {
  const session = await getTestSession()
  const res = await fetch(`${FEEDBACK_URL}/send`, {
    headers: authHeaders(session.access_token),
  })
  assertEquals(res.status, 405)
  await res.body?.cancel()
})

// ── Audit logs ───────────────────────────────────────────
//
// Every feedback mutation must emit a `traffic.audit_logs` row inside the
// same transaction as the feedback row insert/update. We assert that with a
// direct DB query using the application pool (which has SELECT on audit_logs).

async function fetchAuditCountForTarget(action: string, feedbackId: number): Promise<number> {
  const connection = await pool.connect()
  try {
    const result = await connection.queryObject<{ c: number }>`
      SELECT COUNT(*)::int AS c FROM traffic.audit_logs
      WHERE action_name = ${action}
        AND target_metadata @> ${JSON.stringify({ feedback_id: feedbackId })}::jsonb
    `
    return result.rows[0]?.c ?? 0
  } finally {
    connection.release()
  }
}

Deno.test('POST /feedback/send emits profile.feedback_submitted audit log', async () => {
  const session = await getTestSession()
  const res = await fetch(`${FEEDBACK_URL}/send`, {
    method: 'POST',
    headers: authHeaders(session.access_token),
    body: JSON.stringify({ message: `audit-check ${Date.now()}` }),
  })
  assertEquals(res.status, 201)
  const body = await res.json()

  const count = await fetchAuditCountForTarget('profile.feedback_submitted', body.id)
  assertEquals(count, 1, 'expected exactly one profile.feedback_submitted audit row')
})

Deno.test('PATCH /feedback custom-fields emits profile.feedback_updated audit log', async () => {
  const session = await getTestSession()
  const createRes = await fetch(`${FEEDBACK_URL}/send`, {
    method: 'POST',
    headers: authHeaders(session.access_token),
    body: JSON.stringify({ message: `audit-patch ${Date.now()}` }),
  })
  assertEquals(createRes.status, 201)
  const created = await createRes.json()
  const id: number = created.id

  const patchRes = await fetch(`${FEEDBACK_URL}/conversations/${id}/custom-fields`, {
    method: 'PATCH',
    headers: authHeaders(session.access_token),
    body: JSON.stringify({ org_id: 99 }),
  })
  assertEquals(patchRes.status, 200)
  await patchRes.body?.cancel()

  const count = await fetchAuditCountForTarget('profile.feedback_updated', id)
  assertEquals(count, 1, 'expected exactly one profile.feedback_updated audit row')
})
