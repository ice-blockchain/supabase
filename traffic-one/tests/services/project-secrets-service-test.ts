import { Pool } from 'https://deno.land/x/postgres@v0.17.0/mod.ts'
import { assert, assertEquals } from 'jsr:@std/assert@1'

import 'jsr:@std/dotenv/load'

import {
  createSecret,
  decryptSecretInternal,
  deleteSecret,
  listSecretNames,
} from '../../functions/services/project-secrets.service.ts'

const pool = new Pool(Deno.env.get('TRAFFIC_DB_URL')!, 1, true)

async function cleanup(projectRef: string) {
  const connection = await pool.connect()
  try {
    const rows = await connection.queryObject<{ secret_id: string }>`
      SELECT secret_id FROM traffic.project_secrets WHERE project_ref = ${projectRef}
    `
    for (const row of rows.rows) {
      await connection.queryObject`
        DELETE FROM vault.secrets WHERE id = ${row.secret_id}::uuid
      `
    }
    await connection.queryObject`
      DELETE FROM traffic.project_secrets WHERE project_ref = ${projectRef}
    `
  } finally {
    connection.release()
  }
}

// ── encrypt + decrypt round-trip via Vault ──────────────

Deno.test('createSecret + decryptSecretInternal round-trip', async () => {
  const ref = `psec_rt_${Date.now()}`
  try {
    const result = await createSecret(pool, ref, 'API_KEY', 'super-secret-value')
    assertEquals(result.name, 'API_KEY')
    assertEquals(result.status, 'created')

    const decrypted = await decryptSecretInternal(pool, ref, 'API_KEY')
    assertEquals(decrypted, 'super-secret-value')
  } finally {
    await cleanup(ref)
  }
})

// ── createSecret with existing name updates (status 'updated') ─

Deno.test('createSecret with existing name rotates plaintext in place', async () => {
  const ref = `psec_up_${Date.now()}`
  try {
    const first = await createSecret(pool, ref, 'ROT', 'v1')
    assertEquals(first.status, 'created')

    const second = await createSecret(pool, ref, 'ROT', 'v2')
    assertEquals(second.status, 'updated')

    const decrypted = await decryptSecretInternal(pool, ref, 'ROT')
    assertEquals(decrypted, 'v2')

    const names = await listSecretNames(pool, ref)
    assertEquals(names.length, 1)
    assertEquals(names[0].name, 'ROT')
  } finally {
    await cleanup(ref)
  }
})

// ── listSecretNames never returns plaintext ─────────────

Deno.test('listSecretNames only returns name + updated_at (no plaintext surface)', async () => {
  const ref = `psec_ls_${Date.now()}`
  try {
    await createSecret(pool, ref, 'A', 'aaa')
    await createSecret(pool, ref, 'B', 'bbb')

    const names = await listSecretNames(pool, ref)
    assertEquals(names.length, 2)

    const sorted = [...names].sort((a, b) => a.name.localeCompare(b.name))
    assertEquals(sorted[0].name, 'A')
    assertEquals(sorted[1].name, 'B')

    for (const row of sorted) {
      const rec = row as unknown as Record<string, unknown>
      assertEquals('value' in rec, false)
      assertEquals('decrypted_secret' in rec, false)
      assertEquals('secret_id' in rec, false)
      assert(typeof row.updated_at === 'string')
    }
  } finally {
    await cleanup(ref)
  }
})

// ── deleteSecret removes both Vault row and mapping ────

Deno.test('deleteSecret removes the Vault row and mapping', async () => {
  const ref = `psec_del_${Date.now()}`
  try {
    await createSecret(pool, ref, 'DOOMED', 'will-be-gone')

    const removed = await deleteSecret(pool, ref, 'DOOMED')
    assertEquals(removed, true)

    const names = await listSecretNames(pool, ref)
    assertEquals(names.length, 0)

    const decrypted = await decryptSecretInternal(pool, ref, 'DOOMED')
    assertEquals(decrypted, null)
  } finally {
    await cleanup(ref)
  }
})

Deno.test('deleteSecret returns false when mapping does not exist', async () => {
  const ref = `psec_miss_${Date.now()}`
  const removed = await deleteSecret(pool, ref, 'NEVER_CREATED')
  assertEquals(removed, false)
})

// ── decryptSecretInternal isolation by project_ref ─────

Deno.test('decryptSecretInternal is isolated by project_ref', async () => {
  const refA = `psec_iso_a_${Date.now()}`
  const refB = `psec_iso_b_${Date.now()}`
  try {
    await createSecret(pool, refA, 'SHARED_NAME', 'value-a')
    await createSecret(pool, refB, 'SHARED_NAME', 'value-b')

    const decryptedA = await decryptSecretInternal(pool, refA, 'SHARED_NAME')
    const decryptedB = await decryptSecretInternal(pool, refB, 'SHARED_NAME')
    assertEquals(decryptedA, 'value-a')
    assertEquals(decryptedB, 'value-b')
  } finally {
    await cleanup(refA)
    await cleanup(refB)
  }
})
