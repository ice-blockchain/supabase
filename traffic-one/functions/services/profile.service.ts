import type { Pool } from 'https://deno.land/x/postgres@v0.19.3/mod.ts'

import type { ProfileResponse } from '../types/api.ts'

interface ProfileRow {
  id: number
  gotrue_id: string
  username: string
  primary_email: string
  first_name: string | null
  last_name: string | null
  mobile: string | null
  is_alpha_user: boolean
  is_sso_user: boolean
  free_project_limit: number | null
  disabled_features: string[]
  created_at: string
  updated_at: string
}

function rowToResponse(row: ProfileRow): ProfileResponse {
  return {
    id: row.id,
    gotrue_id: row.gotrue_id,
    auth0_id: row.gotrue_id,
    username: row.username,
    primary_email: row.primary_email,
    first_name: row.first_name,
    last_name: row.last_name,
    mobile: row.mobile,
    is_alpha_user: row.is_alpha_user,
    is_sso_user: row.is_sso_user,
    free_project_limit: row.free_project_limit,
    disabled_features: row.disabled_features as ProfileResponse['disabled_features'],
  }
}

export async function getOrCreateProfile(
  pool: Pool,
  gotrueId: string,
  email: string,
): Promise<ProfileResponse> {
  const connection = await pool.connect()
  try {
    const existing = await connection.queryObject<ProfileRow>`
      SELECT * FROM traffic.profiles WHERE gotrue_id = ${gotrueId}
    `
    if (existing.rows.length > 0) {
      return rowToResponse(existing.rows[0])
    }

    const username = email.split('@')[0] || gotrueId.slice(0, 8)
    const created = await connection.queryObject<ProfileRow>`
      INSERT INTO traffic.profiles (gotrue_id, username, primary_email)
      VALUES (${gotrueId}, ${username}, ${email})
      ON CONFLICT (gotrue_id) DO UPDATE SET gotrue_id = EXCLUDED.gotrue_id
      RETURNING *
    `
    return rowToResponse(created.rows[0])
  } finally {
    connection.release()
  }
}

export async function updateProfile(
  pool: Pool,
  gotrueId: string,
  updates: Partial<Pick<ProfileResponse, 'first_name' | 'last_name' | 'username' | 'mobile'>>,
  auditContext?: { email: string; ip: string; method: string; route: string },
): Promise<ProfileResponse> {
  const connection = await pool.connect()
  try {
    const tx = connection.createTransaction('profile_update')
    await tx.begin()

    const setClauses: string[] = []
    const values: unknown[] = []
    let paramIdx = 1

    if (updates.first_name !== undefined) {
      setClauses.push(`first_name = $${paramIdx++}`)
      values.push(updates.first_name)
    }
    if (updates.last_name !== undefined) {
      setClauses.push(`last_name = $${paramIdx++}`)
      values.push(updates.last_name)
    }
    if (updates.username !== undefined) {
      setClauses.push(`username = $${paramIdx++}`)
      values.push(updates.username)
    }
    if (updates.mobile !== undefined) {
      setClauses.push(`mobile = $${paramIdx++}`)
      values.push(updates.mobile)
    }

    setClauses.push(`updated_at = now()`)

    if (setClauses.length === 1) {
      await tx.rollback()
      const existing = await connection.queryObject<ProfileRow>`
        SELECT * FROM traffic.profiles WHERE gotrue_id = ${gotrueId}
      `
      return rowToResponse(existing.rows[0])
    }

    const setClause = setClauses.join(', ')
    values.push(gotrueId)
    const query =
      `UPDATE traffic.profiles SET ${setClause} WHERE gotrue_id = $${paramIdx} RETURNING *`

    const result = await tx.queryObject<ProfileRow>({ text: query, args: values })

    if (auditContext && result.rows.length > 0) {
      await tx.queryObject`
        INSERT INTO traffic.audit_logs (
          id, profile_id, action_name, action_metadata,
          actor_id, actor_type, actor_metadata,
          target_description, target_metadata, occurred_at
        ) VALUES (
          gen_random_uuid(), ${result.rows[0].id}, 'profiles.update',
          ${
        JSON.stringify([{ method: auditContext.method, route: auditContext.route, status: 200 }])
      }::jsonb,
          ${gotrueId}, 'user',
          ${JSON.stringify([{ email: auditContext.email, ip: auditContext.ip }])}::jsonb,
          ${'profiles #' + result.rows[0].id}, '{}'::jsonb, now()
        )
      `
    }

    await tx.commit()
    return rowToResponse(result.rows[0])
  } finally {
    connection.release()
  }
}

export async function getProfileByGotrueId(
  pool: Pool,
  gotrueId: string,
): Promise<ProfileRow | null> {
  const connection = await pool.connect()
  try {
    const result = await connection.queryObject<ProfileRow>`
      SELECT * FROM traffic.profiles WHERE gotrue_id = ${gotrueId}
    `
    return result.rows[0] ?? null
  } finally {
    connection.release()
  }
}

export async function updatePrimaryEmail(
  pool: Pool,
  gotrueId: string,
  newEmail: string,
  auditContext: { email: string; ip: string; method: string; route: string },
): Promise<ProfileResponse> {
  const connection = await pool.connect()
  try {
    const tx = connection.createTransaction('profile_update_email')
    await tx.begin()

    const updated = await tx.queryObject<ProfileRow>`
      UPDATE traffic.profiles
      SET primary_email = ${newEmail}, updated_at = now()
      WHERE gotrue_id = ${gotrueId}
      RETURNING *
    `

    if (updated.rows.length === 0) {
      await tx.rollback()
      throw new Error('Profile not found')
    }

    const row = updated.rows[0]
    const targetMetadata = {
      old_email: auditContext.email,
      new_email: newEmail,
    }

    await tx.queryObject`
      INSERT INTO traffic.audit_logs (
        id, profile_id, action_name, action_metadata,
        actor_id, actor_type, actor_metadata,
        target_description, target_metadata, occurred_at
      ) VALUES (
        gen_random_uuid(), ${row.id}, 'profile.email_updated',
        ${
      JSON.stringify([{ method: auditContext.method, route: auditContext.route, status: 200 }])
    }::jsonb,
        ${gotrueId}, 'user',
        ${JSON.stringify([{ email: auditContext.email, ip: auditContext.ip }])}::jsonb,
        ${'profiles #' + row.id}, ${JSON.stringify(targetMetadata)}::jsonb, now()
      )
    `

    await tx.commit()
    return rowToResponse(row)
  } finally {
    connection.release()
  }
}
