// ─────────────────────────────────────────────────────────────────────────────
// Disposable test-user helper.
//
// The integration suites previously each defined their own
// `signUpDisposableUser()` that POSTed to `/api/platform/signup`. That public
// endpoint runs through GoTrue's email-sent rate limiter
// (`GOTRUE_RATE_LIMIT_EMAIL_SENT`, default 30/hr), which would burn through
// the budget after a handful of suites and trip a `429` for the rest of the
// run. The fix is to route disposable-user creation through GoTrue's admin
// API (`auth.admin.createUser`) — which is exempt from the email rate limit
// — and force-confirm in one round-trip via `email_confirm: true`.
//
// Public sign-in still goes through the anon client so the returned session
// is identical in shape to what production callers would receive.
// ─────────────────────────────────────────────────────────────────────────────

import { createClient, type Session, type SupabaseClient } from 'npm:@supabase/supabase-js@2'

const supabaseUrl = Deno.env.get('SUPABASE_URL')
const anonKey = Deno.env.get('SUPABASE_ANON_KEY')
// Accept all three names a developer might have in their local .env.
const serviceRoleKey = Deno.env.get('SUPABASE_SERVICE_ROLE_KEY') ||
  Deno.env.get('SUPABASE_SECRET_KEY') ||
  Deno.env.get('SUPABASE_SERVICE_KEY') ||
  ''

if (!supabaseUrl || !anonKey) {
  throw new Error(
    'createDisposableUser helper requires SUPABASE_URL and SUPABASE_ANON_KEY in tests/.env',
  )
}
if (!serviceRoleKey) {
  throw new Error(
    'createDisposableUser helper requires SUPABASE_SERVICE_ROLE_KEY in tests/.env (copy ' +
      "from the deployed VM's docker .env). The admin API is exempt from " +
      'GOTRUE_RATE_LIMIT_EMAIL_SENT, which is the whole point of this helper.',
  )
}

const adminClient: SupabaseClient = createClient(supabaseUrl, serviceRoleKey, {
  auth: {
    autoRefreshToken: false,
    persistSession: false,
    detectSessionInUrl: false,
  },
})

const anonClient: SupabaseClient = createClient(supabaseUrl, anonKey, {
  auth: {
    autoRefreshToken: false,
    persistSession: false,
    detectSessionInUrl: false,
  },
})

export interface DisposableUser {
  id: string
  email: string
  password: string
}

function freshEmail(prefix: string): string {
  const ts = Date.now()
  const rand = Math.floor(Math.random() * 1e6)
  return `${prefix}-${ts}-${rand}@example.com`
}

// Creates an email-confirmed user via GoTrue's admin API. The `prefix`
// becomes the local-part of the address so failing assertions can be traced
// back to a specific suite (e.g. `jit-other-…`, `branches-other-…`).
export async function createDisposableUser(
  prefix: string,
): Promise<DisposableUser> {
  const email = freshEmail(prefix)
  const password = 'Test1234!'
  const { data, error } = await adminClient.auth.admin.createUser({
    email,
    password,
    email_confirm: true,
  })
  if (error || !data.user) {
    throw new Error(
      `createDisposableUser(${prefix}) failed: ${error?.message ?? 'no user'}`,
    )
  }
  return { id: data.user.id, email, password }
}

// Public-flow sign-in for the disposable user. Mirrors the shape of the old
// per-suite `signIn` / `signInAs` helpers so call sites can keep using the
// returned `session.access_token` directly.
export async function signInAs(
  email: string,
  password: string,
): Promise<Session> {
  const {
    data: { session },
    error,
  } = await anonClient.auth.signInWithPassword({ email, password })
  if (error || !session) {
    throw new Error(
      `signInAs(${email}) failed: ${error?.message ?? 'no session'}`,
    )
  }
  return session
}

// Best-effort cleanup. Suites that care about leaving GoTrue tidy can call
// this in a teardown step; we swallow `not found` so a re-run after a
// partial failure doesn't compound the noise.
export async function deleteDisposableUser(userId: string): Promise<void> {
  if (!userId) return
  const { error } = await adminClient.auth.admin.deleteUser(userId)
  if (error && !/not.?found/i.test(error.message)) {
    throw new Error(`deleteDisposableUser(${userId}) failed: ${error.message}`)
  }
}
