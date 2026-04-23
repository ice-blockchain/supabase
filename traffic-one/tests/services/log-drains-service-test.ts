import { Pool } from 'https://deno.land/x/postgres@v0.17.0/mod.ts'
import { assert, assertEquals } from 'jsr:@std/assert@1'

import 'jsr:@std/dotenv/load'

const pool = new Pool(Deno.env.get('TRAFFIC_DB_URL')!, 1, true)

// ── Insert / Select ──────────────────────────────────────

Deno.test('log_drains: insert and select by project_ref', async () => {
  const connection = await pool.connect()
  const tx = connection.createTransaction('test_log_drains_insert')
  try {
    await tx.begin()

    const inserted = await tx.queryObject<{
      id: number
      project_ref: string
      token: string
      name: string
      type: string
      config: Record<string, unknown>
      filters: unknown[]
      active: boolean
      deleted_at: string | null
    }>`
      INSERT INTO traffic.log_drains (project_ref, name, type, config)
      VALUES ('ld_ref_01', 'primary-drain', 'webhook', '{"url":"https://example.test"}'::jsonb)
      RETURNING id, project_ref, token, name, type, config, filters, active, deleted_at
    `
    assertEquals(inserted.rows.length, 1)
    const row = inserted.rows[0]
    assertEquals(row.project_ref, 'ld_ref_01')
    assertEquals(row.name, 'primary-drain')
    assertEquals(row.type, 'webhook')
    assertEquals(row.active, true)
    assertEquals(row.deleted_at, null)
    assert(typeof row.token === 'string' && row.token.length > 0, 'token must be a UUID string')

    const selected = await tx.queryObject<{ count: number }>`
      SELECT COUNT(*)::int AS count FROM traffic.log_drains
      WHERE project_ref = 'ld_ref_01' AND deleted_at IS NULL
    `
    assertEquals(selected.rows[0].count, 1)

    await tx.rollback()
  } finally {
    connection.release()
  }
})

// ── UNIQUE(project_ref, name) WHERE deleted_at IS NULL ──

Deno.test(
  'log_drains: UNIQUE (project_ref, name) prevents duplicates among active rows',
  async () => {
    const connection = await pool.connect()
    const tx = connection.createTransaction('test_log_drains_unique')
    try {
      await tx.begin()

      await tx.queryObject`
      INSERT INTO traffic.log_drains (project_ref, name, type, config)
      VALUES ('ld_ref_02', 'duplicate', 'webhook', '{}'::jsonb)
    `

      let threw = false
      try {
        await tx.queryObject`
        INSERT INTO traffic.log_drains (project_ref, name, type, config)
        VALUES ('ld_ref_02', 'duplicate', 'webhook', '{}'::jsonb)
      `
      } catch {
        threw = true
      }
      assert(threw, 'Duplicate (project_ref, name) on active rows should throw')

      await tx.rollback()
    } finally {
      connection.release()
    }
  }
)

// ── Same name allowed after soft-delete ──────────────────

Deno.test('log_drains: same name is allowed after soft-delete', async () => {
  const connection = await pool.connect()
  const tx = connection.createTransaction('test_log_drains_recreate')
  try {
    await tx.begin()

    const first = await tx.queryObject<{ id: number }>`
      INSERT INTO traffic.log_drains (project_ref, name, type, config)
      VALUES ('ld_ref_03', 'recycled', 'webhook', '{}'::jsonb)
      RETURNING id
    `
    const firstId = first.rows[0].id

    await tx.queryObject`
      UPDATE traffic.log_drains SET deleted_at = now() WHERE id = ${firstId}
    `

    const second = await tx.queryObject<{ id: number }>`
      INSERT INTO traffic.log_drains (project_ref, name, type, config)
      VALUES ('ld_ref_03', 'recycled', 'webhook', '{}'::jsonb)
      RETURNING id
    `
    assertEquals(second.rows.length, 1)
    assert(second.rows[0].id !== firstId, 'second insert must create a new row')

    await tx.rollback()
  } finally {
    connection.release()
  }
})

// ── Different project_ref with same name is allowed ──────

Deno.test('log_drains: same name allowed across different project_refs', async () => {
  const connection = await pool.connect()
  const tx = connection.createTransaction('test_log_drains_cross_ref')
  try {
    await tx.begin()

    await tx.queryObject`
      INSERT INTO traffic.log_drains (project_ref, name, type, config) VALUES
      ('ld_ref_04a', 'shared-name', 'webhook', '{}'::jsonb),
      ('ld_ref_04b', 'shared-name', 'webhook', '{}'::jsonb)
    `

    const result = await tx.queryObject<{ count: number }>`
      SELECT COUNT(*)::int AS count FROM traffic.log_drains
      WHERE name = 'shared-name'
    `
    assertEquals(result.rows[0].count, 2)

    await tx.rollback()
  } finally {
    connection.release()
  }
})

// ── CRUD round-trip via raw SQL (mirrors service ops) ────

Deno.test('log_drains: full CRUD round-trip (list → update → soft-delete)', async () => {
  const connection = await pool.connect()
  const tx = connection.createTransaction('test_log_drains_crud')
  try {
    await tx.begin()

    const inserted = await tx.queryObject<{ token: string }>`
      INSERT INTO traffic.log_drains (project_ref, name, type, config)
      VALUES ('ld_ref_05', 'crud-drain', 'webhook', '{"url":"https://a.test"}'::jsonb)
      RETURNING token
    `
    const token = inserted.rows[0].token

    const beforeUpdate = await tx.queryObject<{ name: string; type: string }>`
      SELECT name, type FROM traffic.log_drains
      WHERE project_ref = 'ld_ref_05' AND token = ${token}::uuid AND deleted_at IS NULL
    `
    assertEquals(beforeUpdate.rows[0].name, 'crud-drain')
    assertEquals(beforeUpdate.rows[0].type, 'webhook')

    await tx.queryObject`
      UPDATE traffic.log_drains
      SET name = 'crud-drain-renamed',
          description = 'renamed',
          updated_at = now()
      WHERE project_ref = 'ld_ref_05' AND token = ${token}::uuid AND deleted_at IS NULL
    `

    const afterUpdate = await tx.queryObject<{ name: string; description: string }>`
      SELECT name, description FROM traffic.log_drains
      WHERE project_ref = 'ld_ref_05' AND token = ${token}::uuid AND deleted_at IS NULL
    `
    assertEquals(afterUpdate.rows[0].name, 'crud-drain-renamed')
    assertEquals(afterUpdate.rows[0].description, 'renamed')

    await tx.queryObject`
      UPDATE traffic.log_drains
      SET deleted_at = now(), active = false
      WHERE project_ref = 'ld_ref_05' AND token = ${token}::uuid AND deleted_at IS NULL
    `

    const activeCount = await tx.queryObject<{ count: number }>`
      SELECT COUNT(*)::int AS count FROM traffic.log_drains
      WHERE project_ref = 'ld_ref_05' AND deleted_at IS NULL
    `
    assertEquals(activeCount.rows[0].count, 0)

    const rawCount = await tx.queryObject<{ count: number }>`
      SELECT COUNT(*)::int AS count FROM traffic.log_drains
      WHERE project_ref = 'ld_ref_05'
    `
    assertEquals(rawCount.rows[0].count, 1)

    await tx.rollback()
  } finally {
    connection.release()
  }
})

// ── Defaults ─────────────────────────────────────────────

Deno.test('log_drains: defaults populate description/filters/active', async () => {
  const connection = await pool.connect()
  const tx = connection.createTransaction('test_log_drains_defaults')
  try {
    await tx.begin()

    const result = await tx.queryObject<{
      description: string
      filters: unknown[]
      active: boolean
      config: Record<string, unknown>
    }>`
      INSERT INTO traffic.log_drains (project_ref, name, type)
      VALUES ('ld_ref_06', 'defaults-drain', 'webhook')
      RETURNING description, filters, active, config
    `
    assertEquals(result.rows[0].description, '')
    assert(Array.isArray(result.rows[0].filters))
    assertEquals(result.rows[0].filters.length, 0)
    assertEquals(result.rows[0].active, true)
    assertEquals(result.rows[0].config as Record<string, unknown>, {})

    await tx.rollback()
  } finally {
    connection.release()
  }
})
