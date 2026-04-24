import { assertEquals, assertExists } from 'jsr:@std/assert@1'
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

const TELEMETRY_URL = `${supabaseUrl}/api/platform/telemetry`

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

// ── Anonymous (no auth) ────────────────────────────────────────────────────
// Studio fires PostHog events from signed-out states (landing, sign-in).
// These endpoints must succeed without an Authorization header.

Deno.test('POST /telemetry/event returns 200 without auth', async () => {
  const res = await fetch(`${TELEMETRY_URL}/event`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ action: 'studio_landing_viewed' }),
  })
  assertEquals(res.status, 200)
  const body = await res.json()
  assertEquals(body.success, true)
})

Deno.test('POST /telemetry/identify returns 200 without auth', async () => {
  const res = await fetch(`${TELEMETRY_URL}/identify`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ user_id: 'anon-user' }),
  })
  assertEquals(res.status, 200)
  const body = await res.json()
  assertEquals(body.success, true)
})

Deno.test('POST /telemetry/reset returns 200 without auth', async () => {
  const res = await fetch(`${TELEMETRY_URL}/reset`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({}),
  })
  assertEquals(res.status, 200)
  const body = await res.json()
  assertEquals(body.success, true)
})

Deno.test('GET /telemetry/feature-flags returns {} without auth', async () => {
  const res = await fetch(`${TELEMETRY_URL}/feature-flags`)
  assertEquals(res.status, 200)
  const body = await res.json()
  assertEquals(body, {})
})

// ── Authenticated (signed-in users) ────────────────────────────────────────
// Studio conditionally attaches an Authorization header when a session exists;
// the same endpoints must work for signed-in callers too.

Deno.test('POST /telemetry/event returns 200 { success: true } with auth', async () => {
  const session = await getTestSession()
  const res = await fetch(`${TELEMETRY_URL}/event`, {
    method: 'POST',
    headers: authHeaders(session.access_token),
    body: JSON.stringify({
      action: 'studio_dashboard_loaded',
      custom_properties: { foo: 'bar' },
    }),
  })
  assertEquals(res.status, 200)
  const body = await res.json()
  assertEquals(body.success, true)
})

Deno.test('POST /telemetry/identify returns 200 { success: true } with auth', async () => {
  const session = await getTestSession()
  const res = await fetch(`${TELEMETRY_URL}/identify`, {
    method: 'POST',
    headers: authHeaders(session.access_token),
    body: JSON.stringify({ user_id: 'abc', anonymous_id: 'anon' }),
  })
  assertEquals(res.status, 200)
  const body = await res.json()
  assertEquals(body.success, true)
})

Deno.test('POST /telemetry/reset returns 200 { success: true } with auth', async () => {
  const session = await getTestSession()
  const res = await fetch(`${TELEMETRY_URL}/reset`, {
    method: 'POST',
    headers: authHeaders(session.access_token),
    body: JSON.stringify({}),
  })
  assertEquals(res.status, 200)
  const body = await res.json()
  assertEquals(body.success, true)
})

Deno.test('POST /telemetry/event ignores body shape (no validation)', async () => {
  const res = await fetch(`${TELEMETRY_URL}/event`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: 'not-json',
  })
  assertEquals(res.status, 200)
  const body = await res.json()
  assertEquals(body.success, true)
})

// ── Regression: /telemetry/feature-flags ──────────────────────────────────

Deno.test('GET /telemetry/feature-flags still returns {} with auth', async () => {
  const session = await getTestSession()
  const res = await fetch(`${TELEMETRY_URL}/feature-flags`, {
    headers: authHeaders(session.access_token),
  })
  assertEquals(res.status, 200)
  const body = await res.json()
  assertEquals(body, {})
})

Deno.test('POST /telemetry/feature-flags/track still returns {}', async () => {
  const res = await fetch(`${TELEMETRY_URL}/feature-flags/track`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ foo: 'bar' }),
  })
  assertEquals(res.status, 200)
  const body = await res.json()
  assertEquals(body, {})
})

// ── CORS ──────────────────────────────────────────────────────────────────

Deno.test('OPTIONS /telemetry/event returns CORS headers', async () => {
  const res = await fetch(`${TELEMETRY_URL}/event`, { method: 'OPTIONS' })
  assertEquals(res.status, 200)
  assertExists(res.headers.get('access-control-allow-origin'))
  await res.body?.cancel()
})
