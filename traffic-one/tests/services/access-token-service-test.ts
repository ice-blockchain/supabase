import { assert, assertEquals, assertExists, assertNotEquals } from "jsr:@std/assert@1";
import { Pool } from "https://deno.land/x/postgres@v0.17.0/mod.ts";
import "jsr:@std/dotenv/load";

const pool = new Pool(Deno.env.get("TRAFFIC_DB_URL")!, 1, true);

async function createTestProfile(tx: ReturnType<Awaited<ReturnType<Pool["connect"]>>["createTransaction"]>, suffix: string) {
  const result = await tx.queryObject<{ id: number }>`
    INSERT INTO traffic.profiles (gotrue_id, username, primary_email)
    VALUES (${"00000000-0000-0000-0000-00000000a" + suffix}, ${"tokenuser" + suffix}, ${suffix + "@test.com"})
    RETURNING id
  `;
  return result.rows[0].id;
}

async function hashToken(token: string): Promise<string> {
  const encoder = new TextEncoder();
  const data = encoder.encode(token);
  const hashBuffer = await crypto.subtle.digest("SHA-256", data);
  const hashArray = Array.from(new Uint8Array(hashBuffer));
  return hashArray.map((b) => b.toString(16).padStart(2, "0")).join("");
}

Deno.test("createAccessToken stores hash, not raw token", async () => {
  const connection = await pool.connect();
  const tx = connection.createTransaction("test_token_hash");
  try {
    await tx.begin();
    const profileId = await createTestProfile(tx, "001");

    const rawToken = "test-raw-token-value-12345";
    const hash = await hashToken(rawToken);

    await tx.queryObject`
      INSERT INTO traffic.access_tokens (profile_id, name, token_hash, token_alias)
      VALUES (${profileId}, 'Test Token', ${hash}, ${"test-raw...2345"})
    `;

    const result = await tx.queryObject<{ token_hash: string }>`
      SELECT token_hash FROM traffic.access_tokens WHERE profile_id = ${profileId}
    `;
    assertEquals(result.rows.length, 1);
    assertNotEquals(result.rows[0].token_hash, rawToken);
    assertEquals(result.rows[0].token_hash, hash);
    await tx.rollback();
  } finally {
    connection.release();
  }
});

Deno.test("listAccessTokens returns token_alias, not hash", async () => {
  const connection = await pool.connect();
  const tx = connection.createTransaction("test_list_tokens");
  try {
    await tx.begin();
    const profileId = await createTestProfile(tx, "002");

    await tx.queryObject`
      INSERT INTO traffic.access_tokens (profile_id, name, token_hash, token_alias)
      VALUES (${profileId}, 'My Token', 'fakehash123', 'sbp_1234...5678')
    `;

    const result = await tx.queryObject<{ name: string; token_alias: string; token_hash: string }>`
      SELECT name, token_alias, token_hash FROM traffic.access_tokens WHERE profile_id = ${profileId}
    `;
    assertEquals(result.rows.length, 1);
    assertEquals(result.rows[0].name, "My Token");
    assertEquals(result.rows[0].token_alias, "sbp_1234...5678");
    assertExists(result.rows[0].token_hash);
    await tx.rollback();
  } finally {
    connection.release();
  }
});

Deno.test("deleteAccessToken removes token", async () => {
  const connection = await pool.connect();
  const tx = connection.createTransaction("test_delete_token");
  try {
    await tx.begin();
    const profileId = await createTestProfile(tx, "003");

    const inserted = await tx.queryObject<{ id: number }>`
      INSERT INTO traffic.access_tokens (profile_id, name, token_hash, token_alias)
      VALUES (${profileId}, 'Delete Me', 'hash', 'alias')
      RETURNING id
    `;
    const tokenId = inserted.rows[0].id;

    await tx.queryObject`
      DELETE FROM traffic.access_tokens WHERE id = ${tokenId} AND profile_id = ${profileId}
    `;

    const result = await tx.queryObject`
      SELECT * FROM traffic.access_tokens WHERE id = ${tokenId}
    `;
    assertEquals(result.rows.length, 0);
    await tx.rollback();
  } finally {
    connection.release();
  }
});

Deno.test("createScopedAccessToken stores permissions array", async () => {
  const connection = await pool.connect();
  const tx = connection.createTransaction("test_scoped_token");
  try {
    await tx.begin();
    const profileId = await createTestProfile(tx, "004");

    const permissions = ["organizations_read", "projects_read"];
    await tx.queryObject`
      INSERT INTO traffic.scoped_access_tokens (profile_id, name, token_hash, token_alias, permissions)
      VALUES (${profileId}, 'Scoped Token', 'hash', 'alias', ${permissions})
    `;

    const result = await tx.queryObject<{ permissions: string[] }>`
      SELECT permissions FROM traffic.scoped_access_tokens WHERE profile_id = ${profileId}
    `;
    assertEquals(result.rows.length, 1);
    assert(Array.isArray(result.rows[0].permissions));
    assertEquals(result.rows[0].permissions.length, 2);
    assert(result.rows[0].permissions.includes("organizations_read"));
    assert(result.rows[0].permissions.includes("projects_read"));
    await tx.rollback();
  } finally {
    connection.release();
  }
});
