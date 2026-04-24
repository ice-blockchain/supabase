import { assert, assertEquals, assertExists } from 'jsr:@std/assert@1'
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

function bearerOnly(token: string): Record<string, string> {
  return { Authorization: `Bearer ${token}` }
}

// Unique per-process test identifiers so parallel runs don't collide with
// real functions or with each other.
const RUN_TOKEN = `${Date.now()}_${Math.floor(Math.random() * 1e6)}`
const testSlug = `__test_wave3_p_${RUN_TOKEN}`
const testSlugMultipart = `__test_wave3_p_mp_${RUN_TOKEN}`
const initialSource = `Deno.serve(() => new Response("initial-${RUN_TOKEN}"));\n`
const multipartSource = `Deno.serve(() => new Response("mp-${RUN_TOKEN}"));\n`

let testOrgSlug: string | null = null
let testRef: string | null = null
// True once we've observed a successful deploy against the live stack. If the
// edge-runtime container mounts /home/deno/functions read-only, the probe
// deploy returns 503 and all mutation tests below short-circuit.
let canWriteFs = false

// ── Auth ─────────────────────────────────────────────────

Deno.test('POST /v1/projects/{ref}/functions/deploy returns 401 without auth', async () => {
  const res = await fetch(`${V1_PROJECTS_URL}/some-ref/functions/deploy`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: '{}',
  })
  assertEquals(res.status, 401)
  await res.body?.cancel()
})

Deno.test('PATCH /v1/projects/{ref}/functions/{slug} returns 401 without auth', async () => {
  const res = await fetch(`${V1_PROJECTS_URL}/some-ref/functions/hello`, {
    method: 'PATCH',
    headers: { 'Content-Type': 'application/json' },
    body: '{}',
  })
  assertEquals(res.status, 401)
  await res.body?.cancel()
})

Deno.test('DELETE /v1/projects/{ref}/functions/{slug} returns 401 without auth', async () => {
  const res = await fetch(`${V1_PROJECTS_URL}/some-ref/functions/hello`, {
    method: 'DELETE',
  })
  assertEquals(res.status, 401)
  await res.body?.cancel()
})

// ── Setup test org + project ─────────────────────────────

Deno.test('setup: create test org and project for edge-function mutation tests', async () => {
  const session = await getTestSession()

  const orgRes = await fetch(ORG_URL, {
    method: 'POST',
    headers: authHeaders(session.access_token),
    body: JSON.stringify({
      name: `EdgeFnMut Test Org ${RUN_TOKEN}`,
      tier: 'tier_free',
    }),
  })
  assertEquals(orgRes.status, 201)
  const org = await orgRes.json()
  testOrgSlug = org.slug

  const projRes = await fetch(PROJECTS_URL, {
    method: 'POST',
    headers: authHeaders(session.access_token),
    body: JSON.stringify({
      name: `EdgeFnMut Test Project ${RUN_TOKEN}`,
      organization_slug: testOrgSlug,
      db_region: 'local',
    }),
  })
  assertEquals(projRes.status, 201)
  const project = await projRes.json()
  testRef = project.ref
})

// ── Unknown ref → 404 ────────────────────────────────────

Deno.test('PATCH /v1/projects/{unknownRef}/functions/{slug} returns 404', async () => {
  const session = await getTestSession()
  const res = await fetch(
    `${V1_PROJECTS_URL}/nonexistent00000000/functions/anything`,
    {
      method: 'PATCH',
      headers: authHeaders(session.access_token),
      body: JSON.stringify({ name: 'x' }),
    },
  )
  assertEquals(res.status, 404)
  await res.body?.cancel()
})

Deno.test('POST /v1/projects/{unknownRef}/functions/deploy returns 404', async () => {
  const session = await getTestSession()
  const res = await fetch(
    `${V1_PROJECTS_URL}/nonexistent00000000/functions/deploy`,
    {
      method: 'POST',
      headers: authHeaders(session.access_token),
      body: JSON.stringify({
        slug: 'whatever',
        body: [{ name: 'index.ts', content: '' }],
      }),
    },
  )
  assertEquals(res.status, 404)
  await res.body?.cancel()
})

// ── Validation (runs before FS writability check) ────────

Deno.test('POST /deploy with invalid slug returns 400 invalid_slug', async () => {
  if (!testRef) return
  const session = await getTestSession()
  const res = await fetch(`${V1_PROJECTS_URL}/${testRef}/functions/deploy`, {
    method: 'POST',
    headers: authHeaders(session.access_token),
    body: JSON.stringify({
      slug: 'BAD Slug!',
      body: [{ name: 'index.ts', content: initialSource }],
    }),
  })
  assertEquals(res.status, 400)
  const body = await res.json()
  assertEquals(body.code, 'invalid_slug')
})

Deno.test("POST /deploy with reserved slug 'main' returns 403 reserved_slug", async () => {
  if (!testRef) return
  const session = await getTestSession()
  const res = await fetch(`${V1_PROJECTS_URL}/${testRef}/functions/deploy`, {
    method: 'POST',
    headers: authHeaders(session.access_token),
    body: JSON.stringify({
      slug: 'main',
      body: [{ name: 'index.ts', content: initialSource }],
    }),
  })
  assertEquals(res.status, 403)
  const body = await res.json()
  assertEquals(body.code, 'reserved_slug')
})

Deno.test("POST /deploy with reserved slug 'traffic-one' returns 403 reserved_slug", async () => {
  if (!testRef) return
  const session = await getTestSession()
  const res = await fetch(`${V1_PROJECTS_URL}/${testRef}/functions/deploy`, {
    method: 'POST',
    headers: authHeaders(session.access_token),
    body: JSON.stringify({
      slug: 'traffic-one',
      body: [{ name: 'index.ts', content: initialSource }],
    }),
  })
  assertEquals(res.status, 403)
  const body = await res.json()
  assertEquals(body.code, 'reserved_slug')
})

Deno.test('POST /deploy without slug returns 400', async () => {
  if (!testRef) return
  const session = await getTestSession()
  const res = await fetch(`${V1_PROJECTS_URL}/${testRef}/functions/deploy`, {
    method: 'POST',
    headers: authHeaders(session.access_token),
    body: JSON.stringify({ body: [{ name: 'index.ts', content: '' }] }),
  })
  assertEquals(res.status, 400)
  await res.body?.cancel()
})

Deno.test('POST /deploy with empty file list returns 400', async () => {
  if (!testRef) return
  const session = await getTestSession()
  const res = await fetch(`${V1_PROJECTS_URL}/${testRef}/functions/deploy`, {
    method: 'POST',
    headers: authHeaders(session.access_token),
    body: JSON.stringify({ slug: `${testSlug}_empty_files`, body: [] }),
  })
  assertEquals(res.status, 400)
  await res.body?.cancel()
})

Deno.test('PATCH /functions/main returns 403 reserved_slug', async () => {
  if (!testRef) return
  const session = await getTestSession()
  const res = await fetch(`${V1_PROJECTS_URL}/${testRef}/functions/main`, {
    method: 'PATCH',
    headers: authHeaders(session.access_token),
    body: JSON.stringify({ name: 'x' }),
  })
  assertEquals(res.status, 403)
  const body = await res.json()
  assertEquals(body.code, 'reserved_slug')
})

Deno.test('DELETE /functions/main returns 403 reserved_slug', async () => {
  if (!testRef) return
  const session = await getTestSession()
  const res = await fetch(`${V1_PROJECTS_URL}/${testRef}/functions/main`, {
    method: 'DELETE',
    headers: authHeaders(session.access_token),
  })
  assertEquals(res.status, 403)
  const body = await res.json()
  assertEquals(body.code, 'reserved_slug')
})

Deno.test('PATCH /functions/{bad-slug} returns 400 invalid_slug', async () => {
  if (!testRef) return
  const session = await getTestSession()
  // URL segment must still be a valid path component; `BADSLUG` (uppercase)
  // is URL-safe but fails the /^[a-z0-9_-]+$/ validation.
  const res = await fetch(`${V1_PROJECTS_URL}/${testRef}/functions/BADSLUG`, {
    method: 'PATCH',
    headers: authHeaders(session.access_token),
    body: JSON.stringify({ name: 'x' }),
  })
  assertEquals(res.status, 400)
  const body = await res.json()
  assertEquals(body.code, 'invalid_slug')
})

// ── Probe: can we write to /home/deno/functions? ─────────

Deno.test('probe: POST /deploy either succeeds (201) or signals fs_readonly (503)', async () => {
  if (!testRef) return
  const session = await getTestSession()

  const res = await fetch(`${V1_PROJECTS_URL}/${testRef}/functions/deploy`, {
    method: 'POST',
    headers: authHeaders(session.access_token),
    body: JSON.stringify({
      slug: testSlug,
      name: 'Initial',
      verify_jwt: false,
      body: [{ name: 'index.ts', content: initialSource }],
    }),
  })

  if (res.status === 503) {
    const body = await res.json()
    assertEquals(body.code, 'fs_readonly')
    canWriteFs = false
    console.warn(
      '[edge-function-mutations-test] /home/deno/functions is read-only; ' +
        'skipping filesystem-dependent tests.',
    )
    return
  }

  assertEquals(res.status, 201)
  const body = await res.json()
  assertEquals(body.slug, testSlug)
  assertEquals(body.name, 'Initial')
  assertEquals(body.verify_jwt, false)
  assertExists(body.entrypoint_path)
  canWriteFs = true
})

// ── Deploy wrote files: GET /functions/{slug}/body reflects upload ──

Deno.test(
  'POST /deploy wrote files — GET /functions/{slug}/body returns uploaded source',
  async () => {
    if (!testRef || !canWriteFs) return
    const session = await getTestSession()
    const res = await fetch(
      `${V1_PROJECTS_URL}/${testRef}/functions/${testSlug}/body`,
      {
        headers: bearerOnly(session.access_token),
      },
    )
    assertEquals(res.status, 200)
    const files = await res.json()
    assert(Array.isArray(files), 'GET /body must return an array of files')
    const indexFile = files.find((f: { name: string }) => f.name === 'index.ts')
    assertExists(indexFile, 'index.ts should be in the deployed files')
    assertEquals(indexFile.content, initialSource)
  },
)

Deno.test('GET /functions/{slug} reflects deployed function shape', async () => {
  if (!testRef || !canWriteFs) return
  const session = await getTestSession()
  const res = await fetch(
    `${V1_PROJECTS_URL}/${testRef}/functions/${testSlug}`,
    {
      headers: bearerOnly(session.access_token),
    },
  )
  assertEquals(res.status, 200)
  const body = await res.json()
  assertEquals(body.slug, testSlug)
  assertExists(body.entrypoint_path)
})

// ── PATCH updates .meta.json ─────────────────────────────

Deno.test('PATCH /functions/{slug} updates .meta.json sidecar', async () => {
  if (!testRef || !canWriteFs) return
  const session = await getTestSession()

  const patchRes = await fetch(
    `${V1_PROJECTS_URL}/${testRef}/functions/${testSlug}`,
    {
      method: 'PATCH',
      headers: authHeaders(session.access_token),
      body: JSON.stringify({
        name: 'Renamed Function',
        verify_jwt: true,
      }),
    },
  )
  assertEquals(patchRes.status, 200)
  const patched = await patchRes.json()
  assertEquals(patched.slug, testSlug)
  assertEquals(patched.name, 'Renamed Function')
  assertEquals(patched.verify_jwt, true)

  // A subsequent GET (through the existing read-side handler in projects.ts)
  // should also reflect the override layered by parseFunctionDir.
  const getRes = await fetch(
    `${V1_PROJECTS_URL}/${testRef}/functions/${testSlug}`,
    {
      headers: bearerOnly(session.access_token),
    },
  )
  assertEquals(getRes.status, 200)
  await getRes.body?.cancel()
})

Deno.test('PATCH /functions/{unknownSlug} returns 404', async () => {
  if (!testRef || !canWriteFs) return
  const session = await getTestSession()
  const res = await fetch(
    `${V1_PROJECTS_URL}/${testRef}/functions/__nonexistent_${RUN_TOKEN}`,
    {
      method: 'PATCH',
      headers: authHeaders(session.access_token),
      body: JSON.stringify({ name: 'x' }),
    },
  )
  assertEquals(res.status, 404)
  await res.body?.cancel()
})

// ── Multipart deploy ─────────────────────────────────────

Deno.test('POST /deploy accepts multipart/form-data with files', async () => {
  if (!testRef || !canWriteFs) return
  const session = await getTestSession()

  const form = new FormData()
  form.append('slug', testSlugMultipart)
  form.append('name', 'Multipart')
  form.append('verify_jwt', 'true')
  form.append(
    'file',
    new File([multipartSource], 'index.ts', { type: 'application/typescript' }),
  )

  const res = await fetch(`${V1_PROJECTS_URL}/${testRef}/functions/deploy`, {
    method: 'POST',
    headers: bearerOnly(session.access_token),
    body: form,
  })
  assertEquals(res.status, 201)
  const body = await res.json()
  assertEquals(body.slug, testSlugMultipart)
  assertEquals(body.name, 'Multipart')
  assertEquals(body.verify_jwt, true)

  const bodyRes = await fetch(
    `${V1_PROJECTS_URL}/${testRef}/functions/${testSlugMultipart}/body`,
    {
      headers: bearerOnly(session.access_token),
    },
  )
  assertEquals(bodyRes.status, 200)
  const files = await bodyRes.json()
  const indexFile = files.find((f: { name: string }) => f.name === 'index.ts')
  assertExists(indexFile)
  assertEquals(indexFile.content, multipartSource)
})

// ── DELETE removes the dir ───────────────────────────────

Deno.test('DELETE /functions/{slug} removes the directory', async () => {
  if (!testRef || !canWriteFs) return
  const session = await getTestSession()

  const delRes = await fetch(
    `${V1_PROJECTS_URL}/${testRef}/functions/${testSlug}`,
    {
      method: 'DELETE',
      headers: bearerOnly(session.access_token),
    },
  )
  assertEquals(delRes.status, 200)
  const body = await delRes.json()
  assertEquals(body.slug, testSlug)
  assertEquals(body.deleted, true)

  // Subsequent GET must now 404.
  const getRes = await fetch(
    `${V1_PROJECTS_URL}/${testRef}/functions/${testSlug}`,
    {
      headers: bearerOnly(session.access_token),
    },
  )
  assertEquals(getRes.status, 404)
  await getRes.body?.cancel()

  // Deleting again must 404.
  const redelete = await fetch(
    `${V1_PROJECTS_URL}/${testRef}/functions/${testSlug}`,
    {
      method: 'DELETE',
      headers: bearerOnly(session.access_token),
    },
  )
  assertEquals(redelete.status, 404)
  await redelete.body?.cancel()
})

// ── Cleanup ──────────────────────────────────────────────

// ── Cross-user (non-member) denial ───────────────────────
//
// C1 regression: the three GET /{ref}/functions* handlers used to resolve
// `backend` via `resolveFunctionsBackend(ref)` before any membership check
// fired, which let an authenticated user from a _different_ org read the list
// of function slugs, a single function's metadata, and a function's source
// body by just guessing a `ref`. The fix added `getProjectByRef(pool, ref,
// profileId)` at the top of each GET handler — a non-member now sees the
// same 404 a total-stranger would. These tests pin that behaviour against
// the live stack.

Deno.test('C1: GET /v1/projects/{ref}/functions from non-member returns 404', async () => {
  if (!testRef) return
  const { email, password } = await createDisposableUser('edgefn-c1-list')
  const otherSession = await signInAs(email, password)
  const res = await fetch(`${V1_PROJECTS_URL}/${testRef}/functions`, {
    method: 'GET',
    headers: bearerOnly(otherSession.access_token),
  })
  assert(
    res.status === 404 || res.status === 403,
    `non-member listing functions should be denied (got ${res.status})`,
  )
  await res.body?.cancel()
})

Deno.test('C1: GET /v1/projects/{ref}/functions/{slug} from non-member returns 404', async () => {
  if (!testRef) return
  const { email, password } = await createDisposableUser('edgefn-c1-get')
  const otherSession = await signInAs(email, password)
  const res = await fetch(
    `${V1_PROJECTS_URL}/${testRef}/functions/${testSlug}`,
    {
      method: 'GET',
      headers: bearerOnly(otherSession.access_token),
    },
  )
  assert(
    res.status === 404 || res.status === 403,
    `non-member reading function metadata should be denied (got ${res.status})`,
  )
  await res.body?.cancel()
})

Deno.test(
  'C1: GET /v1/projects/{ref}/functions/{slug}/body from non-member returns 404',
  async () => {
    if (!testRef) return
    const { email, password } = await createDisposableUser('edgefn-c1-body')
    const otherSession = await signInAs(email, password)
    const res = await fetch(
      `${V1_PROJECTS_URL}/${testRef}/functions/${testSlug}/body`,
      {
        method: 'GET',
        headers: bearerOnly(otherSession.access_token),
      },
    )
    assert(
      res.status === 404 || res.status === 403,
      `non-member reading function body should be denied (got ${res.status})`,
    )
    await res.body?.cancel()
  },
)

Deno.test('POST /v1/projects/{ref}/functions/deploy from non-member is denied', async () => {
  if (!testRef) return
  const { email, password } = await createDisposableUser('edgefn-other')
  const otherSession = await signInAs(email, password)
  const res = await fetch(`${V1_PROJECTS_URL}/${testRef}/functions/deploy`, {
    method: 'POST',
    headers: authHeaders(otherSession.access_token),
    body: JSON.stringify({
      metadata: { name: 'nope', entrypoint_path: 'index.ts' },
      file: [],
    }),
  })
  assert(
    res.status === 404 || res.status === 403,
    `non-member should be denied (got ${res.status})`,
  )
  await res.body?.cancel()
})

Deno.test('PATCH /v1/projects/{ref}/functions/{slug} from non-member is denied', async () => {
  if (!testRef) return
  const { email, password } = await createDisposableUser('edgefn-other')
  const otherSession = await signInAs(email, password)
  const res = await fetch(
    `${V1_PROJECTS_URL}/${testRef}/functions/${testSlug}`,
    {
      method: 'PATCH',
      headers: authHeaders(otherSession.access_token),
      body: JSON.stringify({ name: 'renamed-by-outsider' }),
    },
  )
  assert(
    res.status === 404 || res.status === 403,
    `non-member should be denied (got ${res.status})`,
  )
  await res.body?.cancel()
})

Deno.test('DELETE /v1/projects/{ref}/functions/{slug} from non-member is denied', async () => {
  if (!testRef) return
  const { email, password } = await createDisposableUser('edgefn-other')
  const otherSession = await signInAs(email, password)
  const res = await fetch(
    `${V1_PROJECTS_URL}/${testRef}/functions/${testSlug}`,
    {
      method: 'DELETE',
      headers: authHeaders(otherSession.access_token),
    },
  )
  assert(
    res.status === 404 || res.status === 403,
    `non-member should be denied (got ${res.status})`,
  )
  await res.body?.cancel()
})

Deno.test('cleanup: delete multipart test function', async () => {
  if (!testRef || !canWriteFs) return
  const session = await getTestSession()
  const res = await fetch(
    `${V1_PROJECTS_URL}/${testRef}/functions/${testSlugMultipart}`,
    {
      method: 'DELETE',
      headers: bearerOnly(session.access_token),
    },
  )
  await res.body?.cancel()
})

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
