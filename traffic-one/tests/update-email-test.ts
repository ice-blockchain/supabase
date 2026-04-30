import { Pool } from 'https://deno.land/x/postgres@v0.19.3/mod.ts'
import { assert, assertEquals, assertExists } from 'jsr:@std/assert@1'

import 'jsr:@std/dotenv/load'

import { createDisposableUser, signInAs } from './_helpers/test-user.ts'

const supabaseUrl = Deno.env.get('SUPABASE_URL')!
const superuserDbUrl = Deno.env.get('SUPERUSER_DB_URL')!

const UPDATE_EMAIL_URL = `${supabaseUrl}/api/platform/update-email`
const PROFILE_URL = `${supabaseUrl}/api/platform/profile`

function authHeaders(token: string): Record<string, string> {
  return {
    Authorization: `Bearer ${token}`,
    'Content-Type': 'application/json',
  }
}

// ── Auth ─────────────────────────────────────────────────

Deno.test('PUT /update-email returns 401 without auth', async () => {
  const res = await fetch(UPDATE_EMAIL_URL, {
    method: 'PUT',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({
      newEmail: 'does-not-matter@example.com',
      hcaptchaToken: null,
    }),
  })
  assertEquals(res.status, 401)
  await res.body?.cancel()
})

Deno.test('PUT /update-email returns 401 with invalid JWT', async () => {
  const res = await fetch(UPDATE_EMAIL_URL, {
    method: 'PUT',
    headers: {
      Authorization: 'Bearer invalid-token-here',
      'Content-Type': 'application/json',
    },
    body: JSON.stringify({
      newEmail: 'does-not-matter@example.com',
      hcaptchaToken: null,
    }),
  })
  assertEquals(res.status, 401)
  await res.body?.cancel()
})

// ── Validation ───────────────────────────────────────────

Deno.test('PUT /update-email with invalid email returns 400', async () => {
  const { email, password } = await createDisposableUser('update-email')
  const session = await signInAs(email, password)

  const res = await fetch(UPDATE_EMAIL_URL, {
    method: 'PUT',
    headers: authHeaders(session.access_token),
    body: JSON.stringify({
      newEmail: 'not-a-valid-email',
      hcaptchaToken: null,
    }),
  })
  assertEquals(res.status, 400)
  const body = await res.json()
  assertExists(body.message)
})

// ── Happy path ───────────────────────────────────────────

Deno.test(
  'PUT /update-email happy path updates GoTrue email, local profile, and writes audit log',
  async () => {
    const { email: originalEmail, password } = await createDisposableUser(
      'update-email',
    )
    const session = await signInAs(originalEmail, password)

    // Prime the profile row so primary_email is set to originalEmail.
    const primeRes = await fetch(PROFILE_URL, {
      headers: authHeaders(session.access_token),
    })
    assertEquals(primeRes.status, 200)
    const primed = await primeRes.json()
    assertEquals(primed.primary_email, originalEmail)

    const newEmail = `update-email-new-${Date.now()}-${Math.floor(Math.random() * 1e6)}@example.com`

    const updateRes = await fetch(UPDATE_EMAIL_URL, {
      method: 'PUT',
      headers: authHeaders(session.access_token),
      body: JSON.stringify({ newEmail, hcaptchaToken: null }),
    })
    assertEquals(updateRes.status, 200)
    const updated = await updateRes.json()
    assertEquals(updated.primary_email, newEmail)

    // GoTrue may not consider the new email confirmed until the user clicks the
    // change-email link; confirm it directly so the sign-in below succeeds.
    const adminPool = new Pool(superuserDbUrl, 1, true)
    try {
      const connection = await adminPool.connect()
      try {
        await connection.queryObject`
          UPDATE auth.users
          SET email = ${newEmail},
              email_confirmed_at = COALESCE(email_confirmed_at, now()),
              confirmed_at = COALESCE(confirmed_at, now()),
              email_change = '',
              email_change_token_new = '',
              email_change_token_current = '',
              email_change_confirm_status = 0
          WHERE email = ${newEmail} OR email_change = ${newEmail}
        `
      } finally {
        connection.release()
      }
    } finally {
      await adminPool.end()
    }

    const newSession = await signInAs(newEmail, password)
    const profileRes = await fetch(PROFILE_URL, {
      headers: authHeaders(newSession.access_token),
    })
    assertEquals(profileRes.status, 200)
    const profile = await profileRes.json()
    assertEquals(profile.primary_email, newEmail)

    // Audit log: look for profile.email_updated via the profile audit endpoint.
    const now = new Date()
    const start = new Date(now.getTime() - 60 * 60 * 1000).toISOString()
    const end = new Date(now.getTime() + 60 * 1000).toISOString()
    const auditRes = await fetch(
      `${PROFILE_URL}/audit?iso_timestamp_start=${start}&iso_timestamp_end=${end}`,
      { headers: authHeaders(newSession.access_token) },
    )
    assertEquals(auditRes.status, 200)
    const auditBody = await auditRes.json()
    assert(Array.isArray(auditBody.result))
    const match = auditBody.result.find(
      (row: { action: { name: string } }) => row.action?.name === 'profile.email_updated',
    )
    assertExists(
      match,
      'expected a profile.email_updated audit log entry for the updated profile',
    )
  },
)
