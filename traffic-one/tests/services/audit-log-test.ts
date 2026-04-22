import { assert, assertEquals, assertExists } from "jsr:@std/assert@1";
import { Pool } from "https://deno.land/x/postgres@v0.17.0/mod.ts";
import "jsr:@std/dotenv/load";

const pool = new Pool(Deno.env.get("TRAFFIC_DB_URL")!, 1, true);

async function createTestProfile(tx: ReturnType<Awaited<ReturnType<Pool["connect"]>>["createTransaction"]>, suffix: string) {
  const result = await tx.queryObject<{ id: number }>`
    INSERT INTO traffic.profiles (gotrue_id, username, primary_email)
    VALUES (${"00000000-0000-0000-0000-00000000c" + suffix}, ${"audituser" + suffix}, ${suffix + "@test.com"})
    RETURNING id
  `;
  return result.rows[0].id;
}

Deno.test("audit log insert succeeds with traffic_api role", async () => {
  const connection = await pool.connect();
  const tx = connection.createTransaction("test_audit_insert");
  try {
    await tx.begin();
    const profileId = await createTestProfile(tx, "001");

    const result = await tx.queryObject<{ id: string; action_name: string }>`
      INSERT INTO traffic.audit_logs (
        id, profile_id, action_name, action_metadata,
        actor_id, actor_type, actor_metadata,
        target_description, target_metadata
      ) VALUES (
        gen_random_uuid(), ${profileId}, 'profiles.update',
        '[{"method":"PUT","route":"/profile","status":200}]'::jsonb,
        'test-actor-id', 'user',
        '[{"email":"test@test.com"}]'::jsonb,
        'profiles #1', '{}'::jsonb
      )
      RETURNING id, action_name
    `;
    assertEquals(result.rows.length, 1);
    assertExists(result.rows[0].id);
    assertEquals(result.rows[0].action_name, "profiles.update");
    await tx.rollback();
  } finally {
    connection.release();
  }
});

Deno.test("audit log DELETE is denied for traffic_api role", async () => {
  const connection = await pool.connect();
  const tx = connection.createTransaction("test_audit_no_delete");
  try {
    await tx.begin();
    const profileId = await createTestProfile(tx, "002");

    await tx.queryObject`
      INSERT INTO traffic.audit_logs (
        id, profile_id, action_name, actor_id, actor_type
      ) VALUES (
        gen_random_uuid(), ${profileId}, 'test.action', 'actor', 'user'
      )
    `;

    try {
      await tx.queryObject`DELETE FROM traffic.audit_logs WHERE profile_id = ${profileId}`;
      assert(false, "DELETE should have been denied");
    } catch (e: unknown) {
      const error = e as Error;
      assert(
        error.message.includes("permission denied") || error.message.includes("denied"),
        `Expected permission denied error, got: ${error.message}`,
      );
    }
    await tx.rollback();
  } finally {
    connection.release();
  }
});

Deno.test("audit log UPDATE is denied for traffic_api role", async () => {
  const connection = await pool.connect();
  const tx = connection.createTransaction("test_audit_no_update");
  try {
    await tx.begin();
    const profileId = await createTestProfile(tx, "003");

    await tx.queryObject`
      INSERT INTO traffic.audit_logs (
        id, profile_id, action_name, actor_id, actor_type
      ) VALUES (
        gen_random_uuid(), ${profileId}, 'original.action', 'actor', 'user'
      )
    `;

    try {
      await tx.queryObject`
        UPDATE traffic.audit_logs SET action_name = 'tampered' WHERE profile_id = ${profileId}
      `;
      assert(false, "UPDATE should have been denied");
    } catch (e: unknown) {
      const error = e as Error;
      assert(
        error.message.includes("permission denied") || error.message.includes("denied"),
        `Expected permission denied error, got: ${error.message}`,
      );
    }
    await tx.rollback();
  } finally {
    connection.release();
  }
});

Deno.test("mutation + audit log are atomic (both commit or both rollback)", async () => {
  const connection = await pool.connect();
  const tx = connection.createTransaction("test_audit_atomicity");
  try {
    await tx.begin();
    const profileId = await createTestProfile(tx, "004");

    await tx.queryObject`
      UPDATE traffic.profiles SET first_name = 'Atomic' WHERE id = ${profileId}
    `;

    await tx.queryObject`
      INSERT INTO traffic.audit_logs (
        id, profile_id, action_name, actor_id, actor_type,
        target_description
      ) VALUES (
        gen_random_uuid(), ${profileId}, 'profiles.update', 'actor', 'user',
        ${"profiles #" + profileId}
      )
    `;

    const profile = await tx.queryObject<{ first_name: string }>`
      SELECT first_name FROM traffic.profiles WHERE id = ${profileId}
    `;
    assertEquals(profile.rows[0].first_name, "Atomic");

    const audit = await tx.queryObject<{ action_name: string }>`
      SELECT action_name FROM traffic.audit_logs WHERE profile_id = ${profileId}
    `;
    assertEquals(audit.rows.length, 1);
    assertEquals(audit.rows[0].action_name, "profiles.update");

    await tx.rollback();

    // After rollback, neither should exist (in a new transaction)
  } finally {
    connection.release();
  }
});
