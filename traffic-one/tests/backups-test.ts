import { assert, assertEquals, assertExists } from "jsr:@std/assert@1";
import { createClient } from "npm:@supabase/supabase-js@2";
import "jsr:@std/dotenv/load";

const supabaseUrl = Deno.env.get("SUPABASE_URL")!;
const supabaseKey = Deno.env.get("SUPABASE_ANON_KEY")!;
const supabase = createClient(supabaseUrl, supabaseKey, {
  auth: { autoRefreshToken: false, persistSession: false, detectSessionInUrl: false },
});

const DATABASE_URL = `${supabaseUrl}/api/platform/database`;
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

Deno.test("GET /database/{ref}/backups returns 401 without auth", async () => {
  const res = await fetch(`${DATABASE_URL}/some-ref/backups`);
  assertEquals(res.status, 401);
  await res.body?.cancel();
});

Deno.test("POST /database/{ref}/backups/restore returns 401 without auth", async () => {
  const res = await fetch(`${DATABASE_URL}/some-ref/backups/restore`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: "{}",
  });
  assertEquals(res.status, 401);
  await res.body?.cancel();
});

// ── Setup test project ──────────────────────────────────

let testOrgSlug: string | null = null;
let testRef: string | null = null;

Deno.test("setup: create test org and project for backups tests", async () => {
  const session = await getTestSession();

  const orgName = `Backups Test Org ${Date.now()}`;
  const orgRes = await fetch(ORG_URL, {
    method: "POST",
    headers: authHeaders(session.access_token),
    body: JSON.stringify({ name: orgName, tier: "tier_free" }),
  });
  assertEquals(orgRes.status, 201);
  const org = await orgRes.json();
  testOrgSlug = org.slug;

  const projectName = `Backups Test Project ${Date.now()}`;
  const projRes = await fetch(PROJECTS_URL, {
    method: "POST",
    headers: authHeaders(session.access_token),
    body: JSON.stringify({
      name: projectName,
      organization_slug: testOrgSlug,
      db_region: "local",
    }),
  });
  assertEquals(projRes.status, 201);
  const project = await projRes.json();
  testRef = project.ref;
});

// ── Unknown ref → 404 ────────────────────────────────────

Deno.test("GET /database/{unknownRef}/backups returns 404", async () => {
  const session = await getTestSession();
  const res = await fetch(`${DATABASE_URL}/nonexistent00000000/backups`, {
    headers: authHeaders(session.access_token),
  });
  assertEquals(res.status, 404);
  await res.body?.cancel();
});

// ── GET /backups ─────────────────────────────────────────

Deno.test("GET /database/{ref}/backups returns BackupsResponse shape", async () => {
  if (!testRef) return;
  const session = await getTestSession();
  const res = await fetch(`${DATABASE_URL}/${testRef}/backups`, {
    headers: authHeaders(session.access_token),
  });
  assertEquals(res.status, 200);

  const body = await res.json();
  assert(Array.isArray(body.backups));
  assertEquals(body.backups.length, 0);
  assertEquals(typeof body.physicalBackupData, "object");
  assertEquals(body.pitr_enabled, false);
  assertEquals(body.walg_enabled, false);
  assertExists(body.region);
});

// ── GET /backups/downloadable-backups ────────────────────

Deno.test("GET /database/{ref}/backups/downloadable-backups returns empty list", async () => {
  if (!testRef) return;
  const session = await getTestSession();
  const res = await fetch(
    `${DATABASE_URL}/${testRef}/backups/downloadable-backups`,
    { headers: authHeaders(session.access_token) },
  );
  assertEquals(res.status, 200);

  const body = await res.json();
  assert(Array.isArray(body.backups));
  assertEquals(body.backups.length, 0);
  assertEquals(body.status, "ok");
});

// ── POST mutations → 501 ─────────────────────────────────

const UNSUPPORTED_PATHS = [
  "/backups/download",
  "/backups/restore",
  "/backups/restore-physical",
  "/backups/enable-physical-backups",
  "/backups/pitr",
  "/clone",
];

for (const subPath of UNSUPPORTED_PATHS) {
  Deno.test(`POST /database/{ref}${subPath} returns 501 self_hosted_unsupported`, async () => {
    if (!testRef) return;
    const session = await getTestSession();
    const res = await fetch(`${DATABASE_URL}/${testRef}${subPath}`, {
      method: "POST",
      headers: authHeaders(session.access_token),
      body: "{}",
    });
    assertEquals(res.status, 501);
    const body = await res.json();
    assertEquals(body.code, "self_hosted_unsupported");
    assertExists(body.message);
  });
}

// ── GET /clone ───────────────────────────────────────────

Deno.test("GET /database/{ref}/clone returns CloneBackupsResponse shape", async () => {
  if (!testRef) return;
  const session = await getTestSession();
  const res = await fetch(`${DATABASE_URL}/${testRef}/clone`, {
    headers: authHeaders(session.access_token),
  });
  assertEquals(res.status, 200);
  const body = await res.json();
  assert(Array.isArray(body.backups));
  assertEquals(body.backups.length, 0);
  assertEquals(body.pitr_enabled, false);
  assertEquals(body.walg_enabled, false);
  assertExists(body.region);
  assertExists(body.target_compute_size);
  assertEquals(typeof body.target_volume_size_gb, "number");
});

// ── GET /clone/status ────────────────────────────────────

Deno.test("GET /database/{ref}/clone/status returns { clones: [] }", async () => {
  if (!testRef) return;
  const session = await getTestSession();
  const res = await fetch(`${DATABASE_URL}/${testRef}/clone/status`, {
    headers: authHeaders(session.access_token),
  });
  assertEquals(res.status, 200);
  const body = await res.json();
  assert(Array.isArray(body.clones));
  assertEquals(body.clones.length, 0);
  assertExists(body.ref);
});

// ── POST /hook-enable ────────────────────────────────────

Deno.test("POST /database/{ref}/hook-enable returns 200 with { enabled: true }", async () => {
  if (!testRef) return;
  const session = await getTestSession();
  const res = await fetch(`${DATABASE_URL}/${testRef}/hook-enable`, {
    method: "POST",
    headers: authHeaders(session.access_token),
  });
  assertEquals(res.status, 200);
  const body = await res.json();
  assertEquals(body.enabled, true);
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
