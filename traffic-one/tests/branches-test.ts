import { Pool } from 'https://deno.land/x/postgres@v0.19.3/mod.ts'
import { assert, assertEquals, assertExists } from 'jsr:@std/assert@1'
import { createClient } from 'npm:@supabase/supabase-js@2'

import 'jsr:@std/dotenv/load'

import { createDisposableUser, signInAs } from './_helpers/test-user.ts'

const supabaseUrl = Deno.env.get('SUPABASE_URL')!
const supabaseKey = Deno.env.get('SUPABASE_ANON_KEY')!
const superuserDbUrl = Deno.env.get('SUPERUSER_DB_URL')!

const supabase = createClient(supabaseUrl, supabaseKey, {
  auth: {
    autoRefreshToken: false,
    persistSession: false,
    detectSessionInUrl: false,
  },
})

const V1_PROJECTS_URL = `${supabaseUrl}/api/v1/projects`
const V1_BRANCHES_URL = `${supabaseUrl}/api/v1/branches`
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

async function countBranchAuditRows(
  action: string,
  branchId: string,
): Promise<number> {
  const adminPool = new Pool(superuserDbUrl, 1, true)
  try {
    const conn = await adminPool.connect()
    try {
      const result = await conn.queryObject<{ c: number }>`
        SELECT COUNT(*)::int AS c FROM traffic.audit_logs
        WHERE action_name = ${action}
          AND target_description LIKE ${'%#' + branchId + '%'}
      `
      return result.rows[0]?.c ?? 0
    } finally {
      conn.release()
    }
  } finally {
    await adminPool.end()
  }
}

// ── Auth ─────────────────────────────────────────────────

Deno.test('GET /v1/projects/{ref}/branches returns 401 without auth', async () => {
  const res = await fetch(`${V1_PROJECTS_URL}/some-ref/branches`)
  assertEquals(res.status, 401)
  await res.body?.cancel()
})

Deno.test('POST /v1/projects/{ref}/branches returns 401 without auth', async () => {
  const res = await fetch(`${V1_PROJECTS_URL}/some-ref/branches`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ branch_name: 'feature-x' }),
  })
  assertEquals(res.status, 401)
  await res.body?.cancel()
})

Deno.test('GET /v1/branches/{id} returns 401 without auth', async () => {
  const res = await fetch(
    `${V1_BRANCHES_URL}/00000000-0000-0000-0000-000000000000`,
  )
  assertEquals(res.status, 401)
  await res.body?.cancel()
})

Deno.test('POST /v1/branches/{id}/push returns 401 without auth', async () => {
  const res = await fetch(
    `${V1_BRANCHES_URL}/00000000-0000-0000-0000-000000000000/push`,
    {
      method: 'POST',
    },
  )
  assertEquals(res.status, 401)
  await res.body?.cancel()
})

// ── Setup ────────────────────────────────────────────────

let testOrgSlug: string | null = null
let testRef: string | null = null

Deno.test('setup: create test org and project for branches tests', async () => {
  const session = await getTestSession()

  const orgName = `Branches Test Org ${Date.now()}`
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
      name: `Branches Test Project ${Date.now()}`,
      organization_slug: testOrgSlug,
      db_region: 'local',
    }),
  })
  assertEquals(projRes.status, 201)
  const project = await projRes.json()
  testRef = project.ref
})

// ── Unknown ref → 404 ────────────────────────────────────

Deno.test('GET /v1/projects/{unknownRef}/branches returns 404', async () => {
  const session = await getTestSession()
  const res = await fetch(`${V1_PROJECTS_URL}/nonexistent00000000/branches`, {
    headers: authHeaders(session.access_token),
  })
  assertEquals(res.status, 404)
  await res.body?.cancel()
})

// ── Initial list ─────────────────────────────────────────

Deno.test('GET /v1/projects/{ref}/branches returns empty list initially', async () => {
  if (!testRef) return
  const session = await getTestSession()
  const res = await fetch(`${V1_PROJECTS_URL}/${testRef}/branches`, {
    headers: authHeaders(session.access_token),
  })
  assertEquals(res.status, 200)
  const body = await res.json()
  assert(Array.isArray(body))
  assertEquals(body.length, 0)
})

// ── Create ───────────────────────────────────────────────

let createdBranchId: string | null = null
const createdBranchName = `feature-${Date.now()}`

Deno.test('POST /v1/projects/{ref}/branches creates a branch', async () => {
  if (!testRef) return
  const session = await getTestSession()
  const res = await fetch(`${V1_PROJECTS_URL}/${testRef}/branches`, {
    method: 'POST',
    headers: authHeaders(session.access_token),
    body: JSON.stringify({
      branch_name: createdBranchName,
      git_branch: 'main',
    }),
  })
  assertEquals(res.status, 201)
  const body = await res.json()
  assertExists(body.id)
  assertEquals(body.branch_name, createdBranchName)
  assertEquals(body.project_ref, testRef)
  assertEquals(body.status, 'created')
  assertEquals(body.git_branch, 'main')
  assertEquals(body.is_default, false)
  assertEquals(body.merged_at, null)
  assertEquals(body.deleted_at, null)
  createdBranchId = body.id
})

Deno.test('POST /v1/projects/{ref}/branches with missing branch_name returns 400', async () => {
  if (!testRef) return
  const session = await getTestSession()
  const res = await fetch(`${V1_PROJECTS_URL}/${testRef}/branches`, {
    method: 'POST',
    headers: authHeaders(session.access_token),
    body: JSON.stringify({ git_branch: 'main' }),
  })
  assertEquals(res.status, 400)
  await res.body?.cancel()
})

Deno.test('POST /v1/projects/{ref}/branches with duplicate name returns 409', async () => {
  if (!testRef) return
  const session = await getTestSession()
  const res = await fetch(`${V1_PROJECTS_URL}/${testRef}/branches`, {
    method: 'POST',
    headers: authHeaders(session.access_token),
    body: JSON.stringify({ branch_name: createdBranchName }),
  })
  assertEquals(res.status, 409)
  const body = await res.json()
  assertEquals(body.code, 'conflict')
})

Deno.test('GET /v1/projects/{ref}/branches returns the created branch', async () => {
  if (!testRef || !createdBranchId) return
  const session = await getTestSession()
  const res = await fetch(`${V1_PROJECTS_URL}/${testRef}/branches`, {
    headers: authHeaders(session.access_token),
  })
  assertEquals(res.status, 200)
  const body = await res.json()
  assert(Array.isArray(body))
  const found = body.find((b: { id: string }) => b.id === createdBranchId)
  assertExists(found, 'Created branch should appear in list')
  assertEquals(found.branch_name, createdBranchName)
})

// ── /v1/branches/{id} ────────────────────────────────────

Deno.test('GET /v1/branches/{id} returns the branch', async () => {
  if (!createdBranchId) return
  const session = await getTestSession()
  const res = await fetch(`${V1_BRANCHES_URL}/${createdBranchId}`, {
    headers: authHeaders(session.access_token),
  })
  assertEquals(res.status, 200)
  const body = await res.json()
  assertEquals(body.id, createdBranchId)
  assertEquals(body.branch_name, createdBranchName)
})

Deno.test('GET /v1/branches/{unknown-uuid} returns 404', async () => {
  const session = await getTestSession()
  const res = await fetch(
    `${V1_BRANCHES_URL}/11111111-1111-1111-1111-111111111111`,
    {
      headers: authHeaders(session.access_token),
    },
  )
  assertEquals(res.status, 404)
  await res.body?.cancel()
})

Deno.test('GET /v1/branches/not-a-uuid returns 404', async () => {
  const session = await getTestSession()
  const res = await fetch(`${V1_BRANCHES_URL}/not-a-uuid`, {
    headers: authHeaders(session.access_token),
  })
  assertEquals(res.status, 404)
  await res.body?.cancel()
})

Deno.test('PATCH /v1/branches/{id} updates git_branch', async () => {
  if (!createdBranchId) return
  const session = await getTestSession()
  const before = await countBranchAuditRows(
    'project.branch_updated',
    createdBranchId,
  )

  const res = await fetch(`${V1_BRANCHES_URL}/${createdBranchId}`, {
    method: 'PATCH',
    headers: authHeaders(session.access_token),
    body: JSON.stringify({ git_branch: 'develop', pr_number: 42 }),
  })
  assertEquals(res.status, 200)
  const body = await res.json()
  assertEquals(body.git_branch, 'develop')

  const after = await countBranchAuditRows(
    'project.branch_updated',
    createdBranchId,
  )
  assertEquals(
    after - before,
    1,
    'PATCH must emit one project.branch_updated audit row',
  )
  assertEquals(body.pr_number, 42)
  assertEquals(body.branch_name, createdBranchName)
})

// ── Diff ─────────────────────────────────────────────────
//
// Self-hosted traffic-one intentionally returns an empty-stub diff for
// `/v1/branches/{id}/diff`. Cloud Supabase computes a real schema diff via
// an internal pg_dump worker that doesn't exist in this stack. The spec is
// downgraded to the empty-stub contract so Studio's "Open diff" panel
// renders a valid (empty) diff instead of spinning.
// Documented under "Self-hosted limitations" in traffic-one/ARCHITECTURE.md.

Deno.test(
  'GET /v1/branches/{id}/diff returns empty-stub shape (self-hosted limitation)',
  async () => {
    if (!createdBranchId) return
    const session = await getTestSession()
    const res = await fetch(`${V1_BRANCHES_URL}/${createdBranchId}/diff`, {
      headers: authHeaders(session.access_token),
    })
    assertEquals(res.status, 200)
    const body = await res.json()
    assertEquals(body.migrations_ahead, 0)
    assert(Array.isArray(body.schema_changes))
    assertEquals(body.schema_changes.length, 0)
    assert(Array.isArray(body.data_changes))
    assertEquals(body.data_changes.length, 0)
  },
)

// ── State transitions ────────────────────────────────────

Deno.test('POST /v1/branches/{id}/merge before push returns 409 invalid_state', async () => {
  if (!createdBranchId) return
  const session = await getTestSession()
  const res = await fetch(`${V1_BRANCHES_URL}/${createdBranchId}/merge`, {
    method: 'POST',
    headers: authHeaders(session.access_token),
  })
  assertEquals(res.status, 409)
  const body = await res.json()
  assertEquals(body.code, 'invalid_state')
  assertEquals(body.current_status, 'created')
})

Deno.test('POST /v1/branches/{id}/push advances state to pushed', async () => {
  if (!createdBranchId) return
  const session = await getTestSession()
  const res = await fetch(`${V1_BRANCHES_URL}/${createdBranchId}/push`, {
    method: 'POST',
    headers: authHeaders(session.access_token),
  })
  assertEquals(res.status, 200)
  const body = await res.json()
  assertEquals(body.id, createdBranchId)
  assertEquals(body.status, 'pushed')
})

Deno.test('POST /v1/branches/{id}/merge flips status to merged', async () => {
  if (!createdBranchId) return
  const session = await getTestSession()
  const res = await fetch(`${V1_BRANCHES_URL}/${createdBranchId}/merge`, {
    method: 'POST',
    headers: authHeaders(session.access_token),
  })
  assertEquals(res.status, 200)
  const body = await res.json()
  assertEquals(body.status, 'merged')
  assertExists(body.merged_at)
})

Deno.test('POST /v1/branches/{id}/push on merged branch returns 409 invalid_state', async () => {
  if (!createdBranchId) return
  const session = await getTestSession()
  const res = await fetch(`${V1_BRANCHES_URL}/${createdBranchId}/push`, {
    method: 'POST',
    headers: authHeaders(session.access_token),
  })
  assertEquals(res.status, 409)
  const body = await res.json()
  assertEquals(body.code, 'invalid_state')
})

Deno.test('POST /v1/branches/{id}/reset rolls back to pushed', async () => {
  if (!createdBranchId) return
  const session = await getTestSession()
  const res = await fetch(`${V1_BRANCHES_URL}/${createdBranchId}/reset`, {
    method: 'POST',
    headers: authHeaders(session.access_token),
  })
  assertEquals(res.status, 200)
  const body = await res.json()
  assertEquals(body.status, 'pushed')
  assertEquals(body.merged_at, null)
})

// ── Soft-delete + restore ────────────────────────────────

Deno.test('DELETE /v1/branches/{id} soft-deletes the branch', async () => {
  if (!createdBranchId) return
  const session = await getTestSession()
  const res = await fetch(`${V1_BRANCHES_URL}/${createdBranchId}`, {
    method: 'DELETE',
    headers: authHeaders(session.access_token),
  })
  assertEquals(res.status, 200)
  const body = await res.json()
  assertExists(body.deleted_at)
})

Deno.test('GET /v1/projects/{ref}/branches excludes soft-deleted branches', async () => {
  if (!testRef || !createdBranchId) return
  const session = await getTestSession()
  const res = await fetch(`${V1_PROJECTS_URL}/${testRef}/branches`, {
    headers: authHeaders(session.access_token),
  })
  assertEquals(res.status, 200)
  const body = await res.json()
  const found = body.find((b: { id: string }) => b.id === createdBranchId)
  assertEquals(
    found,
    undefined,
    'Soft-deleted branch should not appear in list',
  )
})

Deno.test('PATCH /v1/branches/{id} on deleted branch returns 404', async () => {
  if (!createdBranchId) return
  const session = await getTestSession()
  const res = await fetch(`${V1_BRANCHES_URL}/${createdBranchId}`, {
    method: 'PATCH',
    headers: authHeaders(session.access_token),
    body: JSON.stringify({ git_branch: 'main' }),
  })
  assertEquals(res.status, 404)
  await res.body?.cancel()
})

Deno.test('POST /v1/branches/{id}/restore un-soft-deletes the branch', async () => {
  if (!createdBranchId) return
  const session = await getTestSession()
  const before = await countBranchAuditRows(
    'project.branch_restored',
    createdBranchId,
  )

  const res = await fetch(`${V1_BRANCHES_URL}/${createdBranchId}/restore`, {
    method: 'POST',
    headers: authHeaders(session.access_token),
  })
  assertEquals(res.status, 200)
  const body = await res.json()
  assertEquals(body.deleted_at, null)

  const after = await countBranchAuditRows(
    'project.branch_restored',
    createdBranchId,
  )
  assertEquals(
    after - before,
    1,
    'restore must emit one project.branch_restored audit row',
  )
})

Deno.test('POST /v1/branches/{id}/restore on non-deleted branch returns 409', async () => {
  if (!createdBranchId) return
  const session = await getTestSession()
  const res = await fetch(`${V1_BRANCHES_URL}/${createdBranchId}/restore`, {
    method: 'POST',
    headers: authHeaders(session.access_token),
  })
  assertEquals(res.status, 409)
  await res.body?.cancel()
})

// ── Cross-project 403 ────────────────────────────────────
//
// A second disposable user is not a member of testOrg, so they must not
// see testRef's branches (403) and must not be able to operate on any
// branch that belongs to testRef (403 on `/v1/branches/{id}`).

Deno.test('GET /v1/projects/{ref}/branches from non-member user is denied', async () => {
  if (!testRef) return
  const { email, password } = await createDisposableUser('branches-other')
  const otherSession = await signInAs(email, password)

  const res = await fetch(`${V1_PROJECTS_URL}/${testRef}/branches`, {
    headers: authHeaders(otherSession.access_token),
  })
  // getProjectByRef joins organization_members, so a non-member's request
  // is indistinguishable from an unknown ref (404) at the project level.
  assert(
    res.status === 404 || res.status === 403,
    `non-member should be denied (got ${res.status})`,
  )
  await res.body?.cancel()
})

Deno.test('GET /v1/branches/{id} from non-member user returns 403', async () => {
  if (!createdBranchId) return
  const { email, password } = await createDisposableUser('branches-other')
  const otherSession = await signInAs(email, password)

  const res = await fetch(`${V1_BRANCHES_URL}/${createdBranchId}`, {
    headers: authHeaders(otherSession.access_token),
  })
  // /v1/branches/{id} finds the row (so not 404), then rejects on membership.
  assertEquals(res.status, 403)
  await res.body?.cancel()
})

Deno.test('POST /v1/branches/{id}/push from non-member user returns 403', async () => {
  if (!createdBranchId) return
  const { email, password } = await createDisposableUser('branches-other')
  const otherSession = await signInAs(email, password)

  const res = await fetch(`${V1_BRANCHES_URL}/${createdBranchId}/push`, {
    method: 'POST',
    headers: authHeaders(otherSession.access_token),
  })
  assertEquals(res.status, 403)
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
