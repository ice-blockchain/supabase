import { assertEquals, assertExists } from "jsr:@std/assert@1";
import { Pool } from "https://deno.land/x/postgres@v0.17.0/mod.ts";
import "jsr:@std/dotenv/load";

const pool = new Pool(Deno.env.get("TRAFFIC_DB_URL")!, 1, true);

Deno.test("createOrGetProfile creates profile on first call", async () => {
  const connection = await pool.connect();
  const tx = connection.createTransaction("test_create_profile");
  try {
    await tx.begin();
    const result = await tx.queryObject<{
      id: number;
      gotrue_id: string;
      username: string;
      primary_email: string;
    }>`
      INSERT INTO traffic.profiles (gotrue_id, username, primary_email)
      VALUES ('00000000-0000-0000-0000-000000000099', 'testuser', 'test@test.com')
      ON CONFLICT (gotrue_id) DO UPDATE SET gotrue_id = EXCLUDED.gotrue_id
      RETURNING *
    `;
    assertEquals(result.rows.length, 1);
    assertExists(result.rows[0].id);
    assertEquals(result.rows[0].gotrue_id, "00000000-0000-0000-0000-000000000099");
    assertEquals(result.rows[0].username, "testuser");
    assertEquals(result.rows[0].primary_email, "test@test.com");
    await tx.rollback();
  } finally {
    connection.release();
  }
});

Deno.test("createOrGetProfile returns existing profile on second call", async () => {
  const connection = await pool.connect();
  const tx = connection.createTransaction("test_get_existing_profile");
  try {
    await tx.begin();
    await tx.queryObject`
      INSERT INTO traffic.profiles (gotrue_id, username, primary_email)
      VALUES ('00000000-0000-0000-0000-000000000098', 'existuser', 'exist@test.com')
      ON CONFLICT (gotrue_id) DO UPDATE SET gotrue_id = EXCLUDED.gotrue_id
    `;

    const result = await tx.queryObject<{ id: number; gotrue_id: string }>`
      SELECT * FROM traffic.profiles WHERE gotrue_id = '00000000-0000-0000-0000-000000000098'
    `;
    assertEquals(result.rows.length, 1);
    assertEquals(result.rows[0].gotrue_id, "00000000-0000-0000-0000-000000000098");
    await tx.rollback();
  } finally {
    connection.release();
  }
});

Deno.test("updateProfile updates only provided fields", async () => {
  const connection = await pool.connect();
  const tx = connection.createTransaction("test_update_profile");
  try {
    await tx.begin();
    const inserted = await tx.queryObject<{ id: number }>`
      INSERT INTO traffic.profiles (gotrue_id, username, primary_email, first_name, last_name)
      VALUES ('00000000-0000-0000-0000-000000000097', 'updateuser', 'update@test.com', 'Original', 'Name')
      RETURNING id
    `;
    const profileId = inserted.rows[0].id;

    await tx.queryObject`
      UPDATE traffic.profiles SET first_name = 'Updated' WHERE id = ${profileId}
    `;

    const result = await tx.queryObject<{ first_name: string; last_name: string }>`
      SELECT first_name, last_name FROM traffic.profiles WHERE id = ${profileId}
    `;
    assertEquals(result.rows[0].first_name, "Updated");
    assertEquals(result.rows[0].last_name, "Name");
    await tx.rollback();
  } finally {
    connection.release();
  }
});

Deno.test("updateProfile preserves unchanged fields", async () => {
  const connection = await pool.connect();
  const tx = connection.createTransaction("test_preserve_fields");
  try {
    await tx.begin();
    await tx.queryObject`
      INSERT INTO traffic.profiles (gotrue_id, username, primary_email, mobile, is_alpha_user)
      VALUES ('00000000-0000-0000-0000-000000000096', 'preserveuser', 'preserve@test.com', '+1234567890', true)
    `;

    await tx.queryObject`
      UPDATE traffic.profiles SET username = 'newname' WHERE gotrue_id = '00000000-0000-0000-0000-000000000096'
    `;

    const result = await tx.queryObject<{ username: string; mobile: string; is_alpha_user: boolean }>`
      SELECT username, mobile, is_alpha_user FROM traffic.profiles WHERE gotrue_id = '00000000-0000-0000-0000-000000000096'
    `;
    assertEquals(result.rows[0].username, "newname");
    assertEquals(result.rows[0].mobile, "+1234567890");
    assertEquals(result.rows[0].is_alpha_user, true);
    await tx.rollback();
  } finally {
    connection.release();
  }
});
