import type { Pool } from 'https://deno.land/x/postgres@v0.19.3/mod.ts'

// Vault-backed per-project secret storage.
//
// The `traffic.project_secrets` table maps (project_ref, name) to the
// vault.secrets.id that holds the encrypted value. Plaintext is never stored
// in `traffic.project_secrets`; it only lives in vault.decrypted_secrets and
// is surfaced exclusively via decryptSecretInternal — the HTTP routes must
// never call that helper on the list / GET paths.
//
// Vault helpers mirror the patterns used by project.service.ts:
//   vault.create_secret(text, text, text)  → uuid
//   vault.update_secret(uuid, text, text, text)
//   DELETE FROM vault.secrets WHERE id = ?::uuid
//   SELECT decrypted_secret FROM vault.decrypted_secrets WHERE id = ?::uuid

export interface ProjectSecretInfo {
  name: string
  updated_at: string
}

interface ProjectSecretRow {
  id: number
  project_ref: string
  name: string
  secret_id: string
  inserted_at: string
  updated_at: string
}

function vaultSecretName(projectRef: string, name: string): string {
  return `project_${projectRef}_user_secret_${name}`
}

function vaultSecretDescription(projectRef: string, name: string): string {
  return `Project ${projectRef} user-managed secret: ${name}`
}

// ── Upsert (create or update) ─────────────────────────────
//
// v1 API treats POST with the same name as an upsert: the plaintext is
// replaced in place while the vault secret_id is preserved. That way any
// external caller that holds the secret_id sees the new value immediately.

export interface SecretUpsertResult {
  name: string
  status: 'created' | 'updated'
  updated_at: string
}

export async function createSecret(
  pool: Pool,
  projectRef: string,
  name: string,
  value: string,
): Promise<SecretUpsertResult> {
  const connection = await pool.connect()
  try {
    const tx = connection.createTransaction(`project_secret_upsert_${projectRef}_${Date.now()}`)
    await tx.begin()

    const existing = await tx.queryObject<ProjectSecretRow>`
      SELECT id, project_ref, name, secret_id, inserted_at, updated_at
      FROM traffic.project_secrets
      WHERE project_ref = ${projectRef} AND name = ${name}
    `

    if (existing.rows.length > 0) {
      const row = existing.rows[0]
      await tx.queryObject`
        SELECT vault.update_secret(
          ${row.secret_id}::uuid,
          ${value},
          ${vaultSecretName(projectRef, name)},
          ${vaultSecretDescription(projectRef, name)}
        )
      `
      const updated = await tx.queryObject<ProjectSecretRow>`
        UPDATE traffic.project_secrets
        SET updated_at = now()
        WHERE id = ${row.id}
        RETURNING id, project_ref, name, secret_id, inserted_at, updated_at
      `
      await tx.commit()
      return {
        name: updated.rows[0].name,
        status: 'updated',
        updated_at: updated.rows[0].updated_at,
      }
    }

    const secret = await tx.queryObject<{ id: string }>`
      SELECT vault.create_secret(
        ${value},
        ${vaultSecretName(projectRef, name)},
        ${vaultSecretDescription(projectRef, name)}
      ) AS id
    `

    const inserted = await tx.queryObject<ProjectSecretRow>`
      INSERT INTO traffic.project_secrets (project_ref, name, secret_id)
      VALUES (${projectRef}, ${name}, ${secret.rows[0].id}::uuid)
      RETURNING id, project_ref, name, secret_id, inserted_at, updated_at
    `

    await tx.commit()
    return {
      name: inserted.rows[0].name,
      status: 'created',
      updated_at: inserted.rows[0].updated_at,
    }
  } finally {
    connection.release()
  }
}

// ── List (names + timestamps only) ─────────────────────────

export async function listSecretNames(
  pool: Pool,
  projectRef: string,
): Promise<ProjectSecretInfo[]> {
  const connection = await pool.connect()
  try {
    const result = await connection.queryObject<{
      name: string
      updated_at: string
    }>`
      SELECT name, updated_at
      FROM traffic.project_secrets
      WHERE project_ref = ${projectRef}
      ORDER BY name ASC
    `
    return result.rows.map((row) => ({
      name: row.name,
      updated_at: row.updated_at,
    }))
  } finally {
    connection.release()
  }
}

// ── Delete (vault + mapping row) ───────────────────────────

export async function deleteSecret(pool: Pool, projectRef: string, name: string): Promise<boolean> {
  const connection = await pool.connect()
  try {
    const tx = connection.createTransaction(`project_secret_delete_${projectRef}_${Date.now()}`)
    await tx.begin()

    const existing = await tx.queryObject<{ id: number; secret_id: string }>`
      SELECT id, secret_id
      FROM traffic.project_secrets
      WHERE project_ref = ${projectRef} AND name = ${name}
    `
    if (existing.rows.length === 0) {
      await tx.rollback()
      return false
    }
    const row = existing.rows[0]

    await tx.queryObject`
      DELETE FROM vault.secrets WHERE id = ${row.secret_id}::uuid
    `
    await tx.queryObject`
      DELETE FROM traffic.project_secrets WHERE id = ${row.id}
    `

    await tx.commit()
    return true
  } finally {
    connection.release()
  }
}

// ── Internal decrypt (never exposed by routes) ─────────────

export async function decryptSecretInternal(
  pool: Pool,
  projectRef: string,
  name: string,
): Promise<string | null> {
  const connection = await pool.connect()
  try {
    const mapping = await connection.queryObject<{ secret_id: string }>`
      SELECT secret_id
      FROM traffic.project_secrets
      WHERE project_ref = ${projectRef} AND name = ${name}
    `
    if (mapping.rows.length === 0) return null

    const decrypted = await connection.queryObject<{ decrypted_secret: string }>`
      SELECT decrypted_secret FROM vault.decrypted_secrets
      WHERE id = ${mapping.rows[0].secret_id}::uuid
    `
    if (decrypted.rows.length === 0) return null
    return decrypted.rows[0].decrypted_secret
  } finally {
    connection.release()
  }
}
