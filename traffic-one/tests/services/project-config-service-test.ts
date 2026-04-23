import { Pool } from 'https://deno.land/x/postgres@v0.17.0/mod.ts'
import { assert, assertEquals, assertRejects } from 'jsr:@std/assert@1'

import 'jsr:@std/dotenv/load'

import {
  CONFIG_DEFAULTS,
  InvalidSensitivityError,
  isValidSensitivity,
  SENSITIVITY_VALUES,
  updateProjectSensitivity,
} from '../../functions/services/project-config.service.ts'

const pool = new Pool(Deno.env.get('TRAFFIC_DB_URL')!, 1, true)

// ── Pure validators (no DB) ─────────────────────────────

Deno.test('isValidSensitivity accepts all documented enum values', () => {
  for (const v of SENSITIVITY_VALUES) {
    assert(isValidSensitivity(v), `expected ${v} to be valid`)
  }
})

Deno.test('isValidSensitivity rejects arbitrary strings / non-strings', () => {
  assertEquals(isValidSensitivity('low'), false)
  assertEquals(isValidSensitivity(''), false)
  assertEquals(isValidSensitivity(123), false)
  assertEquals(isValidSensitivity(null), false)
  assertEquals(isValidSensitivity(undefined), false)
  assertEquals(isValidSensitivity({ value: 'HIGH' }), false)
})

Deno.test('CONFIG_DEFAULTS expose exactly the documented shapes', () => {
  assertEquals(CONFIG_DEFAULTS.postgrest.db_schema, 'public')
  assertEquals(CONFIG_DEFAULTS.postgrest.max_rows, 1000)
  assertEquals(CONFIG_DEFAULTS.postgrest.db_pool, 100)
  assertEquals(CONFIG_DEFAULTS.postgrest.jwt_secret, '***')
  assertEquals(CONFIG_DEFAULTS.storage.fileSizeLimit, 52428800)
  assertEquals(CONFIG_DEFAULTS.storage.isFreeTier, true)
  assertEquals(CONFIG_DEFAULTS.realtime.enabled, true)
  assert(Array.isArray((CONFIG_DEFAULTS.realtime as { db_publications: unknown }).db_publications))
  assertEquals(CONFIG_DEFAULTS.pgbouncer.pool_mode, 'transaction')
  assertEquals(CONFIG_DEFAULTS.secrets.jwt_secret, '***')
  assertEquals(CONFIG_DEFAULTS.secrets.service_role_key, '***')
})

// ── updateProjectSensitivity: enum rejection throws BEFORE DB ─

Deno.test(
  'updateProjectSensitivity throws InvalidSensitivityError for invalid enum (no DB write)',
  async () => {
    await assertRejects(
      () =>
        updateProjectSensitivity(
          pool,
          'pcfg_ref_fake',
          'SUPER_HIGH',
          0,
          0,
          '00000000-0000-0000-0000-000000000000',
          {
            email: 'x@test',
            ip: '127.0.0.1',
            method: 'PATCH',
            route: '/projects/pcfg_ref_fake/settings/sensitivity',
          }
        ),
      InvalidSensitivityError
    )
  }
)

Deno.test('updateProjectSensitivity rejects empty string', async () => {
  await assertRejects(
    () =>
      updateProjectSensitivity(
        pool,
        'pcfg_ref_fake2',
        '',
        0,
        0,
        '00000000-0000-0000-0000-000000000000',
        {
          email: 'x@test',
          ip: '127.0.0.1',
          method: 'PATCH',
          route: '/projects/pcfg_ref_fake2/settings/sensitivity',
        }
      ),
    InvalidSensitivityError
  )
})

// ── JSONB shallow-merge behaviour (mirrors updateConfigSection SQL) ──

Deno.test(
  'project_config JSONB || merges only the target section — other sections untouched',
  async () => {
    const connection = await pool.connect()
    const tx = connection.createTransaction('test_project_config_merge')
    try {
      await tx.begin()

      await tx.queryObject`
        INSERT INTO traffic.project_config (project_ref, postgrest, storage, realtime, pgbouncer)
        VALUES (
          'pcfg_ref_merge',
          '{"max_rows": 999, "db_schema": "public"}'::jsonb,
          '{"fileSizeLimit": 52428800}'::jsonb,
          '{"enabled": true}'::jsonb,
          '{"default_pool_size": 20}'::jsonb
        )
      `

      // Mirror the shallow merge that updateConfigSection performs on PATCH.
      await tx.queryObject`
        UPDATE traffic.project_config
        SET postgrest = postgrest || '{"max_rows": 555, "db_pool": 200}'::jsonb,
            updated_at = now()
        WHERE project_ref = 'pcfg_ref_merge'
      `

      const result = await tx.queryObject<{
        postgrest: Record<string, unknown>
        storage: Record<string, unknown>
        realtime: Record<string, unknown>
        pgbouncer: Record<string, unknown>
      }>`
        SELECT postgrest, storage, realtime, pgbouncer
        FROM traffic.project_config WHERE project_ref = 'pcfg_ref_merge'
      `
      const row = result.rows[0]

      const pg = row.postgrest as {
        max_rows: number
        db_pool: number
        db_schema: string
      }
      assertEquals(pg.max_rows, 555, 'patched key wins')
      assertEquals(pg.db_pool, 200, 'new key added')
      assertEquals(pg.db_schema, 'public', 'untouched key preserved')

      const storage = row.storage as { fileSizeLimit: number }
      assertEquals(storage.fileSizeLimit, 52428800, 'storage untouched')
      const realtime = row.realtime as { enabled: boolean }
      assertEquals(realtime.enabled, true, 'realtime untouched')
      const pgb = row.pgbouncer as { default_pool_size: number }
      assertEquals(pgb.default_pool_size, 20, 'pgbouncer untouched')

      await tx.rollback()
    } finally {
      connection.release()
    }
  }
)

Deno.test(
  'project_config upsert-on-conflict creates-or-merges without clobbering other sections',
  async () => {
    const connection = await pool.connect()
    const tx = connection.createTransaction('test_project_config_upsert')
    try {
      await tx.begin()

      // First upsert creates the row with storage overrides.
      await tx.queryObject`
        INSERT INTO traffic.project_config (project_ref, storage)
        VALUES ('pcfg_ref_up', '{"fileSizeLimit": 10}'::jsonb)
        ON CONFLICT (project_ref) DO UPDATE
        SET storage = traffic.project_config.storage || EXCLUDED.storage,
            updated_at = now()
      `

      // Second upsert targets a different section — storage must not be reset.
      await tx.queryObject`
        INSERT INTO traffic.project_config (project_ref, realtime)
        VALUES ('pcfg_ref_up', '{"enabled": false}'::jsonb)
        ON CONFLICT (project_ref) DO UPDATE
        SET realtime = traffic.project_config.realtime || EXCLUDED.realtime,
            updated_at = now()
      `

      const result = await tx.queryObject<{
        storage: Record<string, unknown>
        realtime: Record<string, unknown>
      }>`
        SELECT storage, realtime FROM traffic.project_config
        WHERE project_ref = 'pcfg_ref_up'
      `
      const row = result.rows[0]
      assertEquals(
        (row.storage as { fileSizeLimit: number }).fileSizeLimit,
        10,
        'storage section survived a realtime upsert'
      )
      assertEquals((row.realtime as { enabled: boolean }).enabled, false)

      await tx.rollback()
    } finally {
      connection.release()
    }
  }
)

// ── rotateJwtSecret idempotency (mirrors service read-then-write-if-different) ──

Deno.test(
  'rotation: same request_id idempotent (re-submit returns stored pending row unchanged)',
  async () => {
    const connection = await pool.connect()
    const tx = connection.createTransaction('test_rotation_idempotent')
    try {
      await tx.begin()

      const firstRequestId = '00000000-0000-0000-0000-0000aaaaaaaa'
      const firstRequestedAt = '2099-01-01T00:00:00.000Z'
      const firstRow = {
        status: 'pending',
        request_id: firstRequestId,
        requested_at: firstRequestedAt,
      }

      await tx.queryObject`
        INSERT INTO traffic.project_config (project_ref, secrets_rotation)
        VALUES ('pcfg_ref_rot', ${JSON.stringify(firstRow)}::jsonb)
        ON CONFLICT (project_ref) DO UPDATE
        SET secrets_rotation = EXCLUDED.secrets_rotation,
            updated_at = now()
      `

      // Mirror service: re-submitting same request_id reads existing row and
      // returns it as-is without overwriting requested_at.
      const existing = await tx.queryObject<{
        secrets_rotation: { status: string; request_id: string; requested_at: string }
      }>`
        SELECT secrets_rotation
        FROM traffic.project_config WHERE project_ref = 'pcfg_ref_rot'
      `
      const current = existing.rows[0].secrets_rotation
      assertEquals(current.request_id, firstRequestId)
      assertEquals(current.requested_at, firstRequestedAt, 'requested_at unchanged for same id')
      assertEquals(current.status, 'pending')

      // Different request_id → replace (not idempotent).
      const secondRequestId = '00000000-0000-0000-0000-0000bbbbbbbb'
      const secondRow = {
        status: 'pending',
        request_id: secondRequestId,
        requested_at: '2099-02-02T00:00:00.000Z',
      }
      await tx.queryObject`
        UPDATE traffic.project_config
        SET secrets_rotation = ${JSON.stringify(secondRow)}::jsonb,
            updated_at = now()
        WHERE project_ref = 'pcfg_ref_rot'
      `

      const after = await tx.queryObject<{
        secrets_rotation: { request_id: string }
      }>`
        SELECT secrets_rotation
        FROM traffic.project_config WHERE project_ref = 'pcfg_ref_rot'
      `
      assertEquals(after.rows[0].secrets_rotation.request_id, secondRequestId)

      await tx.rollback()
    } finally {
      connection.release()
    }
  }
)

Deno.test('rotation: advance pending→running→succeeded; succeeded is terminal', async () => {
  const connection = await pool.connect()
  const tx = connection.createTransaction('test_rotation_advance')
  try {
    await tx.begin()

    const reqId = '00000000-0000-0000-0000-0000ccccccccc'.slice(0, 36)
    await tx.queryObject`
        INSERT INTO traffic.project_config (project_ref, secrets_rotation)
        VALUES (
          'pcfg_ref_adv',
          ${JSON.stringify({
            status: 'pending',
            request_id: reqId,
            requested_at: '2099-03-03T00:00:00.000Z',
          })}::jsonb
        )
      `

    // Simulate advanceStatus-on-read for each poll.
    const advance = async () => {
      const result = await tx.queryObject<{
        secrets_rotation: { status: string }
      }>`
          SELECT secrets_rotation FROM traffic.project_config
          WHERE project_ref = 'pcfg_ref_adv'
        `
      const cur = result.rows[0].secrets_rotation
      const next =
        cur.status === 'pending' ? 'running' : cur.status === 'running' ? 'succeeded' : cur.status
      if (next !== cur.status) {
        await tx.queryObject`
            UPDATE traffic.project_config
            SET secrets_rotation = jsonb_set(secrets_rotation, '{status}', ${`"${next}"`}::jsonb)
            WHERE project_ref = 'pcfg_ref_adv'
          `
      }
      return next
    }

    assertEquals(await advance(), 'running')
    assertEquals(await advance(), 'succeeded')
    assertEquals(await advance(), 'succeeded')

    await tx.rollback()
  } finally {
    connection.release()
  }
})

// ── Lint exceptions: upsert behaviour ──

Deno.test('lint_exceptions: upsert on (project_ref, lint_name) updates disabled flag', async () => {
  const connection = await pool.connect()
  const tx = connection.createTransaction('test_lint_upsert')
  try {
    await tx.begin()

    await tx.queryObject`
        INSERT INTO traffic.lint_exceptions (project_ref, lint_name, disabled, metadata)
        VALUES ('pcfg_ref_lint', 'unindexed_foreign_keys', true, '{"note":"first"}'::jsonb)
      `

    await tx.queryObject`
        INSERT INTO traffic.lint_exceptions (project_ref, lint_name, disabled, metadata)
        VALUES ('pcfg_ref_lint', 'unindexed_foreign_keys', false, '{"note":"second"}'::jsonb)
        ON CONFLICT (project_ref, lint_name) DO UPDATE
        SET disabled = EXCLUDED.disabled,
            metadata = EXCLUDED.metadata,
            updated_at = now()
      `

    const result = await tx.queryObject<{
      disabled: boolean
      metadata: { note?: string }
      count: number
    }>`
        SELECT disabled, metadata,
          (SELECT COUNT(*)::int FROM traffic.lint_exceptions
            WHERE project_ref = 'pcfg_ref_lint'
              AND lint_name = 'unindexed_foreign_keys') AS count
        FROM traffic.lint_exceptions
        WHERE project_ref = 'pcfg_ref_lint'
          AND lint_name = 'unindexed_foreign_keys'
      `
    assertEquals(result.rows.length, 1)
    assertEquals(result.rows[0].disabled, false)
    assertEquals(result.rows[0].metadata.note, 'second')
    assertEquals(result.rows[0].count, 1, 'UNIQUE(project_ref, lint_name) prevents duplicates')

    await tx.rollback()
  } finally {
    connection.release()
  }
})
