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

Deno.test("setup: create org for members tests", async () => {
  const session = await getTestSession();
  const res = await fetch(ORG_URL, {
    method: "POST",
    headers: authHeaders(session.access_token),
    body: JSON.stringify({ name: `Members Test Org ${Date.now()}` }),
  });
  assertEquals(res.status, 201);
  const org = await res.json();
  testSlug = org.slug;
  assertExists(testSlug);
});

// ── Auth: 401 without token ─────────────────────────────

Deno.test("GET /organizations/{slug}/members returns 401 without auth", async () => {
  const res = await fetch(`${ORG_URL}/${testSlug}/members`);
  assertEquals(res.status, 401);
  await res.body?.cancel();
});

Deno.test("GET /organizations/{slug}/roles returns 401 without auth", async () => {
  const res = await fetch(`${ORG_URL}/${testSlug}/roles`);
  assertEquals(res.status, 401);
  await res.body?.cancel();
});

// ── List members ─────────────────────────────────────────

Deno.test("GET /organizations/{slug}/members returns owner in member list", async () => {
  const session = await getTestSession();
  const res = await fetch(`${ORG_URL}/${testSlug}/members`, {
    headers: authHeaders(session.access_token),
  });
  assertEquals(res.status, 200);
  const members = await res.json();
  assert(Array.isArray(members));
  assert(members.length >= 1, "Should include at least the owner");

  const owner = members.find((m: { gotrue_id: string }) => m.gotrue_id === session.user.id);
  assertExists(owner, "Owner should appear in member list");
  assert(Array.isArray(owner.role_ids), "Should have role_ids array");
  assertExists(owner.username);
  assertExists(owner.primary_email);
});

// ── List roles ───────────────────────────────────────────

Deno.test("GET /organizations/{slug}/roles returns role catalog", async () => {
  const session = await getTestSession();
  const res = await fetch(`${ORG_URL}/${testSlug}/roles`, {
    headers: authHeaders(session.access_token),
  });
  assertEquals(res.status, 200);
  const body = await res.json();
  assertExists(body.org_scoped_roles);
  assertExists(body.project_scoped_roles);
  assert(Array.isArray(body.org_scoped_roles));
  assert(body.org_scoped_roles.length >= 4, "Should have at least 4 roles");

  const ownerRole = body.org_scoped_roles.find((r: { name: string }) => r.name === "Owner");
  assertExists(ownerRole);
  assertEquals(ownerRole.id, 5);
  assertEquals(ownerRole.base_role_id, 5);
});

// ── Free project limit ───────────────────────────────────

Deno.test("GET /organizations/{slug}/members/reached-free-project-limit returns array", async () => {
  const session = await getTestSession();
  const res = await fetch(`${ORG_URL}/${testSlug}/members/reached-free-project-limit`, {
    headers: authHeaders(session.access_token),
  });
  assertEquals(res.status, 200);
  const body = await res.json();
  assert(Array.isArray(body));
});

// ── MFA enforcement ──────────────────────────────────────

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

// ── Invitations ──────────────────────────────────────────

Deno.test("GET /organizations/{slug}/members/invitations returns empty initially", async () => {
  const session = await getTestSession();
  const res = await fetch(`${ORG_URL}/${testSlug}/members/invitations`, {
    headers: authHeaders(session.access_token),
  });
  assertEquals(res.status, 200);
  const body = await res.json();
  assertExists(body.invitations);
  assert(Array.isArray(body.invitations));
  assertEquals(body.invitations.length, 0);
});

let createdInvitationId: number;

Deno.test("POST /organizations/{slug}/members/invitations creates invitation", async () => {
  const session = await getTestSession();
  const res = await fetch(`${ORG_URL}/${testSlug}/members/invitations`, {
    method: "POST",
    headers: authHeaders(session.access_token),
    body: JSON.stringify({
      email: "newmember@example.com",
      role_id: 3,
    }),
  });
  assertEquals(res.status, 201);
  const inv = await res.json();
  assertExists(inv.id);
  assertEquals(inv.invited_email, "newmember@example.com");
  assertEquals(inv.role_id, 3);
  createdInvitationId = inv.id;
});

Deno.test("POST /organizations/{slug}/members/invitations rejects duplicate email", async () => {
  const session = await getTestSession();
  const res = await fetch(`${ORG_URL}/${testSlug}/members/invitations`, {
    method: "POST",
    headers: authHeaders(session.access_token),
    body: JSON.stringify({
      email: "newmember@example.com",
      role_id: 3,
    }),
  });
  assertEquals(res.status, 409);
  await res.body?.cancel();
});

Deno.test("POST /organizations/{slug}/members/invitations rejects missing fields", async () => {
  const session = await getTestSession();
  const res = await fetch(`${ORG_URL}/${testSlug}/members/invitations`, {
    method: "POST",
    headers: authHeaders(session.access_token),
    body: JSON.stringify({ email: "missing@example.com" }),
  });
  assertEquals(res.status, 400);
  await res.body?.cancel();
});

Deno.test("GET /organizations/{slug}/members/invitations lists the created invitation", async () => {
  const session = await getTestSession();
  const res = await fetch(`${ORG_URL}/${testSlug}/members/invitations`, {
    headers: authHeaders(session.access_token),
  });
  assertEquals(res.status, 200);
  const body = await res.json();
  assert(body.invitations.length >= 1);
  const found = body.invitations.find((i: { id: number }) => i.id === createdInvitationId);
  assertExists(found, "Created invitation should appear in list");
  assertEquals(found.invited_email, "newmember@example.com");
});

Deno.test("DELETE /organizations/{slug}/members/invitations/{id} removes invitation", async () => {
  const session = await getTestSession();
  const res = await fetch(`${ORG_URL}/${testSlug}/members/invitations/${createdInvitationId}`, {
    method: "DELETE",
    headers: authHeaders(session.access_token),
  });
  assertEquals(res.status, 200);
  await res.body?.cancel();
});

Deno.test("DELETE /organizations/{slug}/members/invitations/{id} returns 404 for nonexistent", async () => {
  const session = await getTestSession();
  const res = await fetch(`${ORG_URL}/${testSlug}/members/invitations/99999`, {
    method: "DELETE",
    headers: authHeaders(session.access_token),
  });
  assertEquals(res.status, 404);
  await res.body?.cancel();
});

Deno.test("GET /organizations/{slug}/members/invitations is empty after deletion", async () => {
  const session = await getTestSession();
  const res = await fetch(`${ORG_URL}/${testSlug}/members/invitations`, {
    headers: authHeaders(session.access_token),
  });
  assertEquals(res.status, 200);
  const body = await res.json();
  assertEquals(body.invitations.length, 0);
});

// ── Role assignment (PATCH member) ───────────────────────

Deno.test("PATCH /organizations/{slug}/members/{gotrue_id} assigns role", async () => {
  const session = await getTestSession();
  const res = await fetch(`${ORG_URL}/${testSlug}/members/${session.user.id}`, {
    method: "PATCH",
    headers: authHeaders(session.access_token),
    body: JSON.stringify({ role_id: 4 }),
  });
  assertEquals(res.status, 200);
  await res.body?.cancel();
});

Deno.test("after role assignment, member list shows new role", async () => {
  const session = await getTestSession();
  const res = await fetch(`${ORG_URL}/${testSlug}/members`, {
    headers: authHeaders(session.access_token),
  });
  assertEquals(res.status, 200);
  const members = await res.json();
  const me = members.find((m: { gotrue_id: string }) => m.gotrue_id === session.user.id);
  assertExists(me);
  assert(me.role_ids.includes(4), "Should have Administrator role");
});

// ── Cannot delete last owner ─────────────────────────────

Deno.test("DELETE /organizations/{slug}/members/{gotrue_id} blocks removing last owner", async () => {
  const session = await getTestSession();
  const res = await fetch(`${ORG_URL}/${testSlug}/members/${session.user.id}`, {
    method: "DELETE",
    headers: authHeaders(session.access_token),
  });
  assertEquals(res.status, 400);
  const body = await res.json();
  assert(body.message.includes("last owner"), "Should explain cannot remove last owner");
});

// ── Cleanup ─────────────────────────────────────────────

Deno.test("cleanup: delete members test org", async () => {
  const session = await getTestSession();
  const res = await fetch(`${ORG_URL}/${testSlug}`, {
    method: "DELETE",
    headers: authHeaders(session.access_token),
  });
  assertEquals(res.status, 200);
  await res.body?.cancel();
});
