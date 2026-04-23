import { assert, assertEquals, assertExists } from "jsr:@std/assert@1";
import { createClient } from "npm:@supabase/supabase-js@2";
import "jsr:@std/dotenv/load";

const supabaseUrl = Deno.env.get("SUPABASE_URL")!;
const supabaseKey = Deno.env.get("SUPABASE_ANON_KEY")!;
const supabase = createClient(supabaseUrl, supabaseKey, {
  auth: { autoRefreshToken: false, persistSession: false, detectSessionInUrl: false },
});

const REPLICATION_URL = `${supabaseUrl}/api/platform/replication`;
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

Deno.test("GET /replication/{ref}/destinations returns 401 without auth", async () => {
  const res = await fetch(`${REPLICATION_URL}/some-ref/destinations`);
  assertEquals(res.status, 401);
  await res.body?.cancel();
});

Deno.test("POST /replication/{ref}/destinations returns 401 without auth", async () => {
  const res = await fetch(`${REPLICATION_URL}/some-ref/destinations`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: "{}",
  });
  assertEquals(res.status, 401);
  await res.body?.cancel();
});

// ── Setup ────────────────────────────────────────────────

let testOrgSlug: string | null = null;
let testRef: string | null = null;

Deno.test("setup: create test org and project for replication tests", async () => {
  const session = await getTestSession();

  const orgName = `Replication Test Org ${Date.now()}`;
  const orgRes = await fetch(ORG_URL, {
    method: "POST",
    headers: authHeaders(session.access_token),
    body: JSON.stringify({ name: orgName, tier: "tier_free" }),
  });
  assertEquals(orgRes.status, 201);
  const org = await orgRes.json();
  testOrgSlug = org.slug;

  const projRes = await fetch(PROJECTS_URL, {
    method: "POST",
    headers: authHeaders(session.access_token),
    body: JSON.stringify({
      name: `Replication Test Project ${Date.now()}`,
      organization_slug: testOrgSlug,
      db_region: "local",
    }),
  });
  assertEquals(projRes.status, 201);
  const project = await projRes.json();
  testRef = project.ref;
});

// ── Unknown ref → 404 ────────────────────────────────────

Deno.test("GET /replication/{unknownRef}/destinations returns 404", async () => {
  const session = await getTestSession();
  const res = await fetch(
    `${REPLICATION_URL}/nonexistent00000000/destinations`,
    { headers: authHeaders(session.access_token) },
  );
  assertEquals(res.status, 404);
  await res.body?.cancel();
});

// ── GET list endpoints return wrapped empty arrays ───────

const LIST_ENDPOINTS: Array<{ path: string; key: string }> = [
  { path: "/destinations", key: "destinations" },
  { path: "/pipelines", key: "pipelines" },
  { path: "/sources", key: "sources" },
  { path: "/destinations-pipelines", key: "destinations_pipelines" },
  { path: "/tenants-sources", key: "tenants_sources" },
];

for (const { path, key } of LIST_ENDPOINTS) {
  Deno.test(`GET /replication/{ref}${path} returns { ${key}: [] }`, async () => {
    if (!testRef) return;
    const session = await getTestSession();
    const res = await fetch(`${REPLICATION_URL}/${testRef}${path}`, {
      headers: authHeaders(session.access_token),
    });
    assertEquals(res.status, 200);
    const body = await res.json();
    assert(Array.isArray(body[key]), `${key} should be an array`);
    assertEquals(body[key].length, 0);
  });
}

// ── Nested GETs ──────────────────────────────────────────

Deno.test("GET /replication/{ref}/pipelines/{id} returns 404", async () => {
  if (!testRef) return;
  const session = await getTestSession();
  const res = await fetch(`${REPLICATION_URL}/${testRef}/pipelines/999`, {
    headers: authHeaders(session.access_token),
  });
  assertEquals(res.status, 404);
  await res.body?.cancel();
});

Deno.test("GET /replication/{ref}/pipelines/{id}/status returns pipeline_id + status.name", async () => {
  if (!testRef) return;
  const session = await getTestSession();
  const res = await fetch(
    `${REPLICATION_URL}/${testRef}/pipelines/1/status`,
    { headers: authHeaders(session.access_token) },
  );
  assertEquals(res.status, 200);
  const body = await res.json();
  assertEquals(body.pipeline_id, 1);
  assertExists(body.status);
  assertExists(body.status.name);
});

Deno.test("GET /replication/{ref}/pipelines/{id}/replication-status returns empty arrays", async () => {
  if (!testRef) return;
  const session = await getTestSession();
  const res = await fetch(
    `${REPLICATION_URL}/${testRef}/pipelines/1/replication-status`,
    { headers: authHeaders(session.access_token) },
  );
  assertEquals(res.status, 200);
  const body = await res.json();
  assertEquals(body.pipeline_id, 1);
  assert(Array.isArray(body.replication_slots));
  assert(Array.isArray(body.table_statuses));
});

Deno.test("GET /replication/{ref}/pipelines/{id}/version returns empty versions", async () => {
  if (!testRef) return;
  const session = await getTestSession();
  const res = await fetch(
    `${REPLICATION_URL}/${testRef}/pipelines/1/version`,
    { headers: authHeaders(session.access_token) },
  );
  assertEquals(res.status, 200);
  const body = await res.json();
  assertEquals(body.pipeline_id, 1);
  assert(Array.isArray(body.versions));
});

Deno.test("GET /replication/{ref}/sources/{id}/tables returns { tables: [] }", async () => {
  if (!testRef) return;
  const session = await getTestSession();
  const res = await fetch(
    `${REPLICATION_URL}/${testRef}/sources/1/tables`,
    { headers: authHeaders(session.access_token) },
  );
  assertEquals(res.status, 200);
  const body = await res.json();
  assert(Array.isArray(body.tables));
  assertEquals(body.tables.length, 0);
});

Deno.test("GET /replication/{ref}/sources/{id}/publications returns { publications: [] }", async () => {
  if (!testRef) return;
  const session = await getTestSession();
  const res = await fetch(
    `${REPLICATION_URL}/${testRef}/sources/1/publications`,
    { headers: authHeaders(session.access_token) },
  );
  assertEquals(res.status, 200);
  const body = await res.json();
  assert(Array.isArray(body.publications));
  assertEquals(body.publications.length, 0);
});

// ── POST mutations → 501 ─────────────────────────────────

type MutationCase = {
  path: string;
  method: "POST" | "PATCH" | "PUT" | "DELETE";
};

const MUTATIONS: MutationCase[] = [
  { path: "/destinations", method: "POST" },
  { path: "/destinations/validate", method: "POST" },
  { path: "/destinations-pipelines", method: "POST" },
  { path: "/destinations-pipelines/1/2", method: "POST" },
  { path: "/destinations-pipelines/1/2", method: "DELETE" },
  { path: "/tenants-sources", method: "POST" },
  { path: "/pipelines", method: "POST" },
  { path: "/pipelines/validate", method: "POST" },
  { path: "/pipelines/1/start", method: "POST" },
  { path: "/pipelines/1/stop", method: "POST" },
  { path: "/pipelines/1/rollback-tables", method: "POST" },
  { path: "/pipelines/1/version", method: "POST" },
  { path: "/sources/1/publications", method: "POST" },
  { path: "/sources/1/publications/pub_name", method: "POST" },
  { path: "/sources/1/publications/pub_name", method: "DELETE" },
];

for (const { path, method } of MUTATIONS) {
  Deno.test(`${method} /replication/{ref}${path} returns 501 self_hosted_unsupported`, async () => {
    if (!testRef) return;
    const session = await getTestSession();
    const res = await fetch(`${REPLICATION_URL}/${testRef}${path}`, {
      method,
      headers: authHeaders(session.access_token),
      body: method === "DELETE" ? undefined : "{}",
    });
    assertEquals(res.status, 501);
    const body = await res.json();
    assertEquals(body.code, "self_hosted_unsupported");
    assertExists(body.message);
  });
}

// ── Cleanup ──────────────────────────────────────────────

Deno.test("cleanup: delete test project and org", async () => {
  const session = await getTestSession();
  if (testRef) {
    const res = await fetch(`${PROJECTS_URL}/${testRef}`, {
      method: "DELETE",
      headers: authHeaders(session.access_token),
    });
    await res.body?.cancel();
  }
  if (testOrgSlug) {
    const res = await fetch(`${ORG_URL}/${testOrgSlug}`, {
      method: "DELETE",
      headers: authHeaders(session.access_token),
    });
    await res.body?.cancel();
  }
});
