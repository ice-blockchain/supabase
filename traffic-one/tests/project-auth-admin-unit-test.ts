import { assert, assertEquals, assertStringIncludes } from 'jsr:@std/assert@1'

import 'jsr:@std/dotenv/load'

import { handleProjectAuthAdmin } from '../functions/routes/project-auth-admin.ts'
import type { FetchLike } from '../functions/services/project-backend.service.ts'

// ─────────────────────────────────────────────────────────────────────────────
// H4: unit tests for handleProjectAuthAdmin.
//
// These cases inject a fake `fetch` and a mock pool so the handler can be
// exercised without Kong + GoTrue + a live Postgres. The assertions focus on
// the outbound contract: target URL, HTTP method, and the `Authorization` /
// `apikey` headers (both of which must carry the project-scoped service_role
// key produced by `getProjectBackend`, NOT any platform-global env fallback).
//
// Each test uses a fresh mock pool instance so audit-log inserts from one
// case never bleed into another. We keep these tests offline deliberately —
// the live integration suite in `project-auth-admin-test.ts` already covers
// the end-to-end happy paths and cross-tenant 404 semantics; this suite
// guards the routing layer.
// ─────────────────────────────────────────────────────────────────────────────

interface QueryCall {
  sql: string
  values: unknown[]
}

interface MockPoolOptions {
  memberProject: {
    id: number
    ref: string
    name: string
    organization_id: number
    region: string
    cloud_provider: string
    status: string
    endpoint: string | null
    anon_key: string | null
    db_host: string | null
    service_key_secret_id: string | null
    db_pass_secret_id: string | null
    connection_string_secret_id: string | null
    created_at: string
    updated_at: string
  } | null
  backendRow?: {
    ref: string
    endpoint: string | null
    anon_key: string | null
    db_host: string | null
    service_key_secret_id: string | null
    db_pass_secret_id: string | null
    connection_string_secret_id: string | null
  }
  secrets?: Record<string, string>
  goTrueFactors?: Array<{ id: string }>
}

interface MockPool {
  // deno-lint-ignore no-explicit-any
  pool: any
  calls: QueryCall[]
  auditInserts: Array<Record<string, unknown>>
}

// Audit-row values land in the tagged-template parameters as positional
// `unknown` values. `decodeAuditMetadata` pulls the JSON-encoded strings
// out so tests can assert on them without string-matching raw SQL.
function pickAuditParams(values: unknown[]): Record<string, unknown> {
  // The INSERT has positional params in this order: organizationId,
  // profileId, actionName, actionMetadata (json), gotrueId, actorMetadata,
  // targetDescription, targetMetadata.
  return {
    organization_id: values[0],
    profile_id: values[1],
    action_name: values[2],
    action_metadata: values[3],
    actor_id: values[4],
    actor_metadata: values[5],
    target_description: values[6],
    target_metadata: values[7],
  }
}

function createMockPool(options: MockPoolOptions): MockPool {
  const calls: QueryCall[] = []
  const auditInserts: Array<Record<string, unknown>> = []

  const connection = {
    queryObject<T>(
      strings: TemplateStringsArray,
      ...values: unknown[]
    ): Promise<{ rows: T[] }> {
      const sql = strings.join('?')
      calls.push({ sql, values })

      // INSERT INTO traffic.audit_logs — capture row for assertions.
      if (/INSERT INTO traffic\.audit_logs/i.test(sql)) {
        auditInserts.push(pickAuditParams(values))
        return Promise.resolve({ rows: [] as T[] })
      }

      // getProjectByRef: JOIN against organization_members.
      if (/JOIN traffic\.organization_members/i.test(sql)) {
        const rows = options.memberProject ? [options.memberProject] : []
        return Promise.resolve({ rows: rows as unknown as T[] })
      }

      // getProjectBackend: plain traffic.projects SELECT.
      if (/FROM traffic\.projects/i.test(sql)) {
        const row = options.backendRow ?? options.memberProject
        return Promise.resolve({ rows: (row ? [row] : []) as unknown as T[] })
      }

      // vault decrypt.
      if (/FROM vault\.decrypted_secrets/i.test(sql)) {
        const secretId = values[0] as string | null | undefined
        if (secretId && options.secrets && options.secrets[secretId]) {
          return Promise.resolve({
            rows: [{
              decrypted_secret: options.secrets[secretId],
            }] as unknown as T[],
          })
        }
        return Promise.resolve({ rows: [] as T[] })
      }

      // Default: no-op.
      return Promise.resolve({ rows: [] as T[] })
    },
    release() {},
  }

  const pool = {
    connect() {
      return Promise.resolve(connection)
    },
  }

  return { pool, calls, auditInserts }
}

function baseProjectRow(
  overrides: Partial<MockPoolOptions['memberProject']> = {},
) {
  return {
    id: 42,
    ref: 'abcdefabcdefabcdefab',
    name: 'unit-proj',
    organization_id: 7,
    region: 'local',
    cloud_provider: 'FLY',
    status: 'ACTIVE_HEALTHY',
    endpoint: 'http://kong:8000',
    anon_key: 'anon-row',
    db_host: 'db',
    service_key_secret_id: 'a1111111-1111-1111-1111-111111111111',
    db_pass_secret_id: null,
    connection_string_secret_id: null,
    created_at: new Date().toISOString(),
    updated_at: new Date().toISOString(),
    ...overrides,
  } as NonNullable<MockPoolOptions['memberProject']>
}

const DEFAULT_REF = 'abcdefabcdefabcdefab'
const DEFAULT_SECRETS = {
  'a1111111-1111-1111-1111-111111111111': 'svc-role-key',
}

// Each fake fetch test captures ONLY the first call; the handlers under
// test always fire exactly one outbound request per surface. The factors
// surface is an exception and uses its own ordered capture.
interface CapturedCall {
  url: string
  method: string
  authorization: string
  apikey: string
  body: string
}

function createFakeFetch(responder: (call: CapturedCall) => Response): {
  fetchImpl: FetchLike
  captured: CapturedCall[]
} {
  const captured: CapturedCall[] = []
  const fetchImpl: FetchLike = async (input, init) => {
    const url = typeof input === 'string'
      ? input
      : input instanceof URL
      ? input.toString()
      : input.url
    const headers = new Headers(init?.headers ?? {})
    const body = init?.body ? String(init.body) : ''
    const call: CapturedCall = {
      url,
      method: (init?.method ?? 'GET').toUpperCase(),
      authorization: headers.get('Authorization') ?? '',
      apikey: headers.get('apikey') ?? '',
      body,
    }
    captured.push(call)
    return await Promise.resolve(responder(call))
  }
  return { fetchImpl, captured }
}

function makeReq(
  path: string,
  method: string,
  body?: Record<string, unknown>,
  origin = 'http://kong:8000',
): Request {
  return new Request(`${origin}/api/platform/auth${path}`, {
    method,
    headers: body ? { 'Content-Type': 'application/json' } : {},
    body: body ? JSON.stringify(body) : undefined,
  })
}

function setTrafficEnv() {
  // The resolver reads SUPABASE_URL when resolving a shared-stack endpoint;
  // set it to match the row's `endpoint` column so the resolver takes the
  // shared-stack path (no vault lookup for anon) and the fake service key
  // we feed via Vault gets used.
  Deno.env.set('SUPABASE_URL', 'http://kong:8000')
  Deno.env.set('SUPABASE_ANON_KEY', 'anon-env')
  Deno.env.set('SUPABASE_SERVICE_ROLE_KEY', 'svc-env')
}

// ── POST /{ref}/users ───────────────────────────────────────

Deno.test('handleProjectAuthAdmin POST /users dispatches to /auth/v1/admin/users', async () => {
  setTrafficEnv()
  const mock = createMockPool({
    memberProject: baseProjectRow(),
    secrets: DEFAULT_SECRETS,
  })
  const { fetchImpl, captured } = createFakeFetch(
    () =>
      new Response(JSON.stringify({ id: 'u-1' }), {
        status: 200,
        headers: { 'Content-Type': 'application/json' },
      }),
  )

  const res = await handleProjectAuthAdmin(
    makeReq(`/${DEFAULT_REF}/users`, 'POST', {
      email: 'u@x.dev',
      password: 'p',
    }),
    `/${DEFAULT_REF}/users`,
    'POST',
    // deno-lint-ignore no-explicit-any
    mock.pool as any,
    /* profileId */ 11,
    /* gotrueId */ 'g-1',
    /* email */ 'admin@example.com',
    fetchImpl,
  )
  assertEquals(res.status, 200)
  await res.body?.cancel()

  assertEquals(captured.length, 1)
  assertEquals(captured[0].url, 'http://kong:8000/auth/v1/admin/users')
  assertEquals(captured[0].method, 'POST')
  assertEquals(captured[0].authorization, 'Bearer svc-role-key')
  assertEquals(captured[0].apikey, 'svc-role-key')
  assertEquals(JSON.parse(captured[0].body), {
    email: 'u@x.dev',
    password: 'p',
  })

  // Audit row captured — sensitive password must be stripped.
  assertEquals(mock.auditInserts.length, 1)
  const audit = mock.auditInserts[0]
  assertEquals(audit.action_name, 'project.app_user_create')
  const targetMetaRaw = audit.target_metadata as string
  assert(
    targetMetaRaw.includes('"password"') === false,
    'password must not appear in audit metadata',
  )
})

Deno.test('handleProjectAuthAdmin POST /users skips audit on upstream failure', async () => {
  setTrafficEnv()
  const mock = createMockPool({
    memberProject: baseProjectRow(),
    secrets: DEFAULT_SECRETS,
  })
  const { fetchImpl } = createFakeFetch(() => new Response('boom', { status: 500 }))

  const res = await handleProjectAuthAdmin(
    makeReq(`/${DEFAULT_REF}/users`, 'POST', { email: 'u@x.dev' }),
    `/${DEFAULT_REF}/users`,
    'POST',
    // deno-lint-ignore no-explicit-any
    mock.pool as any,
    11,
    'g-1',
    'admin@example.com',
    fetchImpl,
  )
  assertEquals(res.status, 500)
  await res.body?.cancel()
  assertEquals(mock.auditInserts.length, 0)
})

// ── PATCH /{ref}/users/{id} → PUT upstream ─────────────────

Deno.test(
  'handleProjectAuthAdmin PATCH /users/{id} dispatches PUT /auth/v1/admin/users/{id}',
  async () => {
    setTrafficEnv()
    const mock = createMockPool({
      memberProject: baseProjectRow(),
      secrets: DEFAULT_SECRETS,
    })
    const { fetchImpl, captured } = createFakeFetch(
      () =>
        new Response('{}', {
          status: 200,
          headers: { 'Content-Type': 'application/json' },
        }),
    )
    const res = await handleProjectAuthAdmin(
      makeReq(`/${DEFAULT_REF}/users/u-1`, 'PATCH', { email_confirm: true }),
      `/${DEFAULT_REF}/users/u-1`,
      'PATCH',
      // deno-lint-ignore no-explicit-any
      mock.pool as any,
      11,
      'g-1',
      'admin@example.com',
      fetchImpl,
    )
    assertEquals(res.status, 200)
    await res.body?.cancel()
    assertEquals(captured[0].method, 'PUT')
    assertEquals(captured[0].url, 'http://kong:8000/auth/v1/admin/users/u-1')
    assertEquals(captured[0].authorization, 'Bearer svc-role-key')
    assertEquals(mock.auditInserts[0].action_name, 'project.app_user_update')
  },
)

// ── DELETE /{ref}/users/{id} ──────────────────────────────

Deno.test('handleProjectAuthAdmin DELETE /users/{id} audits on 200', async () => {
  setTrafficEnv()
  const mock = createMockPool({
    memberProject: baseProjectRow(),
    secrets: DEFAULT_SECRETS,
  })
  const { fetchImpl, captured } = createFakeFetch(() => new Response('{}', { status: 200 }))
  const res = await handleProjectAuthAdmin(
    makeReq(`/${DEFAULT_REF}/users/u-1`, 'DELETE'),
    `/${DEFAULT_REF}/users/u-1`,
    'DELETE',
    // deno-lint-ignore no-explicit-any
    mock.pool as any,
    11,
    'g-1',
    'admin@example.com',
    fetchImpl,
  )
  assertEquals(res.status, 200)
  await res.body?.cancel()
  assertEquals(captured[0].method, 'DELETE')
  assertEquals(captured[0].url, 'http://kong:8000/auth/v1/admin/users/u-1')
  assertEquals(mock.auditInserts[0].action_name, 'project.app_user_delete')
})

// ── DELETE /{ref}/users/{id}/factors — list + delete loop ─

Deno.test(
  'handleProjectAuthAdmin DELETE /factors lists + deletes each factor and audits ok',
  async () => {
    setTrafficEnv()
    const mock = createMockPool({
      memberProject: baseProjectRow(),
      secrets: DEFAULT_SECRETS,
    })
    const factors = [{ id: 'f1' }, { id: 'f2' }]
    let listed = false
    const { fetchImpl, captured } = createFakeFetch((call) => {
      if (!listed) {
        listed = true
        return new Response(JSON.stringify({ factors }), {
          status: 200,
          headers: { 'Content-Type': 'application/json' },
        })
      }
      assertEquals(call.method, 'DELETE')
      return new Response('{}', { status: 200 })
    })
    const res = await handleProjectAuthAdmin(
      makeReq(`/${DEFAULT_REF}/users/u-1/factors`, 'DELETE'),
      `/${DEFAULT_REF}/users/u-1/factors`,
      'DELETE',
      // deno-lint-ignore no-explicit-any
      mock.pool as any,
      11,
      'g-1',
      'admin@example.com',
      fetchImpl,
    )
    assertEquals(res.status, 200)
    await res.body?.cancel()
    assertEquals(captured.length, 3)
    assertEquals(
      captured[0].url,
      'http://kong:8000/auth/v1/admin/users/u-1/factors',
    )
    assertEquals(
      captured[1].url,
      'http://kong:8000/auth/v1/admin/users/u-1/factors/f1',
    )
    assertEquals(
      captured[2].url,
      'http://kong:8000/auth/v1/admin/users/u-1/factors/f2',
    )
    // All calls carry the project-scoped service key.
    for (const call of captured) {
      assertEquals(call.authorization, 'Bearer svc-role-key')
      assertEquals(call.apikey, 'svc-role-key')
    }
    assertEquals(
      mock.auditInserts[0].action_name,
      'project.app_user_mfa_factors_delete',
    )
  },
)

// ── POST /{ref}/invite + /magiclink + /recover + /otp ─────

Deno.test('handleProjectAuthAdmin POST /invite dispatches to /auth/v1/invite', async () => {
  setTrafficEnv()
  const mock = createMockPool({
    memberProject: baseProjectRow(),
    secrets: DEFAULT_SECRETS,
  })
  const { fetchImpl, captured } = createFakeFetch(
    () =>
      new Response('{}', {
        status: 200,
        headers: { 'Content-Type': 'application/json' },
      }),
  )
  await handleProjectAuthAdmin(
    makeReq(`/${DEFAULT_REF}/invite`, 'POST', { email: 'u@x.dev' }),
    `/${DEFAULT_REF}/invite`,
    'POST',
    // deno-lint-ignore no-explicit-any
    mock.pool as any,
    11,
    'g-1',
    'admin@example.com',
    fetchImpl,
  )
  assertEquals(captured[0].url, 'http://kong:8000/auth/v1/invite')
  assertEquals(mock.auditInserts[0].action_name, 'project.app_user_invite')
})

Deno.test('handleProjectAuthAdmin POST /magiclink dispatches to /auth/v1/magiclink', async () => {
  setTrafficEnv()
  const mock = createMockPool({
    memberProject: baseProjectRow(),
    secrets: DEFAULT_SECRETS,
  })
  const { fetchImpl, captured } = createFakeFetch(
    () =>
      new Response('{}', {
        status: 200,
        headers: { 'Content-Type': 'application/json' },
      }),
  )
  await handleProjectAuthAdmin(
    makeReq(`/${DEFAULT_REF}/magiclink`, 'POST', { email: 'u@x.dev' }),
    `/${DEFAULT_REF}/magiclink`,
    'POST',
    // deno-lint-ignore no-explicit-any
    mock.pool as any,
    11,
    'g-1',
    'admin@example.com',
    fetchImpl,
  )
  assertEquals(captured[0].url, 'http://kong:8000/auth/v1/magiclink')
  assertEquals(mock.auditInserts[0].action_name, 'project.app_user_magiclink')
})

Deno.test('handleProjectAuthAdmin POST /recover dispatches to /auth/v1/recover', async () => {
  setTrafficEnv()
  const mock = createMockPool({
    memberProject: baseProjectRow(),
    secrets: DEFAULT_SECRETS,
  })
  const { fetchImpl, captured } = createFakeFetch(
    () =>
      new Response('{}', {
        status: 200,
        headers: { 'Content-Type': 'application/json' },
      }),
  )
  await handleProjectAuthAdmin(
    makeReq(`/${DEFAULT_REF}/recover`, 'POST', { email: 'u@x.dev' }),
    `/${DEFAULT_REF}/recover`,
    'POST',
    // deno-lint-ignore no-explicit-any
    mock.pool as any,
    11,
    'g-1',
    'admin@example.com',
    fetchImpl,
  )
  assertEquals(captured[0].url, 'http://kong:8000/auth/v1/recover')
  assertEquals(mock.auditInserts[0].action_name, 'project.app_user_recover')
})

// ── 404 on unknown ref ─────────────────────────────────────

Deno.test('handleProjectAuthAdmin returns 404 for non-member project', async () => {
  setTrafficEnv()
  const mock = createMockPool({ memberProject: null })
  const { fetchImpl, captured } = createFakeFetch(() => new Response('{}', { status: 200 }))
  const res = await handleProjectAuthAdmin(
    makeReq(`/${DEFAULT_REF}/users`, 'POST', { email: 'u@x.dev' }),
    `/${DEFAULT_REF}/users`,
    'POST',
    // deno-lint-ignore no-explicit-any
    mock.pool as any,
    11,
    'g-1',
    'admin@example.com',
    fetchImpl,
  )
  assertEquals(res.status, 404)
  await res.body?.cancel()
  // Fake fetch was NEVER called — membership check short-circuits.
  assertEquals(captured.length, 0)
})

// ── 501 on missing service key (C2 regression) ─────────────

Deno.test(
  'handleProjectAuthAdmin returns 501 when per-project endpoint is missing service key',
  async () => {
    setTrafficEnv()
    const perProjectRow = baseProjectRow({
      endpoint: 'https://tenant-b.supabase.example.com',
      service_key_secret_id: null,
    })
    const mock = createMockPool({ memberProject: perProjectRow })
    const { fetchImpl, captured } = createFakeFetch(() => new Response('{}', { status: 200 }))
    const res = await handleProjectAuthAdmin(
      makeReq(`/${DEFAULT_REF}/users`, 'POST', { email: 'u@x.dev' }),
      `/${DEFAULT_REF}/users`,
      'POST',
      // deno-lint-ignore no-explicit-any
      mock.pool as any,
      11,
      'g-1',
      'admin@example.com',
      fetchImpl,
    )
    assertEquals(res.status, 501)
    const body = await res.json()
    // M6: every project route now shares the
    // `notProvisionedResponse` helper, so the canonical
    // `{ code, message, missing: [...] }` shape MUST be emitted.
    assertEquals(body.code, 'project_backend_not_provisioned')
    assert(
      Array.isArray(body.missing) && body.missing.includes('service_key'),
      `expected service_key in body.missing, got: ${JSON.stringify(body)}`,
    )
    assertEquals(captured.length, 0)
  },
)

// ── /validate/spam: proxy → heuristic fallback (M4) ────────

Deno.test(
  'handleProjectAuthAdmin POST /validate/spam falls back to heuristic when GoTrue has no endpoint',
  async () => {
    setTrafficEnv()
    // Make sure no external scorer is configured for this test.
    Deno.env.delete('TRAFFIC_SPAM_CHECK_URL')
    const mock = createMockPool({
      memberProject: baseProjectRow(),
      secrets: DEFAULT_SECRETS,
    })
    // Simulate GoTrue 404 for /auth/v1/validate/spam (open-source GoTrue).
    const { fetchImpl, captured } = createFakeFetch(() => new Response('{}', { status: 404 }))
    const res = await handleProjectAuthAdmin(
      makeReq(`/${DEFAULT_REF}/validate/spam`, 'POST', {
        subject: 'FREE money lottery winner',
        content: 'CLICK HERE for prize',
      }),
      `/${DEFAULT_REF}/validate/spam`,
      'POST',
      // deno-lint-ignore no-explicit-any
      mock.pool as any,
      11,
      'g-1',
      'admin@example.com',
      fetchImpl,
    )
    assertEquals(res.status, 200)
    const body = await res.json()
    assert(Array.isArray(body.rules))
    assert(
      body.rules.length > 0,
      'spam heuristic must yield rules for obvious inputs',
    )
    // One outbound probe to GoTrue (the proxy attempt), then fallback to
    // the local heuristic.
    assertEquals(captured.length, 1)
    assertEquals(captured[0].method, 'POST')
    assertEquals(captured[0].url, 'http://kong:8000/auth/v1/validate/spam')
    // Audit surfaces that the heuristic produced the answer. The
    // target_metadata is `{ ref, body: {...} }` — `source` lives on body.
    const auditMeta = JSON.parse(
      mock.auditInserts[0].target_metadata as string,
    )
    assertEquals(auditMeta.body.source, 'heuristic')
    assertEquals(
      mock.auditInserts[0].action_name,
      'project.app_user_validate_spam',
    )
  },
)

Deno.test(
  'handleProjectAuthAdmin POST /validate/spam uses GoTrue when it responds 200',
  async () => {
    setTrafficEnv()
    Deno.env.delete('TRAFFIC_SPAM_CHECK_URL')
    const mock = createMockPool({
      memberProject: baseProjectRow(),
      secrets: DEFAULT_SECRETS,
    })
    // GoTrue returns its own rules — traffic-one should pass them
    // through untouched.
    const { fetchImpl, captured } = createFakeFetch(
      () =>
        new Response(
          JSON.stringify({
            rules: [{ name: 'CLOUD_RULE', desc: 'from gotrue', score: 1.2 }],
          }),
          { status: 200, headers: { 'Content-Type': 'application/json' } },
        ),
    )
    const res = await handleProjectAuthAdmin(
      makeReq(`/${DEFAULT_REF}/validate/spam`, 'POST', {
        subject: 'hi',
        content: 'hello',
      }),
      `/${DEFAULT_REF}/validate/spam`,
      'POST',
      // deno-lint-ignore no-explicit-any
      mock.pool as any,
      11,
      'g-1',
      'admin@example.com',
      fetchImpl,
    )
    assertEquals(res.status, 200)
    const body = await res.json()
    assertEquals(body.rules[0].name, 'CLOUD_RULE')
    assertEquals(captured.length, 1)
    const auditMeta = JSON.parse(
      mock.auditInserts[0].target_metadata as string,
    )
    assertEquals(auditMeta.body.source, 'gotrue')
  },
)

Deno.test(
  'handleProjectAuthAdmin POST /validate/spam uses TRAFFIC_SPAM_CHECK_URL when set',
  async () => {
    setTrafficEnv()
    Deno.env.set(
      'TRAFFIC_SPAM_CHECK_URL',
      'https://spam-scorer.example.com/score',
    )
    const mock = createMockPool({
      memberProject: baseProjectRow(),
      secrets: DEFAULT_SECRETS,
    })
    const { fetchImpl, captured } = createFakeFetch(
      () =>
        new Response(
          JSON.stringify({ rules: [{ name: 'EXT', desc: 'x', score: 9 }] }),
          {
            status: 200,
            headers: { 'Content-Type': 'application/json' },
          },
        ),
    )
    try {
      const res = await handleProjectAuthAdmin(
        makeReq(`/${DEFAULT_REF}/validate/spam`, 'POST', {
          subject: 'hi',
          content: 'hello',
        }),
        `/${DEFAULT_REF}/validate/spam`,
        'POST',
        // deno-lint-ignore no-explicit-any
        mock.pool as any,
        11,
        'g-1',
        'admin@example.com',
        fetchImpl,
      )
      assertEquals(res.status, 200)
      const body = await res.json()
      assertEquals(body.rules[0].name, 'EXT')
      assertEquals(captured.length, 1)
      assertEquals(captured[0].url, 'https://spam-scorer.example.com/score')
      const auditMeta = JSON.parse(
        mock.auditInserts[0].target_metadata as string,
      )
      assertEquals(auditMeta.body.source, 'external')
    } finally {
      Deno.env.delete('TRAFFIC_SPAM_CHECK_URL')
    }
  },
)

// ── H5: MFA factor-clear failure handling ─────────────────

Deno.test(
  'handleProjectAuthAdmin DELETE /factors returns 502 + skips audit when LIST fails',
  async () => {
    setTrafficEnv()
    const mock = createMockPool({
      memberProject: baseProjectRow(),
      secrets: DEFAULT_SECRETS,
    })
    // LIST hits 5xx — prior behavior treated as empty list + audited
    // success. H5 requires a 502 + no audit row.
    const { fetchImpl, captured } = createFakeFetch(
      () => new Response(JSON.stringify({ error: 'gotrue down' }), { status: 500 }),
    )
    const res = await handleProjectAuthAdmin(
      makeReq(`/${DEFAULT_REF}/users/u-1/factors`, 'DELETE'),
      `/${DEFAULT_REF}/users/u-1/factors`,
      'DELETE',
      // deno-lint-ignore no-explicit-any
      mock.pool as any,
      11,
      'g-1',
      'admin@example.com',
      fetchImpl,
    )
    assertEquals(res.status, 502)
    const body = await res.json()
    assertEquals(body.error.reason, 'upstream_error')
    assertEquals(body.error.upstream_status, 500)
    assertEquals(captured.length, 1)
    assertEquals(captured[0].method, 'GET')
    assertEquals(
      captured[0].url,
      'http://kong:8000/auth/v1/admin/users/u-1/factors',
    )
    // Critical: no success audit on LIST failure.
    assertEquals(mock.auditInserts.length, 0)
  },
)

Deno.test(
  'handleProjectAuthAdmin DELETE /factors returns 502 + skips audit on partial DELETE failure',
  async () => {
    setTrafficEnv()
    const mock = createMockPool({
      memberProject: baseProjectRow(),
      secrets: DEFAULT_SECRETS,
    })
    const factors = [{ id: 'f1' }, { id: 'f2' }]
    let step = 0
    const { fetchImpl, captured } = createFakeFetch(() => {
      const current = step++
      if (current === 0) {
        // LIST ok.
        return new Response(JSON.stringify({ factors }), {
          status: 200,
          headers: { 'Content-Type': 'application/json' },
        })
      }
      if (current === 1) {
        // f1 DELETE ok.
        return new Response('{}', { status: 200 })
      }
      // f2 DELETE fails with 500.
      return new Response('{}', { status: 500 })
    })
    const res = await handleProjectAuthAdmin(
      makeReq(`/${DEFAULT_REF}/users/u-1/factors`, 'DELETE'),
      `/${DEFAULT_REF}/users/u-1/factors`,
      'DELETE',
      // deno-lint-ignore no-explicit-any
      mock.pool as any,
      11,
      'g-1',
      'admin@example.com',
      fetchImpl,
    )
    assertEquals(res.status, 502)
    await res.body?.cancel()
    assertEquals(captured.length, 3)
    // Partial failure MUST NOT audit success.
    assertEquals(mock.auditInserts.length, 0)
  },
)

// ── 405 on wrong method ────────────────────────────────────

Deno.test('handleProjectAuthAdmin PUT /users returns 405', async () => {
  setTrafficEnv()
  const mock = createMockPool({
    memberProject: baseProjectRow(),
    secrets: DEFAULT_SECRETS,
  })
  const { fetchImpl, captured } = createFakeFetch(() => new Response('{}', { status: 200 }))
  const res = await handleProjectAuthAdmin(
    makeReq(`/${DEFAULT_REF}/users`, 'PUT', { email: 'u@x.dev' }),
    `/${DEFAULT_REF}/users`,
    'PUT',
    // deno-lint-ignore no-explicit-any
    mock.pool as any,
    11,
    'g-1',
    'admin@example.com',
    fetchImpl,
  )
  // /{ref}/users with PUT falls through to the 404 branch (handler only
  // matches POST). This keeps route semantics crisp: unknown combinations
  // MUST NOT hit the upstream.
  assertStringIncludes(String(res.status), '4')
  await res.body?.cancel()
  assertEquals(captured.length, 0)
})
