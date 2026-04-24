import type { Pool } from 'https://deno.land/x/postgres@v0.19.3/mod.ts'
import { assert, assertEquals } from 'jsr:@std/assert@1'

import 'jsr:@std/dotenv/load'

import { createRetryingPool } from '../_helpers/pool.ts'

const pool = createRetryingPool(Deno.env.get('TRAFFIC_DB_URL')!)

async function createTestProfile(
  tx: ReturnType<Awaited<ReturnType<Pool['connect']>>['createTransaction']>,
  suffix: string,
) {
  const result = await tx.queryObject<{ id: number }>`
    INSERT INTO traffic.profiles (gotrue_id, username, primary_email)
    VALUES (${'00000000-0000-0000-0000-0000000org' + suffix}, ${'orguser' + suffix}, ${
    suffix + '@orgtest.com'
  })
    RETURNING id
  `
  return result.rows[0].id
}

// ── Insert / Select ──────────────────────────────────────

Deno.test('insert organization and select by slug', async () => {
  await pool.withConnection(async (connection) => {
    const tx = connection.createTransaction('test_org_insert')
    await tx.begin()
    const profileId = await createTestProfile(tx, 'o01')

    const orgResult = await tx.queryObject<
      { id: number; slug: string; name: string }
    >`
      INSERT INTO traffic.organizations (name, slug)
      VALUES ('Test Org', 'test-org-o01')
      RETURNING id, slug, name
    `
    assertEquals(orgResult.rows.length, 1)
    assertEquals(orgResult.rows[0].name, 'Test Org')
    assertEquals(orgResult.rows[0].slug, 'test-org-o01')

    await tx.queryObject`
      INSERT INTO traffic.organization_members (organization_id, profile_id, role)
      VALUES (${orgResult.rows[0].id}, ${profileId}, 'owner')
    `

    const memberResult = await tx.queryObject<{ role: string }>`
      SELECT role FROM traffic.organization_members
      WHERE organization_id = ${orgResult.rows[0].id} AND profile_id = ${profileId}
    `
    assertEquals(memberResult.rows.length, 1)
    assertEquals(memberResult.rows[0].role, 'owner')

    await tx.rollback()
  })
})

// ── Slug uniqueness ──────────────────────────────────────

Deno.test('slug uniqueness constraint prevents duplicates', async () => {
  await pool.withConnection(async (connection) => {
    const tx = connection.createTransaction('test_slug_unique')
    await tx.begin()

    await tx.queryObject`
      INSERT INTO traffic.organizations (name, slug) VALUES ('Org A', 'duplicate-slug')
    `

    let threw = false
    try {
      await tx.queryObject`
        INSERT INTO traffic.organizations (name, slug) VALUES ('Org B', 'duplicate-slug')
      `
    } catch {
      threw = true
    }
    assert(threw, 'Duplicate slug should throw a constraint error')

    await tx.rollback()
  })
})

// ── Membership unique constraint ─────────────────────────

Deno.test('membership unique constraint prevents duplicate membership', async () => {
  await pool.withConnection(async (connection) => {
    const tx = connection.createTransaction('test_member_unique')
    await tx.begin()
    const profileId = await createTestProfile(tx, 'o02')

    const org = await tx.queryObject<{ id: number }>`
      INSERT INTO traffic.organizations (name, slug) VALUES ('Unique Mem Org', 'unique-mem-org')
      RETURNING id
    `

    await tx.queryObject`
      INSERT INTO traffic.organization_members (organization_id, profile_id, role)
      VALUES (${org.rows[0].id}, ${profileId}, 'owner')
    `

    let threw = false
    try {
      await tx.queryObject`
        INSERT INTO traffic.organization_members (organization_id, profile_id, role)
        VALUES (${org.rows[0].id}, ${profileId}, 'member')
      `
    } catch {
      threw = true
    }
    assert(threw, 'Duplicate membership should throw a constraint error')

    await tx.rollback()
  })
})

// ── Update ───────────────────────────────────────────────

Deno.test('update organization name and billing_email', async () => {
  await pool.withConnection(async (connection) => {
    const tx = connection.createTransaction('test_org_update')
    await tx.begin()

    const org = await tx.queryObject<{ id: number }>`
      INSERT INTO traffic.organizations (name, slug)
      VALUES ('Original Name', 'update-test-org')
      RETURNING id
    `

    const updated = await tx.queryObject<
      { name: string; billing_email: string | null }
    >`
      UPDATE traffic.organizations
      SET name = 'Updated Name', billing_email = 'billing@example.com', updated_at = now()
      WHERE id = ${org.rows[0].id}
      RETURNING name, billing_email
    `
    assertEquals(updated.rows[0].name, 'Updated Name')
    assertEquals(updated.rows[0].billing_email, 'billing@example.com')

    await tx.rollback()
  })
})

// ── Delete + Cascade ─────────────────────────────────────

Deno.test('deleting organization cascades to members', async () => {
  await pool.withConnection(async (connection) => {
    const tx = connection.createTransaction('test_org_cascade')
    await tx.begin()
    const profileId = await createTestProfile(tx, 'o03')

    const org = await tx.queryObject<{ id: number }>`
      INSERT INTO traffic.organizations (name, slug) VALUES ('Cascade Org', 'cascade-org')
      RETURNING id
    `

    await tx.queryObject`
      INSERT INTO traffic.organization_members (organization_id, profile_id, role)
      VALUES (${org.rows[0].id}, ${profileId}, 'owner')
    `

    await tx.queryObject`DELETE FROM traffic.organizations WHERE id = ${org.rows[0].id}`

    const members = await tx.queryObject`
      SELECT * FROM traffic.organization_members WHERE organization_id = ${org.rows[0].id}
    `
    assertEquals(members.rows.length, 0, 'Members should be cascade-deleted')

    await tx.rollback()
  })
})

// ── List orgs by profile membership ──────────────────────

Deno.test('list organizations returns only orgs the profile belongs to', async () => {
  await pool.withConnection(async (connection) => {
    const tx = connection.createTransaction('test_org_membership_filter')
    await tx.begin()
    const profileA = await createTestProfile(tx, 'o04')
    const profileB = await createTestProfile(tx, 'o05')

    const orgA = await tx.queryObject<{ id: number }>`
      INSERT INTO traffic.organizations (name, slug) VALUES ('Org For A', 'org-for-a')
      RETURNING id
    `
    const orgB = await tx.queryObject<{ id: number }>`
      INSERT INTO traffic.organizations (name, slug) VALUES ('Org For B', 'org-for-b')
      RETURNING id
    `

    await tx.queryObject`
      INSERT INTO traffic.organization_members (organization_id, profile_id, role)
      VALUES (${orgA.rows[0].id}, ${profileA}, 'owner')
    `
    await tx.queryObject`
      INSERT INTO traffic.organization_members (organization_id, profile_id, role)
      VALUES (${orgB.rows[0].id}, ${profileB}, 'owner')
    `

    const orgsForA = await tx.queryObject<{ slug: string }>`
      SELECT o.slug FROM traffic.organizations o
      JOIN traffic.organization_members m ON m.organization_id = o.id
      WHERE m.profile_id = ${profileA}
    `
    assertEquals(orgsForA.rows.length, 1)
    assertEquals(orgsForA.rows[0].slug, 'org-for-a')

    const orgsForB = await tx.queryObject<{ slug: string }>`
      SELECT o.slug FROM traffic.organizations o
      JOIN traffic.organization_members m ON m.organization_id = o.id
      WHERE m.profile_id = ${profileB}
    `
    assertEquals(orgsForB.rows.length, 1)
    assertEquals(orgsForB.rows[0].slug, 'org-for-b')

    await tx.rollback()
  })
})

// ── Default column values ────────────────────────────────

Deno.test('organization defaults: plan_id=free, plan_name=Free, opt_in_tags=empty', async () => {
  await pool.withConnection(async (connection) => {
    const tx = connection.createTransaction('test_org_defaults')
    await tx.begin()

    const org = await tx.queryObject<{
      plan_id: string
      plan_name: string
      opt_in_tags: string[]
      billing_email: string | null
    }>`
      INSERT INTO traffic.organizations (name, slug) VALUES ('Defaults Org', 'defaults-org')
      RETURNING plan_id, plan_name, opt_in_tags, billing_email
    `

    assertEquals(org.rows[0].plan_id, 'free')
    assertEquals(org.rows[0].plan_name, 'Free')
    assertEquals(org.rows[0].opt_in_tags, [])
    assertEquals(org.rows[0].billing_email, null)

    await tx.rollback()
  })
})
