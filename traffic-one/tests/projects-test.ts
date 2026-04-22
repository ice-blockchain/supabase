import { assert, assertEquals, assertExists, assertNotEquals } from "jsr:@std/assert@1";
import { createClient } from "npm:@supabase/supabase-js@2";
import "jsr:@std/dotenv/load";

const supabaseUrl = Deno.env.get("SUPABASE_URL")!;
const supabaseKey = Deno.env.get("SUPABASE_ANON_KEY")!;
const supabase = createClient(supabaseUrl, supabaseKey, {
  auth: { autoRefreshToken: false, persistSession: false, detectSessionInUrl: false },
});

const PROJECTS_URL = `${supabaseUrl}/api/platform/projects`;
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

Deno.test("GET /projects returns 401 without auth", async () => {
  const res = await fetch(PROJECTS_URL);
  assertEquals(res.status, 401);
  await res.body?.cancel();
});

Deno.test("POST /projects returns 401 without auth", async () => {
  const res = await fetch(PROJECTS_URL, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ name: "Test", organization_slug: "x" }),
  });
  assertEquals(res.status, 401);
  await res.body?.cancel();
});

// ── CRUD lifecycle ───────────────────────────────────────

let testOrgSlug: string | null = null;
let createdRef: string | null = null;

Deno.test("setup: create test org for projects", async () => {
  const session = await getTestSession();
  const orgName = `Project Test Org ${Date.now()}`;
  const res = await fetch(ORG_URL, {
    method: "POST",
    headers: authHeaders(session.access_token),
    body: JSON.stringify({ name: orgName, tier: "tier_free" }),
  });
  assertEquals(res.status, 201);
  const org = await res.json();
  testOrgSlug = org.slug;
});

Deno.test("POST /projects creates project and returns CreateProjectResponse shape", async () => {
  if (!testOrgSlug) return;
  const session = await getTestSession();
  const projectName = `Test Project ${Date.now()}`;

  const res = await fetch(PROJECTS_URL, {
    method: "POST",
    headers: authHeaders(session.access_token),
    body: JSON.stringify({
      name: projectName,
      organization_slug: testOrgSlug,
      db_region: "local",
    }),
  });
  assertEquals(res.status, 201);

  const project = await res.json();
  assertExists(project.id);
  assertExists(project.ref);
  assertEquals(project.ref.length, 20);
  assertEquals(project.name, projectName);
  assertEquals(project.status, "ACTIVE_HEALTHY");
  assertExists(project.endpoint);
  assertExists(project.anon_key);
  assertExists(project.service_key);
  assertExists(project.organization_id);
  assertEquals(project.organization_slug, testOrgSlug);
  assertEquals(project.region, "local");
  assertEquals(project.is_branch_enabled, false);
  assertEquals(project.is_physical_backups_enabled, false);
  assert(Array.isArray(project.preview_branch_refs));
  assertExists(project.inserted_at);

  createdRef = project.ref;
});

Deno.test("POST /projects rejects missing name", async () => {
  if (!testOrgSlug) return;
  const session = await getTestSession();
  const res = await fetch(PROJECTS_URL, {
    method: "POST",
    headers: authHeaders(session.access_token),
    body: JSON.stringify({ organization_slug: testOrgSlug }),
  });
  assertEquals(res.status, 400);
  await res.body?.cancel();
});

Deno.test("POST /projects rejects invalid org slug", async () => {
  const session = await getTestSession();
  const res = await fetch(PROJECTS_URL, {
    method: "POST",
    headers: authHeaders(session.access_token),
    body: JSON.stringify({ name: "Test", organization_slug: "nonexistent-org" }),
  });
  assertEquals(res.status, 404);
  await res.body?.cancel();
});

// ── List ─────────────────────────────────────────────────

Deno.test("GET /projects returns paginated response including created project", async () => {
  if (!createdRef) return;
  const session = await getTestSession();
  const res = await fetch(PROJECTS_URL, {
    headers: authHeaders(session.access_token),
  });
  assertEquals(res.status, 200);

  const body = await res.json();
  assertExists(body.pagination);
  assert(Array.isArray(body.projects));
  assert(body.pagination.count > 0);

  const found = body.projects.find((p: { ref: string }) => p.ref === createdRef);
  assertExists(found, "Created project should appear in list");
  assertExists(found.organization_slug);
});

// ── Org-scoped list ──────────────────────────────────────

Deno.test("GET /organizations/{slug}/projects returns project with databases array", async () => {
  if (!testOrgSlug || !createdRef) return;
  const session = await getTestSession();
  const res = await fetch(`${ORG_URL}/${testOrgSlug}/projects`, {
    headers: authHeaders(session.access_token),
  });
  assertEquals(res.status, 200);

  const body = await res.json();
  assertExists(body.pagination);
  assert(Array.isArray(body.projects));
  assert(body.projects.length > 0);

  const found = body.projects.find((p: { ref: string }) => p.ref === createdRef);
  assertExists(found, "Created project should appear in org project list");
  assert(Array.isArray(found.databases));
  assert(found.databases.length > 0);
  assertEquals(found.databases[0].identifier, createdRef);
  assertEquals(found.databases[0].type, "PRIMARY");
});

// ── Detail ───────────────────────────────────────────────

Deno.test("GET /projects/{ref} returns ProjectDetailResponse shape", async () => {
  if (!createdRef) return;
  const session = await getTestSession();
  const res = await fetch(`${PROJECTS_URL}/${createdRef}`, {
    headers: authHeaders(session.access_token),
  });
  assertEquals(res.status, 200);

  const project = await res.json();
  assertEquals(project.ref, createdRef);
  assertExists(project.id);
  assertExists(project.name);
  assertExists(project.status);
  assertExists(project.db_host);
  assertExists(project.restUrl);
  assertEquals(project.high_availability, false);
  assertEquals(project.is_branch_enabled, false);
  assertEquals(project.is_physical_backups_enabled, false);
  assertExists(project.inserted_at);
  assertExists(project.updated_at);
});

Deno.test("GET /projects/nonexistent returns 404", async () => {
  const session = await getTestSession();
  const res = await fetch(`${PROJECTS_URL}/nonexistent00000000`, {
    headers: authHeaders(session.access_token),
  });
  assertEquals(res.status, 404);
  await res.body?.cancel();
});

// ── Update ───────────────────────────────────────────────

Deno.test("PATCH /projects/{ref} updates project name", async () => {
  if (!createdRef) return;
  const session = await getTestSession();
  const newName = `Updated Project ${Date.now()}`;

  const res = await fetch(`${PROJECTS_URL}/${createdRef}`, {
    method: "PATCH",
    headers: authHeaders(session.access_token),
    body: JSON.stringify({ name: newName }),
  });
  assertEquals(res.status, 200);

  const project = await res.json();
  assertEquals(project.name, newName);
  assertEquals(project.ref, createdRef);
});

// ── Status ───────────────────────────────────────────────

Deno.test("GET /projects/{ref}/status returns status", async () => {
  if (!createdRef) return;
  const session = await getTestSession();
  const res = await fetch(`${PROJECTS_URL}/${createdRef}/status`, {
    headers: authHeaders(session.access_token),
  });
  assertEquals(res.status, 200);

  const body = await res.json();
  assertEquals(body.status, "ACTIVE_HEALTHY");
});

// ── Pause / Restore ──────────────────────────────────────

Deno.test("POST /projects/{ref}/pause sets status to INACTIVE", async () => {
  if (!createdRef) return;
  const session = await getTestSession();
  const res = await fetch(`${PROJECTS_URL}/${createdRef}/pause`, {
    method: "POST",
    headers: authHeaders(session.access_token),
  });
  assertEquals(res.status, 200);

  // Verify status changed
  const statusRes = await fetch(`${PROJECTS_URL}/${createdRef}/status`, {
    headers: authHeaders(session.access_token),
  });
  const body = await statusRes.json();
  assertEquals(body.status, "INACTIVE");
});

Deno.test("POST /projects/{ref}/restore sets status to ACTIVE_HEALTHY", async () => {
  if (!createdRef) return;
  const session = await getTestSession();
  const res = await fetch(`${PROJECTS_URL}/${createdRef}/restore`, {
    method: "POST",
    headers: authHeaders(session.access_token),
  });
  assertEquals(res.status, 200);

  const statusRes = await fetch(`${PROJECTS_URL}/${createdRef}/status`, {
    headers: authHeaders(session.access_token),
  });
  const body = await statusRes.json();
  assertEquals(body.status, "ACTIVE_HEALTHY");
});

// ── Restart (no-op) ──────────────────────────────────────

Deno.test("POST /projects/{ref}/restart returns 200", async () => {
  if (!createdRef) return;
  const session = await getTestSession();
  const res = await fetch(`${PROJECTS_URL}/${createdRef}/restart`, {
    method: "POST",
    headers: authHeaders(session.access_token),
  });
  assertEquals(res.status, 200);
  await res.body?.cancel();
});

Deno.test("POST /projects/{ref}/restart-services returns 200", async () => {
  if (!createdRef) return;
  const session = await getTestSession();
  const res = await fetch(`${PROJECTS_URL}/${createdRef}/restart-services`, {
    method: "POST",
    headers: authHeaders(session.access_token),
  });
  assertEquals(res.status, 200);
  await res.body?.cancel();
});

// ── Service versions ─────────────────────────────────────

Deno.test("GET /projects/{ref}/service-versions returns object", async () => {
  if (!createdRef) return;
  const session = await getTestSession();
  const res = await fetch(`${PROJECTS_URL}/${createdRef}/service-versions`, {
    headers: authHeaders(session.access_token),
  });
  assertEquals(res.status, 200);
  const body = await res.json();
  assertEquals(typeof body, "object");
});

// ── Resource warnings ────────────────────────────────────

Deno.test("GET /projects-resource-warnings returns empty array", async () => {
  const session = await getTestSession();
  const res = await fetch(`${supabaseUrl}/api/platform/projects-resource-warnings`, {
    headers: authHeaders(session.access_token),
  });
  assertEquals(res.status, 200);
  const body = await res.json();
  assert(Array.isArray(body));
  assertEquals(body.length, 0);
});

// ── Delete ───────────────────────────────────────────────

Deno.test("DELETE /projects/{ref} removes project", async () => {
  if (!createdRef) return;
  const session = await getTestSession();
  const res = await fetch(`${PROJECTS_URL}/${createdRef}`, {
    method: "DELETE",
    headers: authHeaders(session.access_token),
  });
  assertEquals(res.status, 200);
  const body = await res.json();
  assertEquals(body.ref, createdRef);
});

Deno.test("GET /projects/{ref} returns 404 after deletion", async () => {
  if (!createdRef) return;
  const session = await getTestSession();
  const res = await fetch(`${PROJECTS_URL}/${createdRef}`, {
    headers: authHeaders(session.access_token),
  });
  assertEquals(res.status, 404);
  await res.body?.cancel();
});

// ── Cleanup ──────────────────────────────────────────────

Deno.test("cleanup: delete test org", async () => {
  if (!testOrgSlug) return;
  const session = await getTestSession();
  const res = await fetch(`${ORG_URL}/${testOrgSlug}`, {
    method: "DELETE",
    headers: authHeaders(session.access_token),
  });
  assertEquals(res.status, 200);
  await res.body?.cancel();
});
