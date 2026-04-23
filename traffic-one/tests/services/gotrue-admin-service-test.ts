import { Pool } from 'https://deno.land/x/postgres@v0.17.0/mod.ts'
import { assert, assertEquals, assertRejects } from 'jsr:@std/assert@1'

import 'jsr:@std/dotenv/load'

import {
  applyConfigPatch,
  buildServiceRoleJwt,
  fetchLiveSettings,
  getDefaultConfig,
  getMergedConfig,
  getOverrides,
  isSecretField,
  pushLiveConfig,
  upsertOverrides,
  type FetchLike,
} from '../../functions/services/gotrue-admin.service.ts'

const pool = new Pool(Deno.env.get('TRAFFIC_DB_URL')!, 1, true)

function freshRef(suffix: string): string {
  return `test-gac-${suffix}-${crypto.randomUUID().slice(0, 8)}`
}

async function cleanupOverrides(projectRef: string) {
  const connection = await pool.connect()
  try {
    await connection.queryObject`
      DELETE FROM traffic.auth_config_overrides WHERE project_ref = ${projectRef}
    `
  } finally {
    connection.release()
  }
}

async function countOverrides(projectRef: string): Promise<number> {
  const connection = await pool.connect()
  try {
    const res = await connection.queryObject<{ count: number }>`
      SELECT COUNT(*)::int AS count FROM traffic.auth_config_overrides
      WHERE project_ref = ${projectRef}
    `
    return res.rows[0].count
  } finally {
    connection.release()
  }
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
      0
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
      await upsertOverrides(pool, ref, { SITE_URL: 'https://first.example.com' }, '', 0)
      await upsertOverrides(pool, ref, { SITE_URL: 'https://second.example.com' }, '', 0)

      const overrides = await getOverrides(pool, ref)
      assertEquals(overrides.SITE_URL, 'https://second.example.com')

      const count = await countOverrides(ref)
      assertEquals(count, 1)
    } finally {
      await cleanupOverrides(ref)
    }
  }
)

Deno.test('getMergedConfig layers overrides on top of defaults', async () => {
  const ref = freshRef('merge')
  try {
    await upsertOverrides(
      pool,
      ref,
      { SITE_URL: 'https://merged.example.com', DISABLE_SIGNUP: true },
      '',
      0
    )

    const defaults = getDefaultConfig()
    const merged = await getMergedConfig(pool, ref)

    assertEquals(merged.SITE_URL, 'https://merged.example.com')
    assertEquals(merged.DISABLE_SIGNUP, true)
    assertEquals(merged.JWT_EXP, defaults.JWT_EXP)
    assertEquals(merged.EXTERNAL_EMAIL_ENABLED, defaults.EXTERNAL_EMAIL_ENABLED)

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
      0
    )

    const merged = await getMergedConfig(pool, ref)
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

// ── Service-role JWT construction ──────────────────────────

function decodeJwt(token: string): {
  header: Record<string, unknown>
  payload: Record<string, unknown>
} {
  const [h, p] = token.split('.')
  const pad = (s: string) => s + '='.repeat((4 - (s.length % 4)) % 4)
  const fromB64Url = (s: string) =>
    JSON.parse(atob(pad(s.replaceAll('-', '+').replaceAll('_', '/'))))
  return { header: fromB64Url(h), payload: fromB64Url(p) }
}

async function verifyHs256(token: string, secret: string): Promise<boolean> {
  const [h, p, s] = token.split('.')
  const enc = new TextEncoder()
  const key = await crypto.subtle.importKey(
    'raw',
    enc.encode(secret),
    { name: 'HMAC', hash: 'SHA-256' },
    false,
    ['verify']
  )
  const sigBytes = Uint8Array.from(
    atob(s.replaceAll('-', '+').replaceAll('_', '/') + '='.repeat((4 - (s.length % 4)) % 4)),
    (c) => c.charCodeAt(0)
  )
  return crypto.subtle.verify('HMAC', key, sigBytes, enc.encode(`${h}.${p}`))
}

Deno.test('buildServiceRoleJwt produces HS256 token with service_role claim', async () => {
  const secret = 'test-jwt-secret-x'
  const token = await buildServiceRoleJwt(secret, 120)
  const { header, payload } = decodeJwt(token)

  assertEquals(header.alg, 'HS256')
  assertEquals(header.typ, 'JWT')
  assertEquals(payload.role, 'service_role')
  assertEquals(typeof payload.iat, 'number')
  assertEquals(typeof payload.exp, 'number')
  assert((payload.exp as number) - (payload.iat as number) === 120)

  assert(await verifyHs256(token, secret), 'signature must verify under the same secret')
  assertEquals(await verifyHs256(token, 'wrong-secret'), false)
})

Deno.test('buildServiceRoleJwt throws when secret is empty', async () => {
  await assertRejects(() => buildServiceRoleJwt('', 60), Error, 'JWT_SECRET')
})

// ── Live /admin/settings round-trip ──────────────────────

Deno.test('fetchLiveSettings returns parsed JSON on 200 with injected fetch', async () => {
  const originalSecret = Deno.env.get('JWT_SECRET')
  Deno.env.set('JWT_SECRET', 'round-trip-secret')
  try {
    let capturedAuth = ''
    const fakeFetch: FetchLike = (_url, init) => {
      capturedAuth = (init?.headers as Record<string, string>)?.Authorization ?? ''
      return Promise.resolve(
        new Response(JSON.stringify({ SITE_URL: 'https://live.example.com', JWT_EXP: 9999 }), {
          status: 200,
          headers: { 'Content-Type': 'application/json' },
        })
      )
    }
    const live = await fetchLiveSettings(fakeFetch)
    assert(live !== null, 'expected non-null live settings')
    assertEquals(live!.SITE_URL, 'https://live.example.com')
    assertEquals(live!.JWT_EXP, 9999)
    assert(capturedAuth.startsWith('Bearer '), 'expected Bearer auth header')
  } finally {
    if (originalSecret === undefined) Deno.env.delete('JWT_SECRET')
    else Deno.env.set('JWT_SECRET', originalSecret)
  }
})

Deno.test('fetchLiveSettings returns null on 404 (endpoint not exposed)', async () => {
  const originalSecret = Deno.env.get('JWT_SECRET')
  Deno.env.set('JWT_SECRET', 'round-trip-secret')
  try {
    const fakeFetch: FetchLike = () => Promise.resolve(new Response('not found', { status: 404 }))
    const live = await fetchLiveSettings(fakeFetch)
    assertEquals(live, null)
  } finally {
    if (originalSecret === undefined) Deno.env.delete('JWT_SECRET')
    else Deno.env.set('JWT_SECRET', originalSecret)
  }
})

Deno.test('fetchLiveSettings returns null on network error', async () => {
  const originalSecret = Deno.env.get('JWT_SECRET')
  Deno.env.set('JWT_SECRET', 'round-trip-secret')
  try {
    const fakeFetch: FetchLike = () => Promise.reject(new Error('dns fail'))
    const live = await fetchLiveSettings(fakeFetch)
    assertEquals(live, null)
  } finally {
    if (originalSecret === undefined) Deno.env.delete('JWT_SECRET')
    else Deno.env.set('JWT_SECRET', originalSecret)
  }
})

Deno.test('getMergedConfig layers live over defaults, overrides over live', async () => {
  const ref = freshRef('layered')
  const originalSecret = Deno.env.get('JWT_SECRET')
  Deno.env.set('JWT_SECRET', 'merged-secret')
  try {
    await upsertOverrides(pool, ref, { SITE_URL: 'https://override.example.com' }, '', 0)
    const fakeFetch: FetchLike = () =>
      Promise.resolve(
        new Response(
          JSON.stringify({
            SITE_URL: 'https://live.example.com',
            URI_ALLOW_LIST: 'https://live-only.example.com',
          }),
          { status: 200, headers: { 'Content-Type': 'application/json' } }
        )
      )

    const merged = await getMergedConfig(pool, ref, fakeFetch)
    // Overrides win over live.
    assertEquals(merged.SITE_URL, 'https://override.example.com')
    // Live wins over env defaults.
    assertEquals(merged.URI_ALLOW_LIST, 'https://live-only.example.com')
  } finally {
    await cleanupOverrides(ref)
    if (originalSecret === undefined) Deno.env.delete('JWT_SECRET')
    else Deno.env.set('JWT_SECRET', originalSecret)
  }
})

// ── Partial-PATCH transactional semantics ────────────────

Deno.test('pushLiveConfig treats 200 + {accepted, rejected} body as authoritative', async () => {
  const originalSecret = Deno.env.get('JWT_SECRET')
  Deno.env.set('JWT_SECRET', 'push-secret')
  try {
    const fakeFetch: FetchLike = () =>
      Promise.resolve(
        new Response(
          JSON.stringify({
            accepted: ['SITE_URL'],
            rejected: ['CUSTOM_OAUTH_MAX_PROVIDERS'],
          }),
          { status: 200, headers: { 'Content-Type': 'application/json' } }
        )
      )
    const result = await pushLiveConfig(
      { SITE_URL: 'https://ok.example', CUSTOM_OAUTH_MAX_PROVIDERS: 5 },
      fakeFetch
    )
    assertEquals(result.accepted, ['SITE_URL'])
    assertEquals(result.rejected, ['CUSTOM_OAUTH_MAX_PROVIDERS'])
  } finally {
    if (originalSecret === undefined) Deno.env.delete('JWT_SECRET')
    else Deno.env.set('JWT_SECRET', originalSecret)
  }
})

Deno.test('pushLiveConfig treats 404 as "nothing accepted" (override-only path)', async () => {
  const originalSecret = Deno.env.get('JWT_SECRET')
  Deno.env.set('JWT_SECRET', 'push-secret')
  try {
    const fakeFetch: FetchLike = () => Promise.resolve(new Response('not found', { status: 404 }))
    const result = await pushLiveConfig({ SITE_URL: 'https://x' }, fakeFetch)
    assertEquals(result.accepted, [])
    assertEquals(result.rejected, ['SITE_URL'])
  } finally {
    if (originalSecret === undefined) Deno.env.delete('JWT_SECRET')
    else Deno.env.set('JWT_SECRET', originalSecret)
  }
})

Deno.test(
  'applyConfigPatch: GoTrue-rejected fields land in overrides; accepted fields do not',
  async () => {
    const ref = freshRef('partial-patch')
    const originalSecret = Deno.env.get('JWT_SECRET')
    Deno.env.set('JWT_SECRET', 'partial-secret')
    try {
      const fakeFetch: FetchLike = () =>
        Promise.resolve(
          new Response(JSON.stringify({ accepted: ['SITE_URL'], rejected: ['JWT_EXP'] }), {
            status: 200,
            headers: { 'Content-Type': 'application/json' },
          })
        )
      const result = await applyConfigPatch(
        pool,
        ref,
        { SITE_URL: 'https://accepted.example.com', JWT_EXP: 9001 },
        '',
        0,
        undefined,
        fakeFetch
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
      if (originalSecret === undefined) Deno.env.delete('JWT_SECRET')
      else Deno.env.set('JWT_SECRET', originalSecret)
    }
  }
)

Deno.test(
  'applyConfigPatch: bad field (live 500) leaves overrides row unchanged before retry',
  async () => {
    const ref = freshRef('bad-field-tx')
    const originalSecret = Deno.env.get('JWT_SECRET')
    Deno.env.set('JWT_SECRET', 'partial-secret')
    try {
      // Pre-seed a known good override.
      await upsertOverrides(pool, ref, { SITE_URL: 'https://pre.example.com' }, '', 0)

      // Live side fails entirely — every key should land in overrides.
      const failingFetch: FetchLike = () => Promise.resolve(new Response('boom', { status: 500 }))
      await applyConfigPatch(
        pool,
        ref,
        { SITE_URL: 'https://after.example.com', JWT_EXP: 7200 },
        '',
        0,
        undefined,
        failingFetch
      )

      const after = await getOverrides(pool, ref)
      assertEquals(after.SITE_URL, 'https://after.example.com')
      assertEquals(after.JWT_EXP, 7200)
    } finally {
      await cleanupOverrides(ref)
      if (originalSecret === undefined) Deno.env.delete('JWT_SECRET')
      else Deno.env.set('JWT_SECRET', originalSecret)
    }
  }
)
