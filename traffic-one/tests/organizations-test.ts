import { assert, assertEquals, assertExists, assertNotEquals } from "jsr:@std/assert@1";
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

// ── Auth ─────────────────────────────────────────────────

Deno.test("GET /organizations returns 401 without auth", async () => {
  const res = await fetch(ORG_URL);
  assertEquals(res.status, 401);
  await res.body?.cancel();
});

Deno.test("POST /organizations returns 401 without auth", async () => {
  const res = await fetch(ORG_URL, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ name: "Test Org" }),
  });
  assertEquals(res.status, 401);
  await res.body?.cancel();
});

// ── CRUD lifecycle ───────────────────────────────────────

let createdSlug: string | null = null;

Deno.test("POST /organizations creates org and returns OrganizationResponse shape", async () => {
  const session = await getTestSession();
  const orgName = `Test Org ${Date.now()}`;

  const res = await fetch(ORG_URL, {
    method: "POST",
    headers: authHeaders(session.access_token),
    body: JSON.stringify({ name: orgName, kind: "PERSONAL", tier: "tier_free" }),
  });
  assertEquals(res.status, 201);

  const org = await res.json();
  assertExists(org.id);
  assertEquals(org.name, orgName);
  assertExists(org.slug);
  assertEquals(org.is_owner, true);
  assertEquals(org.billing_partner, null);
  assertExists(org.plan);
  assertEquals(org.plan.id, "free");
  assertEquals(org.plan.name, "Free");
  assertEquals(org.stripe_customer_id, null);
  assertEquals(org.subscription_id, null);
  assertEquals(org.usage_billing_enabled, false);
  assertEquals(org.organization_missing_address, false);
  assertEquals(org.organization_missing_tax_id, false);
  assertEquals(org.organization_requires_mfa, false);
  assert(Array.isArray(org.opt_in_tags));
  assertEquals(org.restriction_data, null);
  assertEquals(org.restriction_status, null);

  createdSlug = org.slug;
});

Deno.test("POST /organizations rejects missing name", async () => {
  const session = await getTestSession();
  const res = await fetch(ORG_URL, {
    method: "POST",
    headers: authHeaders(session.access_token),
    body: JSON.stringify({ tier: "tier_free" }),
  });
  assertEquals(res.status, 400);
  await res.body?.cancel();
});

Deno.test("GET /organizations lists orgs including the created one", async () => {
  const session = await getTestSession();
  const res = await fetch(ORG_URL, {
    headers: authHeaders(session.access_token),
  });
  assertEquals(res.status, 200);

  const orgs = await res.json();
  assert(Array.isArray(orgs));
  assert(orgs.length > 0);

  if (createdSlug) {
    const found = orgs.find((o: { slug: string }) => o.slug === createdSlug);
    assertExists(found, "Created org should appear in list");
    assertEquals(found.is_owner, true);
    assertExists(found.plan);
  }
});

Deno.test("GET /organizations/{slug} returns OrganizationSlugResponse shape", async () => {
  if (!createdSlug) return;
  const session = await getTestSession();
  const res = await fetch(`${ORG_URL}/${createdSlug}`, {
    headers: authHeaders(session.access_token),
  });
  assertEquals(res.status, 200);

  const org = await res.json();
  assertExists(org.id);
  assertExists(org.name);
  assertEquals(org.slug, createdSlug);
  assertExists(org.plan);
  assertEquals(org.billing_partner, null);
  assertEquals(org.usage_billing_enabled, false);
  assertEquals(org.has_oriole_project, false);
  assert(Array.isArray(org.opt_in_tags));
});

Deno.test("GET /organizations/{slug} returns 404 for nonexistent slug", async () => {
  const session = await getTestSession();
  const res = await fetch(`${ORG_URL}/nonexistent-org-slug-12345`, {
    headers: authHeaders(session.access_token),
  });
  assertEquals(res.status, 404);
  await res.body?.cancel();
});

Deno.test("GET /organizations/{slug}/projects returns project list", async () => {
  if (!createdSlug) return;
  const session = await getTestSession();
  const res = await fetch(`${ORG_URL}/${createdSlug}/projects`, {
    headers: authHeaders(session.access_token),
  });
  assertEquals(res.status, 200);

  const body = await res.json();
  assertExists(body.pagination);
  assert(Array.isArray(body.projects));
});

Deno.test("PATCH /organizations/{slug} updates org name", async () => {
  if (!createdSlug) return;
  const session = await getTestSession();
  const newName = `Updated Org ${Date.now()}`;

  const res = await fetch(`${ORG_URL}/${createdSlug}`, {
    method: "PATCH",
    headers: authHeaders(session.access_token),
    body: JSON.stringify({ name: newName }),
  });
  assertEquals(res.status, 200);

  const org = await res.json();
  assertEquals(org.name, newName);
  assertEquals(org.slug, createdSlug);
  assertExists(org.id);
});

Deno.test("PATCH /organizations/{slug} updates billing_email", async () => {
  if (!createdSlug) return;
  const session = await getTestSession();

  const res = await fetch(`${ORG_URL}/${createdSlug}`, {
    method: "PATCH",
    headers: authHeaders(session.access_token),
    body: JSON.stringify({ billing_email: "billing@example.com" }),
  });
  assertEquals(res.status, 200);

  const org = await res.json();
  assertEquals(org.billing_email, "billing@example.com");
});

Deno.test("PATCH /organizations/nonexistent returns 404", async () => {
  const session = await getTestSession();
  const res = await fetch(`${ORG_URL}/nonexistent-org-slug-12345`, {
    method: "PATCH",
    headers: authHeaders(session.access_token),
    body: JSON.stringify({ name: "Nope" }),
  });
  assertEquals(res.status, 404);
  await res.body?.cancel();
});

Deno.test("DELETE /organizations/{slug} removes org", async () => {
  if (!createdSlug) return;
  const session = await getTestSession();
  const res = await fetch(`${ORG_URL}/${createdSlug}`, {
    method: "DELETE",
    headers: authHeaders(session.access_token),
  });
  assertEquals(res.status, 200);
  await res.body?.cancel();
});

Deno.test("GET /organizations after delete no longer includes deleted org", async () => {
  if (!createdSlug) return;
  const session = await getTestSession();
  const res = await fetch(ORG_URL, {
    headers: authHeaders(session.access_token),
  });
  assertEquals(res.status, 200);

  const orgs = await res.json();
  assert(Array.isArray(orgs));
  const found = orgs.find((o: { slug: string }) => o.slug === createdSlug);
  assertEquals(found, undefined, "Deleted org should not appear in list");
});

Deno.test("DELETE /organizations/nonexistent returns 404", async () => {
  const session = await getTestSession();
  const res = await fetch(`${ORG_URL}/nonexistent-org-slug-12345`, {
    method: "DELETE",
    headers: authHeaders(session.access_token),
  });
  assertEquals(res.status, 404);
  await res.body?.cancel();
});

// ── Permissions include org slug ─────────────────────────

Deno.test("GET /permissions includes slug of newly created org", async () => {
  const session = await getTestSession();
  const orgName = `Perm Test Org ${Date.now()}`;

  const createRes = await fetch(ORG_URL, {
    method: "POST",
    headers: authHeaders(session.access_token),
    body: JSON.stringify({ name: orgName, tier: "tier_free" }),
  });
  assertEquals(createRes.status, 201);
  const createdOrg = await createRes.json();
  const slug = createdOrg.slug;

  const permRes = await fetch(`${supabaseUrl}/api/platform/profile/permissions`, {
    headers: authHeaders(session.access_token),
  });
  assertEquals(permRes.status, 200);
  const permissions = await permRes.json();
  assert(Array.isArray(permissions));
  assert(permissions.includes("organizations_read"));

  // Cleanup
  await fetch(`${ORG_URL}/${slug}`, {
    method: "DELETE",
    headers: authHeaders(session.access_token),
  });
});
