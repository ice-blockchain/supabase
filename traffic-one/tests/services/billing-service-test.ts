import type { Pool } from 'https://deno.land/x/postgres@v0.19.3/mod.ts'
import { assert, assertEquals } from 'jsr:@std/assert@1'

import 'jsr:@std/dotenv/load'

import { createRetryingPool } from '../_helpers/pool.ts'

const pool = createRetryingPool(Deno.env.get('TRAFFIC_DB_URL')!)

async function createTestOrg(
  tx: ReturnType<Awaited<ReturnType<Pool['connect']>>['createTransaction']>,
  suffix: string,
): Promise<number> {
  const profile = await tx.queryObject<{ id: number }>`
    INSERT INTO traffic.profiles (gotrue_id, username, primary_email)
    VALUES (${'00000000-0000-0000-0000-000bill' + suffix}, ${'billuser' + suffix}, ${
    suffix + '@billtest.com'
  })
    RETURNING id
  `
  const org = await tx.queryObject<{ id: number }>`
    INSERT INTO traffic.organizations (name, slug)
    VALUES (${'Bill Org ' + suffix}, ${'bill-org-' + suffix})
    RETURNING id
  `
  await tx.queryObject`
    INSERT INTO traffic.organization_members (organization_id, profile_id, role)
    VALUES (${org.rows[0].id}, ${profile.rows[0].id}, 'owner')
  `
  return org.rows[0].id
}

// ── Subscription ─────────────────────────────────────────

Deno.test('insert subscription with defaults', async () => {
  await pool.withConnection(async (connection) => {
    const tx = connection.createTransaction('test_sub_insert')
    await tx.begin()
    const orgId = await createTestOrg(tx, 's01')

    const result = await tx.queryObject<{
      plan_id: string
      plan_name: string
      tier: string
      usage_billing_enabled: boolean
      nano_enabled: boolean
    }>`
      INSERT INTO traffic.subscriptions (organization_id)
      VALUES (${orgId})
      RETURNING plan_id, plan_name, tier, usage_billing_enabled, nano_enabled
    `
    assertEquals(result.rows.length, 1)
    assertEquals(result.rows[0].plan_id, 'free')
    assertEquals(result.rows[0].plan_name, 'Free')
    assertEquals(result.rows[0].tier, 'tier_free')
    assertEquals(result.rows[0].usage_billing_enabled, false)
    assertEquals(result.rows[0].nano_enabled, true)

    await tx.rollback()
  })
})

Deno.test('update subscription tier', async () => {
  await pool.withConnection(async (connection) => {
    const tx = connection.createTransaction('test_sub_update')
    await tx.begin()
    const orgId = await createTestOrg(tx, 's02')

    await tx.queryObject`
      INSERT INTO traffic.subscriptions (organization_id) VALUES (${orgId})
    `

    const updated = await tx.queryObject<
      { plan_id: string; plan_name: string; tier: string }
    >`
      UPDATE traffic.subscriptions
      SET plan_id = 'pro', plan_name = 'Pro', tier = 'tier_pro'
      WHERE organization_id = ${orgId}
      RETURNING plan_id, plan_name, tier
    `
    assertEquals(updated.rows[0].plan_id, 'pro')
    assertEquals(updated.rows[0].plan_name, 'Pro')
    assertEquals(updated.rows[0].tier, 'tier_pro')

    await tx.rollback()
  })
})

Deno.test('subscription unique constraint on organization_id', async () => {
  await pool.withConnection(async (connection) => {
    const tx = connection.createTransaction('test_sub_unique')
    await tx.begin()
    const orgId = await createTestOrg(tx, 's03')

    await tx.queryObject`
      INSERT INTO traffic.subscriptions (organization_id) VALUES (${orgId})
    `

    let threw = false
    try {
      await tx.queryObject`
        INSERT INTO traffic.subscriptions (organization_id) VALUES (${orgId})
      `
    } catch {
      threw = true
    }
    assert(threw, 'Duplicate subscription for same org should throw')

    await tx.rollback()
  })
})

// ── Customer ─────────────────────────────────────────────

Deno.test('customer upsert inserts and updates', async () => {
  await pool.withConnection(async (connection) => {
    const tx = connection.createTransaction('test_customer_upsert')
    await tx.begin()
    const orgId = await createTestOrg(tx, 'c01')

    const inserted = await tx.queryObject<
      { billing_name: string; country: string }
    >`
      INSERT INTO traffic.customers (organization_id, billing_name, country)
      VALUES (${orgId}, 'Test Corp', 'US')
      RETURNING billing_name, country
    `
    assertEquals(inserted.rows[0].billing_name, 'Test Corp')
    assertEquals(inserted.rows[0].country, 'US')

    const updated = await tx.queryObject<
      { billing_name: string; city: string }
    >`
      UPDATE traffic.customers SET billing_name = 'Updated Corp', city = 'NYC'
      WHERE organization_id = ${orgId}
      RETURNING billing_name, city
    `
    assertEquals(updated.rows[0].billing_name, 'Updated Corp')
    assertEquals(updated.rows[0].city, 'NYC')

    await tx.rollback()
  })
})

// ── Tax IDs ──────────────────────────────────────────────

Deno.test('tax ID insert and delete', async () => {
  await pool.withConnection(async (connection) => {
    const tx = connection.createTransaction('test_taxid_crud')
    await tx.begin()
    const orgId = await createTestOrg(tx, 't01')

    const inserted = await tx.queryObject<
      { id: number; type: string; value: string }
    >`
      INSERT INTO traffic.tax_ids (organization_id, type, value)
      VALUES (${orgId}, 'eu_vat', 'DE123456789')
      RETURNING id, type, value
    `
    assertEquals(inserted.rows[0].type, 'eu_vat')
    assertEquals(inserted.rows[0].value, 'DE123456789')

    await tx.queryObject`
      DELETE FROM traffic.tax_ids WHERE id = ${inserted.rows[0].id}
    `

    const remaining = await tx.queryObject`
      SELECT * FROM traffic.tax_ids WHERE organization_id = ${orgId}
    `
    assertEquals(remaining.rows.length, 0)

    await tx.rollback()
  })
})

// ── Invoices ─────────────────────────────────────────────

Deno.test('invoice insert and pagination query', async () => {
  await pool.withConnection(async (connection) => {
    const tx = connection.createTransaction('test_invoice_pagination')
    await tx.begin()
    const orgId = await createTestOrg(tx, 'i01')

    for (let i = 0; i < 5; i++) {
      await tx.queryObject`
        INSERT INTO traffic.invoices (organization_id, number, status, amount_due)
        VALUES (${orgId}, ${'INV-' + i}, 'paid', ${(i + 1) * 1000})
      `
    }

    const page1 = await tx.queryObject<{ number: string }>`
      SELECT number FROM traffic.invoices
      WHERE organization_id = ${orgId}
      ORDER BY created_at DESC
      OFFSET 0 LIMIT 2
    `
    assertEquals(page1.rows.length, 2)

    const countResult = await tx.queryObject<{ count: number }>`
      SELECT COUNT(*)::int AS count FROM traffic.invoices
      WHERE organization_id = ${orgId}
    `
    assertEquals(countResult.rows[0].count, 5)

    await tx.rollback()
  })
})

// ── Credits ──────────────────────────────────────────────

Deno.test('credit balance update', async () => {
  await pool.withConnection(async (connection) => {
    const tx = connection.createTransaction('test_credit_balance')
    await tx.begin()
    const orgId = await createTestOrg(tx, 'cr01')

    await tx.queryObject`
      INSERT INTO traffic.credits (organization_id, balance) VALUES (${orgId}, 500)
    `

    const updated = await tx.queryObject<{ balance: number }>`
      UPDATE traffic.credits SET balance = balance + 200
      WHERE organization_id = ${orgId}
      RETURNING balance
    `
    assertEquals(Number(updated.rows[0].balance), 700)

    await tx.rollback()
  })
})

// ── Project Addons ───────────────────────────────────────

Deno.test('project addon insert and unique constraint', async () => {
  await pool.withConnection(async (connection) => {
    const tx = connection.createTransaction('test_addon_unique')
    await tx.begin()

    await tx.queryObject`
      INSERT INTO traffic.project_addons (project_ref, addon_type, addon_variant)
      VALUES ('test-ref', 'compute_instance', 'ci_small')
    `

    const upserted = await tx.queryObject<{ addon_variant: string }>`
      INSERT INTO traffic.project_addons (project_ref, addon_type, addon_variant)
      VALUES ('test-ref', 'compute_instance', 'ci_medium')
      ON CONFLICT (project_ref, addon_type) DO UPDATE SET addon_variant = 'ci_medium'
      RETURNING addon_variant
    `
    assertEquals(upserted.rows[0].addon_variant, 'ci_medium')

    await tx.rollback()
  })
})

// ── Cascade deletes ──────────────────────────────────────

Deno.test('deleting organization cascades to billing tables', async () => {
  await pool.withConnection(async (connection) => {
    const tx = connection.createTransaction('test_billing_cascade')
    await tx.begin()
    const orgId = await createTestOrg(tx, 'cas01')

    await tx.queryObject`
      INSERT INTO traffic.subscriptions (organization_id) VALUES (${orgId})
    `
    await tx.queryObject`
      INSERT INTO traffic.customers (organization_id, billing_name) VALUES (${orgId}, 'Cascade Corp')
    `
    await tx.queryObject`
      INSERT INTO traffic.invoices (organization_id, number, status) VALUES (${orgId}, 'INV-CAS', 'paid')
    `
    await tx.queryObject`
      INSERT INTO traffic.tax_ids (organization_id, type, value) VALUES (${orgId}, 'eu_vat', 'DE999')
    `
    await tx.queryObject`
      INSERT INTO traffic.credits (organization_id, balance) VALUES (${orgId}, 100)
    `

    await tx.queryObject`DELETE FROM traffic.organizations WHERE id = ${orgId}`

    const subs = await tx.queryObject`
      SELECT * FROM traffic.subscriptions WHERE organization_id = ${orgId}
    `
    assertEquals(subs.rows.length, 0, 'Subscriptions should cascade')

    const customers = await tx.queryObject`
      SELECT * FROM traffic.customers WHERE organization_id = ${orgId}
    `
    assertEquals(customers.rows.length, 0, 'Customers should cascade')

    const invoices = await tx.queryObject`
      SELECT * FROM traffic.invoices WHERE organization_id = ${orgId}
    `
    assertEquals(invoices.rows.length, 0, 'Invoices should cascade')

    const taxIds = await tx.queryObject`
      SELECT * FROM traffic.tax_ids WHERE organization_id = ${orgId}
    `
    assertEquals(taxIds.rows.length, 0, 'Tax IDs should cascade')

    const credits = await tx.queryObject`
      SELECT * FROM traffic.credits WHERE organization_id = ${orgId}
    `
    assertEquals(credits.rows.length, 0, 'Credits should cascade')

    await tx.rollback()
  })
})
