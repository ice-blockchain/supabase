import { assert, assertEquals } from 'jsr:@std/assert@1'

import 'jsr:@std/dotenv/load'

import { createRetryingPool } from '../_helpers/pool.ts'
import {
  applyConfigPatch,
  type FetchLike,
  fetchLiveSettings,
  getDefaultConfig,
  getMergedConfig,
  getOverrides,
  isSecretField,
  pushLiveConfig,
  upsertOverrides,
} from '../../functions/services/gotrue-admin.service.ts'
import type { ProjectBackend } from '../../functions/services/project-backend.service.ts'

const pool = createRetryingPool(Deno.env.get('TRAFFIC_DB_URL')!)

function freshRef(suffix: string): string {
  return `test-gac-${suffix}-${crypto.randomUUID().slice(0, 8)}`
}

// Per-test projection of ProjectBackend — only the fields the admin-service
// functions actually touch (endpoint + serviceKey + ref). Everything else is
// filled with benign values so the type-checker is satisfied without pulling
// in a real DB row.
function fakeBackend(
  ref: string,
  overrides: Partial<ProjectBackend> = {},
): ProjectBackend {
  return {
    ref,
    endpoint: 'http://gotrue-admin.test',
    anonKey: 'anon-key',
    serviceKey: 'service-key',
    pgMetaUrl: 'http://meta.test',
    logflareUrl: 'http://logflare.test',
    logflareToken: '',
    dbHost: 'db',
    externalDbHost: 'db',
    dbPort: 5432,
    dbUser: 'postgres',
    dbPass: 'pg',
    dbName: 'postgres',
    connectionString: 'postgresql://postgres:pg@db:5432/postgres',
    functionsApiUrl: 'http://functions.test/functions/v1',
    ...overrides,
  }
}

async function cleanupOverrides(projectRef: string) {
  await pool.withConnection(async (connection) => {
    await connection.queryObject`
      DELETE FROM traffic.auth_config_overrides WHERE project_ref = ${projectRef}
    `
  })
}

async function countOverrides(projectRef: string): Promise<number> {
  return await pool.withConnection(async (connection) => {
    const res = await connection.queryObject<{ count: number }>`
      SELECT COUNT(*)::int AS count FROM traffic.auth_config_overrides
      WHERE project_ref = ${projectRef}
    `
    return res.rows[0].count
  })
}

// ── Pure functions ───────────────────────────────────────

Deno.test('getDefaultConfig returns expected keys with typed defaults', () => {
  const defaults = getDefaultConfig()

  assertEquals(typeof defaults.SITE_URL, 'string')
  assertEquals(typeof defaults.URI_ALLOW_LIST, 'string')
  assertEquals(typeof defaults.JWT_EXP, 'number')
  assertEquals(typeof defaults.DISABLE_SIGNUP, 'boolean')
  assertEquals(typeof defaults.MAILER_AUTOCONFIRM, 'boolean')
  assertEquals(typeof defaults.MAILER_OTP_EXP, 'number')
  assertEquals(typeof defaults.MAILER_OTP_LENGTH, 'number')
  assertEquals(typeof defaults.SMTP_ADMIN_EMAIL, 'string')
  assertEquals(typeof defaults.SMTP_HOST, 'string')
  assertEquals(typeof defaults.SMTP_PORT, 'string')
  assertEquals(typeof defaults.SMTP_USER, 'string')
  assertEquals(typeof defaults.SMTP_PASS, 'string')
  assertEquals(typeof defaults.SMTP_SENDER_NAME, 'string')
  assertEquals(typeof defaults.SMTP_MAX_FREQUENCY, 'number')
  assertEquals(typeof defaults.EXTERNAL_EMAIL_ENABLED, 'boolean')
  assertEquals(typeof defaults.EXTERNAL_PHONE_ENABLED, 'boolean')
  assertEquals(typeof defaults.EXTERNAL_ANONYMOUS_USERS_ENABLED, 'boolean')
  assertEquals(typeof defaults.EXTERNAL_GITHUB_ENABLED, 'boolean')
  assertEquals(typeof defaults.EXTERNAL_GITHUB_CLIENT_ID, 'string')
  assertEquals(typeof defaults.EXTERNAL_GITHUB_SECRET, 'string')
  assertEquals(typeof defaults.RATE_LIMIT_EMAIL_SENT, 'number')
  assertEquals(typeof defaults.RATE_LIMIT_SMS_SENT, 'number')
  assertEquals(typeof defaults.RATE_LIMIT_TOKEN_REFRESH, 'number')
  assertEquals(typeof defaults.PASSWORD_MIN_LENGTH, 'number')
  assertEquals(typeof defaults.PASSWORD_REQUIRED_CHARACTERS, 'string')
  assertEquals(typeof defaults.HOOK_CUSTOM_ACCESS_TOKEN_ENABLED, 'boolean')
  assertEquals(typeof defaults.HOOK_CUSTOM_ACCESS_TOKEN_URI, 'string')
  assertEquals(typeof defaults.HOOK_CUSTOM_ACCESS_TOKEN_SECRETS, 'string')
  assertEquals(typeof defaults.HOOK_SEND_EMAIL_ENABLED, 'boolean')
  assertEquals(typeof defaults.HOOK_SEND_SMS_ENABLED, 'boolean')
  assertEquals(typeof defaults.MAILER_TEMPLATES_INVITE_CONTENT, 'string')
  assertEquals(typeof defaults.MAILER_TEMPLATES_CONFIRMATION_CONTENT, 'string')
  assertEquals(typeof defaults.MAILER_TEMPLATES_RECOVERY_CONTENT, 'string')
  assertEquals(typeof defaults.SECURITY_CAPTCHA_ENABLED, 'boolean')
  assertEquals(typeof defaults.SECURITY_CAPTCHA_PROVIDER, 'string')
  assertEquals(typeof defaults.SECURITY_CAPTCHA_SECRET, 'string')
})

Deno.test('isSecretField flags secrets by suffix and explicit list', () => {
  assertEquals(isSecretField('SMTP_PASS'), true)
  assertEquals(isSecretField('SECURITY_CAPTCHA_SECRET'), true)
  assertEquals(isSecretField('EXTERNAL_GITHUB_SECRET'), true)
  assertEquals(isSecretField('HOOK_CUSTOM_ACCESS_TOKEN_SECRETS'), true)
  assertEquals(isSecretField('SMS_TWILIO_AUTH_TOKEN'), true)
  assertEquals(isSecretField('SMS_MESSAGEBIRD_ACCESS_KEY'), true)
  assertEquals(isSecretField('NIMBUS_OAUTH_CLIENT_SECRET'), true)

  assertEquals(isSecretField('SITE_URL'), false)
  assertEquals(isSecretField('JWT_EXP'), false)
  assertEquals(isSecretField('DISABLE_SIGNUP'), false)
  assertEquals(isSecretField('EXTERNAL_GITHUB_CLIENT_ID'), false)
  assertEquals(isSecretField('MAILER_SUBJECTS_CONFIRMATION'), false)
})

// ── DB-touching ─────────────────────────────────────────

Deno.test('getOverrides returns {} for a project with no rows', async () => {
  const ref = freshRef('empty')
  try {
    const result = await getOverrides(pool, ref)
    assertEquals(result, {})
  } finally {
    await cleanupOverrides(ref)
  }
})

Deno.test('upsertOverrides + getOverrides round-trip for mixed value types', async () => {
  const ref = freshRef('round-trip')
  try {
    await upsertOverrides(
      pool,
      ref,
      {
        SITE_URL: 'https://round-trip.example.com',
        JWT_EXP: 7200,
        DISABLE_SIGNUP: true,
        EXTERNAL_GITHUB_ENABLED: false,
        RATE_LIMIT_EMAIL_SENT: 100,
      },
      '',
      0,
    )

    const overrides = await getOverrides(pool, ref)
    assertEquals(overrides.SITE_URL, 'https://round-trip.example.com')
    assertEquals(overrides.JWT_EXP, 7200)
    assertEquals(overrides.DISABLE_SIGNUP, true)
    assertEquals(overrides.EXTERNAL_GITHUB_ENABLED, false)
    assertEquals(overrides.RATE_LIMIT_EMAIL_SENT, 100)
  } finally {
    await cleanupOverrides(ref)
  }
})

Deno.test(
  'upsertOverrides is idempotent — same key twice keeps latest value, no duplicates',
  async () => {
    const ref = freshRef('idempotent')
    try {
      await upsertOverrides(
        pool,
        ref,
        { SITE_URL: 'https://first.example.com' },
        '',
        0,
      )
      await upsertOverrides(
        pool,
        ref,
        { SITE_URL: 'https://second.example.com' },
        '',
        0,
      )

      const overrides = await getOverrides(pool, ref)
      assertEquals(overrides.SITE_URL, 'https://second.example.com')

      const count = await countOverrides(ref)
      assertEquals(count, 1)
    } finally {
      await cleanupOverrides(ref)
    }
  },
)

// A fetch that always 404s — lets getMergedConfig tests ignore live settings
// without hitting GoTrue (and without a real network call).
const fetchAlways404: FetchLike = () => Promise.resolve(new Response('not found', { status: 404 }))

Deno.test('getMergedConfig layers overrides on top of defaults', async () => {
  const ref = freshRef('merge')
  try {
    await upsertOverrides(
      pool,
      ref,
      { SITE_URL: 'https://merged.example.com', DISABLE_SIGNUP: true },
      '',
      0,
    )

    const defaults = getDefaultConfig()
    const merged = await getMergedConfig(
      pool,
      fakeBackend(ref),
      fetchAlways404,
    )

    assertEquals(merged.SITE_URL, 'https://merged.example.com')
    assertEquals(merged.DISABLE_SIGNUP, true)
    assertEquals(merged.JWT_EXP, defaults.JWT_EXP)
    assertEquals(
      merged.EXTERNAL_EMAIL_ENABLED,
      defaults.EXTERNAL_EMAIL_ENABLED,
    )

    assert(Object.keys(merged).length >= Object.keys(defaults).length)
  } finally {
    await cleanupOverrides(ref)
  }
})

Deno.test('getMergedConfig redacts secret fields', async () => {
  const ref = freshRef('redact')
  try {
    await upsertOverrides(
      pool,
      ref,
      {
        SMTP_PASS: 'plaintext-smtp-pw',
        SECURITY_CAPTCHA_SECRET: 'plaintext-captcha-secret',
        EXTERNAL_APPLE_SECRET: 'plaintext-apple-secret',
        HOOK_SEND_EMAIL_SECRETS: 'plaintext-hook-secret',
      },
      '',
      0,
    )

    const merged = await getMergedConfig(
      pool,
      fakeBackend(ref),
      fetchAlways404,
    )
    assertEquals(merged.SMTP_PASS, '***')
    assertEquals(merged.SECURITY_CAPTCHA_SECRET, '***')
    assertEquals(merged.EXTERNAL_APPLE_SECRET, '***')
    assertEquals(merged.HOOK_SEND_EMAIL_SECRETS, '***')

    const raw = await getOverrides(pool, ref)
    assertEquals(raw.SMTP_PASS, 'plaintext-smtp-pw')
    assertEquals(raw.SECURITY_CAPTCHA_SECRET, 'plaintext-captcha-secret')
  } finally {
    await cleanupOverrides(ref)
  }
})

// L9: The `buildServiceRoleJwt` tests were removed together with the helper
// itself. The helper was unused in `functions/` — every production caller
// already receives a signed `service_role` key through `getProjectBackend()`.
// Keeping the tests around would only have kept the helper compilable for
// the tests themselves, so both were dropped at the same time. If we ever
// need to sign a service-role JWT from scratch again we should reach for
// `jose` (already in the import map) instead of re-adding the bespoke
// base64-url signer that used to live here.

// ── Live /admin/settings round-trip ──────────────────────

Deno.test('fetchLiveSettings returns parsed JSON on 200 with injected fetch', async () => {
  let capturedAuth = ''
  let capturedApikey = ''
  let capturedUrl: string | URL | undefined
  const fakeFetch: FetchLike = (url, init) => {
    capturedUrl = url as string | URL | undefined
    const headers = new Headers(
      (init as RequestInit | undefined)?.headers ?? {},
    )
    capturedAuth = headers.get('Authorization') ?? ''
    capturedApikey = headers.get('apikey') ?? ''
    return Promise.resolve(
      new Response(
        JSON.stringify({ SITE_URL: 'https://live.example.com', JWT_EXP: 9999 }),
        {
          status: 200,
          headers: { 'Content-Type': 'application/json' },
        },
      ),
    )
  }
  const live = await fetchLiveSettings(
    fakeBackend('ref-live', {
      endpoint: 'http://proj.test',
      serviceKey: 'proj-svc-key',
    }),
    fakeFetch,
  )
  assert(live !== null, 'expected non-null live settings')
  assertEquals(live!.SITE_URL, 'https://live.example.com')
  assertEquals(live!.JWT_EXP, 9999)
  assertEquals(capturedAuth, 'Bearer proj-svc-key')
  assertEquals(capturedApikey, 'proj-svc-key')
  assertEquals(String(capturedUrl), 'http://proj.test/auth/v1/admin/settings')
})

Deno.test('fetchLiveSettings returns null on 404 (endpoint not exposed)', async () => {
  const fakeFetch: FetchLike = () => Promise.resolve(new Response('not found', { status: 404 }))
  const live = await fetchLiveSettings(fakeBackend('ref-404'), fakeFetch)
  assertEquals(live, null)
})

Deno.test('fetchLiveSettings returns null on network error', async () => {
  const fakeFetch: FetchLike = () => Promise.reject(new Error('dns fail'))
  const live = await fetchLiveSettings(fakeBackend('ref-err'), fakeFetch)
  assertEquals(live, null)
})

Deno.test('getMergedConfig layers live over defaults, overrides over live', async () => {
  const ref = freshRef('layered')
  try {
    await upsertOverrides(
      pool,
      ref,
      { SITE_URL: 'https://override.example.com' },
      '',
      0,
    )
    const fakeFetch: FetchLike = () =>
      Promise.resolve(
        new Response(
          JSON.stringify({
            SITE_URL: 'https://live.example.com',
            URI_ALLOW_LIST: 'https://live-only.example.com',
          }),
          { status: 200, headers: { 'Content-Type': 'application/json' } },
        ),
      )

    const merged = await getMergedConfig(pool, fakeBackend(ref), fakeFetch)
    // Overrides win over live.
    assertEquals(merged.SITE_URL, 'https://override.example.com')
    // Live wins over env defaults.
    assertEquals(merged.URI_ALLOW_LIST, 'https://live-only.example.com')
  } finally {
    await cleanupOverrides(ref)
  }
})

// ── Partial-PATCH transactional semantics ────────────────

Deno.test('pushLiveConfig treats 200 + {accepted, rejected} body as authoritative', async () => {
  let capturedUrl: string | URL | undefined
  const fakeFetch: FetchLike = (url) => {
    capturedUrl = url as string | URL | undefined
    return Promise.resolve(
      new Response(
        JSON.stringify({
          accepted: ['SITE_URL'],
          rejected: ['CUSTOM_OAUTH_MAX_PROVIDERS'],
        }),
        { status: 200, headers: { 'Content-Type': 'application/json' } },
      ),
    )
  }
  const result = await pushLiveConfig(
    fakeBackend('ref-push', { endpoint: 'http://push.test' }),
    { SITE_URL: 'https://ok.example', CUSTOM_OAUTH_MAX_PROVIDERS: 5 },
    fakeFetch,
  )
  assertEquals(result.accepted, ['SITE_URL'])
  assertEquals(result.rejected, ['CUSTOM_OAUTH_MAX_PROVIDERS'])
  assertEquals(String(capturedUrl), 'http://push.test/auth/v1/admin/config')
})

Deno.test('pushLiveConfig treats 404 as "nothing accepted" (override-only path)', async () => {
  const fakeFetch: FetchLike = () => Promise.resolve(new Response('not found', { status: 404 }))
  const result = await pushLiveConfig(
    fakeBackend('ref-push-404'),
    { SITE_URL: 'https://x' },
    fakeFetch,
  )
  assertEquals(result.accepted, [])
  assertEquals(result.rejected, ['SITE_URL'])
})

Deno.test(
  'applyConfigPatch: GoTrue-rejected fields land in overrides; accepted fields do not',
  async () => {
    const ref = freshRef('partial-patch')
    try {
      const fakeFetch: FetchLike = () =>
        Promise.resolve(
          new Response(
            JSON.stringify({ accepted: ['SITE_URL'], rejected: ['JWT_EXP'] }),
            {
              status: 200,
              headers: { 'Content-Type': 'application/json' },
            },
          ),
        )
      const result = await applyConfigPatch(
        pool,
        fakeBackend(ref),
        { SITE_URL: 'https://accepted.example.com', JWT_EXP: 9001 },
        '',
        0,
        undefined,
        fakeFetch,
      )
      assertEquals(result.accepted.sort(), ['SITE_URL'])
      assertEquals(result.overridden.sort(), ['JWT_EXP'])

      const stored = await getOverrides(pool, ref)
      // Rejected field persisted...
      assertEquals(stored.JWT_EXP, 9001)
      // ...accepted field did NOT.
      assertEquals(stored.SITE_URL, undefined)
    } finally {
      await cleanupOverrides(ref)
    }
  },
)

Deno.test(
  'applyConfigPatch: bad field (live 500) leaves overrides row unchanged before retry',
  async () => {
    const ref = freshRef('bad-field-tx')
    try {
      // Pre-seed a known good override.
      await upsertOverrides(
        pool,
        ref,
        { SITE_URL: 'https://pre.example.com' },
        '',
        0,
      )

      // Live side fails entirely — every key should land in overrides.
      const failingFetch: FetchLike = () => Promise.resolve(new Response('boom', { status: 500 }))
      await applyConfigPatch(
        pool,
        fakeBackend(ref),
        { SITE_URL: 'https://after.example.com', JWT_EXP: 7200 },
        '',
        0,
        undefined,
        failingFetch,
      )

      const after = await getOverrides(pool, ref)
      assertEquals(after.SITE_URL, 'https://after.example.com')
      assertEquals(after.JWT_EXP, 7200)
    } finally {
      await cleanupOverrides(ref)
    }
  },
)

// M13 regression: a single PATCH used to trigger two separate
// `GET /auth/v1/admin/settings` round-trips (one inside the internal
// fetchLiveSettings call, one again from the follow-up getMergedConfig).
// This test pins the new contract: exactly ONE settings fetch per
// applyConfigPatch call, regardless of whether any keys were accepted
// live. It also verifies the returned `merged` view contains both the
// accepted-live patch values and the rejected (overridden) patch values
// — Studio's save-then-reload flow relied on that merge.
Deno.test(
  'applyConfigPatch (M13): makes one /admin/settings fetch and returns merged view',
  async () => {
    const ref = freshRef('m13-merge-once')
    try {
      let settingsFetches = 0
      let configPosts = 0
      const fakeFetch: FetchLike = (url, init) => {
        const u = String(url)
        const method = (init as RequestInit | undefined)?.method ?? 'GET'
        if (u.endsWith('/auth/v1/admin/settings') && method === 'GET') {
          settingsFetches++
          return Promise.resolve(
            new Response(
              JSON.stringify({
                SITE_URL: 'https://pre-push.example.com',
                JWT_EXP: 100,
              }),
              { status: 200, headers: { 'Content-Type': 'application/json' } },
            ),
          )
        }
        if (u.endsWith('/auth/v1/admin/config') && method === 'POST') {
          configPosts++
          return Promise.resolve(
            new Response(
              JSON.stringify({ accepted: ['SITE_URL'], rejected: ['JWT_EXP'] }),
              {
                status: 200,
                headers: { 'Content-Type': 'application/json' },
              },
            ),
          )
        }
        return Promise.resolve(new Response('not found', { status: 404 }))
      }

      const result = await applyConfigPatch(
        pool,
        fakeBackend(ref),
        { SITE_URL: 'https://post-push.example.com', JWT_EXP: 9000 },
        '',
        0,
        undefined,
        fakeFetch,
      )

      // Exactly one settings fetch and one config push per PATCH.
      assertEquals(settingsFetches, 1)
      assertEquals(configPosts, 1)

      // Shape of the result.
      assertEquals(result.accepted.sort(), ['SITE_URL'])
      assertEquals(result.overridden.sort(), ['JWT_EXP'])

      // Accepted keys reflect the pushed value (live overlay), overridden
      // keys reflect the override-table write.
      assertEquals(result.merged.SITE_URL, 'https://post-push.example.com')
      assertEquals(result.merged.JWT_EXP, 9000)
    } finally {
      await cleanupOverrides(ref)
    }
  },
)

Deno.test('applyConfigPatch (M13): empty patch does a single settings fetch, no push', async () => {
  const ref = freshRef('m13-empty-patch')
  try {
    let settingsFetches = 0
    let configPosts = 0
    const fakeFetch: FetchLike = (url, init) => {
      const u = String(url)
      const method = (init as RequestInit | undefined)?.method ?? 'GET'
      if (u.endsWith('/auth/v1/admin/settings') && method === 'GET') {
        settingsFetches++
        return Promise.resolve(
          new Response(
            JSON.stringify({ SITE_URL: 'https://live.example.com' }),
            {
              status: 200,
              headers: { 'Content-Type': 'application/json' },
            },
          ),
        )
      }
      if (u.endsWith('/auth/v1/admin/config') && method === 'POST') {
        configPosts++
      }
      return Promise.resolve(new Response('not found', { status: 404 }))
    }

    const result = await applyConfigPatch(
      pool,
      fakeBackend(ref),
      {},
      '',
      0,
      undefined,
      fakeFetch,
    )

    assertEquals(settingsFetches, 1)
    assertEquals(configPosts, 0)
    assertEquals(result.accepted, [])
    assertEquals(result.overridden, [])
    assertEquals(result.merged.SITE_URL, 'https://live.example.com')
  } finally {
    await cleanupOverrides(ref)
  }
})
