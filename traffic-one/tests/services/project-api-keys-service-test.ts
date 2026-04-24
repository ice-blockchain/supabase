import { assert, assertEquals, assertExists, assertNotEquals } from 'jsr:@std/assert@1'

import 'jsr:@std/dotenv/load'

import { createRetryingPool } from '../_helpers/pool.ts'
import {
  computeKeyAlias,
  hashApiKey,
  verifyApiKey,
} from '../../functions/services/project-api-keys.service.ts'

const pool = createRetryingPool(Deno.env.get('TRAFFIC_DB_URL')!)

// ── Hashing ──────────────────────────────────────────────

Deno.test('hashApiKey is deterministic SHA-256 hex (same plaintext → same hash)', async () => {
  const plaintext = 'sb_secret_abcdef0123456789'
  const h1 = await hashApiKey(plaintext)
  const h2 = await hashApiKey(plaintext)
  assertEquals(
    h1,
    h2,
    'deterministic hashing: no salt, same input → same hash',
  )
  assertEquals(h1.length, 64, 'SHA-256 hex is 64 chars')
  assert(/^[0-9a-f]+$/.test(h1), 'hash is lowercase hex')
  assertNotEquals(h1, plaintext, 'hash must differ from plaintext')
})

Deno.test('hashApiKey produces distinct hashes for different plaintexts', async () => {
  const a = await hashApiKey('sb_secret_alpha')
  const b = await hashApiKey('sb_secret_beta')
  assertNotEquals(a, b)
})

Deno.test('verifyApiKey round-trips: matches the stored hash, rejects other inputs', async () => {
  const plaintext = 'sb_publishable_round_trip_example'
  const hash = await hashApiKey(plaintext)
  assert(await verifyApiKey(plaintext, hash), 'correct plaintext verifies')
  assert(
    !(await verifyApiKey('different-plaintext', hash)),
    'wrong plaintext must not verify',
  )
})

// ── Alias ────────────────────────────────────────────────

Deno.test("computeKeyAlias returns first 8 + '...' + last 4", () => {
  const alias = computeKeyAlias('sb_secret_abcdefghijklmnop1234')
  assertEquals(alias, 'sb_secre...' + '1234')
  assert(alias.includes('...'))
})

Deno.test('computeKeyAlias returns the plaintext unchanged when it is too short', () => {
  const alias = computeKeyAlias('short')
  assertEquals(alias, 'short')
})

// ── project_api_keys table: list excludes soft-deleted ───

Deno.test(
  'project_api_keys: soft-deleted rows (deleted_at IS NOT NULL) excluded from active list',
  async () => {
    await pool.withConnection(async (connection) => {
      const tx = connection.createTransaction('test_api_keys_soft_delete')
      await tx.begin()

      const ref = `svc_ref_${Math.floor(Math.random() * 1e9)}`

      const keep = await tx.queryObject<{ id: number }>`
      INSERT INTO traffic.project_api_keys (
        project_ref, name, key_hash, key_alias, type
      ) VALUES (${ref}, 'keep', 'hash_keep_1', 'alias_keep', 'secret')
      RETURNING id
    `
      const drop = await tx.queryObject<{ id: number }>`
      INSERT INTO traffic.project_api_keys (
        project_ref, name, key_hash, key_alias, type, deleted_at
      ) VALUES (${ref}, 'drop', 'hash_drop_1', 'alias_drop', 'secret', now())
      RETURNING id
    `

      const list = await tx.queryObject<{ id: number; name: string }>`
      SELECT id, name FROM traffic.project_api_keys
      WHERE project_ref = ${ref} AND deleted_at IS NULL
      ORDER BY id ASC
    `
      assertEquals(list.rows.length, 1)
      assertEquals(list.rows[0].id, keep.rows[0].id)
      assertEquals(list.rows[0].name, 'keep')

      const all = await tx.queryObject<{ id: number }>`
      SELECT id FROM traffic.project_api_keys
      WHERE project_ref = ${ref}
    `
      assertEquals(
        all.rows.length,
        2,
        'soft-deleted row is still present at the DB level',
      )
      const ids = all.rows.map((r) => r.id)
      assert(ids.includes(keep.rows[0].id))
      assert(ids.includes(drop.rows[0].id))

      await tx.rollback()
    })
  },
)

// ── project_api_keys table: hash stored, not plaintext ──

Deno.test('project_api_keys: stored key_hash matches hashApiKey(plaintext)', async () => {
  await pool.withConnection(async (connection) => {
    const tx = connection.createTransaction('test_api_keys_hash_persist')
    await tx.begin()

    const ref = `svc_ref_${Math.floor(Math.random() * 1e9)}`
    const plaintext = 'sb_secret_persisted_round_trip_value'
    const hash = await hashApiKey(plaintext)
    const alias = computeKeyAlias(plaintext)

    await tx.queryObject`
      INSERT INTO traffic.project_api_keys (
        project_ref, name, key_hash, key_alias, type
      ) VALUES (${ref}, 'persisted', ${hash}, ${alias}, 'secret')
    `

    const result = await tx.queryObject<
      { key_hash: string; key_alias: string }
    >`
      SELECT key_hash, key_alias FROM traffic.project_api_keys
      WHERE project_ref = ${ref}
    `
    assertEquals(result.rows.length, 1)
    assertNotEquals(
      result.rows[0].key_hash,
      plaintext,
      'plaintext must never be persisted',
    )
    assertEquals(result.rows[0].key_hash, hash)
    assertEquals(result.rows[0].key_alias, alias)
    assert(await verifyApiKey(plaintext, result.rows[0].key_hash))

    await tx.rollback()
  })
})

// ── UNIQUE(project_ref, key_hash) ────────────────────────

Deno.test('project_api_keys: UNIQUE(project_ref, key_hash) prevents duplicate hashes', async () => {
  await pool.withConnection(async (connection) => {
    const tx = connection.createTransaction('test_api_keys_unique_hash')
    await tx.begin()

    const ref = `svc_ref_${Math.floor(Math.random() * 1e9)}`
    await tx.queryObject`
      INSERT INTO traffic.project_api_keys (
        project_ref, name, key_hash, key_alias, type
      ) VALUES (${ref}, 'a', 'dup_hash', 'dup_alias', 'secret')
    `

    let threw = false
    try {
      await tx.queryObject`
        INSERT INTO traffic.project_api_keys (
          project_ref, name, key_hash, key_alias, type
        ) VALUES (${ref}, 'b', 'dup_hash', 'dup_alias', 'secret')
      `
    } catch {
      threw = true
    }
    assert(
      threw,
      'duplicate key_hash for the same project_ref should violate UNIQUE',
    )

    await tx.rollback()
  })
})

// ── Active-swap invariant for signing keys ───────────────

Deno.test(
  'project_jwt_signing_keys: marking a new key in_use must demote existing in_use keys',
  async () => {
    await pool.withConnection(async (connection) => {
      const tx = connection.createTransaction('test_signing_swap')
      await tx.begin()

      const ref = `svc_ref_${Math.floor(Math.random() * 1e9)}`
      const keyA = await tx.queryObject<{ id: number }>`
      INSERT INTO traffic.project_jwt_signing_keys (
        project_ref, algorithm, status, public_jwk
      ) VALUES (${ref}, 'HS256', 'in_use', '{"kid":"a"}'::jsonb)
      RETURNING id
    `

      // Atomic swap: demote any existing in_use, then insert the new in_use key.
      await tx.queryObject`
      UPDATE traffic.project_jwt_signing_keys
      SET status = 'previously_used', updated_at = now()
      WHERE project_ref = ${ref} AND status = 'in_use'
    `
      const keyB = await tx.queryObject<{ id: number }>`
      INSERT INTO traffic.project_jwt_signing_keys (
        project_ref, algorithm, status, public_jwk
      ) VALUES (${ref}, 'HS256', 'in_use', '{"kid":"b"}'::jsonb)
      RETURNING id
    `

      const result = await tx.queryObject<{ id: number; status: string }>`
      SELECT id, status FROM traffic.project_jwt_signing_keys
      WHERE project_ref = ${ref}
      ORDER BY id ASC
    `
      assertEquals(result.rows.length, 2)

      const a = result.rows.find((r) => r.id === keyA.rows[0].id)!
      const b = result.rows.find((r) => r.id === keyB.rows[0].id)!
      assertExists(a)
      assertExists(b)
      assertEquals(
        a.status,
        'previously_used',
        'previous in_use key must be demoted',
      )
      assertEquals(b.status, 'in_use', 'newly-active key must be in_use')

      const inUse = result.rows.filter((r) => r.status === 'in_use')
      assertEquals(
        inUse.length,
        1,
        'exactly one signing key must be in_use per project',
      )

      await tx.rollback()
    })
  },
)

// ── Active-swap atomicity ────────────────────────────────

Deno.test(
  'project_jwt_signing_keys: swap rolled back on error leaves previous state intact',
  async () => {
    await pool.withConnection(async (connection) => {
      const ref = `svc_ref_${Math.floor(Math.random() * 1e9)}`

      // Seed one in_use key outside the aborted transaction so we can observe
      // that the swap rolled back cleanly.
      const seedTx = connection.createTransaction('seed_swap')
      await seedTx.begin()
      await seedTx.queryObject`
      INSERT INTO traffic.project_jwt_signing_keys (
        project_ref, algorithm, status, public_jwk
      ) VALUES (${ref}, 'HS256', 'in_use', '{"kid":"seed"}'::jsonb)
    `
      await seedTx.commit()

      const tx = connection.createTransaction('swap_rollback')
      await tx.begin()
      try {
        await tx.queryObject`
        UPDATE traffic.project_jwt_signing_keys
        SET status = 'previously_used', updated_at = now()
        WHERE project_ref = ${ref} AND status = 'in_use'
      `
        // Force a rollback by violating the CHECK constraint on status.
        await tx.queryObject`
        INSERT INTO traffic.project_jwt_signing_keys (
          project_ref, algorithm, status, public_jwk
        ) VALUES (${ref}, 'HS256', 'INVALID_STATUS', '{"kid":"new"}'::jsonb)
      `
        await tx.commit()
        throw new Error('expected CHECK violation to abort the transaction')
      } catch {
        try {
          await tx.rollback()
        } catch {
          // already rolled back by the failed statement; that's fine.
        }
      }

      const result = await connection.queryObject<{ status: string }>`
      SELECT status FROM traffic.project_jwt_signing_keys
      WHERE project_ref = ${ref}
      ORDER BY id ASC
    `
      assertEquals(result.rows.length, 1, 'only the seed row should exist')
      assertEquals(
        result.rows[0].status,
        'in_use',
        'seed row must remain in_use after the aborted swap',
      )

      // Clean up (outside any transaction we intentionally rolled back).
      await connection.queryObject`
      DELETE FROM traffic.project_jwt_signing_keys WHERE project_ref = ${ref}
    `
    })
  },
)
