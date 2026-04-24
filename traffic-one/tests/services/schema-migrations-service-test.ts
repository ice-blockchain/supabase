import { assert, assertEquals } from 'jsr:@std/assert@1'

import 'jsr:@std/dotenv/load'

import { createRetryingPool } from '../_helpers/pool.ts'

const pool = createRetryingPool(Deno.env.get('TRAFFIC_DB_URL')!)

// ── Insert / Select ──────────────────────────────────────

Deno.test('schema_migrations: insert and select by project_ref', async () => {
  await pool.withConnection(async (connection) => {
    const tx = connection.createTransaction('test_schema_migrations_insert')
    await tx.begin()

    const result = await tx.queryObject<{
      id: number
      project_ref: string
      version: string
      name: string
      statements: string[]
    }>`
      INSERT INTO traffic.schema_migrations (project_ref, version, name, statements)
      VALUES ('sm_ref_01', '20240101120000', 'initial_schema', ARRAY['CREATE TABLE t (id int)'])
      RETURNING id, project_ref, version, name, statements
    `
    assertEquals(result.rows.length, 1)
    assertEquals(result.rows[0].project_ref, 'sm_ref_01')
    assertEquals(result.rows[0].version, '20240101120000')
    assertEquals(result.rows[0].name, 'initial_schema')
    assertEquals(result.rows[0].statements[0], 'CREATE TABLE t (id int)')

    await tx.rollback()
  })
})

// ── UNIQUE(project_ref, version) ─────────────────────────

Deno.test('schema_migrations: UNIQUE(project_ref, version) prevents duplicates', async () => {
  await pool.withConnection(async (connection) => {
    const tx = connection.createTransaction('test_schema_migrations_unique')
    await tx.begin()

    await tx.queryObject`
      INSERT INTO traffic.schema_migrations (project_ref, version, name, statements)
      VALUES ('sm_ref_02', 'v1', 'a', ARRAY['SELECT 1'])
    `

    let threw = false
    try {
      await tx.queryObject`
        INSERT INTO traffic.schema_migrations (project_ref, version, name, statements)
        VALUES ('sm_ref_02', 'v1', 'b', ARRAY['SELECT 2'])
      `
    } catch {
      threw = true
    }
    assert(
      threw,
      'Duplicate (project_ref, version) should throw a constraint error',
    )

    await tx.rollback()
  })
})

// ── Different project_ref with same version is allowed ───

Deno.test('schema_migrations: same version allowed for different project_refs', async () => {
  await pool.withConnection(async (connection) => {
    const tx = connection.createTransaction('test_schema_migrations_cross_ref')
    await tx.begin()

    await tx.queryObject`
      INSERT INTO traffic.schema_migrations (project_ref, version, name, statements)
      VALUES ('sm_ref_03a', 'shared_version', 'a', ARRAY['SELECT 1'])
    `
    await tx.queryObject`
      INSERT INTO traffic.schema_migrations (project_ref, version, name, statements)
      VALUES ('sm_ref_03b', 'shared_version', 'b', ARRAY['SELECT 2'])
    `

    const result = await tx.queryObject<{ count: number }>`
      SELECT COUNT(*)::int AS count FROM traffic.schema_migrations
      WHERE version = 'shared_version'
    `
    assertEquals(result.rows[0].count, 2)

    await tx.rollback()
  })
})

// ── list ordered by version DESC ─────────────────────────

Deno.test('schema_migrations: list filters by project_ref and orders by version DESC', async () => {
  await pool.withConnection(async (connection) => {
    const tx = connection.createTransaction('test_schema_migrations_list')
    await tx.begin()

    await tx.queryObject`
      INSERT INTO traffic.schema_migrations (project_ref, version, name, statements) VALUES
      ('sm_ref_04', '20240101120000', 'first', ARRAY['SELECT 1']),
      ('sm_ref_04', '20240201120000', 'second', ARRAY['SELECT 2']),
      ('sm_ref_04', '20240301120000', 'third', ARRAY['SELECT 3']),
      ('sm_ref_other', '20240101120000', 'other', ARRAY['SELECT X'])
    `

    const result = await tx.queryObject<{ version: string; name: string }>`
      SELECT version, name FROM traffic.schema_migrations
      WHERE project_ref = 'sm_ref_04'
      ORDER BY version DESC
    `
    assertEquals(result.rows.length, 3)
    assertEquals(result.rows[0].version, '20240301120000')
    assertEquals(result.rows[0].name, 'third')
    assertEquals(result.rows[1].version, '20240201120000')
    assertEquals(result.rows[2].version, '20240101120000')

    await tx.rollback()
  })
})

// ── Default values ───────────────────────────────────────

Deno.test('schema_migrations: defaults empty statements array and empty name', async () => {
  await pool.withConnection(async (connection) => {
    const tx = connection.createTransaction('test_schema_migrations_defaults')
    await tx.begin()

    const result = await tx.queryObject<{
      name: string
      statements: string[]
    }>`
      INSERT INTO traffic.schema_migrations (project_ref, version)
      VALUES ('sm_ref_05', 'only_version')
      RETURNING name, statements
    `
    assertEquals(result.rows[0].name, '')
    assert(Array.isArray(result.rows[0].statements))
    assertEquals(result.rows[0].statements.length, 0)

    await tx.rollback()
  })
})
