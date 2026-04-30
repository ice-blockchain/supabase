import type { Pool } from 'https://deno.land/x/postgres@v0.19.3/mod.ts'

import type {
  AccessToken,
  CreateAccessTokenResponse,
  CreateScopedAccessTokenResponse,
  ScopedAccessToken,
} from '../types/api.ts'

async function hashToken(token: string): Promise<string> {
  const encoder = new TextEncoder()
  const data = encoder.encode(token)
  const hashBuffer = await crypto.subtle.digest('SHA-256', data)
  const hashArray = Array.from(new Uint8Array(hashBuffer))
  return hashArray.map((b) => b.toString(16).padStart(2, '0')).join('')
}

function generateToken(): string {
  const bytes = new Uint8Array(32)
  crypto.getRandomValues(bytes)
  return Array.from(bytes)
    .map((b) => b.toString(16).padStart(2, '0'))
    .join('')
}

function tokenAlias(token: string): string {
  return token.slice(0, 8) + '...' + token.slice(-4)
}

interface AccessTokenRow {
  id: number
  profile_id: number
  name: string
  token_hash: string
  token_alias: string
  scope: string | null
  expires_at: string | null
  last_used_at: string | null
  created_at: string
}

interface ScopedTokenRow {
  id: string
  profile_id: number
  name: string
  token_hash: string
  token_alias: string
  permissions: string[]
  organization_slugs: string[]
  project_refs: string[]
  expires_at: string | null
  last_used_at: string | null
  created_at: string
}

function rowToAccessToken(row: AccessTokenRow): AccessToken {
  return {
    id: row.id,
    name: row.name,
    token_alias: row.token_alias,
    scope: (row.scope as AccessToken['scope']) ?? undefined,
    expires_at: row.expires_at,
    last_used_at: row.last_used_at,
    created_at: row.created_at,
  }
}

function rowToScopedToken(row: ScopedTokenRow): ScopedAccessToken {
  return {
    id: row.id,
    name: row.name,
    token_alias: row.token_alias,
    permissions: row.permissions,
    organization_slugs: row.organization_slugs?.length ? row.organization_slugs : undefined,
    project_refs: row.project_refs?.length ? row.project_refs : undefined,
    expires_at: row.expires_at,
    last_used_at: row.last_used_at,
    created_at: row.created_at,
  }
}

export async function listAccessTokens(pool: Pool, profileId: number): Promise<AccessToken[]> {
  const connection = await pool.connect()
  try {
    const result = await connection.queryObject<AccessTokenRow>`
      SELECT id, profile_id, name, token_hash, token_alias, scope, expires_at, last_used_at, created_at
      FROM traffic.access_tokens WHERE profile_id = ${profileId}
      ORDER BY created_at DESC
    `
    return result.rows.map(rowToAccessToken)
  } finally {
    connection.release()
  }
}

export async function createAccessToken(
  pool: Pool,
  profileId: number,
  name: string,
  gotrueId: string,
  auditContext?: { email: string; ip: string; method: string; route: string },
): Promise<CreateAccessTokenResponse> {
  const rawToken = generateToken()
  const hash = await hashToken(rawToken)
  const alias = tokenAlias(rawToken)

  const connection = await pool.connect()
  try {
    const tx = connection.createTransaction('create_access_token')
    await tx.begin()

    const result = await tx.queryObject<AccessTokenRow>`
      INSERT INTO traffic.access_tokens (profile_id, name, token_hash, token_alias)
      VALUES (${profileId}, ${name}, ${hash}, ${alias})
      RETURNING *
    `

    if (auditContext) {
      await tx.queryObject`
        INSERT INTO traffic.audit_logs (
          id, profile_id, action_name, action_metadata,
          actor_id, actor_type, actor_metadata,
          target_description, target_metadata, occurred_at
        ) VALUES (
          gen_random_uuid(), ${profileId}, 'access_tokens.insert',
          ${
        JSON.stringify([{ method: auditContext.method, route: auditContext.route, status: 201 }])
      }::jsonb,
          ${gotrueId}, 'user',
          ${JSON.stringify([{ email: auditContext.email, ip: auditContext.ip }])}::jsonb,
          ${'access_tokens #' + result.rows[0].id}, '{}'::jsonb, now()
        )
      `
    }

    await tx.commit()
    return { ...rowToAccessToken(result.rows[0]), token: rawToken }
  } finally {
    connection.release()
  }
}

export async function deleteAccessToken(
  pool: Pool,
  profileId: number,
  tokenId: number,
  gotrueId: string,
  auditContext?: { email: string; ip: string; method: string; route: string },
): Promise<boolean> {
  const connection = await pool.connect()
  try {
    const tx = connection.createTransaction('delete_access_token')
    await tx.begin()

    const result = await tx.queryObject`
      DELETE FROM traffic.access_tokens WHERE id = ${tokenId} AND profile_id = ${profileId}
    `

    if ((result.rowCount ?? 0) === 0) {
      await tx.rollback()
      return false
    }

    if (auditContext) {
      await tx.queryObject`
        INSERT INTO traffic.audit_logs (
          id, profile_id, action_name, action_metadata,
          actor_id, actor_type, actor_metadata,
          target_description, target_metadata, occurred_at
        ) VALUES (
          gen_random_uuid(), ${profileId}, 'access_tokens.delete',
          ${
        JSON.stringify([{ method: auditContext.method, route: auditContext.route, status: 200 }])
      }::jsonb,
          ${gotrueId}, 'user',
          ${JSON.stringify([{ email: auditContext.email, ip: auditContext.ip }])}::jsonb,
          ${'access_tokens #' + tokenId}, '{}'::jsonb, now()
        )
      `
    }

    await tx.commit()
    return true
  } finally {
    connection.release()
  }
}

export async function listScopedAccessTokens(
  pool: Pool,
  profileId: number,
): Promise<ScopedAccessToken[]> {
  const connection = await pool.connect()
  try {
    const result = await connection.queryObject<ScopedTokenRow>`
      SELECT * FROM traffic.scoped_access_tokens WHERE profile_id = ${profileId}
      ORDER BY created_at DESC
    `
    return result.rows.map(rowToScopedToken)
  } finally {
    connection.release()
  }
}

export async function createScopedAccessToken(
  pool: Pool,
  profileId: number,
  body: {
    name: string
    permissions: string[]
    organization_slugs?: string[]
    project_refs?: string[]
    expires_at?: string
  },
  gotrueId: string,
  auditContext?: { email: string; ip: string; method: string; route: string },
): Promise<CreateScopedAccessTokenResponse> {
  const rawToken = generateToken()
  const hash = await hashToken(rawToken)
  const alias = tokenAlias(rawToken)

  const connection = await pool.connect()
  try {
    const tx = connection.createTransaction('create_scoped_token')
    await tx.begin()

    const expiresAt = body.expires_at ? new Date(body.expires_at).toISOString() : null

    const result = await tx.queryObject<ScopedTokenRow>`
      INSERT INTO traffic.scoped_access_tokens (
        profile_id, name, token_hash, token_alias, permissions,
        organization_slugs, project_refs, expires_at
      ) VALUES (
        ${profileId}, ${body.name}, ${hash}, ${alias},
        ${body.permissions}, ${body.organization_slugs ?? []},
        ${body.project_refs ?? []}, ${expiresAt}
      )
      RETURNING *
    `

    if (auditContext) {
      await tx.queryObject`
        INSERT INTO traffic.audit_logs (
          id, profile_id, action_name, action_metadata,
          actor_id, actor_type, actor_metadata,
          target_description, target_metadata, occurred_at
        ) VALUES (
          gen_random_uuid(), ${profileId}, 'scoped_access_tokens.insert',
          ${
        JSON.stringify([{ method: auditContext.method, route: auditContext.route, status: 201 }])
      }::jsonb,
          ${gotrueId}, 'user',
          ${JSON.stringify([{ email: auditContext.email, ip: auditContext.ip }])}::jsonb,
          ${'scoped_access_tokens #' + result.rows[0].id}, '{}'::jsonb, now()
        )
      `
    }

    await tx.commit()
    return { ...rowToScopedToken(result.rows[0]), token: rawToken }
  } finally {
    connection.release()
  }
}

export async function deleteScopedAccessToken(
  pool: Pool,
  profileId: number,
  tokenId: string,
  gotrueId: string,
  auditContext?: { email: string; ip: string; method: string; route: string },
): Promise<boolean> {
  const connection = await pool.connect()
  try {
    const tx = connection.createTransaction('delete_scoped_token')
    await tx.begin()

    const result = await tx.queryObject`
      DELETE FROM traffic.scoped_access_tokens WHERE id = ${tokenId}::uuid AND profile_id = ${profileId}
    `

    if ((result.rowCount ?? 0) === 0) {
      await tx.rollback()
      return false
    }

    if (auditContext) {
      await tx.queryObject`
        INSERT INTO traffic.audit_logs (
          id, profile_id, action_name, action_metadata,
          actor_id, actor_type, actor_metadata,
          target_description, target_metadata, occurred_at
        ) VALUES (
          gen_random_uuid(), ${profileId}, 'scoped_access_tokens.delete',
          ${
        JSON.stringify([{ method: auditContext.method, route: auditContext.route, status: 200 }])
      }::jsonb,
          ${gotrueId}, 'user',
          ${JSON.stringify([{ email: auditContext.email, ip: auditContext.ip }])}::jsonb,
          ${'scoped_access_tokens #' + tokenId}, '{}'::jsonb, now()
        )
      `
    }

    await tx.commit()
    return true
  } finally {
    connection.release()
  }
}
