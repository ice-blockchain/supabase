import { assertEquals } from "jsr:@std/assert@1";
import { Pool } from "https://deno.land/x/postgres@v0.17.0/mod.ts";
import "jsr:@std/dotenv/load";

const pool = new Pool(Deno.env.get("TRAFFIC_DB_URL")!, 1, true);

async function createTestProfile(tx: ReturnType<Awaited<ReturnType<Pool["connect"]>>["createTransaction"]>, suffix: string) {
  const result = await tx.queryObject<{ id: number }>`
    INSERT INTO traffic.profiles (gotrue_id, username, primary_email)
    VALUES (${"00000000-0000-0000-0000-00000000b" + suffix}, ${"notifuser" + suffix}, ${suffix + "@test.com"})
    RETURNING id
  `;
  return result.rows[0].id;
}

Deno.test("list notifications returns empty for new profile", async () => {
  const connection = await pool.connect();
  const tx = connection.createTransaction("test_empty_notifications");
  try {
    await tx.begin();
    const profileId = await createTestProfile(tx, "001");

    const result = await tx.queryObject`
      SELECT * FROM traffic.notifications WHERE profile_id = ${profileId}
    `;
    assertEquals(result.rows.length, 0);
    await tx.rollback();
  } finally {
    connection.release();
  }
});

Deno.test("insert and retrieve notification", async () => {
  const connection = await pool.connect();
  const tx = connection.createTransaction("test_insert_notification");
  try {
    await tx.begin();
    const profileId = await createTestProfile(tx, "002");

    await tx.queryObject`
      INSERT INTO traffic.notifications (profile_id, name, data, meta, priority, status)
      VALUES (${profileId}, 'Test Notification', '{"key":"value"}'::jsonb, '{}'::jsonb, 'Warning', 'new')
    `;

    const result = await tx.queryObject<{ name: string; priority: string; status: string }>`
      SELECT name, priority, status FROM traffic.notifications WHERE profile_id = ${profileId}
    `;
    assertEquals(result.rows.length, 1);
    assertEquals(result.rows[0].name, "Test Notification");
    assertEquals(result.rows[0].priority, "Warning");
    assertEquals(result.rows[0].status, "new");
    await tx.rollback();
  } finally {
    connection.release();
  }
});

Deno.test("update notification status", async () => {
  const connection = await pool.connect();
  const tx = connection.createTransaction("test_update_notification_status");
  try {
    await tx.begin();
    const profileId = await createTestProfile(tx, "003");

    const inserted = await tx.queryObject<{ id: string }>`
      INSERT INTO traffic.notifications (profile_id, name, priority, status)
      VALUES (${profileId}, 'Status Test', 'Info', 'new')
      RETURNING id
    `;
    const notifId = inserted.rows[0].id;

    await tx.queryObject`
      UPDATE traffic.notifications SET status = 'seen' WHERE id = ${notifId}::uuid
    `;

    const result = await tx.queryObject<{ status: string }>`
      SELECT status FROM traffic.notifications WHERE id = ${notifId}::uuid
    `;
    assertEquals(result.rows[0].status, "seen");
    await tx.rollback();
  } finally {
    connection.release();
  }
});

Deno.test("bulk update notification status", async () => {
  const connection = await pool.connect();
  const tx = connection.createTransaction("test_bulk_update");
  try {
    await tx.begin();
    const profileId = await createTestProfile(tx, "004");

    const n1 = await tx.queryObject<{ id: string }>`
      INSERT INTO traffic.notifications (profile_id, name, priority, status)
      VALUES (${profileId}, 'Notif 1', 'Info', 'new') RETURNING id
    `;
    const n2 = await tx.queryObject<{ id: string }>`
      INSERT INTO traffic.notifications (profile_id, name, priority, status)
      VALUES (${profileId}, 'Notif 2', 'Warning', 'new') RETURNING id
    `;

    const ids = [n1.rows[0].id, n2.rows[0].id];
    await tx.queryObject`
      UPDATE traffic.notifications SET status = 'archived' WHERE id = ANY(${ids}::uuid[])
    `;

    const result = await tx.queryObject<{ status: string }>`
      SELECT status FROM traffic.notifications WHERE profile_id = ${profileId}
    `;
    assertEquals(result.rows.length, 2);
    result.rows.forEach((r) => assertEquals(r.status, "archived"));
    await tx.rollback();
  } finally {
    connection.release();
  }
});
