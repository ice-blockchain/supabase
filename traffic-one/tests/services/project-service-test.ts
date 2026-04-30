import type { Pool } from 'https://deno.land/x/postgres@v0.19.3/mod.ts'
import { assert, assertEquals, assertNotEquals } from 'jsr:@std/assert@1'

import 'jsr:@std/dotenv/load'

import { createRetryingPool } from '../_helpers/pool.ts'

const pool = createRetryingPool(Deno.env.get('TRAFFIC_DB_URL')!)

async function createTestProfile(
  tx: ReturnType<Awaited<ReturnType<Pool['connect']>>['createTransaction']>,
  suffix: string,
) {
  const result = await tx.queryObject<{ id: number }>`
    INSERT INTO traffic.profiles (gotrue_id, username, primary_email)
    VALUES (${'00000000-0000-0000-0000-000000proj' + suffix}, ${'projuser' + suffix}, ${
    suffix + '@projtest.com'
  })
    RETURNING id
  `
  return result.rows[0].id
}

async function createTestOrg(
  tx: ReturnType<Awaited<ReturnType<Pool['connect']>>['createTransaction']>,
  slug: string,
  profileId: number,
) {
  const org = await tx.queryObject<{ id: number }>`
    INSERT INTO traffic.organizations (name, slug)
    VALUES (${'Org ' + slug}, ${slug})
    RETURNING id
  `
  await tx.queryObject`
    INSERT INTO traffic.organization_members (organization_id, profile_id, role)
    VALUES (${org.rows[0].id}, ${profileId}, 'owner')
  `
  return org.rows[0].id
}

// ── Insert / Select ──────────────────────────────────────

Deno.test('insert project and select by ref', async () => {
  await pool.withConnection(async (connection) => {
    const tx = connection.createTransaction('test_project_insert')
    await tx.begin()
    const profileId = await createTestProfile(tx, 'p01')
    const orgId = await createTestOrg(tx, 'proj-test-01', profileId)

    const result = await tx.queryObject<
      { id: number; ref: string; name: string; status: string }
    >`
      INSERT INTO traffic.projects (ref, name, organization_id, status, endpoint, anon_key, db_host)
      VALUES ('abcdef0123456789abcd', 'Test Project', ${orgId}, 'ACTIVE_HEALTHY', 'http://kong:8000', 'anon', 'db')
      RETURNING id, ref, name, status
    `
    assertEquals(result.rows.length, 1)
    assertEquals(result.rows[0].ref, 'abcdef0123456789abcd')
    assertEquals(result.rows[0].name, 'Test Project')
    assertEquals(result.rows[0].status, 'ACTIVE_HEALTHY')

    const selected = await tx.queryObject<{ name: string }>`
      SELECT name FROM traffic.projects WHERE ref = 'abcdef0123456789abcd'
    `
    assertEquals(selected.rows.length, 1)
    assertEquals(selected.rows[0].name, 'Test Project')

    await tx.rollback()
  })
})

// ── Ref uniqueness ───────────────────────────────────────

Deno.test('ref uniqueness constraint prevents duplicates', async () => {
  await pool.withConnection(async (connection) => {
    const tx = connection.createTransaction('test_ref_unique')
    await tx.begin()
    const profileId = await createTestProfile(tx, 'p02')
    const orgId = await createTestOrg(tx, 'proj-test-02', profileId)

    await tx.queryObject`
      INSERT INTO traffic.projects (ref, name, organization_id)
      VALUES ('duplicate_ref_test_01', 'Project A', ${orgId})
    `

    let threw = false
    try {
      await tx.queryObject`
        INSERT INTO traffic.projects (ref, name, organization_id)
        VALUES ('duplicate_ref_test_01', 'Project B', ${orgId})
      `
    } catch {
      threw = true
    }
    assert(threw, 'Duplicate ref should throw a constraint error')

    await tx.rollback()
  })
})

// ── Organization FK constraint ───────────────────────────

Deno.test('cannot create project with non-existent org_id', async () => {
  await pool.withConnection(async (connection) => {
    const tx = connection.createTransaction('test_org_fk')
    await tx.begin()

    let threw = false
    try {
      await tx.queryObject`
        INSERT INTO traffic.projects (ref, name, organization_id)
        VALUES ('fk_test_ref_0000001', 'Orphan', 999999)
      `
    } catch {
      threw = true
    }
    assert(threw, 'Non-existent org_id should throw FK constraint error')

    await tx.rollback()
  })
})

// ── Cascade delete ───────────────────────────────────────

Deno.test('deleting organization cascades to projects', async () => {
  await pool.withConnection(async (connection) => {
    const tx = connection.createTransaction('test_project_cascade')
    await tx.begin()
    const profileId = await createTestProfile(tx, 'p03')
    const orgId = await createTestOrg(tx, 'proj-test-03', profileId)

    await tx.queryObject`
      INSERT INTO traffic.projects (ref, name, organization_id)
      VALUES ('cascade_test_ref_001', 'Cascade Project', ${orgId})
    `

    await tx.queryObject`DELETE FROM traffic.organizations WHERE id = ${orgId}`

    const projects = await tx.queryObject`
      SELECT * FROM traffic.projects WHERE ref = 'cascade_test_ref_001'
    `
    assertEquals(projects.rows.length, 0, 'Project should be cascade-deleted')

    await tx.rollback()
  })
})

// ── Update ───────────────────────────────────────────────

Deno.test('update project name', async () => {
  await pool.withConnection(async (connection) => {
    const tx = connection.createTransaction('test_project_update')
    await tx.begin()
    const profileId = await createTestProfile(tx, 'p04')
    const orgId = await createTestOrg(tx, 'proj-test-04', profileId)

    await tx.queryObject`
      INSERT INTO traffic.projects (ref, name, organization_id)
      VALUES ('update_test_ref_0001', 'Original', ${orgId})
    `

    const updated = await tx.queryObject<{ name: string }>`
      UPDATE traffic.projects SET name = 'Updated', updated_at = now()
      WHERE ref = 'update_test_ref_0001'
      RETURNING name
    `
    assertEquals(updated.rows[0].name, 'Updated')

    await tx.rollback()
  })
})

// ── Pagination ───────────────────────────────────────────

Deno.test('pagination: limit and offset work correctly', async () => {
  await pool.withConnection(async (connection) => {
    const tx = connection.createTransaction('test_project_pagination')
    await tx.begin()
    const profileId = await createTestProfile(tx, 'p05')
    const orgId = await createTestOrg(tx, 'proj-test-05', profileId)

    for (let i = 0; i < 5; i++) {
      await tx.queryObject`
        INSERT INTO traffic.projects (ref, name, organization_id)
        VALUES (${'page_test_ref_00000' + i}, ${'Project ' + i}, ${orgId})
      `
    }

    const page1 = await tx.queryObject<{ ref: string }>`
      SELECT ref FROM traffic.projects WHERE organization_id = ${orgId}
      ORDER BY created_at ASC LIMIT 2 OFFSET 0
    `
    assertEquals(page1.rows.length, 2)

    const page2 = await tx.queryObject<{ ref: string }>`
      SELECT ref FROM traffic.projects WHERE organization_id = ${orgId}
      ORDER BY created_at ASC LIMIT 2 OFFSET 2
    `
    assertEquals(page2.rows.length, 2)
    assertNotEquals(page1.rows[0].ref, page2.rows[0].ref)

    const page3 = await tx.queryObject<{ ref: string }>`
      SELECT ref FROM traffic.projects WHERE organization_id = ${orgId}
      ORDER BY created_at ASC LIMIT 2 OFFSET 4
    `
    assertEquals(page3.rows.length, 1)

    await tx.rollback()
  })
})

// ── Default column values ────────────────────────────────

Deno.test('project defaults: region=local, cloud_provider=FLY, status=COMING_UP', async () => {
  await pool.withConnection(async (connection) => {
    const tx = connection.createTransaction('test_project_defaults')
    await tx.begin()
    const profileId = await createTestProfile(tx, 'p06')
    const orgId = await createTestOrg(tx, 'proj-test-06', profileId)

    const project = await tx.queryObject<{
      region: string
      cloud_provider: string
      status: string
      endpoint: string | null
    }>`
      INSERT INTO traffic.projects (ref, name, organization_id)
      VALUES ('defaults_test_ref_01', 'Defaults Project', ${orgId})
      RETURNING region, cloud_provider, status, endpoint
    `

    assertEquals(project.rows[0].region, 'local')
    assertEquals(project.rows[0].cloud_provider, 'FLY')
    assertEquals(project.rows[0].status, 'COMING_UP')
    assertEquals(project.rows[0].endpoint, null)

    await tx.rollback()
  })
})

// ── Membership-scoped query ──────────────────────────────

Deno.test('list projects returns only projects in orgs the user belongs to', async () => {
  await pool.withConnection(async (connection) => {
    const tx = connection.createTransaction('test_project_membership')
    await tx.begin()
    const profileA = await createTestProfile(tx, 'p07')
    const profileB = await createTestProfile(tx, 'p08')

    const orgA = await createTestOrg(tx, 'proj-test-07a', profileA)
    const orgB = await createTestOrg(tx, 'proj-test-07b', profileB)

    await tx.queryObject`
      INSERT INTO traffic.projects (ref, name, organization_id)
      VALUES ('membership_ref_a_001', 'Project A', ${orgA})
    `
    await tx.queryObject`
      INSERT INTO traffic.projects (ref, name, organization_id)
      VALUES ('membership_ref_b_001', 'Project B', ${orgB})
    `

    const projectsForA = await tx.queryObject<{ ref: string }>`
      SELECT p.ref FROM traffic.projects p
      JOIN traffic.organization_members m ON m.organization_id = p.organization_id
      WHERE m.profile_id = ${profileA}
    `
    assertEquals(projectsForA.rows.length, 1)
    assertEquals(projectsForA.rows[0].ref, 'membership_ref_a_001')

    const projectsForB = await tx.queryObject<{ ref: string }>`
      SELECT p.ref FROM traffic.projects p
      JOIN traffic.organization_members m ON m.organization_id = p.organization_id
      WHERE m.profile_id = ${profileB}
    `
    assertEquals(projectsForB.rows.length, 1)
    assertEquals(projectsForB.rows[0].ref, 'membership_ref_b_001')

    await tx.rollback()
  })
})

// ── Status updates ───────────────────────────────────────

Deno.test('status update: pause sets INACTIVE, restore sets ACTIVE_HEALTHY', async () => {
  await pool.withConnection(async (connection) => {
    const tx = connection.createTransaction('test_project_status')
    await tx.begin()
    const profileId = await createTestProfile(tx, 'p09')
    const orgId = await createTestOrg(tx, 'proj-test-09', profileId)

    await tx.queryObject`
      INSERT INTO traffic.projects (ref, name, organization_id, status)
      VALUES ('status_test_ref_0001', 'Status Project', ${orgId}, 'ACTIVE_HEALTHY')
    `

    await tx.queryObject`
      UPDATE traffic.projects SET status = 'INACTIVE' WHERE ref = 'status_test_ref_0001'
    `
    const paused = await tx.queryObject<{ status: string }>`
      SELECT status FROM traffic.projects WHERE ref = 'status_test_ref_0001'
    `
    assertEquals(paused.rows[0].status, 'INACTIVE')

    await tx.queryObject`
      UPDATE traffic.projects SET status = 'ACTIVE_HEALTHY' WHERE ref = 'status_test_ref_0001'
    `
    const restored = await tx.queryObject<{ status: string }>`
      SELECT status FROM traffic.projects WHERE ref = 'status_test_ref_0001'
    `
    assertEquals(restored.rows[0].status, 'ACTIVE_HEALTHY')

    await tx.rollback()
  })
})
