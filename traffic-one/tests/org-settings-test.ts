import { assert, assertEquals, assertExists } from "jsr:@std/assert@1";
import { createClient } from "npm:@supabase/supabase-js@2";
import "jsr:@std/dotenv/load";

const supabaseUrl = Deno.env.get("SUPABASE_URL")!;
const supabaseKey = Deno.env.get("SUPABASE_ANON_KEY")!;
const supabase = createClient(supabaseUrl, supabaseKey, {
  auth: { autoRefreshToken: false, persistSession: false, detectSessionInUrl: false },
});

const ORG_URL = `${supabaseUrl}/api/platform/organizations`;

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

// ── Setup: create org for all tests ──────────────────────

let testSlug: string;
let testOrgId: number;

Deno.test("setup: create org for settings tests", async () => {
  const session = await getTestSession();
  const res = await fetch(ORG_URL, {
    method: "POST",
    headers: authHeaders(session.access_token),
    body: JSON.stringify({ name: `Settings Test Org ${Date.now()}` }),
  });
  assertEquals(res.status, 201);
  const org = await res.json();
  testSlug = org.slug;
  testOrgId = org.id;
  assertExists(testSlug);
});

// ── Auth: 401 without token ─────────────────────────────

Deno.test("GET /organizations/{slug}/audit returns 401 without auth", async () => {
  const res = await fetch(`${ORG_URL}/${testSlug}/audit?iso_timestamp_start=2024-01-01T00:00:00Z&iso_timestamp_end=2025-01-01T00:00:00Z`);
  assertEquals(res.status, 401);
  await res.body?.cancel();
});

Deno.test("GET /organizations/{slug}/members/mfa/enforcement returns 401 without auth", async () => {
  const res = await fetch(`${ORG_URL}/${testSlug}/members/mfa/enforcement`);
  assertEquals(res.status, 401);
  await res.body?.cancel();
});

Deno.test("GET /organizations/{slug}/sso returns 401 without auth", async () => {
  const res = await fetch(`${ORG_URL}/${testSlug}/sso`);
  assertEquals(res.status, 401);
  await res.body?.cancel();
});

// ── Org Audit Logs ──────────────────────────────────────

Deno.test("GET /organizations/{slug}/audit returns audit logs (initially empty)", async () => {
  const session = await getTestSession();
  const now = new Date().toISOString();
  const past = new Date(Date.now() - 86400000).toISOString();
  const res = await fetch(
    `${ORG_URL}/${testSlug}/audit?iso_timestamp_start=${past}&iso_timestamp_end=${now}`,
    { headers: authHeaders(session.access_token) },
  );
  assertEquals(res.status, 200);
  const body = await res.json();
  assertExists(body.result);
  assert(Array.isArray(body.result));
  assertExists(body.retention_period);
});

Deno.test("GET /organizations/{slug}/audit requires date params", async () => {
  const session = await getTestSession();
  const res = await fetch(`${ORG_URL}/${testSlug}/audit`, {
    headers: authHeaders(session.access_token),
  });
  assertEquals(res.status, 400);
  await res.body?.cancel();
});

// ── MFA Enforcement ─────────────────────────────────────

Deno.test("GET /organizations/{slug}/members/mfa/enforcement returns { enforced: false } by default", async () => {
  const session = await getTestSession();
  const res = await fetch(`${ORG_URL}/${testSlug}/members/mfa/enforcement`, {
    headers: authHeaders(session.access_token),
  });
  assertEquals(res.status, 200);
  const body = await res.json();
  assertEquals(body.enforced, false);
});

Deno.test("PATCH /organizations/{slug}/members/mfa/enforcement toggles to true", async () => {
  const session = await getTestSession();
  const res = await fetch(`${ORG_URL}/${testSlug}/members/mfa/enforcement`, {
    method: "PATCH",
    headers: authHeaders(session.access_token),
    body: JSON.stringify({ enforced: true }),
  });
  assertEquals(res.status, 200);
  const body = await res.json();
  assertEquals(body.enforced, true);
});

Deno.test("GET /organizations/{slug}/members/mfa/enforcement confirms enforced=true", async () => {
  const session = await getTestSession();
  const res = await fetch(`${ORG_URL}/${testSlug}/members/mfa/enforcement`, {
    headers: authHeaders(session.access_token),
  });
  assertEquals(res.status, 200);
  const body = await res.json();
  assertEquals(body.enforced, true);
});

Deno.test("MFA toggle creates an audit log entry", async () => {
  const session = await getTestSession();
  const now = new Date().toISOString();
  const past = new Date(Date.now() - 60000).toISOString();
  const res = await fetch(
    `${ORG_URL}/${testSlug}/audit?iso_timestamp_start=${past}&iso_timestamp_end=${now}`,
    { headers: authHeaders(session.access_token) },
  );
  assertEquals(res.status, 200);
  const body = await res.json();
  const mfaEntry = body.result.find((e: { action: { name: string } }) => e.action.name === "organizations.mfa_update");
  assertExists(mfaEntry, "Should have an audit entry for MFA update");
});

// ── SSO Provider CRUD ───────────────────────────────────

Deno.test("GET /organizations/{slug}/sso returns 404 when no provider configured", async () => {
  const session = await getTestSession();
  const res = await fetch(`${ORG_URL}/${testSlug}/sso`, {
    headers: authHeaders(session.access_token),
  });
  assertEquals(res.status, 404);
  const body = await res.json();
  assertExists(body.message);
});

Deno.test("POST /organizations/{slug}/sso creates SSO provider", async () => {
  const session = await getTestSession();
  const res = await fetch(`${ORG_URL}/${testSlug}/sso`, {
    method: "POST",
    headers: authHeaders(session.access_token),
    body: JSON.stringify({
      enabled: true,
      domains: ["example.com"],
      metadata_xml_url: "https://idp.example.com/metadata",
      email_mapping: ["email"],
    }),
  });
  assertEquals(res.status, 201);
  const provider = await res.json();
  assertExists(provider.id);
  assertEquals(provider.organization_id, testOrgId);
  assertEquals(provider.enabled, true);
  assert(Array.isArray(provider.domains));
  assertEquals(provider.domains[0], "example.com");
  assertEquals(provider.metadata_xml_url, "https://idp.example.com/metadata");
});

Deno.test("GET /organizations/{slug}/sso returns the created provider", async () => {
  const session = await getTestSession();
  const res = await fetch(`${ORG_URL}/${testSlug}/sso`, {
    headers: authHeaders(session.access_token),
  });
  assertEquals(res.status, 200);
  const provider = await res.json();
  assertExists(provider.id);
  assertEquals(provider.enabled, true);
  assertEquals(provider.domains[0], "example.com");
});

Deno.test("PUT /organizations/{slug}/sso updates SSO provider", async () => {
  const session = await getTestSession();
  const res = await fetch(`${ORG_URL}/${testSlug}/sso`, {
    method: "PUT",
    headers: authHeaders(session.access_token),
    body: JSON.stringify({
      enabled: false,
      domains: ["example.com", "example.org"],
    }),
  });
  assertEquals(res.status, 200);
  const provider = await res.json();
  assertEquals(provider.enabled, false);
  assertEquals(provider.domains.length, 2);
});

Deno.test("DELETE /organizations/{slug}/sso removes SSO provider", async () => {
  const session = await getTestSession();
  const res = await fetch(`${ORG_URL}/${testSlug}/sso`, {
    method: "DELETE",
    headers: authHeaders(session.access_token),
  });
  assertEquals(res.status, 200);
  await res.body?.cancel();
});

Deno.test("GET /organizations/{slug}/sso returns 404 after deletion", async () => {
  const session = await getTestSession();
  const res = await fetch(`${ORG_URL}/${testSlug}/sso`, {
    headers: authHeaders(session.access_token),
  });
  assertEquals(res.status, 404);
  await res.body?.cancel();
});

Deno.test("DELETE /organizations/{slug}/sso returns 404 when none exists", async () => {
  const session = await getTestSession();
  const res = await fetch(`${ORG_URL}/${testSlug}/sso`, {
    method: "DELETE",
    headers: authHeaders(session.access_token),
  });
  assertEquals(res.status, 404);
  await res.body?.cancel();
});

// ── Org Update: opt_in_tags ─────────────────────────────

Deno.test("PATCH /organizations/{slug} with opt_in_tags updates correctly", async () => {
  const session = await getTestSession();
  const res = await fetch(`${ORG_URL}/${testSlug}`, {
    method: "PATCH",
    headers: authHeaders(session.access_token),
    body: JSON.stringify({ opt_in_tags: ["AI_SQL_GENERATOR_OPT_IN"] }),
  });
  assertEquals(res.status, 200);
  const org = await res.json();
  assert(Array.isArray(org.opt_in_tags));
  assert(org.opt_in_tags.includes("AI_SQL_GENERATOR_OPT_IN"));
});

// ── Cleanup ─────────────────────────────────────────────

Deno.test("cleanup: delete settings test org", async () => {
  const session = await getTestSession();
  const res = await fetch(`${ORG_URL}/${testSlug}`, {
    method: "DELETE",
    headers: authHeaders(session.access_token),
  });
  assertEquals(res.status, 200);
  await res.body?.cancel();
});
