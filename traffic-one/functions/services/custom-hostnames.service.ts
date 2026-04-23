import type { Pool } from 'https://deno.land/x/postgres@v0.17.0/mod.ts'

export type CustomHostnameStatus = 'not_configured' | 'pending' | 'active' | 'failed'

export interface CustomHostnameRow {
  id: number
  project_ref: string
  custom_hostname: string | null
  status: CustomHostnameStatus
  verification_errors: unknown[]
  ownership_verified: boolean
  ssl_verified: boolean
  inserted_at: string
  updated_at: string
}

export async function getCustomHostnameByRef(
  pool: Pool,
  projectRef: string
): Promise<CustomHostnameRow | null> {
  const connection = await pool.connect()
  try {
    const result = await connection.queryObject<CustomHostnameRow>`
      SELECT * FROM traffic.custom_hostnames WHERE project_ref = ${projectRef}
    `
    return result.rows[0] ?? null
  } finally {
    connection.release()
  }
}

// ── Upsert on initialize ──────────────────────────────────
//
// initialize writes the user-supplied hostname and flips the row to
// status='pending'. In self-hosted there is no DNS verification worker,
// so the row stays in 'pending' until the operator manually updates it.

export async function upsertInitializedCustomHostname(
  pool: Pool,
  projectRef: string,
  customHostname: string
): Promise<CustomHostnameRow> {
  const connection = await pool.connect()
  try {
    const result = await connection.queryObject<CustomHostnameRow>`
      INSERT INTO traffic.custom_hostnames (
        project_ref, custom_hostname, status,
        verification_errors, ownership_verified, ssl_verified
      ) VALUES (
        ${projectRef}, ${customHostname}, 'pending',
        '[]'::jsonb, false, false
      )
      ON CONFLICT (project_ref) DO UPDATE SET
        custom_hostname = EXCLUDED.custom_hostname,
        status = 'pending',
        verification_errors = '[]'::jsonb,
        ownership_verified = false,
        ssl_verified = false,
        updated_at = now()
      RETURNING *
    `
    return result.rows[0]
  } finally {
    connection.release()
  }
}
