import { assert, assertEquals, assertExists } from "jsr:@std/assert@1";
import { createClient } from "npm:@supabase/supabase-js@2";
import "jsr:@std/dotenv/load";

const supabaseUrl = Deno.env.get("SUPABASE_URL")!;
const supabaseKey = Deno.env.get("SUPABASE_ANON_KEY")!;
const supabase = createClient(supabaseUrl, supabaseKey, {
  auth: { autoRefreshToken: false, persistSession: false, detectSessionInUrl: false },
});

const V1_PROJECTS_URL = `${supabaseUrl}/api/v1/projects`;
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

Deno.test("PUT /v1/projects/{ref}/database/migrations returns 401 without auth", async () => {
  const res = await fetch(`${V1_PROJECTS_URL}/some-ref/database/migrations`, {
    method: "PUT",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ query: "SELECT 1" }),
  });
  assertEquals(res.status, 401);
  await res.body?.cancel();
});

Deno.test("GET /v1/projects/{ref}/database/migrations returns 401 without auth", async () => {
  const res = await fetch(`${V1_PROJECTS_URL}/some-ref/database/migrations`);
  assertEquals(res.status, 401);
  await res.body?.cancel();
});

// ── Setup ────────────────────────────────────────────────

let testOrgSlug: string | null = null;
let testRef: string | null = null;
const uniqueVersion = `${Date.now()}`;

Deno.test("setup: create test org and project for migrations tests", async () => {
  const session = await getTestSession();

  const orgName = `Migrations Test Org ${Date.now()}`;
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
      name: `Migrations Test Project ${Date.now()}`,
      organization_slug: testOrgSlug,
      db_region: "local",
    }),
  });
  assertEquals(projRes.status, 201);
  const project = await projRes.json();
  testRef = project.ref;
});

// ── Unknown ref → 404 ────────────────────────────────────

Deno.test("PUT /v1/projects/{unknownRef}/database/migrations returns 404", async () => {
  const session = await getTestSession();
  const res = await fetch(
    `${V1_PROJECTS_URL}/nonexistent00000000/database/migrations`,
    {
      method: "PUT",
      headers: authHeaders(session.access_token),
      body: JSON.stringify({
        version: uniqueVersion,
        name: "test",
        statements: ["SELECT 1"],
      }),
    },
  );
  assertEquals(res.status, 404);
  await res.body?.cancel();
});

// ── Happy path: PUT inserts a new migration ──────────────

Deno.test("PUT /v1/projects/{ref}/database/migrations returns 201 with inserted row", async () => {
  if (!testRef) return;
  const session = await getTestSession();
  const res = await fetch(
    `${V1_PROJECTS_URL}/${testRef}/database/migrations`,
    {
      method: "PUT",
      headers: authHeaders(session.access_token),
      body: JSON.stringify({
        version: uniqueVersion,
        name: "initial_schema",
        statements: ["CREATE TABLE t (id int)", "INSERT INTO t VALUES (1)"],
      }),
    },
  );
  assertEquals(res.status, 201);
  const body = await res.json();
  assertEquals(body.version, uniqueVersion);
  assertEquals(body.name, "initial_schema");
  assert(Array.isArray(body.statements));
  assertEquals(body.statements.length, 2);
});

// ── Duplicate version returns 409 ────────────────────────

Deno.test("PUT /v1/projects/{ref}/database/migrations with duplicate version returns 409", async () => {
  if (!testRef) return;
  const session = await getTestSession();
  const res = await fetch(
    `${V1_PROJECTS_URL}/${testRef}/database/migrations`,
    {
      method: "PUT",
      headers: authHeaders(session.access_token),
      body: JSON.stringify({
        version: uniqueVersion,
        name: "initial_schema",
        statements: ["CREATE TABLE t (id int)"],
      }),
    },
  );
  assertEquals(res.status, 409);
  const body = await res.json();
  assertEquals(body.code, "conflict");
  assertExists(body.message);
});

// ── PUT with { query } body (Studio format) ──────────────

Deno.test("PUT /v1/projects/{ref}/database/migrations accepts { query } body", async () => {
  if (!testRef) return;
  const session = await getTestSession();
  const version = `${Date.now()}_query`;
  const res = await fetch(
    `${V1_PROJECTS_URL}/${testRef}/database/migrations`,
    {
      method: "PUT",
      headers: authHeaders(session.access_token),
      body: JSON.stringify({
        version,
        name: "add_column",
        query: "ALTER TABLE t ADD COLUMN v text",
      }),
    },
  );
  assertEquals(res.status, 201);
  const body = await res.json();
  assertEquals(body.version, version);
  assertEquals(body.name, "add_column");
  assertEquals(body.statements.length, 1);
  assertEquals(body.statements[0], "ALTER TABLE t ADD COLUMN v text");
});

// ── GET returns the inserted migrations ──────────────────

Deno.test("GET /v1/projects/{ref}/database/migrations returns array with inserted rows", async () => {
  if (!testRef) return;
  const session = await getTestSession();
  const res = await fetch(
    `${V1_PROJECTS_URL}/${testRef}/database/migrations`,
    { headers: authHeaders(session.access_token) },
  );
  assertEquals(res.status, 200);
  const body = await res.json();
  assert(Array.isArray(body));
  assert(body.length >= 1);

  const found = body.find((m: { version: string }) => m.version === uniqueVersion);
  assertExists(found, "Inserted migration should appear in list");
  assertEquals(found.name, "initial_schema");
  assert(Array.isArray(found.statements));
});

// ── Invalid body returns 400 ─────────────────────────────

Deno.test("PUT /v1/projects/{ref}/database/migrations without query/statements returns 400", async () => {
  if (!testRef) return;
  const session = await getTestSession();
  const res = await fetch(
    `${V1_PROJECTS_URL}/${testRef}/database/migrations`,
    {
      method: "PUT",
      headers: authHeaders(session.access_token),
      body: JSON.stringify({ version: `${Date.now()}_empty`, name: "empty" }),
    },
  );
  assertEquals(res.status, 400);
  await res.body?.cancel();
});

// ── Idempotency-Key as version fallback ──────────────────

Deno.test("PUT /v1/projects/{ref}/database/migrations with Idempotency-Key falls back to it for version", async () => {
  if (!testRef) return;
  const session = await getTestSession();
  const idemKey = `${Date.now()}_idem`;
  const res = await fetch(
    `${V1_PROJECTS_URL}/${testRef}/database/migrations`,
    {
      method: "PUT",
      headers: {
        ...authHeaders(session.access_token),
        "Idempotency-Key": idemKey,
      },
      body: JSON.stringify({ query: "SELECT 1", name: "via_idempotency" }),
    },
  );
  assertEquals(res.status, 201);
  const body = await res.json();
  assertEquals(body.version, idemKey);
});

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
