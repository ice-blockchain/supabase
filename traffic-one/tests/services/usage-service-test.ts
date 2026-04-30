import type { Pool } from 'https://deno.land/x/postgres@v0.19.3/mod.ts'
import { assert, assertEquals, assertExists } from 'jsr:@std/assert@1'

import 'jsr:@std/dotenv/load'

import { createRetryingPool } from '../_helpers/pool.ts'
import {
  ALL_METRICS,
  calculateCost,
  getDefaultPricing,
  getEffectivePricing,
} from '../../functions/services/pricing.config.ts'
import { getOrgDailyUsage, getOrgUsage } from '../../functions/services/usage.service.ts'
import type { MetricPricing, PricingOverride } from '../../functions/types/api.ts'

const pool = createRetryingPool(Deno.env.get('TRAFFIC_DB_URL')!)

async function createTestOrg(
  tx: ReturnType<Awaited<ReturnType<Pool['connect']>>['createTransaction']>,
  suffix: string,
): Promise<{ profileId: number; orgId: number }> {
  const profileResult = await tx.queryObject<{ id: number }>`
    INSERT INTO traffic.profiles (gotrue_id, username, primary_email)
    VALUES (${'00000000-0000-0000-0000-00000usage' + suffix}, ${'usageuser' + suffix}, ${
    suffix + '@usagetest.com'
  })
    RETURNING id
  `
  const profileId = profileResult.rows[0].id

  const orgResult = await tx.queryObject<{ id: number }>`
    INSERT INTO traffic.organizations (name, slug, plan_id)
    VALUES (${'Usage Test Org ' + suffix}, ${'usage-test-org-' + suffix}, 'pro')
    RETURNING id
  `
  const orgId = orgResult.rows[0].id

  await tx.queryObject`
    INSERT INTO traffic.organization_members (organization_id, profile_id, role)
    VALUES (${orgId}, ${profileId}, 'owner')
  `

  return { profileId, orgId }
}

// ── Pricing Config Tests ──────────────────────────────────

Deno.test('getDefaultPricing returns valid pricing for all metrics on free plan', () => {
  for (const metric of ALL_METRICS) {
    const pricing = getDefaultPricing('free', metric)
    assertExists(pricing.pricing_strategy)
    assert(typeof pricing.free_units === 'number')
    assert(typeof pricing.per_unit_price === 'number')
    assert(typeof pricing.available_in_plan === 'boolean')
    assert(typeof pricing.capped === 'boolean')
    assert(typeof pricing.unit_price_desc === 'string')
  }
})

Deno.test('getDefaultPricing: pro plan has higher free units than free plan for EGRESS', () => {
  const freePricing = getDefaultPricing('free', 'EGRESS')
  const proPricing = getDefaultPricing('pro', 'EGRESS')
  assert(proPricing.free_units > freePricing.free_units)
})

Deno.test('getDefaultPricing: free plan has SSO MAU not available', () => {
  const pricing = getDefaultPricing('free', 'MONTHLY_ACTIVE_SSO_USERS')
  assertEquals(pricing.available_in_plan, false)
})

Deno.test('getDefaultPricing: pro plan has SSO MAU available', () => {
  const pricing = getDefaultPricing('pro', 'MONTHLY_ACTIVE_SSO_USERS')
  assertEquals(pricing.available_in_plan, true)
})

// ── Cost Calculation Tests ────────────────────────────────

Deno.test('calculateCost: zero usage returns zero cost', () => {
  const pricing = getDefaultPricing('pro', 'EGRESS')
  assertEquals(calculateCost(0, pricing), 0)
})

Deno.test('calculateCost: usage within free units returns zero cost', () => {
  const pricing = getDefaultPricing('pro', 'EGRESS')
  assertEquals(calculateCost(pricing.free_units, pricing), 0)
})

Deno.test('calculateCost: UNIT strategy charges overage * per_unit_price', () => {
  const pricing: MetricPricing = {
    pricing_strategy: 'UNIT',
    free_units: 100,
    per_unit_price: 0.5,
    available_in_plan: true,
    capped: false,
    unit_price_desc: '',
  }
  const cost = calculateCost(150, pricing)
  const expected = 50 * 0.5
  assertEquals(cost, expected)
})

Deno.test(
  'calculateCost: PACKAGE strategy charges ceil(overage/package_size) * package_price',
  () => {
    const pricing: MetricPricing = {
      pricing_strategy: 'PACKAGE',
      free_units: 1000,
      per_unit_price: 0.002,
      package_size: 1000,
      package_price: 2,
      available_in_plan: true,
      capped: false,
      unit_price_desc: '',
    }
    const cost = calculateCost(2500, pricing)
    assertEquals(cost, 4)
  },
)

Deno.test('calculateCost: NONE strategy returns zero', () => {
  const pricing: MetricPricing = {
    pricing_strategy: 'NONE',
    free_units: 0,
    per_unit_price: 0,
    available_in_plan: true,
    capped: false,
    unit_price_desc: '',
  }
  assertEquals(calculateCost(999999, pricing), 0)
})

// ── Discount Override Tests ───────────────────────────────

Deno.test('getEffectivePricing: per-metric discount reduces price', () => {
  const overrides: PricingOverride[] = [
    {
      id: 1,
      organization_id: 1,
      metric: 'EGRESS',
      discount_percent: 50,
      custom_free_units: null,
      custom_per_unit_price: null,
      notes: null,
    },
  ]
  const base = getDefaultPricing('pro', 'EGRESS')
  const effective = getEffectivePricing('pro', 'EGRESS', overrides)
  assertEquals(effective.per_unit_price, base.per_unit_price * 0.5)
})

Deno.test('getEffectivePricing: global discount applies when no per-metric override', () => {
  const overrides: PricingOverride[] = [
    {
      id: 1,
      organization_id: 1,
      metric: null,
      discount_percent: 20,
      custom_free_units: null,
      custom_per_unit_price: null,
      notes: null,
    },
  ]
  const base = getDefaultPricing('pro', 'DATABASE_SIZE')
  const effective = getEffectivePricing('pro', 'DATABASE_SIZE', overrides)
  const expected = base.per_unit_price * 0.8
  assert(Math.abs(effective.per_unit_price - expected) < 1e-15)
})

Deno.test('getEffectivePricing: per-metric override takes priority over global', () => {
  const overrides: PricingOverride[] = [
    {
      id: 1,
      organization_id: 1,
      metric: null,
      discount_percent: 10,
      custom_free_units: null,
      custom_per_unit_price: null,
      notes: null,
    },
    {
      id: 2,
      organization_id: 1,
      metric: 'EGRESS',
      discount_percent: 50,
      custom_free_units: null,
      custom_per_unit_price: null,
      notes: null,
    },
  ]
  const base = getDefaultPricing('pro', 'EGRESS')
  const effective = getEffectivePricing('pro', 'EGRESS', overrides)
  assertEquals(effective.per_unit_price, base.per_unit_price * 0.5)
})

Deno.test('getEffectivePricing: custom_free_units overrides default', () => {
  const overrides: PricingOverride[] = [
    {
      id: 1,
      organization_id: 1,
      metric: 'EGRESS',
      discount_percent: 0,
      custom_free_units: 999999,
      custom_per_unit_price: null,
      notes: null,
    },
  ]
  const effective = getEffectivePricing('pro', 'EGRESS', overrides)
  assertEquals(effective.free_units, 999999)
})

Deno.test('getEffectivePricing: custom_per_unit_price overrides default', () => {
  const overrides: PricingOverride[] = [
    {
      id: 1,
      organization_id: 1,
      metric: 'MONTHLY_ACTIVE_USERS',
      discount_percent: 0,
      custom_free_units: null,
      custom_per_unit_price: 0.002,
      notes: null,
    },
  ]
  const effective = getEffectivePricing(
    'pro',
    'MONTHLY_ACTIVE_USERS',
    overrides,
  )
  assertEquals(effective.per_unit_price, 0.002)
})

Deno.test('getEffectivePricing: no overrides returns defaults', () => {
  const base = getDefaultPricing('pro', 'STORAGE_SIZE')
  const effective = getEffectivePricing('pro', 'STORAGE_SIZE', [])
  assertEquals(effective.free_units, base.free_units)
  assertEquals(effective.per_unit_price, base.per_unit_price)
})

// ── getOrgUsage DB Tests ──────────────────────────────────

Deno.test('getOrgUsage returns correct structure with usage_billing_enabled true', async () => {
  await pool.withConnection(async (connection) => {
    const tx = connection.createTransaction('test_usage_struct')
    try {
      await tx.begin()
      const { orgId } = await createTestOrg(tx, 'u01')
      await tx.commit()

      const result = await getOrgUsage(pool, orgId, 'free')
      assertEquals(result.usage_billing_enabled, true)
      assert(Array.isArray(result.usages))
      assert(result.usages.length > 0)

      const dbEntry = result.usages.find((u) => u.metric === 'DATABASE_SIZE')
      assertExists(dbEntry)
      assert(dbEntry.usage > 0, 'DATABASE_SIZE should be > 0')

      const storageEntry = result.usages.find((u) => u.metric === 'STORAGE_SIZE')
      assertExists(storageEntry)
      assert(storageEntry.usage >= 0)

      for (const entry of result.usages) {
        assertExists(entry.metric)
        assert(typeof entry.usage === 'number')
        assert(typeof entry.cost === 'number')
        assertExists(entry.pricing_strategy)
        assert(typeof entry.available_in_plan === 'boolean')
        assert(typeof entry.capped === 'boolean')
        assert(typeof entry.unlimited === 'boolean')
        assert(Array.isArray(entry.project_allocations))
        assert(typeof entry.unit_price_desc === 'string')
      }

      // Cleanup
      await pool.withConnection(async (cleanConn) => {
        await cleanConn
          .queryObject`DELETE FROM traffic.organizations WHERE id = ${orgId}`
      })
    } catch (err) {
      try {
        await tx.rollback()
      } catch {
        /* already committed or rolled back */
      }
      throw err
    }
  })
})

// ── getOrgUsage with Discount Override ────────────────────

Deno.test('getOrgUsage applies per-metric discount override', async () => {
  await pool.withConnection(async (connection) => {
    const tx = connection.createTransaction('test_usage_discount')
    try {
      await tx.begin()
      const { orgId } = await createTestOrg(tx, 'u02')

      await tx.queryObject`
        INSERT INTO traffic.pricing_overrides (organization_id, metric, discount_percent)
        VALUES (${orgId}, 'DATABASE_SIZE', 50)
      `
      await tx.commit()

      const result = await getOrgUsage(pool, orgId, 'pro')
      const dbEntry = result.usages.find((u) => u.metric === 'DATABASE_SIZE')
      assertExists(dbEntry)

      const basePricing = getDefaultPricing('pro', 'DATABASE_SIZE')
      if (dbEntry.usage > basePricing.free_units) {
        const expectedPrice = basePricing.per_unit_price * 0.5
        assert(
          Math.abs(dbEntry.pricing_per_unit_price! - expectedPrice) < 1e-15,
          'Discounted price should be 50% of base',
        )
      }

      // Cleanup
      await pool.withConnection(async (cleanConn) => {
        await cleanConn
          .queryObject`DELETE FROM traffic.organizations WHERE id = ${orgId}`
      })
    } catch (err) {
      try {
        await tx.rollback()
      } catch {
        /* already committed or rolled back */
      }
      throw err
    }
  })
})

Deno.test(
  'getOrgUsage (L5): uses opts.projectName for allocation label when usage > 0',
  async () => {
    await pool.withConnection(async (connection) => {
      const tx = connection.createTransaction('test_usage_project_name')
      try {
        await tx.begin()
        const { orgId } = await createTestOrg(tx, 'u05')
        await tx.commit()

        // DATABASE_SIZE is always > 0 (pg_database_size of whatever DB this
        // test is running against), so we're guaranteed a populated
        // `project_allocations` entry to inspect.
        const result = await getOrgUsage(pool, orgId, 'pro', {
          projectRef: 'aaaaaaaaaaaaaaaaaaaa',
          projectName: 'My Resolved Project',
        })

        const dbEntry = result.usages.find((u) => u.metric === 'DATABASE_SIZE')
        assertExists(dbEntry)
        assert(dbEntry.project_allocations.length === 1)
        assertEquals(
          dbEntry.project_allocations[0].ref,
          'aaaaaaaaaaaaaaaaaaaa',
        )
        // Regression: before L5, this would have been
        // `Deno.env.get('DEFAULT_PROJECT_NAME') ?? 'Default Project'`,
        // which misrepresented the selected project in Studio's per-project
        // usage panel.
        assertEquals(
          dbEntry.project_allocations[0].name,
          'My Resolved Project',
        )

        await pool.withConnection(async (cleanConn) => {
          await cleanConn
            .queryObject`DELETE FROM traffic.organizations WHERE id = ${orgId}`
        })
      } catch (err) {
        try {
          await tx.rollback()
        } catch {
          /* already committed or rolled back */
        }
        throw err
      }
    })
  },
)

Deno.test('getOrgUsage applies global discount override', async () => {
  await pool.withConnection(async (connection) => {
    const tx = connection.createTransaction('test_usage_global_discount')
    try {
      await tx.begin()
      const { orgId } = await createTestOrg(tx, 'u03')

      await tx.queryObject`
        INSERT INTO traffic.pricing_overrides (organization_id, metric, discount_percent)
        VALUES (${orgId}, NULL, 25)
      `
      await tx.commit()

      const result = await getOrgUsage(pool, orgId, 'pro')
      const egressEntry = result.usages.find((u) => u.metric === 'EGRESS')
      assertExists(egressEntry)
      const basePricing = getDefaultPricing('pro', 'EGRESS')
      const expectedPrice = basePricing.per_unit_price * 0.75
      assert(
        Math.abs(egressEntry.pricing_per_unit_price! - expectedPrice) < 1e-15,
        'Global discount should reduce all prices by 25%',
      )

      // Cleanup
      await pool.withConnection(async (cleanConn) => {
        await cleanConn
          .queryObject`DELETE FROM traffic.organizations WHERE id = ${orgId}`
      })
    } catch (err) {
      try {
        await tx.rollback()
      } catch {
        /* already committed or rolled back */
      }
      throw err
    }
  })
})

// ── getOrgDailyUsage Tests ────────────────────────────────

Deno.test('getOrgDailyUsage returns entries spanning the date range', async () => {
  await pool.withConnection(async (connection) => {
    const tx = connection.createTransaction('test_daily_usage')
    try {
      await tx.begin()
      const { orgId } = await createTestOrg(tx, 'u04')
      await tx.commit()

      const now = new Date()
      const start = new Date(now.getFullYear(), now.getMonth(), 1)
      const result = await getOrgDailyUsage(pool, orgId, {
        start: start.toISOString(),
        end: now.toISOString(),
      })

      assert(Array.isArray(result.usages))

      for (const entry of result.usages) {
        assertExists(entry.date)
        assertExists(entry.metric)
        assert(typeof entry.usage === 'number')
        assert(typeof entry.usage_original === 'number')
      }

      const egressEntries = result.usages.filter((u) => u.metric === 'EGRESS')
      for (const entry of egressEntries) {
        assertExists(entry.breakdown)
        assert(typeof entry.breakdown!.egress_rest === 'number')
        assert(typeof entry.breakdown!.egress_storage === 'number')
        assert(typeof entry.breakdown!.egress_realtime === 'number')
        assert(typeof entry.breakdown!.egress_function === 'number')
      }

      // M9: REALTIME_PEAK_CONNECTIONS is not derivable from self-hosted Logflare
      // data (no connection-event stream), so the daily feed must always report
      // 0 rather than silently aliasing the REALTIME_MESSAGE_COUNT query as it
      // used to. This assertion guards that regression.
      const rtPeakEntries = result.usages.filter((u) => u.metric === 'REALTIME_PEAK_CONNECTIONS')
      assert(
        rtPeakEntries.length > 0,
        'expected REALTIME_PEAK_CONNECTIONS in daily usage feed',
      )
      for (const entry of rtPeakEntries) {
        assertEquals(entry.usage, 0)
        assertEquals(entry.usage_original, 0)
      }

      // Cleanup
      await pool.withConnection(async (cleanConn) => {
        await cleanConn
          .queryObject`DELETE FROM traffic.organizations WHERE id = ${orgId}`
      })
    } catch (err) {
      try {
        await tx.rollback()
      } catch {
        /* already committed or rolled back */
      }
      throw err
    }
  })
})
