import { assert, assertEquals } from 'jsr:@std/assert@1'

import 'jsr:@std/dotenv/load'

import { handleProjectPgMeta } from '../functions/routes/project-pg-meta.ts'
import type { FetchLike } from '../functions/services/project-backend.service.ts'

// ─────────────────────────────────────────────────────────────────────────────
// H4: unit tests for handleProjectPgMeta.
//
// Same pattern as project-auth-admin-unit-test.ts: mock the pool so the
// membership + backend resolve are offline, inject a fake `fetch` so the
// outbound POST to `{pgMetaUrl}/...` is observable without a live pg-meta.
//
// The assertions guard:
//   1. Every outbound call targets `backend.pgMetaUrl/...` (never Studio's
//      own `PG_META_URL` env fallback when a per-project backend is wired).
//   2. `Authorization` + `apikey` carry the project-scoped service_role key.
//   3. `/query` emits an audit row whose target_metadata captures byte size
//      + 512-char preview (current shape — see M12 for a follow-up).
// ─────────────────────────────────────────────────────────────────────────────

interface QueryCall {
  sql: string
  values: unknown[]
}

interface BaseProjectRow {
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
}

interface MockPoolOptions {
  memberProject: BaseProjectRow | null
  secrets?: Record<string, string>
}

function pickAuditParams(values: unknown[]): Record<string, unknown> {
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

function createMockPool(options: MockPoolOptions) {
  const calls: QueryCall[] = []
  const auditInserts: Array<Record<string, unknown>> = []

  const connection = {
    queryObject<T>(
      strings: TemplateStringsArray,
      ...values: unknown[]
    ): Promise<{ rows: T[] }> {
      const sql = strings.join('?')
      calls.push({ sql, values })

      if (/INSERT INTO traffic\.audit_logs/i.test(sql)) {
        auditInserts.push(pickAuditParams(values))
        return Promise.resolve({ rows: [] as T[] })
      }

      if (/JOIN traffic\.organization_members/i.test(sql)) {
        const rows = options.memberProject ? [options.memberProject] : []
        return Promise.resolve({ rows: rows as unknown as T[] })
      }

      if (/FROM traffic\.projects/i.test(sql)) {
        return Promise.resolve({
          rows: (options.memberProject ? [options.memberProject] : []) as unknown as T[],
        })
      }

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

      return Promise.resolve({ rows: [] as T[] })
    },
    release() {},
  }

  return {
    pool: {
      connect() {
        return Promise.resolve(connection)
      },
    },
    calls,
    auditInserts,
  }
}

function baseProjectRow(
  overrides: Partial<BaseProjectRow> = {},
): BaseProjectRow {
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
  }
}

const DEFAULT_REF = 'abcdefabcdefabcdefab'
const DEFAULT_SECRETS = {
  'a1111111-1111-1111-1111-111111111111': 'svc-role-key',
}

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
  const headers: Record<string, string> = {}
  if (body) headers['Content-Type'] = 'application/json'
  return new Request(`${origin}/api/platform/pg-meta${path}`, {
    method,
    headers,
    body: body ? JSON.stringify(body) : undefined,
  })
}

function setTrafficEnv() {
  // Shared-stack endpoint — resolver picks up PG_META_URL as
  // `http://meta-fake:8080` so the assertions don't accidentally depend on
  // the operator's local env.
  Deno.env.set('SUPABASE_URL', 'http://kong:8000')
  Deno.env.set('PG_META_URL', 'http://meta-fake:8080')
  Deno.env.set('SUPABASE_SERVICE_ROLE_KEY', 'svc-env')
}

// ── POST /{ref}/query — happy path ─────────────────────────

Deno.test(
  'handleProjectPgMeta POST /query forwards SQL to pg-meta with service role auth',
  async () => {
    setTrafficEnv()
    const mock = createMockPool({
      memberProject: baseProjectRow(),
      secrets: DEFAULT_SECRETS,
    })
    const { fetchImpl, captured } = createFakeFetch(
      () =>
        new Response(JSON.stringify([{ n: 1 }]), {
          status: 200,
          headers: { 'Content-Type': 'application/json' },
        }),
    )

    const res = await handleProjectPgMeta(
      makeReq(`/${DEFAULT_REF}/query`, 'POST', { query: 'select 1' }),
      `/${DEFAULT_REF}/query`,
      'POST',
      // deno-lint-ignore no-explicit-any
      mock.pool as any,
      11,
      'g-1',
      'admin@example.com',
      fetchImpl,
    )
    assertEquals(res.status, 200)
    await res.body?.cancel()

    assertEquals(captured.length, 1)
    assertEquals(captured[0].url, 'http://meta-fake:8080/query')
    assertEquals(captured[0].method, 'POST')
    assertEquals(captured[0].authorization, 'Bearer svc-role-key')
    assertEquals(captured[0].apikey, 'svc-role-key')
    assertEquals(JSON.parse(captured[0].body).query, 'select 1')

    // M12: audit row emits byte count + non-reversible SHA-256 hex
    // digest of the SQL, never the statement text. This test also
    // regresses the leakage fix: asserting `preview` is `undefined`
    // guards against someone re-introducing the 512-char preview.
    assertEquals(mock.auditInserts.length, 1)
    assertEquals(mock.auditInserts[0].action_name, 'project.pg_meta.query')
    const targetMeta = JSON.parse(
      mock.auditInserts[0].target_metadata as string,
    )
    assertEquals(targetMeta.sql.bytes, 8)
    assertEquals(typeof targetMeta.sql.sha256, 'string')
    // SHA-256 hex = 64 chars.
    assertEquals(targetMeta.sql.sha256.length, 64)
    assertEquals(targetMeta.sql.preview, undefined)
  },
)

// ── POST /{ref}/query — upstream non-200 still audits ──────

Deno.test('handleProjectPgMeta POST /query audits even when pg-meta returns 400', async () => {
  setTrafficEnv()
  const mock = createMockPool({
    memberProject: baseProjectRow(),
    secrets: DEFAULT_SECRETS,
  })
  const { fetchImpl } = createFakeFetch(
    () =>
      new Response(JSON.stringify({ error: 'syntax error' }), {
        status: 400,
        headers: { 'Content-Type': 'application/json' },
      }),
  )

  const res = await handleProjectPgMeta(
    makeReq(`/${DEFAULT_REF}/query`, 'POST', { query: 'selec 1' }),
    `/${DEFAULT_REF}/query`,
    'POST',
    // deno-lint-ignore no-explicit-any
    mock.pool as any,
    11,
    'g-1',
    'admin@example.com',
    fetchImpl,
  )
  assertEquals(res.status, 400)
  await res.body?.cancel()
  assertEquals(mock.auditInserts.length, 1)
})

// ── POST /{ref}/query — bad body → 400, no upstream ────────

Deno.test(
  'handleProjectPgMeta POST /query rejects missing query with 400 and no upstream call',
  async () => {
    setTrafficEnv()
    const mock = createMockPool({
      memberProject: baseProjectRow(),
      secrets: DEFAULT_SECRETS,
    })
    const { fetchImpl, captured } = createFakeFetch(() => new Response('', { status: 200 }))

    const res = await handleProjectPgMeta(
      makeReq(`/${DEFAULT_REF}/query`, 'POST', {}),
      `/${DEFAULT_REF}/query`,
      'POST',
      // deno-lint-ignore no-explicit-any
      mock.pool as any,
      11,
      'g-1',
      'admin@example.com',
      fetchImpl,
    )
    assertEquals(res.status, 400)
    await res.body?.cancel()
    assertEquals(captured.length, 0)
    assertEquals(mock.auditInserts.length, 0)
  },
)

// ── GET /{ref}/tables — read-through proxy ─────────────────

Deno.test('handleProjectPgMeta GET /tables forwards to pg-meta', async () => {
  setTrafficEnv()
  const mock = createMockPool({
    memberProject: baseProjectRow(),
    secrets: DEFAULT_SECRETS,
  })
  const { fetchImpl, captured } = createFakeFetch(
    () =>
      new Response('[]', {
        status: 200,
        headers: { 'Content-Type': 'application/json' },
      }),
  )

  const req = new Request(
    `http://kong:8000/api/platform/pg-meta/${DEFAULT_REF}/tables?schema=public`,
    { method: 'GET' },
  )
  const res = await handleProjectPgMeta(
    req,
    `/${DEFAULT_REF}/tables`,
    'GET',
    // deno-lint-ignore no-explicit-any
    mock.pool as any,
    11,
    'g-1',
    'admin@example.com',
    fetchImpl,
  )
  assertEquals(res.status, 200)
  await res.body?.cancel()

  assertEquals(captured.length, 1)
  assertEquals(captured[0].url, 'http://meta-fake:8080/tables?schema=public')
  assertEquals(captured[0].method, 'GET')
  assertEquals(captured[0].authorization, 'Bearer svc-role-key')
  // No audit row for read-only surfaces.
  assertEquals(mock.auditInserts.length, 0)
})

// ── 404 on unknown ref ─────────────────────────────────────

Deno.test('handleProjectPgMeta returns 404 for non-member project', async () => {
  setTrafficEnv()
  const mock = createMockPool({ memberProject: null })
  const { fetchImpl, captured } = createFakeFetch(() => new Response('{}', { status: 200 }))

  const res = await handleProjectPgMeta(
    makeReq(`/${DEFAULT_REF}/query`, 'POST', { query: 'select 1' }),
    `/${DEFAULT_REF}/query`,
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
  assertEquals(captured.length, 0)
})

// ── 404 on unknown surface ─────────────────────────────────

Deno.test('handleProjectPgMeta GET /{ref}/bogus returns 404', async () => {
  setTrafficEnv()
  const mock = createMockPool({
    memberProject: baseProjectRow(),
    secrets: DEFAULT_SECRETS,
  })
  const { fetchImpl, captured } = createFakeFetch(() => new Response('{}', { status: 200 }))

  const res = await handleProjectPgMeta(
    makeReq(`/${DEFAULT_REF}/bogus`, 'GET'),
    `/${DEFAULT_REF}/bogus`,
    'GET',
    // deno-lint-ignore no-explicit-any
    mock.pool as any,
    11,
    'g-1',
    'admin@example.com',
    fetchImpl,
  )
  assertEquals(res.status, 404)
  await res.body?.cancel()
  assertEquals(captured.length, 0)
})

// ── 405 on wrong method ────────────────────────────────────

Deno.test('handleProjectPgMeta PATCH /query returns 405', async () => {
  setTrafficEnv()
  const mock = createMockPool({
    memberProject: baseProjectRow(),
    secrets: DEFAULT_SECRETS,
  })
  const { fetchImpl, captured } = createFakeFetch(() => new Response('{}', { status: 200 }))

  const res = await handleProjectPgMeta(
    makeReq(`/${DEFAULT_REF}/query`, 'PATCH', { query: 'select 1' }),
    `/${DEFAULT_REF}/query`,
    'PATCH',
    // deno-lint-ignore no-explicit-any
    mock.pool as any,
    11,
    'g-1',
    'admin@example.com',
    fetchImpl,
  )
  assertEquals(res.status, 405)
  await res.body?.cancel()
  assertEquals(captured.length, 0)
})

// ── 501 on missing service key ─────────────────────────────

Deno.test(
  'handleProjectPgMeta returns 501 when per-project backend lacks service key',
  async () => {
    setTrafficEnv()
    const perProject = baseProjectRow({
      endpoint: 'https://tenant-b.supabase.example.com',
      service_key_secret_id: null,
    })
    const mock = createMockPool({ memberProject: perProject })
    const { fetchImpl, captured } = createFakeFetch(() => new Response('{}', { status: 200 }))
    const res = await handleProjectPgMeta(
      makeReq(`/${DEFAULT_REF}/query`, 'POST', { query: 'select 1' }),
      `/${DEFAULT_REF}/query`,
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
    assertEquals(body.code, 'project_backend_not_provisioned')
    assert(Array.isArray(body.missing) && body.missing.includes('service_key'))
    assertEquals(captured.length, 0)
  },
)
