import { assert, assertEquals, assertRejects } from 'jsr:@std/assert@1'

import 'jsr:@std/dotenv/load'

import {
  type BackendPool,
  type BackendPoolConnection,
  fetchProjectJson,
  getProjectBackend,
  isSharedStack,
  type ProjectBackend,
  ProjectBackendNotProvisionedError,
} from '../../functions/services/project-backend.service.ts'

// ─────────────────────────────────────────────────────────────
// Env helpers
//
// The resolver reads many env vars. Tests must isolate against
// `tests/.env` bleed-through by saving + restoring per case.
// ─────────────────────────────────────────────────────────────

const ENV_KEYS = [
  'SUPABASE_URL',
  'SUPABASE_ANON_KEY',
  'SUPABASE_SERVICE_ROLE_KEY',
  'SUPABASE_SECRET_KEY',
  'SUPABASE_SERVICE_KEY',
  'SUPABASE_DB_URL',
  'SUPABASE_PUBLIC_DB_HOST',
  'POSTGRES_HOST',
  'POSTGRES_PORT',
  'POSTGRES_USER',
  'POSTGRES_PASSWORD',
  'POSTGRES_DB',
  'PG_META_URL',
  'LOGFLARE_URL',
  'LOGFLARE_PRIVATE_ACCESS_TOKEN',
] as const

function snapshotEnv(): Map<(typeof ENV_KEYS)[number], string | undefined> {
  const snap = new Map<(typeof ENV_KEYS)[number], string | undefined>()
  for (const key of ENV_KEYS) snap.set(key, Deno.env.get(key))
  return snap
}

function restoreEnv(snap: Map<(typeof ENV_KEYS)[number], string | undefined>) {
  for (const [key, value] of snap) {
    if (value === undefined) {
      Deno.env.delete(key)
    } else {
      Deno.env.set(key, value)
    }
  }
}

function setEnv(values: Partial<Record<(typeof ENV_KEYS)[number], string>>) {
  for (const key of ENV_KEYS) {
    const v = values[key]
    if (v === undefined) {
      Deno.env.delete(key)
    } else {
      Deno.env.set(key, v)
    }
  }
}

// ─────────────────────────────────────────────────────────────
// Mock pool
//
// `getProjectBackend` calls `connect()` once, then fires at most three
// queries (project row + up to three Vault decrypts). The mock records
// every query so tests can assert e.g. "no Vault query was issued when
// the UUID column was NULL".
// ─────────────────────────────────────────────────────────────

interface QueryCall {
  sql: string
  values: unknown[]
  returned: unknown[]
}

function mockPool(options: {
  projectRow?: Record<string, unknown> | null
  secrets?: Record<string, string>
}): { pool: BackendPool; calls: QueryCall[]; released: number } {
  const calls: QueryCall[] = []
  let released = 0
  const connection: BackendPoolConnection = {
    queryObject<T>(
      strings: TemplateStringsArray,
      ...values: unknown[]
    ): Promise<{ rows: T[] }> {
      const sql = strings.join('?')
      let rows: unknown[] = []
      if (/FROM traffic\.projects/i.test(sql)) {
        rows = options.projectRow ? [options.projectRow] : []
      } else if (/FROM vault\.decrypted_secrets/i.test(sql)) {
        const secretId = values[0] as string | null | undefined
        if (secretId && options.secrets && options.secrets[secretId]) {
          rows = [{ decrypted_secret: options.secrets[secretId] }]
        } else {
          rows = []
        }
      }
      calls.push({ sql, values, returned: rows })
      return Promise.resolve({ rows: rows as T[] })
    },
    release() {
      released += 1
    },
  }
  return {
    pool: {
      connect() {
        return Promise.resolve(connection)
      },
    },
    calls,
    get released() {
      return released
    },
  } as { pool: BackendPool; calls: QueryCall[]; released: number }
}

// ─────────────────────────────────────────────────────────────
// Test cases
// ─────────────────────────────────────────────────────────────

Deno.test('getProjectBackend: throws when project row is missing', async () => {
  const snap = snapshotEnv()
  try {
    setEnv({
      SUPABASE_URL: 'http://kong:8000',
      SUPABASE_SERVICE_ROLE_KEY: 'svc-key-env',
    })
    const { pool, calls } = mockPool({ projectRow: null })

    await assertRejects(
      () => getProjectBackend('missing-ref', pool),
      ProjectBackendNotProvisionedError,
      'missing: project_row',
    )
    // Exactly one SQL call: the row lookup. No Vault calls when the row is absent.
    assertEquals(calls.length, 1)
    assert(/FROM traffic\.projects/i.test(calls[0].sql))
  } finally {
    restoreEnv(snap)
  }
})

Deno.test(
  'getProjectBackend: returns shared-stack URLs when endpoint matches SUPABASE_URL',
  async () => {
    const snap = snapshotEnv()
    try {
      setEnv({
        SUPABASE_URL: 'http://kong:8000',
        SUPABASE_ANON_KEY: 'anon-env',
        SUPABASE_SERVICE_ROLE_KEY: 'svc-env',
        POSTGRES_HOST: 'db',
        POSTGRES_PORT: '5432',
        POSTGRES_USER: 'postgres',
        POSTGRES_PASSWORD: 'pg-env',
        POSTGRES_DB: 'postgres',
        PG_META_URL: 'http://meta:8080',
        LOGFLARE_URL: 'http://analytics:4000',
        LOGFLARE_PRIVATE_ACCESS_TOKEN: 'lf-token-env',
      })
      const { pool } = mockPool({
        projectRow: {
          ref: 'abc123',
          endpoint: 'http://kong:8000',
          anon_key: 'anon-row',
          db_host: 'db',
          service_key_secret_id: null,
          db_pass_secret_id: null,
          connection_string_secret_id: null,
        },
      })

      const backend = await getProjectBackend('abc123', pool)
      assertEquals(backend.ref, 'abc123')
      assertEquals(backend.endpoint, 'http://kong:8000')
      assertEquals(backend.anonKey, 'anon-row')
      // Service key fell back to env because the row's secret id was null.
      assertEquals(backend.serviceKey, 'svc-env')
      // Shared-stack branch must use env URLs, not composed ones.
      assertEquals(backend.pgMetaUrl, 'http://meta:8080')
      assertEquals(backend.logflareUrl, 'http://analytics:4000')
      assertEquals(backend.logflareToken, 'lf-token-env')
      assertEquals(backend.dbHost, 'db')
      assertEquals(backend.dbPort, 5432)
      assertEquals(backend.dbUser, 'postgres')
      assertEquals(backend.dbPass, 'pg-env')
      assertEquals(backend.dbName, 'postgres')
      assertEquals(
        backend.connectionString,
        'postgresql://postgres:pg-env@db:5432/postgres',
      )
      assertEquals(backend.functionsApiUrl, 'http://kong:8000/functions/v1')
    } finally {
      restoreEnv(snap)
    }
  },
)

Deno.test(
  'getProjectBackend: composes per-project URLs when endpoint differs from shared',
  async () => {
    const snap = snapshotEnv()
    try {
      setEnv({
        SUPABASE_URL: 'http://kong:8000',
        SUPABASE_ANON_KEY: 'anon-env',
        SUPABASE_SERVICE_ROLE_KEY: 'svc-env',
        PG_META_URL: 'http://meta:8080',
        LOGFLARE_URL: 'http://analytics:4000',
      })
      const { pool, calls } = mockPool({
        projectRow: {
          ref: 'def456',
          endpoint: 'https://def456.supabase.example.com',
          anon_key: 'anon-proj',
          db_host: 'db-def456.example.internal',
          service_key_secret_id: '11111111-1111-1111-1111-111111111111',
          db_pass_secret_id: '22222222-2222-2222-2222-222222222222',
          connection_string_secret_id: '33333333-3333-3333-3333-333333333333',
        },
        secrets: {
          '11111111-1111-1111-1111-111111111111': 'svc-row-secret',
          '22222222-2222-2222-2222-222222222222': 'pg-row-secret',
          '33333333-3333-3333-3333-333333333333':
            'postgresql://postgres:pg-row-secret@db-def456.example.internal:5432/postgres',
        },
      })

      const backend = await getProjectBackend('def456', pool)
      assertEquals(backend.endpoint, 'https://def456.supabase.example.com')
      assertEquals(backend.anonKey, 'anon-proj')
      assertEquals(backend.serviceKey, 'svc-row-secret')
      assertEquals(backend.dbHost, 'db-def456.example.internal')
      assertEquals(backend.dbPass, 'pg-row-secret')
      assertEquals(
        backend.connectionString,
        'postgresql://postgres:pg-row-secret@db-def456.example.internal:5432/postgres',
      )
      // Per-project branch must compose URLs off the endpoint, ignoring env.
      assertEquals(
        backend.pgMetaUrl,
        'https://def456.supabase.example.com/pg-meta/v1',
      )
      assertEquals(
        backend.logflareUrl,
        'https://def456.supabase.example.com/analytics/v1',
      )
      assertEquals(
        backend.functionsApiUrl,
        'https://def456.supabase.example.com/functions/v1',
      )

      // Exactly 4 queries: row + 3 Vault decrypts.
      assertEquals(calls.length, 4)
      assert(/FROM traffic\.projects/i.test(calls[0].sql))
      for (let i = 1; i <= 3; i++) {
        assert(/FROM vault\.decrypted_secrets/i.test(calls[i].sql))
      }
    } finally {
      restoreEnv(snap)
    }
  },
)

Deno.test(
  'getProjectBackend: skips Vault reads when all *_secret_id columns are NULL',
  async () => {
    const snap = snapshotEnv()
    try {
      setEnv({
        SUPABASE_URL: 'http://kong:8000',
        SUPABASE_SERVICE_ROLE_KEY: 'svc-env',
      })
      const { pool, calls } = mockPool({
        projectRow: {
          ref: 'null-secrets',
          endpoint: 'http://kong:8000',
          anon_key: 'anon',
          db_host: 'db',
          service_key_secret_id: null,
          db_pass_secret_id: null,
          connection_string_secret_id: null,
        },
      })

      const backend = await getProjectBackend('null-secrets', pool)
      assertEquals(backend.serviceKey, 'svc-env')
      // No Vault reads were issued — critical because `vault.decrypted_secrets`
      // in production requires secrets to be unwrapped on each select and we
      // don't want to pay that cost when the column is NULL.
      const vaultCalls = calls.filter((c) => /FROM vault\.decrypted_secrets/i.test(c.sql))
      assertEquals(vaultCalls.length, 0)
    } finally {
      restoreEnv(snap)
    }
  },
)

Deno.test(
  'getProjectBackend: prefers legacy SUPABASE_SERVICE_KEY fallback when ROLE_KEY absent',
  async () => {
    const snap = snapshotEnv()
    try {
      setEnv({
        SUPABASE_URL: 'http://kong:8000',
        SUPABASE_SERVICE_KEY: 'svc-legacy',
      })
      const { pool } = mockPool({
        projectRow: {
          ref: 'legacy',
          endpoint: 'http://kong:8000',
          anon_key: 'anon',
          db_host: 'db',
          service_key_secret_id: null,
          db_pass_secret_id: null,
          connection_string_secret_id: null,
        },
      })

      const backend = await getProjectBackend('legacy', pool)
      assertEquals(backend.serviceKey, 'svc-legacy')
    } finally {
      restoreEnv(snap)
    }
  },
)

Deno.test(
  'getProjectBackend: C2 — per-project endpoint without vault service key throws missing: service_key',
  async () => {
    // C2 regression: when `endpoint` points at a per-project backend the
    // resolver MUST NOT fall back to the platform-global
    // `SUPABASE_SERVICE_ROLE_KEY`. Doing so would sign outbound calls to
    // tenant B with tenant A's (or the shared platform's) service_role.
    const snap = snapshotEnv()
    try {
      setEnv({
        SUPABASE_URL: 'http://kong:8000',
        SUPABASE_ANON_KEY: 'anon-env',
        SUPABASE_SERVICE_ROLE_KEY: 'svc-env',
      })
      const { pool } = mockPool({
        projectRow: {
          ref: 'per-project',
          endpoint: 'https://per-project.supabase.example.com',
          anon_key: 'anon-proj',
          db_host: 'db',
          service_key_secret_id: null,
          db_pass_secret_id: null,
          connection_string_secret_id: null,
        },
      })
      await assertRejects(
        () => getProjectBackend('per-project', pool),
        ProjectBackendNotProvisionedError,
        'service_key',
      )
    } finally {
      restoreEnv(snap)
    }
  },
)

Deno.test(
  'getProjectBackend: C2 — per-project endpoint returns empty anon when row anon_key is NULL',
  async () => {
    // C2: shared `SUPABASE_ANON_KEY` must NOT leak into per-project backends.
    // When the project row has a per-project endpoint but no `anon_key`
    // column, the resolver returns an empty string for `anonKey` rather
    // than silently using the platform-global anon key. Handlers that
    // need the anon key (e.g. `handleRestSpec`) must either have their
    // own fallback or fail visibly.
    const snap = snapshotEnv()
    try {
      setEnv({
        SUPABASE_URL: 'http://kong:8000',
        SUPABASE_ANON_KEY: 'anon-env',
      })
      const { pool } = mockPool({
        projectRow: {
          ref: 'per-project-anon',
          endpoint: 'https://per-project.supabase.example.com',
          anon_key: null,
          db_host: 'db',
          service_key_secret_id: '11111111-1111-1111-1111-111111111111',
          db_pass_secret_id: null,
          connection_string_secret_id: null,
        },
        secrets: {
          '11111111-1111-1111-1111-111111111111': 'svc-row',
        },
      })
      const backend = await getProjectBackend('per-project-anon', pool)
      assertEquals(backend.anonKey, '')
      assertEquals(backend.serviceKey, 'svc-row')
    } finally {
      restoreEnv(snap)
    }
  },
)

Deno.test(
  'getProjectBackend: throws when endpoint and service_key cannot be resolved',
  async () => {
    const snap = snapshotEnv()
    try {
      setEnv({})
      const { pool } = mockPool({
        projectRow: {
          ref: 'unprovisioned',
          endpoint: null,
          anon_key: null,
          db_host: null,
          service_key_secret_id: null,
          db_pass_secret_id: null,
          connection_string_secret_id: null,
        },
      })

      await assertRejects(
        () => getProjectBackend('unprovisioned', pool),
        ProjectBackendNotProvisionedError,
        'missing',
      )
    } finally {
      restoreEnv(snap)
    }
  },
)

Deno.test('getProjectBackend: always releases the pool connection (even on error)', async () => {
  const snap = snapshotEnv()
  try {
    setEnv({
      SUPABASE_URL: 'http://kong:8000',
      SUPABASE_SERVICE_ROLE_KEY: 'svc',
    })
    const state = mockPool({ projectRow: null })
    await assertRejects(() => getProjectBackend('nope', state.pool))
    assertEquals(state.released, 1)
  } finally {
    restoreEnv(snap)
  }
})

Deno.test(
  'getProjectBackend: parses SUPABASE_DB_URL for db components when POSTGRES_* are absent',
  async () => {
    // The supabase/docker-compose.yml `functions` service only exposes
    // SUPABASE_DB_URL to the edge runtime (not the individual POSTGRES_* vars
    // they're composed from). JIT DDL and db-password rotation both need a
    // resolvable superuser connection string, so the resolver must be able to
    // reconstruct dbHost / dbPort / dbUser / dbPass / dbName from the URL.
    const snap = snapshotEnv()
    try {
      setEnv({
        SUPABASE_URL: 'http://kong:8000',
        SUPABASE_SERVICE_ROLE_KEY: 'svc',
        SUPABASE_DB_URL: 'postgresql://postgres:pg-url-pass@db:5432/postgres',
      })
      const { pool } = mockPool({
        projectRow: {
          ref: 'db-url',
          endpoint: 'http://kong:8000',
          anon_key: 'a',
          db_host: null,
          service_key_secret_id: null,
          db_pass_secret_id: null,
          connection_string_secret_id: null,
        },
      })
      const backend = await getProjectBackend('db-url', pool)
      assertEquals(backend.dbHost, 'db')
      assertEquals(backend.dbPort, 5432)
      assertEquals(backend.dbUser, 'postgres')
      assertEquals(backend.dbPass, 'pg-url-pass')
      assertEquals(backend.dbName, 'postgres')
      assertEquals(
        backend.connectionString,
        'postgresql://postgres:pg-url-pass@db:5432/postgres',
      )
    } finally {
      restoreEnv(snap)
    }
  },
)

Deno.test(
  'getProjectBackend: POSTGRES_* env takes precedence over SUPABASE_DB_URL parse',
  async () => {
    const snap = snapshotEnv()
    try {
      setEnv({
        SUPABASE_URL: 'http://kong:8000',
        SUPABASE_SERVICE_ROLE_KEY: 'svc',
        SUPABASE_DB_URL: 'postgresql://postgres:pg-url-pass@db:5432/postgres',
        POSTGRES_PASSWORD: 'pg-explicit',
      })
      const { pool } = mockPool({
        projectRow: {
          ref: 'explicit',
          endpoint: 'http://kong:8000',
          anon_key: 'a',
          db_host: null,
          service_key_secret_id: null,
          db_pass_secret_id: null,
          connection_string_secret_id: null,
        },
      })
      const backend = await getProjectBackend('explicit', pool)
      // Explicit POSTGRES_PASSWORD wins over the parsed URL password.
      assertEquals(backend.dbPass, 'pg-explicit')
    } finally {
      restoreEnv(snap)
    }
  },
)

Deno.test(
  'getProjectBackend: falls back to built connection string when vault conn has empty password',
  async () => {
    // Some tenants were provisioned with placeholder conn_string vault
    // secrets whose password component is blank (e.g. after a DB reset).
    // Attempting to pool against such a string trips postgres-deno's
    // "Attempting SASL auth with unset password" at connect time — so the
    // resolver must prefer the per-component build whenever the vault
    // value lacks a password.
    const snap = snapshotEnv()
    try {
      setEnv({
        SUPABASE_URL: 'http://kong:8000',
        SUPABASE_SERVICE_ROLE_KEY: 'svc',
        SUPABASE_DB_URL: 'postgresql://postgres:pg-url-pass@db:5432/postgres',
      })
      const { pool } = mockPool({
        projectRow: {
          ref: 'empty-conn',
          endpoint: 'http://kong:8000',
          anon_key: 'a',
          db_host: null,
          service_key_secret_id: null,
          db_pass_secret_id: null,
          connection_string_secret_id: 'aaaaaaaa-aaaa-aaaa-aaaa-aaaaaaaaaaaa',
        },
        secrets: {
          'aaaaaaaa-aaaa-aaaa-aaaa-aaaaaaaaaaaa': 'postgresql://postgres:@db:5432/postgres',
        },
      })
      const backend = await getProjectBackend('empty-conn', pool)
      assertEquals(
        backend.connectionString,
        'postgresql://postgres:pg-url-pass@db:5432/postgres',
      )
    } finally {
      restoreEnv(snap)
    }
  },
)

Deno.test(
  'getProjectBackend: prefers vault connection string when it carries a password',
  async () => {
    const snap = snapshotEnv()
    try {
      setEnv({
        SUPABASE_URL: 'http://kong:8000',
        SUPABASE_SERVICE_ROLE_KEY: 'svc',
        SUPABASE_DB_URL: 'postgresql://postgres:pg-url-pass@db:5432/postgres',
      })
      const { pool } = mockPool({
        projectRow: {
          ref: 'vault-conn',
          endpoint: 'http://kong:8000',
          anon_key: 'a',
          db_host: null,
          service_key_secret_id: null,
          db_pass_secret_id: null,
          connection_string_secret_id: 'bbbbbbbb-bbbb-bbbb-bbbb-bbbbbbbbbbbb',
        },
        secrets: {
          'bbbbbbbb-bbbb-bbbb-bbbb-bbbbbbbbbbbb':
            'postgresql://postgres:vault-pw@vault-host:6543/vault-db',
        },
      })
      const backend = await getProjectBackend('vault-conn', pool)
      assertEquals(
        backend.connectionString,
        'postgresql://postgres:vault-pw@vault-host:6543/vault-db',
      )
    } finally {
      restoreEnv(snap)
    }
  },
)

Deno.test(
  'getProjectBackend: externalDbHost falls back to dbHost when SUPABASE_PUBLIC_DB_HOST is unset',
  async () => {
    // Production single-stack default: in-container DDL pools and any DSN
    // we hand back to API clients all point at the same internal `db`
    // host. Setting an external override is opt-in.
    const snap = snapshotEnv()
    try {
      setEnv({
        SUPABASE_URL: 'http://kong:8000',
        SUPABASE_SERVICE_ROLE_KEY: 'svc',
        POSTGRES_HOST: 'db',
        POSTGRES_PASSWORD: 'pg-env',
      })
      const { pool } = mockPool({
        projectRow: {
          ref: 'ext-default',
          endpoint: 'http://kong:8000',
          anon_key: 'a',
          db_host: 'db',
          service_key_secret_id: null,
          db_pass_secret_id: null,
          connection_string_secret_id: null,
        },
      })
      const backend = await getProjectBackend('ext-default', pool)
      assertEquals(backend.dbHost, 'db')
      assertEquals(backend.externalDbHost, 'db')
    } finally {
      restoreEnv(snap)
    }
  },
)

Deno.test(
  'getProjectBackend: SUPABASE_PUBLIC_DB_HOST overrides externalDbHost without touching dbHost',
  async () => {
    // Local-dev / cloud override path. JIT `connection_string` builders
    // and any future external clients should see the externally
    // resolvable host while in-container pools keep talking to the
    // internal `db` hostname.
    const snap = snapshotEnv()
    try {
      setEnv({
        SUPABASE_URL: 'http://kong:8000',
        SUPABASE_SERVICE_ROLE_KEY: 'svc',
        POSTGRES_HOST: 'db',
        POSTGRES_PASSWORD: 'pg-env',
        SUPABASE_PUBLIC_DB_HOST: '127.0.0.1',
      })
      const { pool } = mockPool({
        projectRow: {
          ref: 'ext-override',
          endpoint: 'http://kong:8000',
          anon_key: 'a',
          db_host: 'db',
          service_key_secret_id: null,
          db_pass_secret_id: null,
          connection_string_secret_id: null,
        },
      })
      const backend = await getProjectBackend('ext-override', pool)
      // Internal host stays put — `withProjectPool` and `createPostgresRole`
      // still reach the DB through the docker network.
      assertEquals(backend.dbHost, 'db')
      // External callers (JIT DSN, future cloud clients) get the
      // tunnellable host instead.
      assertEquals(backend.externalDbHost, '127.0.0.1')
      // The internal `connectionString` is unaffected — it's used for the
      // in-container superuser pool that performs DDL, so it must keep
      // pointing at the docker hostname.
      assertEquals(
        backend.connectionString,
        'postgresql://postgres:pg-env@db:5432/postgres',
      )
    } finally {
      restoreEnv(snap)
    }
  },
)

Deno.test(
  'getProjectBackend: trailing slash on endpoint is normalized when comparing to shared',
  async () => {
    const snap = snapshotEnv()
    try {
      setEnv({
        SUPABASE_URL: 'http://kong:8000',
        SUPABASE_SERVICE_ROLE_KEY: 'svc',
      })
      const { pool } = mockPool({
        projectRow: {
          ref: 'trailing',
          endpoint: 'http://kong:8000/',
          anon_key: 'a',
          db_host: 'db',
          service_key_secret_id: null,
          db_pass_secret_id: null,
          connection_string_secret_id: null,
        },
      })
      const backend = await getProjectBackend('trailing', pool)
      // Should detect shared-stack mode despite the trailing slash.
      assertEquals(backend.pgMetaUrl, 'http://meta:8080')
    } finally {
      restoreEnv(snap)
    }
  },
)

// ── fetchProjectJson ─────────────────────────────────────────

function makeBackend(overrides: Partial<ProjectBackend> = {}): ProjectBackend {
  return {
    ref: 'ref',
    endpoint: 'https://example.com',
    anonKey: 'anon',
    serviceKey: 'svc',
    pgMetaUrl: 'https://example.com/pg-meta/v1',
    logflareUrl: 'https://example.com/analytics/v1',
    logflareToken: 'lf',
    dbHost: 'db',
    externalDbHost: 'db',
    dbPort: 5432,
    dbUser: 'postgres',
    dbPass: 'pw',
    dbName: 'postgres',
    connectionString: 'postgresql://postgres:pw@db:5432/postgres',
    functionsApiUrl: 'https://example.com/functions/v1',
    ...overrides,
  }
}

Deno.test('fetchProjectJson: signs with Authorization + apikey + JSON content-type', async () => {
  const backend = makeBackend()
  let capturedUrl = ''
  let capturedHeaders: Headers | undefined
  const fakeFetch: typeof fetch = (input, init) => {
    capturedUrl = String(input)
    capturedHeaders = new Headers(
      (init as RequestInit | undefined)?.headers ?? {},
    )
    return Promise.resolve(new Response('{}', { status: 200 }))
  }
  await fetchProjectJson(backend, '/auth/v1/admin/users', {
    method: 'POST',
    body: '{}',
  }, fakeFetch)
  assertEquals(capturedUrl, 'https://example.com/auth/v1/admin/users')
  assertEquals(capturedHeaders?.get('Authorization'), 'Bearer svc')
  assertEquals(capturedHeaders?.get('apikey'), 'svc')
  assertEquals(capturedHeaders?.get('Content-Type'), 'application/json')
})

Deno.test('fetchProjectJson: normalizes trailing slash in endpoint', async () => {
  const backend = makeBackend({ endpoint: 'https://example.com/' })
  let url = ''
  const fakeFetch: typeof fetch = (input) => {
    url = String(input)
    return Promise.resolve(new Response(null, { status: 204 }))
  }
  await fetchProjectJson(backend, '/rest/v1/x', {}, fakeFetch)
  assertEquals(url, 'https://example.com/rest/v1/x')
})

Deno.test(
  'fetchProjectJson: does not override caller-supplied Authorization / Content-Type',
  async () => {
    const backend = makeBackend()
    let headers: Headers | undefined
    const fakeFetch: typeof fetch = (_input, init) => {
      headers = new Headers((init as RequestInit | undefined)?.headers ?? {})
      return Promise.resolve(new Response('{}'))
    }
    await fetchProjectJson(
      backend,
      '/foo',
      {
        method: 'POST',
        body: 'raw',
        headers: {
          Authorization: 'Bearer user-scoped',
          'Content-Type': 'text/plain',
        },
      },
      fakeFetch,
    )
    assertEquals(headers?.get('Authorization'), 'Bearer user-scoped')
    assertEquals(headers?.get('Content-Type'), 'text/plain')
    // apikey still gets injected because the caller didn't provide one.
    assertEquals(headers?.get('apikey'), 'svc')
  },
)

Deno.test('fetchProjectJson: throws when path does not start with /', async () => {
  const backend = makeBackend()
  await assertRejects(
    () => fetchProjectJson(backend, 'no-slash'),
    Error,
    "path must start with '/'",
  )
})

// ── isSharedStack ────────────────────────────────────────────
//
// L1: these cases pin the resolver ↔ isSharedStack contract. The edge
// function mutation dispatcher picks its branch (local filesystem write
// vs. HTTP proxy) off this helper, so any divergence from
// `isPerProjectBackend` causes confusing local-dev failures when
// operators forget to set SUPABASE_URL.

Deno.test('isSharedStack: matching endpoint + SUPABASE_URL -> true', () => {
  const snap = snapshotEnv()
  try {
    setEnv({ SUPABASE_URL: 'http://kong:8000' })
    assertEquals(
      isSharedStack(makeBackend({ endpoint: 'http://kong:8000' })),
      true,
    )
  } finally {
    restoreEnv(snap)
  }
})

Deno.test('isSharedStack: trailing slash on either side -> true', () => {
  const snap = snapshotEnv()
  try {
    setEnv({ SUPABASE_URL: 'http://kong:8000/' })
    assertEquals(
      isSharedStack(makeBackend({ endpoint: 'http://kong:8000' })),
      true,
    )
  } finally {
    restoreEnv(snap)
  }
})

Deno.test('isSharedStack: distinct per-project endpoint -> false', () => {
  const snap = snapshotEnv()
  try {
    setEnv({ SUPABASE_URL: 'http://kong:8000' })
    assertEquals(
      isSharedStack(makeBackend({ endpoint: 'http://tenant.fly.dev' })),
      false,
    )
  } finally {
    restoreEnv(snap)
  }
})

Deno.test('isSharedStack: row endpoint set, SUPABASE_URL blank -> false (per-project)', () => {
  const snap = snapshotEnv()
  try {
    setEnv({}) // deletes SUPABASE_URL
    assertEquals(
      isSharedStack(makeBackend({ endpoint: 'http://tenant.fly.dev' })),
      false,
    )
  } finally {
    restoreEnv(snap)
  }
})

Deno.test(
  'isSharedStack (L1): empty endpoint + blank SUPABASE_URL -> true (shared fallback)',
  () => {
    const snap = snapshotEnv()
    try {
      setEnv({})
      // Simulates the state `getProjectBackend` leaves behind when
      // row.endpoint is NULL and SUPABASE_URL is unset: endpoint = ''.
      // Prior to L1 this returned false, which forced
      // edge-function-mutations down the HTTP-proxy branch. Now we
      // return true so the filesystem-write branch is taken — matching
      // `isPerProjectBackend('')` = false.
      assertEquals(isSharedStack(makeBackend({ endpoint: '' })), true)
    } finally {
      restoreEnv(snap)
    }
  },
)
