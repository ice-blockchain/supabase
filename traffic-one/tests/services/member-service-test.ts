import { assert, assertEquals } from "jsr:@std/assert@1";
import { Pool } from "https://deno.land/x/postgres@v0.17.0/mod.ts";
import "jsr:@std/dotenv/load";

const pool = new Pool(Deno.env.get("TRAFFIC_DB_URL")!, 1, true);

async function createTestProfile(
  tx: ReturnType<Awaited<ReturnType<Pool["connect"]>>["createTransaction"]>,
  suffix: string,
) {
  const result = await tx.queryObject<{ id: number; gotrue_id: string }>`
    INSERT INTO traffic.profiles (gotrue_id, username, primary_email)
    VALUES (${"00000000-0000-0000-0000-000000mem" + suffix}, ${"memuser" + suffix}, ${suffix + "@memtest.com"})
    RETURNING id, gotrue_id::text
  `;
  return result.rows[0];
}

async function createTestOrg(
  tx: ReturnType<Awaited<ReturnType<Pool["connect"]>>["createTransaction"]>,
  slug: string,
) {
  const result = await tx.queryObject<{ id: number }>`
    INSERT INTO traffic.organizations (name, slug)
    VALUES (${"Org " + slug}, ${slug})
    RETURNING id
  `;
  return result.rows[0].id;
}

async function addMember(
  tx: ReturnType<Awaited<ReturnType<Pool["connect"]>>["createTransaction"]>,
  orgId: number,
  profileId: number,
  role: string,
) {
  await tx.queryObject`
    INSERT INTO traffic.organization_members (organization_id, profile_id, role)
    VALUES (${orgId}, ${profileId}, ${role})
  `;
}

// ── Roles table seed ─────────────────────────────────────

Deno.test("roles table contains 4 seeded roles", async () => {
  const connection = await pool.connect();
  try {
    const result = await connection.queryObject<{ id: number; name: string; base_role_id: number }>`
      SELECT id, name, base_role_id FROM traffic.roles ORDER BY id ASC
    `;
    assertEquals(result.rows.length, 4);
    assertEquals(result.rows[0].id, 2);
    assertEquals(result.rows[0].name, "Read only");
    assertEquals(result.rows[3].id, 5);
    assertEquals(result.rows[3].name, "Owner");
  } finally {
    connection.release();
  }
});

// ── Organization member roles CRUD ───────────────────────

Deno.test("insert and select organization_member_roles", async () => {
  const connection = await pool.connect();
  const tx = connection.createTransaction("test_member_roles_insert");
  try {
    await tx.begin();
    const profile = await createTestProfile(tx, "mr01");
    const orgId = await createTestOrg(tx, "mr-test-01");
    await addMember(tx, orgId, profile.id, "owner");

    await tx.queryObject`
      INSERT INTO traffic.organization_member_roles (organization_id, profile_id, role_id)
      VALUES (${orgId}, ${profile.id}, 5)
    `;

    const roles = await tx.queryObject<{ role_id: number }>`
      SELECT role_id FROM traffic.organization_member_roles
      WHERE organization_id = ${orgId} AND profile_id = ${profile.id}
    `;
    assertEquals(roles.rows.length, 1);
    assertEquals(roles.rows[0].role_id, 5);

    await tx.rollback();
  } finally {
    connection.release();
  }
});

Deno.test("organization_member_roles unique constraint prevents duplicate role assignment", async () => {
  const connection = await pool.connect();
  const tx = connection.createTransaction("test_member_roles_unique");
  try {
    await tx.begin();
    const profile = await createTestProfile(tx, "mr02");
    const orgId = await createTestOrg(tx, "mr-test-02");
    await addMember(tx, orgId, profile.id, "owner");

    await tx.queryObject`
      INSERT INTO traffic.organization_member_roles (organization_id, profile_id, role_id)
      VALUES (${orgId}, ${profile.id}, 5)
    `;

    let threw = false;
    try {
      await tx.queryObject`
        INSERT INTO traffic.organization_member_roles (organization_id, profile_id, role_id)
        VALUES (${orgId}, ${profile.id}, 5)
      `;
    } catch {
      threw = true;
    }
    assert(threw, "Duplicate role assignment should throw a constraint error");

    await tx.rollback();
  } finally {
    connection.release();
  }
});

Deno.test("multiple roles can be assigned to the same member", async () => {
  const connection = await pool.connect();
  const tx = connection.createTransaction("test_member_multi_roles");
  try {
    await tx.begin();
    const profile = await createTestProfile(tx, "mr03");
    const orgId = await createTestOrg(tx, "mr-test-03");
    await addMember(tx, orgId, profile.id, "owner");

    await tx.queryObject`
      INSERT INTO traffic.organization_member_roles (organization_id, profile_id, role_id)
      VALUES (${orgId}, ${profile.id}, 5)
    `;
    await tx.queryObject`
      INSERT INTO traffic.organization_member_roles (organization_id, profile_id, role_id)
      VALUES (${orgId}, ${profile.id}, 4)
    `;

    const roles = await tx.queryObject<{ role_id: number }>`
      SELECT role_id FROM traffic.organization_member_roles
      WHERE organization_id = ${orgId} AND profile_id = ${profile.id}
      ORDER BY role_id ASC
    `;
    assertEquals(roles.rows.length, 2);
    assertEquals(roles.rows[0].role_id, 4);
    assertEquals(roles.rows[1].role_id, 5);

    await tx.rollback();
  } finally {
    connection.release();
  }
});

// ── Invitations CRUD ─────────────────────────────────────

Deno.test("insert and select invitation", async () => {
  const connection = await pool.connect();
  const tx = connection.createTransaction("test_invitation_insert");
  try {
    await tx.begin();
    const orgId = await createTestOrg(tx, "inv-test-01");

    const inv = await tx.queryObject<{ id: number; token: string; invited_email: string; role_id: number }>`
      INSERT INTO traffic.invitations (organization_id, invited_email, role_id)
      VALUES (${orgId}, 'invited@example.com', 3)
      RETURNING id, token, invited_email, role_id
    `;
    assertEquals(inv.rows.length, 1);
    assertEquals(inv.rows[0].invited_email, "invited@example.com");
    assertEquals(inv.rows[0].role_id, 3);
    assert(inv.rows[0].token.length > 0, "Token should be generated");

    const fetched = await tx.queryObject<{ id: number }>`
      SELECT id FROM traffic.invitations
      WHERE organization_id = ${orgId} AND invited_email = 'invited@example.com'
    `;
    assertEquals(fetched.rows.length, 1);
    assertEquals(fetched.rows[0].id, inv.rows[0].id);

    await tx.rollback();
  } finally {
    connection.release();
  }
});

Deno.test("invitation token lookup works", async () => {
  const connection = await pool.connect();
  const tx = connection.createTransaction("test_invitation_token");
  try {
    await tx.begin();
    const orgId = await createTestOrg(tx, "inv-test-02");

    const inv = await tx.queryObject<{ token: string }>`
      INSERT INTO traffic.invitations (organization_id, invited_email, role_id)
      VALUES (${orgId}, 'token@example.com', 4)
      RETURNING token
    `;

    const found = await tx.queryObject<{ invited_email: string }>`
      SELECT invited_email FROM traffic.invitations WHERE token = ${inv.rows[0].token}::uuid
    `;
    assertEquals(found.rows.length, 1);
    assertEquals(found.rows[0].invited_email, "token@example.com");

    await tx.rollback();
  } finally {
    connection.release();
  }
});

Deno.test("invitation delete removes the record", async () => {
  const connection = await pool.connect();
  const tx = connection.createTransaction("test_invitation_delete");
  try {
    await tx.begin();
    const orgId = await createTestOrg(tx, "inv-test-03");

    const inv = await tx.queryObject<{ id: number }>`
      INSERT INTO traffic.invitations (organization_id, invited_email, role_id)
      VALUES (${orgId}, 'delete@example.com', 3)
      RETURNING id
    `;

    await tx.queryObject`
      DELETE FROM traffic.invitations WHERE id = ${inv.rows[0].id}
    `;

    const remaining = await tx.queryObject<{ cnt: number }>`
      SELECT COUNT(*)::int AS cnt FROM traffic.invitations WHERE id = ${inv.rows[0].id}
    `;
    assertEquals(remaining.rows[0].cnt, 0);

    await tx.rollback();
  } finally {
    connection.release();
  }
});

Deno.test("invitation has 24h expiry by default", async () => {
  const connection = await pool.connect();
  const tx = connection.createTransaction("test_invitation_expiry");
  try {
    await tx.begin();
    const orgId = await createTestOrg(tx, "inv-test-04");

    const inv = await tx.queryObject<{ invited_at: string; expires_at: string }>`
      INSERT INTO traffic.invitations (organization_id, invited_email, role_id)
      VALUES (${orgId}, 'expiry@example.com', 3)
      RETURNING invited_at, expires_at
    `;

    const invitedAt = new Date(inv.rows[0].invited_at).getTime();
    const expiresAt = new Date(inv.rows[0].expires_at).getTime();
    const diffHours = (expiresAt - invitedAt) / (1000 * 60 * 60);
    assert(diffHours >= 23.9 && diffHours <= 24.1, `Expected ~24h expiry, got ${diffHours}h`);

    await tx.rollback();
  } finally {
    connection.release();
  }
});

// ── Cascade deletes ──────────────────────────────────────

Deno.test("deleting organization cascades to member_roles and invitations", async () => {
  const connection = await pool.connect();
  const tx = connection.createTransaction("test_cascade");
  try {
    await tx.begin();
    const profile = await createTestProfile(tx, "mr04");
    const orgId = await createTestOrg(tx, "cascade-test");
    await addMember(tx, orgId, profile.id, "owner");

    await tx.queryObject`
      INSERT INTO traffic.organization_member_roles (organization_id, profile_id, role_id)
      VALUES (${orgId}, ${profile.id}, 5)
    `;
    await tx.queryObject`
      INSERT INTO traffic.invitations (organization_id, invited_email, role_id)
      VALUES (${orgId}, 'cascade@example.com', 3)
    `;

    await tx.queryObject`DELETE FROM traffic.organizations WHERE id = ${orgId}`;

    const roles = await tx.queryObject<{ cnt: number }>`
      SELECT COUNT(*)::int AS cnt FROM traffic.organization_member_roles WHERE organization_id = ${orgId}
    `;
    assertEquals(roles.rows[0].cnt, 0, "Member roles should be cascade-deleted");

    const invitations = await tx.queryObject<{ cnt: number }>`
      SELECT COUNT(*)::int AS cnt FROM traffic.invitations WHERE organization_id = ${orgId}
    `;
    assertEquals(invitations.rows[0].cnt, 0, "Invitations should be cascade-deleted");

    await tx.rollback();
  } finally {
    connection.release();
  }
});

// ── Member listing with role aggregation ─────────────────

Deno.test("list members aggregates role_ids from junction table", async () => {
  const connection = await pool.connect();
  const tx = connection.createTransaction("test_list_members");
  try {
    await tx.begin();
    const profile = await createTestProfile(tx, "mr05");
    const orgId = await createTestOrg(tx, "list-test");
    await addMember(tx, orgId, profile.id, "owner");

    await tx.queryObject`
      INSERT INTO traffic.organization_member_roles (organization_id, profile_id, role_id)
      VALUES (${orgId}, ${profile.id}, 5)
    `;
    await tx.queryObject`
      INSERT INTO traffic.organization_member_roles (organization_id, profile_id, role_id)
      VALUES (${orgId}, ${profile.id}, 4)
    `;

    const result = await tx.queryObject<{
      gotrue_id: string;
      role_ids: number[];
    }>`
      SELECT
        p.gotrue_id::text,
        COALESCE(
          array_agg(omr.role_id ORDER BY omr.role_id) FILTER (WHERE omr.role_id IS NOT NULL),
          '{}'
        ) AS role_ids
      FROM traffic.organization_members om
      JOIN traffic.profiles p ON p.id = om.profile_id
      LEFT JOIN traffic.organization_member_roles omr
        ON omr.organization_id = om.organization_id AND omr.profile_id = om.profile_id
      WHERE om.organization_id = ${orgId}
      GROUP BY p.gotrue_id
    `;

    assertEquals(result.rows.length, 1);
    assertEquals(result.rows[0].role_ids, [4, 5]);

    await tx.rollback();
  } finally {
    connection.release();
  }
});

// ── Project-scoped role refs ─────────────────────────────

Deno.test("organization_member_roles stores project_refs", async () => {
  const connection = await pool.connect();
  const tx = connection.createTransaction("test_project_refs");
  try {
    await tx.begin();
    const profile = await createTestProfile(tx, "mr06");
    const orgId = await createTestOrg(tx, "proj-ref-test");
    await addMember(tx, orgId, profile.id, "developer");

    await tx.queryObject`
      INSERT INTO traffic.organization_member_roles (organization_id, profile_id, role_id, project_refs)
      VALUES (${orgId}, ${profile.id}, 3, ${{ '{proj-a,proj-b}': undefined } && ['proj-a', 'proj-b']})
    `;

    const result = await tx.queryObject<{ project_refs: string[] }>`
      SELECT project_refs FROM traffic.organization_member_roles
      WHERE organization_id = ${orgId} AND profile_id = ${profile.id}
    `;
    assertEquals(result.rows[0].project_refs, ["proj-a", "proj-b"]);

    await tx.rollback();
  } finally {
    connection.release();
  }
});
