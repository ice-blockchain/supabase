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

// ── Setup: create a test org for usage tests ─────────────

let testSlug: string | null = null;

Deno.test("setup: create org for usage tests", async () => {
  const session = await getTestSession();
  const orgName = `Usage Test Org ${Date.now()}`;
  const res = await fetch(ORG_URL, {
    method: "POST",
    headers: authHeaders(session.access_token),
    body: JSON.stringify({ name: orgName, tier: "tier_free" }),
  });
  assertEquals(res.status, 201);
  const org = await res.json();
  testSlug = org.slug;
  assertExists(testSlug);
});

// ── Auth ─────────────────────────────────────────────────

Deno.test("GET /organizations/{slug}/usage returns 401 without auth", async () => {
  if (!testSlug) return;
  const res = await fetch(`${ORG_URL}/${testSlug}/usage`);
  assertEquals(res.status, 401);
  await res.body?.cancel();
});

Deno.test("GET /organizations/{slug}/usage/daily returns 401 without auth", async () => {
  if (!testSlug) return;
  const res = await fetch(`${ORG_URL}/${testSlug}/usage/daily`);
  assertEquals(res.status, 401);
  await res.body?.cancel();
});

// ── GET /usage ──────────────────────────────────────────

Deno.test("GET /organizations/{slug}/usage returns OrgUsageResponse shape", async () => {
  if (!testSlug) return;
  const session = await getTestSession();
  const res = await fetch(`${ORG_URL}/${testSlug}/usage`, {
    headers: authHeaders(session.access_token),
  });
  assertEquals(res.status, 200);

  const body = await res.json();
  assertEquals(body.usage_billing_enabled, true);
  assert(Array.isArray(body.usages));
  assert(body.usages.length > 0, "usages array should have entries");

  const dbSizeEntry = body.usages.find((u: { metric: string }) => u.metric === "DATABASE_SIZE");
  assertExists(dbSizeEntry, "DATABASE_SIZE metric should be present");
  assert(typeof dbSizeEntry.usage === "number");
  assert(dbSizeEntry.usage > 0, "DATABASE_SIZE usage should be > 0 (real data)");
  assert(typeof dbSizeEntry.cost === "number");
  assertExists(dbSizeEntry.pricing_strategy);
  assert(Array.isArray(dbSizeEntry.project_allocations));

  const egressEntry = body.usages.find((u: { metric: string }) => u.metric === "EGRESS");
  assertExists(egressEntry, "EGRESS metric should be present");
  assert(typeof egressEntry.pricing_free_units === "number");
  assert(typeof egressEntry.pricing_per_unit_price === "number");
  assertExists(egressEntry.unit_price_desc);

  for (const entry of body.usages) {
    assertExists(entry.metric);
    assert(typeof entry.usage === "number");
    assert(typeof entry.usage_original === "number");
    assert(typeof entry.cost === "number");
    assert(typeof entry.available_in_plan === "boolean");
    assert(typeof entry.capped === "boolean");
    assert(typeof entry.unlimited === "boolean");
    assertExists(entry.pricing_strategy);
    assert(Array.isArray(entry.project_allocations));
    assert(typeof entry.unit_price_desc === "string");
  }
});

Deno.test("GET /organizations/{slug}/usage accepts project_ref query param", async () => {
  if (!testSlug) return;
  const session = await getTestSession();
  const res = await fetch(`${ORG_URL}/${testSlug}/usage?project_ref=default`, {
    headers: authHeaders(session.access_token),
  });
  assertEquals(res.status, 200);
  const body = await res.json();
  assertEquals(body.usage_billing_enabled, true);
  assert(Array.isArray(body.usages));
});

Deno.test("GET /organizations/{slug}/usage returns 404 for nonexistent org", async () => {
  const session = await getTestSession();
  const res = await fetch(`${ORG_URL}/nonexistent-org-slug-usage-99999/usage`, {
    headers: authHeaders(session.access_token),
  });
  assertEquals(res.status, 404);
  await res.body?.cancel();
});

// ── GET /usage/daily ────────────────────────────────────

Deno.test("GET /organizations/{slug}/usage/daily returns OrgDailyUsageResponse shape", async () => {
  if (!testSlug) return;
  const session = await getTestSession();
  const now = new Date();
  const start = new Date(now.getFullYear(), now.getMonth(), 1).toISOString();
  const end = now.toISOString();

  const res = await fetch(
    `${ORG_URL}/${testSlug}/usage/daily?start=${encodeURIComponent(start)}&end=${encodeURIComponent(end)}`,
    { headers: authHeaders(session.access_token) },
  );
  assertEquals(res.status, 200);

  const body = await res.json();
  assert(Array.isArray(body.usages));

  for (const entry of body.usages) {
    assertExists(entry.date);
    assertExists(entry.metric);
    assert(typeof entry.usage === "number");
    assert(typeof entry.usage_original === "number");
  }

  const egressEntries = body.usages.filter((u: { metric: string }) => u.metric === "EGRESS");
  for (const entry of egressEntries) {
    if (entry.breakdown !== null) {
      assert(typeof entry.breakdown.egress_rest === "number");
      assert(typeof entry.breakdown.egress_storage === "number");
      assert(typeof entry.breakdown.egress_realtime === "number");
      assert(typeof entry.breakdown.egress_function === "number");
      assert(typeof entry.breakdown.egress_supavisor === "number");
      assert(typeof entry.breakdown.egress_graphql === "number");
      assert(typeof entry.breakdown.egress_logdrain === "number");
    }
  }
});

Deno.test("GET /organizations/{slug}/usage/daily returns 404 for nonexistent org", async () => {
  const session = await getTestSession();
  const res = await fetch(`${ORG_URL}/nonexistent-org-slug-usage-99999/usage/daily`, {
    headers: authHeaders(session.access_token),
  });
  assertEquals(res.status, 404);
  await res.body?.cancel();
});

// ── Cleanup ──────────────────────────────────────────────

Deno.test("cleanup: delete test org", async () => {
  if (!testSlug) return;
  const session = await getTestSession();
  const res = await fetch(`${ORG_URL}/${testSlug}`, {
    method: "DELETE",
    headers: authHeaders(session.access_token),
  });
  assertEquals(res.status, 200);
  await res.body?.cancel();
});
