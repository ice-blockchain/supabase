import { Pool } from 'https://deno.land/x/postgres@v0.19.3/mod.ts'
import { assert, assertEquals, assertExists } from 'jsr:@std/assert@1'
import { createClient } from 'npm:@supabase/supabase-js@2'

import 'jsr:@std/dotenv/load'

const supabaseUrl = Deno.env.get('SUPABASE_URL')!
const supabaseKey = Deno.env.get('SUPABASE_ANON_KEY')!
const supabase = createClient(supabaseUrl, supabaseKey, {
  auth: {
    autoRefreshToken: false,
    persistSession: false,
    detectSessionInUrl: false,
  },
})

const AUTH_URL = `${supabaseUrl}/api/platform/auth`
const ORG_URL = `${supabaseUrl}/api/platform/organizations`
const PROJECTS_URL = `${supabaseUrl}/api/platform/projects`

// Used for the direct-DB cleanup after PATCH tests so repeated runs don't
// accumulate rows that would poison assertions about defaults.
const pool = new Pool(Deno.env.get('TRAFFIC_DB_URL')!, 1, true)

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

async function clearOverrides(ref: string) {
  const connection = await pool.connect()
  try {
    await connection.queryObject`
      DELETE FROM traffic.auth_config_overrides WHERE project_ref = ${ref}
    `
  } finally {
    connection.release()
  }
}

// ── Auth ─────────────────────────────────────────────────

Deno.test('GET /auth/{ref}/config returns 401 without auth', async () => {
  const res = await fetch(`${AUTH_URL}/anything/config`)
  assertEquals(res.status, 401)
  await res.body?.cancel()
})

Deno.test('PATCH /auth/{ref}/config returns 401 without auth', async () => {
  const res = await fetch(`${AUTH_URL}/anything/config`, {
    method: 'PATCH',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ SITE_URL: 'http://evil.example.com' }),
  })
  assertEquals(res.status, 401)
  await res.body?.cancel()
})

Deno.test('PATCH /auth/{ref}/config returns 401 with invalid JWT', async () => {
  const res = await fetch(`${AUTH_URL}/anything/config`, {
    method: 'PATCH',
    headers: {
      Authorization: 'Bearer not-a-real-jwt',
      'Content-Type': 'application/json',
    },
    body: JSON.stringify({ SITE_URL: 'http://evil.example.com' }),
  })
  assertEquals(res.status, 401)
  await res.body?.cancel()
})

// ── Setup: create a test org + project so `ref` validation has a hit ──

let testOrgSlug: string | null = null
let testRef: string | null = null

Deno.test('setup: create test org for auth-config', async () => {
  const session = await getTestSession()
  const orgName = `Auth Config Test Org ${Date.now()}`
  const res = await fetch(ORG_URL, {
    method: 'POST',
    headers: authHeaders(session.access_token),
    body: JSON.stringify({ name: orgName, tier: 'tier_free' }),
  })
  assertEquals(res.status, 201)
  const org = await res.json()
  testOrgSlug = org.slug
})

Deno.test('setup: create test project for auth-config', async () => {
  if (!testOrgSlug) return
  const session = await getTestSession()
  const res = await fetch(PROJECTS_URL, {
    method: 'POST',
    headers: authHeaders(session.access_token),
    body: JSON.stringify({
      name: `Auth Config Project ${Date.now()}`,
      organization_slug: testOrgSlug,
      db_region: 'local',
    }),
  })
  assertEquals(res.status, 201)
  const project = await res.json()
  testRef = project.ref
  assertExists(testRef)
})

// ── Unknown ref ──────────────────────────────────────────

Deno.test('GET /auth/{unknown-ref}/config returns 404', async () => {
  const session = await getTestSession()
  // L4: must be 20 lowercase-alphanumeric chars to reach the DB branch;
  // a shorter ref (like the 19-char `nonexistent00000000` this used to pass)
  // would now return 400 `invalid_project_ref` from `assertValidRef`.
  const res = await fetch(`${AUTH_URL}/nonexistent000000000/config`, {
    headers: authHeaders(session.access_token),
  })
  assertEquals(res.status, 404)
  await res.body?.cancel()
})

// ── GET: full shape ──────────────────────────────────────

Deno.test('GET /auth/{ref}/config returns object with required keys', async () => {
  if (!testRef) return
  const session = await getTestSession()
  const res = await fetch(`${AUTH_URL}/${testRef}/config`, {
    headers: authHeaders(session.access_token),
  })
  assertEquals(res.status, 200)

  const config = await res.json()
  assert(typeof config === 'object' && !Array.isArray(config))

  // Core fields Studio's /auth/* pages read.
  assertEquals(typeof config.SITE_URL, 'string')
  assertEquals(typeof config.URI_ALLOW_LIST, 'string')
  assertEquals(typeof config.JWT_EXP, 'number')
  assertEquals(typeof config.DISABLE_SIGNUP, 'boolean')
  assertEquals(typeof config.MAILER_AUTOCONFIRM, 'boolean')
  assertEquals(typeof config.MAILER_OTP_EXP, 'number')
  assertEquals(typeof config.MAILER_OTP_LENGTH, 'number')

  // SMTP
  assertEquals(typeof config.SMTP_ADMIN_EMAIL, 'string')
  assertEquals(typeof config.SMTP_HOST, 'string')
  assertEquals(typeof config.SMTP_PORT, 'string')
  assertEquals(typeof config.SMTP_SENDER_NAME, 'string')
  assertEquals(typeof config.SMTP_USER, 'string')
  assertEquals(typeof config.SMTP_PASS, 'string')
  assertEquals(typeof config.SMTP_MAX_FREQUENCY, 'number')

  // External providers
  assertEquals(typeof config.EXTERNAL_EMAIL_ENABLED, 'boolean')
  assertEquals(typeof config.EXTERNAL_PHONE_ENABLED, 'boolean')
  assertEquals(typeof config.EXTERNAL_ANONYMOUS_USERS_ENABLED, 'boolean')
  assertEquals(typeof config.EXTERNAL_GITHUB_ENABLED, 'boolean')
  assertEquals(typeof config.EXTERNAL_GITHUB_CLIENT_ID, 'string')
  assertEquals(typeof config.EXTERNAL_GITHUB_SECRET, 'string')
  assertEquals(typeof config.EXTERNAL_GOOGLE_ENABLED, 'boolean')
  assertEquals(typeof config.EXTERNAL_APPLE_ENABLED, 'boolean')
  assertEquals(typeof config.EXTERNAL_LINKEDIN_OIDC_ENABLED, 'boolean')

  // Rate limits
  assertEquals(typeof config.RATE_LIMIT_EMAIL_SENT, 'number')
  assertEquals(typeof config.RATE_LIMIT_SMS_SENT, 'number')
  assertEquals(typeof config.RATE_LIMIT_VERIFY, 'number')
  assertEquals(typeof config.RATE_LIMIT_TOKEN_REFRESH, 'number')
  assertEquals(typeof config.RATE_LIMIT_OTP, 'number')

  // Security / password
  assertEquals(typeof config.SECURITY_CAPTCHA_ENABLED, 'boolean')
  assertEquals(typeof config.SECURITY_CAPTCHA_PROVIDER, 'string')
  assertEquals(typeof config.SECURITY_CAPTCHA_SECRET, 'string')
  assertEquals(typeof config.SECURITY_REFRESH_TOKEN_REUSE_INTERVAL, 'number')
  assertEquals(typeof config.PASSWORD_MIN_LENGTH, 'number')
  assertEquals(typeof config.PASSWORD_REQUIRED_CHARACTERS, 'string')

  // Mailer templates
  assertEquals(typeof config.MAILER_TEMPLATES_INVITE_CONTENT, 'string')
  assertEquals(typeof config.MAILER_TEMPLATES_CONFIRMATION_CONTENT, 'string')
  assertEquals(typeof config.MAILER_TEMPLATES_RECOVERY_CONTENT, 'string')
  assertEquals(typeof config.MAILER_TEMPLATES_MAGIC_LINK_CONTENT, 'string')
  assertEquals(typeof config.MAILER_TEMPLATES_EMAIL_CHANGE_CONTENT, 'string')

  // Hooks
  assertEquals(typeof config.HOOK_CUSTOM_ACCESS_TOKEN_ENABLED, 'boolean')
  assertEquals(typeof config.HOOK_CUSTOM_ACCESS_TOKEN_URI, 'string')
  assertEquals(typeof config.HOOK_CUSTOM_ACCESS_TOKEN_SECRETS, 'string')
  assertEquals(typeof config.HOOK_MFA_VERIFICATION_ATTEMPT_ENABLED, 'boolean')
  assertEquals(typeof config.HOOK_MFA_VERIFICATION_ATTEMPT_URI, 'string')
  assertEquals(typeof config.HOOK_MFA_VERIFICATION_ATTEMPT_SECRETS, 'string')
  assertEquals(
    typeof config.HOOK_PASSWORD_VERIFICATION_ATTEMPT_ENABLED,
    'boolean',
  )
  assertEquals(typeof config.HOOK_SEND_SMS_ENABLED, 'boolean')
  assertEquals(typeof config.HOOK_SEND_SMS_URI, 'string')
  assertEquals(typeof config.HOOK_SEND_SMS_SECRETS, 'string')
  assertEquals(typeof config.HOOK_SEND_EMAIL_ENABLED, 'boolean')
  assertEquals(typeof config.HOOK_SEND_EMAIL_URI, 'string')
  assertEquals(typeof config.HOOK_SEND_EMAIL_SECRETS, 'string')
})

// ── Redaction ─────────────────────────────────────────────

Deno.test('GET /auth/{ref}/config redacts secret fields', async () => {
  if (!testRef) return
  const session = await getTestSession()

  // Seed secrets via PATCH so we know a value is present.
  const patchRes = await fetch(`${AUTH_URL}/${testRef}/config`, {
    method: 'PATCH',
    headers: authHeaders(session.access_token),
    body: JSON.stringify({
      SMTP_PASS: 'super-secret-password',
      SECURITY_CAPTCHA_SECRET: 'turnstile-secret-key',
      EXTERNAL_GITHUB_SECRET: 'github-oauth-secret',
      HOOK_CUSTOM_ACCESS_TOKEN_SECRETS: 'v1,whsec_xxx',
    }),
  })
  assertEquals(patchRes.status, 200)
  await patchRes.body?.cancel()

  const res = await fetch(`${AUTH_URL}/${testRef}/config`, {
    headers: authHeaders(session.access_token),
  })
  assertEquals(res.status, 200)
  const config = await res.json()

  assertEquals(config.SMTP_PASS, '***')
  assertEquals(config.SECURITY_CAPTCHA_SECRET, '***')
  assertEquals(config.EXTERNAL_GITHUB_SECRET, '***')
  assertEquals(config.HOOK_CUSTOM_ACCESS_TOKEN_SECRETS, '***')

  // Empty secrets must read as "" not "***"
  assert(
    config.EXTERNAL_GOOGLE_SECRET === '' ||
      config.EXTERNAL_GOOGLE_SECRET === '***',
  )
})

// ── PATCH persistence ────────────────────────────────────

Deno.test('PATCH /auth/{ref}/config persists partial updates', async () => {
  if (!testRef) return
  const session = await getTestSession()
  await clearOverrides(testRef)

  const patchRes = await fetch(`${AUTH_URL}/${testRef}/config`, {
    method: 'PATCH',
    headers: authHeaders(session.access_token),
    body: JSON.stringify({
      SITE_URL: 'https://example.com',
      DISABLE_SIGNUP: true,
      RATE_LIMIT_EMAIL_SENT: 42,
      EXTERNAL_GITHUB_ENABLED: true,
    }),
  })
  assertEquals(patchRes.status, 200)
  const patched = await patchRes.json()
  assertEquals(patched.SITE_URL, 'https://example.com')
  assertEquals(patched.DISABLE_SIGNUP, true)
  assertEquals(patched.RATE_LIMIT_EMAIL_SENT, 42)
  assertEquals(patched.EXTERNAL_GITHUB_ENABLED, true)

  const res = await fetch(`${AUTH_URL}/${testRef}/config`, {
    headers: authHeaders(session.access_token),
  })
  assertEquals(res.status, 200)
  const config = await res.json()
  assertEquals(config.SITE_URL, 'https://example.com')
  assertEquals(config.DISABLE_SIGNUP, true)
  assertEquals(config.RATE_LIMIT_EMAIL_SENT, 42)
  assertEquals(config.EXTERNAL_GITHUB_ENABLED, true)
})

// ── PATCH hooks endpoint ─────────────────────────────────

Deno.test('PATCH /auth/{ref}/config/hooks persists hook URLs', async () => {
  if (!testRef) return
  const session = await getTestSession()
  await clearOverrides(testRef)

  const patchRes = await fetch(`${AUTH_URL}/${testRef}/config/hooks`, {
    method: 'PATCH',
    headers: authHeaders(session.access_token),
    body: JSON.stringify({
      HOOK_SEND_EMAIL_ENABLED: true,
      HOOK_SEND_EMAIL_URI: 'http://my-hook.local/email',
      HOOK_CUSTOM_ACCESS_TOKEN_ENABLED: true,
      HOOK_CUSTOM_ACCESS_TOKEN_URI: 'pg-functions://postgres/public/custom_access_token_hook',
    }),
  })
  assertEquals(patchRes.status, 200)
  const patched = await patchRes.json()
  assertEquals(patched.HOOK_SEND_EMAIL_ENABLED, true)
  assertEquals(patched.HOOK_SEND_EMAIL_URI, 'http://my-hook.local/email')
  assertEquals(patched.HOOK_CUSTOM_ACCESS_TOKEN_ENABLED, true)
  assertEquals(
    patched.HOOK_CUSTOM_ACCESS_TOKEN_URI,
    'pg-functions://postgres/public/custom_access_token_hook',
  )

  const res = await fetch(`${AUTH_URL}/${testRef}/config`, {
    headers: authHeaders(session.access_token),
  })
  const config = await res.json()
  assertEquals(config.HOOK_SEND_EMAIL_ENABLED, true)
  assertEquals(config.HOOK_SEND_EMAIL_URI, 'http://my-hook.local/email')
})

// ── Method discipline ────────────────────────────────────

Deno.test('POST /auth/{ref}/config returns 405', async () => {
  if (!testRef) return
  const session = await getTestSession()
  const res = await fetch(`${AUTH_URL}/${testRef}/config`, {
    method: 'POST',
    headers: authHeaders(session.access_token),
    body: JSON.stringify({}),
  })
  assertEquals(res.status, 405)
  await res.body?.cancel()
})

Deno.test('GET /auth/{ref}/config/hooks returns 404 (GET is only on /config)', async () => {
  if (!testRef) return
  const session = await getTestSession()
  const res = await fetch(`${AUTH_URL}/${testRef}/config/hooks`, {
    headers: authHeaders(session.access_token),
  })
  // The hooks path only accepts PATCH; GET falls through to 405.
  assert(res.status === 404 || res.status === 405)
  await res.body?.cancel()
})

// ── Cleanup ──────────────────────────────────────────────

Deno.test('cleanup: delete test project and org', async () => {
  const session = await getTestSession()
  if (testRef) {
    await clearOverrides(testRef)
    const delProj = await fetch(`${PROJECTS_URL}/${testRef}`, {
      method: 'DELETE',
      headers: authHeaders(session.access_token),
    })
    await delProj.body?.cancel()
  }
  if (testOrgSlug) {
    const delOrg = await fetch(`${ORG_URL}/${testOrgSlug}`, {
      method: 'DELETE',
      headers: authHeaders(session.access_token),
    })
    await delOrg.body?.cancel()
  }
})
