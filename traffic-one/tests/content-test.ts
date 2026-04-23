import { Pool } from 'https://deno.land/x/postgres@v0.17.0/mod.ts'
import { assert, assertEquals, assertExists } from 'jsr:@std/assert@1'
import { createClient } from 'npm:@supabase/supabase-js@2'

import 'jsr:@std/dotenv/load'

const supabaseUrl = Deno.env.get('SUPABASE_URL')!
const supabaseKey = Deno.env.get('SUPABASE_ANON_KEY')!
const superuserDbUrl = Deno.env.get('SUPERUSER_DB_URL')!
const supabase = createClient(supabaseUrl, supabaseKey, {
  auth: { autoRefreshToken: false, persistSession: false, detectSessionInUrl: false },
})

const PROJECTS_URL = `${supabaseUrl}/api/platform/projects`
const ORG_URL = `${supabaseUrl}/api/platform/organizations`
const SIGNUP_URL = `${supabaseUrl}/api/platform/signup`

function contentUrl(ref: string, sub = ''): string {
  return `${PROJECTS_URL}/${ref}/content${sub}`
}

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

async function signUpDisposableUser(): Promise<{ email: string; password: string }> {
  const email = `content-other-${Date.now()}-${Math.floor(Math.random() * 1e6)}@example.com`
  const password = 'Test1234!'
  const res = await fetch(SIGNUP_URL, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({
      email,
      password,
      hcaptchaToken: null,
      redirectTo: 'http://localhost:8000',
    }),
  })
  await res.body?.cancel()
  assert(res.status === 201 || res.status === 200, `signup failed: ${res.status}`)

  const adminPool = new Pool(superuserDbUrl, 1, true)
  try {
    const connection = await adminPool.connect()
    try {
      await connection.queryObject`
        UPDATE auth.users
        SET email_confirmed_at = COALESCE(email_confirmed_at, now()),
            confirmed_at = COALESCE(confirmed_at, now())
        WHERE email = ${email}
      `
    } finally {
      connection.release()
    }
  } finally {
    await adminPool.end()
  }
  return { email, password }
}

async function signInAs(email: string, password: string) {
  const {
    data: { session },
    error,
  } = await supabase.auth.signInWithPassword({ email, password })
  if (error || !session) {
    throw new Error(`sign-in failed for ${email}: ${error?.message ?? 'no session'}`)
  }
  return session
}

async function countFolderAuditRows(action: string, folderId: string): Promise<number> {
  const adminPool = new Pool(superuserDbUrl, 1, true)
  try {
    const conn = await adminPool.connect()
    try {
      const result = await conn.queryObject<{ c: number }>`
        SELECT COUNT(*)::int AS c FROM traffic.audit_logs
        WHERE action_name = ${action}
          AND target_description LIKE ${'%' + folderId + '%'}
      `
      return result.rows[0]?.c ?? 0
    } finally {
      conn.release()
    }
  } finally {
    await adminPool.end()
  }
}

async function addAsOrgMember(orgSlug: string, email: string): Promise<void> {
  const adminPool = new Pool(superuserDbUrl, 1, true)
  try {
    const connection = await adminPool.connect()
    try {
      await connection.queryObject`
        INSERT INTO traffic.organization_members (organization_id, profile_id, role)
        SELECT
          o.id,
          p.id,
          'developer'
        FROM traffic.organizations o
        JOIN traffic.profiles p ON p.gotrue_id = (
          SELECT id FROM auth.users WHERE email = ${email}
        )
        WHERE o.slug = ${orgSlug}
        ON CONFLICT (organization_id, profile_id) DO NOTHING
      `
    } finally {
      connection.release()
    }
  } finally {
    await adminPool.end()
  }
}

// ── Auth ─────────────────────────────────────────────────

Deno.test('GET /projects/{ref}/content returns 401 without auth', async () => {
  const res = await fetch(contentUrl('some-ref'))
  assertEquals(res.status, 401)
  await res.body?.cancel()
})

Deno.test('POST /projects/{ref}/content returns 401 without auth', async () => {
  const res = await fetch(contentUrl('some-ref'), {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ type: 'sql', name: 'x' }),
  })
  assertEquals(res.status, 401)
  await res.body?.cancel()
})

Deno.test('GET /projects/{ref}/content/folders returns 401 without auth', async () => {
  const res = await fetch(contentUrl('some-ref', '/folders'))
  assertEquals(res.status, 401)
  await res.body?.cancel()
})

// ── Setup test project ──────────────────────────────────

let testOrgSlug: string | null = null
let testRef: string | null = null

Deno.test('setup: create test org and project for content tests', async () => {
  const session = await getTestSession()

  const orgName = `Content Test Org ${Date.now()}`
  const orgRes = await fetch(ORG_URL, {
    method: 'POST',
    headers: authHeaders(session.access_token),
    body: JSON.stringify({ name: orgName, tier: 'tier_free' }),
  })
  assertEquals(orgRes.status, 201)
  const org = await orgRes.json()
  testOrgSlug = org.slug

  const projectName = `Content Test Project ${Date.now()}`
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

// ── Cross-project / unknown ref → 404 ────────────────────

Deno.test('GET /projects/{unknownRef}/content returns 404', async () => {
  const session = await getTestSession()
  const res = await fetch(contentUrl('nonexistent00000000'), {
    headers: authHeaders(session.access_token),
  })
  assertEquals(res.status, 404)
  await res.body?.cancel()
})

Deno.test('GET /projects/{unknownRef}/content/folders returns 404', async () => {
  const session = await getTestSession()
  const res = await fetch(contentUrl('nonexistent00000000', '/folders'), {
    headers: authHeaders(session.access_token),
  })
  assertEquals(res.status, 404)
  await res.body?.cancel()
})

Deno.test(
  'POST /projects/{unknownRef}/content returns 404 (cross-project access denied)',
  async () => {
    const session = await getTestSession()
    const res = await fetch(contentUrl('nonexistent00000000'), {
      method: 'POST',
      headers: authHeaders(session.access_token),
      body: JSON.stringify({ type: 'sql', name: 'x', content: { sql: 'select 1' } }),
    })
    assertEquals(res.status, 404)
    await res.body?.cancel()
  }
)

// ── Create + list + count ────────────────────────────────

const createdIds: string[] = []

Deno.test('POST /content creates a snippet and returns 201 with owner/id/shape', async () => {
  if (!testRef) return
  const session = await getTestSession()
  const uniqueName = `test snippet ${Date.now()}`

  const res = await fetch(contentUrl(testRef), {
    method: 'POST',
    headers: authHeaders(session.access_token),
    body: JSON.stringify({
      type: 'sql',
      name: uniqueName,
      description: 'integration test',
      visibility: 'user',
      content: { sql: 'select 1' },
      favorite: true,
    }),
  })
  assertEquals(res.status, 201)

  const body = await res.json()
  assertExists(body.id)
  assertEquals(typeof body.id, 'string')
  assertEquals(body.name, uniqueName)
  assertEquals(body.type, 'sql')
  assertEquals(body.visibility, 'user')
  assertEquals(body.favorite, true)
  assertExists(body.owner_id)
  assertEquals(typeof body.owner_id, 'number')
  assertExists(body.project_id)
  assertEquals(typeof body.project_id, 'number')
  assertExists(body.inserted_at)
  assertExists(body.updated_at)
  assertExists(body.owner)
  assertEquals(body.owner.id, body.owner_id)
  assertExists(body.owner.username)
  assertEquals((body.content as { sql?: string }).sql, 'select 1')

  createdIds.push(body.id)
})

Deno.test('PUT /content upserts an existing snippet (owner)', async () => {
  if (!testRef || createdIds.length === 0) return
  const session = await getTestSession()
  const id = createdIds[0]

  const res = await fetch(contentUrl(testRef), {
    method: 'PUT',
    headers: authHeaders(session.access_token),
    body: JSON.stringify({
      id,
      type: 'sql',
      name: 'renamed via put',
      visibility: 'user',
      content: { sql: 'select 2' },
    }),
  })
  assertEquals(res.status, 200)
  const body = await res.json()
  assertEquals(body.id, id)
  assertEquals(body.name, 'renamed via put')
  assertEquals((body.content as { sql?: string }).sql, 'select 2')
})

Deno.test('PUT /content with a fresh id inserts a new snippet', async () => {
  if (!testRef) return
  const session = await getTestSession()
  const id = crypto.randomUUID()

  const res = await fetch(contentUrl(testRef), {
    method: 'PUT',
    headers: authHeaders(session.access_token),
    body: JSON.stringify({
      id,
      type: 'sql',
      name: 'put-created snippet',
      visibility: 'user',
      content: { sql: 'select 3' },
    }),
  })
  assertEquals(res.status, 200)
  const body = await res.json()
  assertEquals(body.id, id)
  createdIds.push(id)
})

Deno.test('GET /content lists the created snippets with wrapping cursor shape', async () => {
  if (!testRef) return
  const session = await getTestSession()

  const res = await fetch(`${contentUrl(testRef)}?type=sql&limit=100`, {
    headers: authHeaders(session.access_token),
  })
  assertEquals(res.status, 200)
  const body = await res.json()
  assert(Array.isArray(body.data))
  assert(body.data.length >= createdIds.length)
  assert('cursor' in body)

  const ids = new Set(body.data.map((d: { id: string }) => d.id))
  for (const id of createdIds) {
    assert(ids.has(id), `expected id ${id} in list`)
  }

  // Shape assertions on the first returned row
  const first = body.data[0]
  assertExists(first.id)
  assertExists(first.name)
  assertExists(first.type)
  assertExists(first.visibility)
  assertExists(first.owner_id)
  assertExists(first.project_id)
  assertExists(first.inserted_at)
  assertExists(first.updated_at)
  assertExists(first.content)
})

Deno.test('GET /content/count returns { count: N }', async () => {
  if (!testRef) return
  const session = await getTestSession()

  const res = await fetch(`${contentUrl(testRef, '/count')}?type=sql`, {
    headers: authHeaders(session.access_token),
  })
  assertEquals(res.status, 200)
  const body = await res.json()
  assertEquals(typeof body.count, 'number')
  assert(body.count >= createdIds.length)
})

// ── Item GET / PATCH ─────────────────────────────────────

Deno.test('GET /content/item/{id} returns a single detailed item', async () => {
  if (!testRef || createdIds.length === 0) return
  const session = await getTestSession()
  const id = createdIds[0]

  const res = await fetch(contentUrl(testRef, `/item/${id}`), {
    headers: authHeaders(session.access_token),
  })
  assertEquals(res.status, 200)
  const body = await res.json()
  assertEquals(body.id, id)
  assertExists(body.content)
  assertExists(body.owner_id)
  assertEquals(body.type, 'sql')
})

Deno.test('GET /content/item/{unknownId} returns 404', async () => {
  if (!testRef) return
  const session = await getTestSession()

  const res = await fetch(contentUrl(testRef, `/item/${crypto.randomUUID()}`), {
    headers: authHeaders(session.access_token),
  })
  assertEquals(res.status, 404)
  await res.body?.cancel()
})

Deno.test('PATCH /content/item/{id} as owner succeeds', async () => {
  if (!testRef || createdIds.length === 0) return
  const session = await getTestSession()
  const id = createdIds[0]

  const res = await fetch(contentUrl(testRef, `/item/${id}`), {
    method: 'PATCH',
    headers: authHeaders(session.access_token),
    body: JSON.stringify({ name: 'patched name', favorite: false }),
  })
  assertEquals(res.status, 200)
  const body = await res.json()
  assertEquals(body.id, id)
  assertEquals(body.name, 'patched name')
  assertEquals(body.favorite, false)
})

// Real two-user visibility='user' scenario: user B (co-member of the same
// org) must get 403 when attempting to mutate a user-private item that user
// A created, and must not be able to read it either.

Deno.test("PATCH /content/item/{id} on another user's private item returns 403", async () => {
  if (!testRef || !testOrgSlug) return
  const session = await getTestSession()

  const createRes = await fetch(contentUrl(testRef), {
    method: 'POST',
    headers: authHeaders(session.access_token),
    body: JSON.stringify({
      type: 'sql',
      name: 'private-to-user-a',
      visibility: 'user',
      content: { sql: 'SELECT 1;' },
    }),
  })
  assertEquals(createRes.status, 201)
  const created = await createRes.json()
  const itemId = created.id as string

  const { email, password } = await signUpDisposableUser()
  await addAsOrgMember(testOrgSlug, email)
  const otherSession = await signInAs(email, password)

  const patchRes = await fetch(contentUrl(testRef, `/item/${itemId}`), {
    method: 'PATCH',
    headers: authHeaders(otherSession.access_token),
    body: JSON.stringify({ name: 'hijacked' }),
  })
  assertEquals(patchRes.status, 403, `expected 403 (got ${patchRes.status})`)
  await patchRes.body?.cancel()

  const getRes = await fetch(contentUrl(testRef, `/item/${itemId}`), {
    headers: authHeaders(otherSession.access_token),
  })
  assert(
    getRes.status === 403 || getRes.status === 404,
    `expected 403/404 when reading another user's private item (got ${getRes.status})`
  )
  await getRes.body?.cancel()

  const listRes = await fetch(contentUrl(testRef), {
    headers: authHeaders(otherSession.access_token),
  })
  assertEquals(listRes.status, 200)
  const listBody = await listRes.json()
  const items: Array<{ id: string }> = listBody.content ?? listBody
  const seen = items.find((c) => c.id === itemId)
  assertEquals(seen, undefined, "user B must not see user A's private item")
})

// ── Folders: create / list / rename ──────────────────────

let createdFolderId: string | null = null
let childFolderId: string | null = null
let folderItemId: string | null = null

Deno.test('POST /content/folders creates a folder', async () => {
  if (!testRef) return
  const session = await getTestSession()

  const res = await fetch(contentUrl(testRef, '/folders'), {
    method: 'POST',
    headers: authHeaders(session.access_token),
    body: JSON.stringify({ name: 'My Folder' }),
  })
  assertEquals(res.status, 201)
  const body = await res.json()
  assertExists(body.id)
  assertEquals(body.name, 'My Folder')
  assertExists(body.owner_id)
  assertExists(body.project_id)
  assertEquals(body.parent_id, null)
  createdFolderId = body.id
})

Deno.test('POST /content/folders with parentId creates a nested folder', async () => {
  if (!testRef || !createdFolderId) return
  const session = await getTestSession()

  const res = await fetch(contentUrl(testRef, '/folders'), {
    method: 'POST',
    headers: authHeaders(session.access_token),
    body: JSON.stringify({ name: 'Nested', parentId: createdFolderId }),
  })
  assertEquals(res.status, 201)
  const body = await res.json()
  assertEquals(body.parent_id, createdFolderId)
  childFolderId = body.id
})

Deno.test('POST /content can create an item inside a folder', async () => {
  if (!testRef || !createdFolderId) return
  const session = await getTestSession()

  const res = await fetch(contentUrl(testRef), {
    method: 'POST',
    headers: authHeaders(session.access_token),
    body: JSON.stringify({
      type: 'sql',
      name: 'folder item',
      visibility: 'user',
      content: { sql: 'select * from pg_tables' },
      folder_id: createdFolderId,
    }),
  })
  assertEquals(res.status, 201)
  const body = await res.json()
  assertEquals(body.folder_id, createdFolderId)
  folderItemId = body.id
  createdIds.push(body.id)
})

Deno.test('GET /content/folders lists root folders + root-level contents', async () => {
  if (!testRef || !createdFolderId) return
  const session = await getTestSession()

  const res = await fetch(`${contentUrl(testRef, '/folders')}?type=sql`, {
    headers: authHeaders(session.access_token),
  })
  assertEquals(res.status, 200)
  const body = await res.json()
  assertExists(body.data)
  assert(Array.isArray(body.data.folders))
  assert(Array.isArray(body.data.contents))

  const folderIds = new Set(body.data.folders.map((f: { id: string }) => f.id))
  assert(folderIds.has(createdFolderId), 'root listing should include created root folder')
  assert(!folderIds.has(childFolderId), 'child folder should not appear at root')
})

Deno.test('GET /content/folders/{id} lists folder contents', async () => {
  if (!testRef || !createdFolderId || !folderItemId) return
  const session = await getTestSession()

  const res = await fetch(contentUrl(testRef, `/folders/${createdFolderId}`), {
    headers: authHeaders(session.access_token),
  })
  assertEquals(res.status, 200)
  const body = await res.json()
  assertExists(body.data)
  assert(Array.isArray(body.data.folders))
  assert(Array.isArray(body.data.contents))
  const itemIds = new Set(body.data.contents.map((c: { id: string }) => c.id))
  assert(itemIds.has(folderItemId), 'folder contents should include the item created inside it')
  const nestedIds = new Set(body.data.folders.map((f: { id: string }) => f.id))
  assert(nestedIds.has(childFolderId), "subfolder should appear in parent's listing")
})

Deno.test('PATCH /content/folders/{id} renames the folder', async () => {
  if (!testRef || !createdFolderId) return
  const session = await getTestSession()
  const before = await countFolderAuditRows('project.content_folder_updated', createdFolderId)

  const res = await fetch(contentUrl(testRef, `/folders/${createdFolderId}`), {
    method: 'PATCH',
    headers: authHeaders(session.access_token),
    body: JSON.stringify({ name: 'My Folder (Renamed)' }),
  })
  assertEquals(res.status, 200)
  const body = await res.json()
  assertEquals(body.id, createdFolderId)
  assertEquals(body.name, 'My Folder (Renamed)')

  const after = await countFolderAuditRows('project.content_folder_updated', createdFolderId)
  assertEquals(after - before, 1, 'PATCH must emit one project.content_folder_updated audit row')
})

Deno.test('PATCH /content/folders/{unknownId} returns 404', async () => {
  if (!testRef) return
  const session = await getTestSession()

  const res = await fetch(contentUrl(testRef, `/folders/${crypto.randomUUID()}`), {
    method: 'PATCH',
    headers: authHeaders(session.access_token),
    body: JSON.stringify({ name: 'x' }),
  })
  assertEquals(res.status, 404)
  await res.body?.cancel()
})

// ── Folders: cascade delete ──────────────────────────────

Deno.test(
  'DELETE /content/folders with parent id cascades children and detaches items',
  async () => {
    if (!testRef || !createdFolderId || !childFolderId || !folderItemId) return
    const session = await getTestSession()

    const res = await fetch(contentUrl(testRef, '/folders'), {
      method: 'DELETE',
      headers: authHeaders(session.access_token),
      body: JSON.stringify({ ids: [createdFolderId] }),
    })
    assertEquals(res.status, 200)
    const body = await res.json()
    assertEquals(body.deleted, 1)

    // Child folder should also be gone (FK ON DELETE CASCADE).
    const childRes = await fetch(contentUrl(testRef, `/folders/${childFolderId}`), {
      headers: authHeaders(session.access_token),
    })
    assertEquals(childRes.status, 404)
    await childRes.body?.cancel()

    // The item that lived under the folder should still exist with folder_id = null.
    const itemRes = await fetch(contentUrl(testRef, `/item/${folderItemId}`), {
      headers: authHeaders(session.access_token),
    })
    assertEquals(itemRes.status, 200)
    const item = await itemRes.json()
    assertEquals(item.folder_id, null)
  }
)

// ── Content: bulk DELETE ────────────────────────────────

Deno.test(
  'DELETE /content with { ids } removes owned items and returns { deleted: N }',
  async () => {
    if (!testRef || createdIds.length === 0) return
    const session = await getTestSession()

    const res = await fetch(contentUrl(testRef), {
      method: 'DELETE',
      headers: authHeaders(session.access_token),
      body: JSON.stringify({ ids: createdIds }),
    })
    assertEquals(res.status, 200)
    const body = await res.json()
    assertEquals(typeof body.deleted, 'number')
    assertEquals(body.deleted, createdIds.length)

    // All items are gone.
    for (const id of createdIds) {
      const itemRes = await fetch(contentUrl(testRef, `/item/${id}`), {
        headers: authHeaders(session.access_token),
      })
      assertEquals(itemRes.status, 404)
      await itemRes.body?.cancel()
    }
  }
)

Deno.test('DELETE /content with empty ids returns { deleted: 0 }', async () => {
  if (!testRef) return
  const session = await getTestSession()

  const res = await fetch(contentUrl(testRef), {
    method: 'DELETE',
    headers: authHeaders(session.access_token),
    body: JSON.stringify({ ids: [] }),
  })
  assertEquals(res.status, 200)
  const body = await res.json()
  assertEquals(body.deleted, 0)
})

// ── Unsupported methods ──────────────────────────────────

Deno.test('PATCH /content on the root returns 405', async () => {
  if (!testRef) return
  const session = await getTestSession()
  const res = await fetch(contentUrl(testRef), {
    method: 'PATCH',
    headers: authHeaders(session.access_token),
    body: '{}',
  })
  assertEquals(res.status, 405)
  await res.body?.cancel()
})

Deno.test('POST /content/count returns 405', async () => {
  if (!testRef) return
  const session = await getTestSession()
  const res = await fetch(contentUrl(testRef, '/count'), {
    method: 'POST',
    headers: authHeaders(session.access_token),
    body: '{}',
  })
  assertEquals(res.status, 405)
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
