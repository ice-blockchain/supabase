import { assert, assertEquals, assertExists } from "jsr:@std/assert@1";
import { createClient } from "npm:@supabase/supabase-js@2";
import "jsr:@std/dotenv/load";

const supabaseUrl = Deno.env.get("SUPABASE_URL")!;
const supabaseKey = Deno.env.get("SUPABASE_ANON_KEY")!;
const supabase = createClient(supabaseUrl, supabaseKey, {
  auth: { autoRefreshToken: false, persistSession: false, detectSessionInUrl: false },
});

const PROFILE_URL = `${supabaseUrl}/api/platform/profile`;

// ── Auth ─────────────────────────────────────────────────

Deno.test("GET /profile returns 401 without auth", async () => {
  const res = await fetch(PROFILE_URL);
  assertEquals(res.status, 401);
  await res.body?.cancel();
});

Deno.test("GET /profile returns 401 with invalid JWT", async () => {
  const res = await fetch(PROFILE_URL, {
    headers: { Authorization: "Bearer invalid-token-here" },
  });
  assertEquals(res.status, 401);
  await res.body?.cancel();
});

// ── CORS ─────────────────────────────────────────────────

Deno.test("OPTIONS returns CORS headers", async () => {
  const res = await fetch(PROFILE_URL, { method: "OPTIONS" });
  assertEquals(res.status, 200);
  assertExists(res.headers.get("access-control-allow-origin"));
  await res.body?.cancel();
});

// ── Helper: get session ──────────────────────────────────

async function getTestSession() {
  const { data: { session }, error } = await supabase.auth.signInWithPassword({
    email: "test@example.com",
    password: "test-password",
  });
  if (error || !session) {
    throw new Error(`Failed to sign in test user: ${error?.message ?? "no session"}`);
  }
  return session;
}

function authHeaders(token: string): Record<string, string> {
  return {
    Authorization: `Bearer ${token}`,
    "Content-Type": "application/json",
  };
}

// ── Profile ──────────────────────────────────────────────

Deno.test("GET /profile returns ProfileResponse shape", async () => {
  const session = await getTestSession();
  const res = await fetch(PROFILE_URL, {
    headers: authHeaders(session.access_token),
  });
  assertEquals(res.status, 200);

  const profile = await res.json();
  assertExists(profile.id);
  assertExists(profile.gotrue_id);
  assertExists(profile.primary_email);
  assertExists(profile.username);
  assertEquals(typeof profile.is_alpha_user, "boolean");
  assertEquals(typeof profile.is_sso_user, "boolean");
  assert(Array.isArray(profile.disabled_features));
  assertExists(profile.auth0_id);
});

Deno.test("PUT /profile/update updates fields", async () => {
  const session = await getTestSession();
  const res = await fetch(`${PROFILE_URL}/update`, {
    method: "PUT",
    headers: authHeaders(session.access_token),
    body: JSON.stringify({ first_name: "IntegrationTest" }),
  });
  assertEquals(res.status, 200);

  const profile = await res.json();
  assertEquals(profile.first_name, "IntegrationTest");
});

// ── Access Tokens ────────────────────────────────────────

let createdTokenId: number | null = null;

Deno.test("POST /access-tokens creates token and returns raw token", async () => {
  const session = await getTestSession();
  const res = await fetch(`${PROFILE_URL}/access-tokens`, {
    method: "POST",
    headers: authHeaders(session.access_token),
    body: JSON.stringify({ name: "integration-test-token" }),
  });
  assertEquals(res.status, 201);

  const token = await res.json();
  assertExists(token.id);
  assertExists(token.token);
  assertExists(token.token_alias);
  assertEquals(token.name, "integration-test-token");
  createdTokenId = token.id;
});

Deno.test("GET /access-tokens lists tokens without raw token", async () => {
  const session = await getTestSession();
  const res = await fetch(`${PROFILE_URL}/access-tokens`, {
    headers: authHeaders(session.access_token),
  });
  assertEquals(res.status, 200);

  const tokens = await res.json();
  assert(Array.isArray(tokens));
  if (tokens.length > 0) {
    assertExists(tokens[0].id);
    assertExists(tokens[0].name);
    assertExists(tokens[0].token_alias);
    assertEquals(tokens[0].token, undefined);
  }
});

Deno.test("DELETE /access-tokens/:id revokes token", async () => {
  if (!createdTokenId) return;
  const session = await getTestSession();
  const res = await fetch(`${PROFILE_URL}/access-tokens/${createdTokenId}`, {
    method: "DELETE",
    headers: authHeaders(session.access_token),
  });
  assertEquals(res.status, 200);
  await res.body?.cancel();
});

// ── Scoped Access Tokens ─────────────────────────────────

let createdScopedTokenId: string | null = null;

Deno.test("POST /scoped-access-tokens creates scoped token", async () => {
  const session = await getTestSession();
  const res = await fetch(`${PROFILE_URL}/scoped-access-tokens`, {
    method: "POST",
    headers: authHeaders(session.access_token),
    body: JSON.stringify({
      name: "integration-scoped-token",
      permissions: ["organizations_read", "projects_read"],
    }),
  });
  assertEquals(res.status, 201);

  const token = await res.json();
  assertExists(token.id);
  assertExists(token.token);
  assertExists(token.token_alias);
  assert(Array.isArray(token.permissions));
  createdScopedTokenId = token.id;
});

Deno.test("GET /scoped-access-tokens lists scoped tokens", async () => {
  const session = await getTestSession();
  const res = await fetch(`${PROFILE_URL}/scoped-access-tokens`, {
    headers: authHeaders(session.access_token),
  });
  assertEquals(res.status, 200);

  const tokens = await res.json();
  assert(Array.isArray(tokens));
});

Deno.test("DELETE /scoped-access-tokens/:id revokes scoped token", async () => {
  if (!createdScopedTokenId) return;
  const session = await getTestSession();
  const res = await fetch(`${PROFILE_URL}/scoped-access-tokens/${createdScopedTokenId}`, {
    method: "DELETE",
    headers: authHeaders(session.access_token),
  });
  assertEquals(res.status, 200);
  await res.body?.cancel();
});

// ── Notifications ────────────────────────────────────────

Deno.test("GET /notifications returns notifications", async () => {
  const session = await getTestSession();
  const res = await fetch(`${PROFILE_URL}/notifications`, {
    headers: authHeaders(session.access_token),
  });
  assertEquals(res.status, 200);

  const notifications = await res.json();
  assert(Array.isArray(notifications));
});

Deno.test("PATCH /notifications updates status", async () => {
  const session = await getTestSession();
  const res = await fetch(`${PROFILE_URL}/notifications`, {
    method: "PATCH",
    headers: authHeaders(session.access_token),
    body: JSON.stringify({ ids: [], status: "seen" }),
  });
  assertEquals(res.status, 200);

  const result = await res.json();
  assert(Array.isArray(result));
});

// ── Permissions ──────────────────────────────────────────

Deno.test("GET /permissions returns permissions array", async () => {
  const session = await getTestSession();
  const res = await fetch(`${PROFILE_URL}/permissions`, {
    headers: authHeaders(session.access_token),
  });
  assertEquals(res.status, 200);

  const permissions = await res.json();
  assert(Array.isArray(permissions));
  assert(permissions.length > 0);
  assert(permissions.includes("organizations_read"));
});

// ── Audit ────────────────────────────────────────────────

Deno.test("POST /audit-login records login event", async () => {
  const session = await getTestSession();
  const res = await fetch(`${PROFILE_URL}/audit-login`, {
    method: "POST",
    headers: authHeaders(session.access_token),
  });
  assertEquals(res.status, 201);
  await res.body?.cancel();
});

Deno.test("GET /audit returns audit logs with date filter", async () => {
  const session = await getTestSession();
  const now = new Date();
  const start = new Date(now.getTime() - 24 * 60 * 60 * 1000).toISOString();
  const end = now.toISOString();

  const res = await fetch(
    `${PROFILE_URL}/audit?iso_timestamp_start=${start}&iso_timestamp_end=${end}`,
    { headers: authHeaders(session.access_token) },
  );
  assertEquals(res.status, 200);

  const body = await res.json();
  assertExists(body.result);
  assert(Array.isArray(body.result));
  assertEquals(typeof body.retention_period, "number");
});

// ── Signup (unauthenticated) ─────────────────────────────

const SIGNUP_URL = `${supabaseUrl}/api/platform/signup`;

Deno.test("POST /signup returns 201 for new user", async () => {
  const uniqueEmail = `test-signup-${Date.now()}@example.com`;
  const res = await fetch(SIGNUP_URL, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({
      email: uniqueEmail,
      password: "Test1234!",
      hcaptchaToken: null,
      redirectTo: "http://localhost:8000",
    }),
  });
  assertEquals(res.status, 201);
  await res.body?.cancel();
});

Deno.test("POST /signup returns error for invalid email", async () => {
  const res = await fetch(SIGNUP_URL, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({
      email: "not-an-email",
      password: "Test1234!",
      hcaptchaToken: null,
      redirectTo: "http://localhost:8000",
    }),
  });
  assert(res.status >= 400);
  const body = await res.json();
  assertExists(body.message);
});

Deno.test("POST /signup does not require Authorization header", async () => {
  const res = await fetch(SIGNUP_URL, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({
      email: `no-auth-${Date.now()}@example.com`,
      password: "Test1234!",
      hcaptchaToken: null,
      redirectTo: "http://localhost:8000",
    }),
  });
  assert(res.status !== 401, "Signup should not require auth");
  await res.body?.cancel();
});

Deno.test("OPTIONS /signup returns CORS headers", async () => {
  const res = await fetch(SIGNUP_URL, { method: "OPTIONS" });
  assertEquals(res.status, 200);
  assertExists(res.headers.get("access-control-allow-origin"));
  await res.body?.cancel();
});

// ── Reset Password (unauthenticated) ─────────────────────

const RESET_URL = `${supabaseUrl}/api/platform/reset-password`;

Deno.test("POST /reset-password returns 200", async () => {
  const res = await fetch(RESET_URL, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({
      email: "test@example.com",
      hcaptchaToken: null,
      redirectTo: "http://localhost:8000",
    }),
  });
  assertEquals(res.status, 200);
  await res.body?.cancel();
});

Deno.test("POST /reset-password does not require Authorization header", async () => {
  const res = await fetch(RESET_URL, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({
      email: "test@example.com",
      hcaptchaToken: null,
      redirectTo: "http://localhost:8000",
    }),
  });
  assert(res.status !== 401, "Reset password should not require auth");
  await res.body?.cancel();
});

Deno.test("OPTIONS /reset-password returns CORS headers", async () => {
  const res = await fetch(RESET_URL, { method: "OPTIONS" });
  assertEquals(res.status, 200);
  assertExists(res.headers.get("access-control-allow-origin"));
  await res.body?.cancel();
});

// ── 404 ──────────────────────────────────────────────────

Deno.test("GET /nonexistent returns 404", async () => {
  const session = await getTestSession();
  const res = await fetch(`${PROFILE_URL}/nonexistent`, {
    headers: authHeaders(session.access_token),
  });
  assertEquals(res.status, 404);
  await res.body?.cancel();
});
