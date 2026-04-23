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

const V1_PROJECTS_URL = `${supabaseUrl}/api/v1/projects`
const PROJECTS_URL = `${supabaseUrl}/api/platform/projects`
const ORG_URL = `${supabaseUrl}/api/platform/organizations`
const SIGNUP_URL = `${supabaseUrl}/api/platform/signup`

async function signUpDisposableUser(): Promise<{ email: string; password: string }> {
  const email = `edgefn-other-${Date.now()}-${Math.floor(Math.random() * 1e6)}@example.com`
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
  const res = await fetch(`${V1_PROJECTS_URL}/nonexistent00000000/functions/anything`, {
    method: 'PATCH',
    headers: authHeaders(session.access_token),
    body: JSON.stringify({ name: 'x' }),
  })
  assertEquals(res.status, 404)
  await res.body?.cancel()
})

Deno.test('POST /v1/projects/{unknownRef}/functions/deploy returns 404', async () => {
  const session = await getTestSession()
  const res = await fetch(`${V1_PROJECTS_URL}/nonexistent00000000/functions/deploy`, {
    method: 'POST',
    headers: authHeaders(session.access_token),
    body: JSON.stringify({ slug: 'whatever', body: [{ name: 'index.ts', content: '' }] }),
  })
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
        'skipping filesystem-dependent tests.'
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
    const res = await fetch(`${V1_PROJECTS_URL}/${testRef}/functions/${testSlug}/body`, {
      headers: bearerOnly(session.access_token),
    })
    assertEquals(res.status, 200)
    const files = await res.json()
    assert(Array.isArray(files), 'GET /body must return an array of files')
    const indexFile = files.find((f: { name: string }) => f.name === 'index.ts')
    assertExists(indexFile, 'index.ts should be in the deployed files')
    assertEquals(indexFile.content, initialSource)
  }
)

Deno.test('GET /functions/{slug} reflects deployed function shape', async () => {
  if (!testRef || !canWriteFs) return
  const session = await getTestSession()
  const res = await fetch(`${V1_PROJECTS_URL}/${testRef}/functions/${testSlug}`, {
    headers: bearerOnly(session.access_token),
  })
  assertEquals(res.status, 200)
  const body = await res.json()
  assertEquals(body.slug, testSlug)
  assertExists(body.entrypoint_path)
})

// ── PATCH updates .meta.json ─────────────────────────────

Deno.test('PATCH /functions/{slug} updates .meta.json sidecar', async () => {
  if (!testRef || !canWriteFs) return
  const session = await getTestSession()

  const patchRes = await fetch(`${V1_PROJECTS_URL}/${testRef}/functions/${testSlug}`, {
    method: 'PATCH',
    headers: authHeaders(session.access_token),
    body: JSON.stringify({
      name: 'Renamed Function',
      verify_jwt: true,
    }),
  })
  assertEquals(patchRes.status, 200)
  const patched = await patchRes.json()
  assertEquals(patched.slug, testSlug)
  assertEquals(patched.name, 'Renamed Function')
  assertEquals(patched.verify_jwt, true)

  // A subsequent GET (through the existing read-side handler in projects.ts)
  // should also reflect the override layered by parseFunctionDir.
  const getRes = await fetch(`${V1_PROJECTS_URL}/${testRef}/functions/${testSlug}`, {
    headers: bearerOnly(session.access_token),
  })
  assertEquals(getRes.status, 200)
  await getRes.body?.cancel()
})

Deno.test('PATCH /functions/{unknownSlug} returns 404', async () => {
  if (!testRef || !canWriteFs) return
  const session = await getTestSession()
  const res = await fetch(`${V1_PROJECTS_URL}/${testRef}/functions/__nonexistent_${RUN_TOKEN}`, {
    method: 'PATCH',
    headers: authHeaders(session.access_token),
    body: JSON.stringify({ name: 'x' }),
  })
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
  form.append('file', new File([multipartSource], 'index.ts', { type: 'application/typescript' }))

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

  const bodyRes = await fetch(`${V1_PROJECTS_URL}/${testRef}/functions/${testSlugMultipart}/body`, {
    headers: bearerOnly(session.access_token),
  })
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

  const delRes = await fetch(`${V1_PROJECTS_URL}/${testRef}/functions/${testSlug}`, {
    method: 'DELETE',
    headers: bearerOnly(session.access_token),
  })
  assertEquals(delRes.status, 200)
  const body = await delRes.json()
  assertEquals(body.slug, testSlug)
  assertEquals(body.deleted, true)

  // Subsequent GET must now 404.
  const getRes = await fetch(`${V1_PROJECTS_URL}/${testRef}/functions/${testSlug}`, {
    headers: bearerOnly(session.access_token),
  })
  assertEquals(getRes.status, 404)
  await getRes.body?.cancel()

  // Deleting again must 404.
  const redelete = await fetch(`${V1_PROJECTS_URL}/${testRef}/functions/${testSlug}`, {
    method: 'DELETE',
    headers: bearerOnly(session.access_token),
  })
  assertEquals(redelete.status, 404)
  await redelete.body?.cancel()
})

// ── Cleanup ──────────────────────────────────────────────

// ── Cross-user (non-member) denial ───────────────────────

Deno.test('POST /v1/projects/{ref}/functions/deploy from non-member is denied', async () => {
  if (!testRef) return
  const { email, password } = await signUpDisposableUser()
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
    `non-member should be denied (got ${res.status})`
  )
  await res.body?.cancel()
})

Deno.test('PATCH /v1/projects/{ref}/functions/{slug} from non-member is denied', async () => {
  if (!testRef) return
  const { email, password } = await signUpDisposableUser()
  const otherSession = await signInAs(email, password)
  const res = await fetch(`${V1_PROJECTS_URL}/${testRef}/functions/${testSlug}`, {
    method: 'PATCH',
    headers: authHeaders(otherSession.access_token),
    body: JSON.stringify({ name: 'renamed-by-outsider' }),
  })
  assert(
    res.status === 404 || res.status === 403,
    `non-member should be denied (got ${res.status})`
  )
  await res.body?.cancel()
})

Deno.test('DELETE /v1/projects/{ref}/functions/{slug} from non-member is denied', async () => {
  if (!testRef) return
  const { email, password } = await signUpDisposableUser()
  const otherSession = await signInAs(email, password)
  const res = await fetch(`${V1_PROJECTS_URL}/${testRef}/functions/${testSlug}`, {
    method: 'DELETE',
    headers: authHeaders(otherSession.access_token),
  })
  assert(
    res.status === 404 || res.status === 403,
    `non-member should be denied (got ${res.status})`
  )
  await res.body?.cancel()
})

Deno.test('cleanup: delete multipart test function', async () => {
  if (!testRef || !canWriteFs) return
  const session = await getTestSession()
  const res = await fetch(`${V1_PROJECTS_URL}/${testRef}/functions/${testSlugMultipart}`, {
    method: 'DELETE',
    headers: bearerOnly(session.access_token),
  })
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
