import type { Pool } from 'https://deno.land/x/postgres@v0.17.0/mod.ts'

// ── Types ────────────────────────────────────────────────────

export type ApiKeyType = 'publishable' | 'secret'

export type SigningKeyStatus = 'in_use' | 'standby' | 'previously_used' | 'revoked'

export interface ApiKeyRow {
  id: number
  project_ref: string
  name: string
  description: string
  key_hash: string
  key_alias: string
  type: ApiKeyType
  tags: string[]
  created_at: string
  updated_at: string
  deleted_at: string | null
}

export interface ApiKey {
  id: number
  name: string
  description: string
  api_key_alias: string
  type: ApiKeyType
  tags: string[]
  inserted_at: string
  updated_at: string
}

export interface CreateApiKeyInput {
  name: string
  description?: string
  type: ApiKeyType
  tags?: string[]
}

export interface UpdateApiKeyInput {
  name?: string
  description?: string
  tags?: string[]
}

export interface LegacyApiKey {
  name: 'anon' | 'service_role'
  api_key: string
  tags: string
}

export interface SigningKeyRow {
  id: number
  project_ref: string
  algorithm: string
  status: SigningKeyStatus
  public_jwk: Record<string, unknown>
  private_jwk_secret_id: string | null
  created_at: string
  updated_at: string
}

export interface SigningKey {
  id: number
  algorithm: string
  status: SigningKeyStatus
  public_jwk: Record<string, unknown>
  inserted_at: string
  updated_at: string
}

export interface CreateSigningKeyInput {
  algorithm: string
  status?: SigningKeyStatus
  active?: boolean
  public_jwk?: Record<string, unknown>
  private_jwk_secret_id?: string | null
}

export interface UpdateSigningKeyInput {
  algorithm?: string
  status?: SigningKeyStatus
  active?: boolean
  public_jwk?: Record<string, unknown>
}

export interface AuditContext {
  email: string
  ip: string
  method: string
  route: string
}

export interface CreateTemporaryApiKeyInput {
  name?: string
  ttl_seconds?: number
}

export interface TemporaryApiKeyResponse {
  api_key: string
  api_key_alias: string
  expires_at: string
  type: ApiKeyType
}

// ── Hashing & helpers ────────────────────────────────────────

// Deterministic SHA-256 hex, no salt. Same plaintext always produces the same
// hash, so a bare `key_hash = sha256(plaintext)` lookup is sufficient for the
// future `verifyApiKey` middleware.
export async function hashApiKey(plaintext: string): Promise<string> {
  const encoder = new TextEncoder()
  const data = encoder.encode(plaintext)
  const hashBuffer = await crypto.subtle.digest('SHA-256', data)
  const hashArray = Array.from(new Uint8Array(hashBuffer))
  return hashArray.map((b) => b.toString(16).padStart(2, '0')).join('')
}

export async function verifyApiKey(plaintext: string, hash: string): Promise<boolean> {
  const computed = await hashApiKey(plaintext)
  return computed === hash
}

function randomHex(bytes: number): string {
  const arr = new Uint8Array(bytes)
  crypto.getRandomValues(arr)
  return Array.from(arr)
    .map((b) => b.toString(16).padStart(2, '0'))
    .join('')
}

function generateApiKey(type: ApiKeyType, prefixOverride?: string): string {
  const prefix = prefixOverride ?? (type === 'publishable' ? 'sb_publishable_' : 'sb_secret_')
  return prefix + randomHex(32)
}

export function computeKeyAlias(plaintext: string): string {
  if (plaintext.length <= 12) return plaintext
  return plaintext.slice(0, 8) + '...' + plaintext.slice(-4)
}

function rowToApiKey(row: ApiKeyRow): ApiKey {
  return {
    id: row.id,
    name: row.name,
    description: row.description,
    api_key_alias: row.key_alias,
    type: row.type,
    tags: row.tags ?? [],
    inserted_at: row.created_at,
    updated_at: row.updated_at,
  }
}

function rowToSigningKey(row: SigningKeyRow): SigningKey {
  return {
    id: row.id,
    algorithm: row.algorithm,
    status: row.status,
    public_jwk: row.public_jwk ?? {},
    inserted_at: row.created_at,
    updated_at: row.updated_at,
  }
}

// ── API Keys ─────────────────────────────────────────────────

export async function listApiKeys(pool: Pool, projectRef: string): Promise<ApiKey[]> {
  const connection = await pool.connect()
  try {
    const result = await connection.queryObject<ApiKeyRow>`
      SELECT id, project_ref, name, description, key_hash, key_alias, type, tags,
             created_at, updated_at, deleted_at
      FROM traffic.project_api_keys
      WHERE project_ref = ${projectRef} AND deleted_at IS NULL
      ORDER BY created_at ASC
    `
    return result.rows.map(rowToApiKey)
  } finally {
    connection.release()
  }
}

export async function getApiKey(
  pool: Pool,
  projectRef: string,
  id: number
): Promise<ApiKey | null> {
  const connection = await pool.connect()
  try {
    const result = await connection.queryObject<ApiKeyRow>`
      SELECT id, project_ref, name, description, key_hash, key_alias, type, tags,
             created_at, updated_at, deleted_at
      FROM traffic.project_api_keys
      WHERE project_ref = ${projectRef} AND id = ${id} AND deleted_at IS NULL
    `
    return result.rows[0] ? rowToApiKey(result.rows[0]) : null
  } finally {
    connection.release()
  }
}

export async function createApiKey(
  pool: Pool,
  projectRef: string,
  profileId: number,
  organizationId: number,
  input: CreateApiKeyInput,
  gotrueId: string,
  auditContext: AuditContext
): Promise<ApiKey & { api_key: string }> {
  const plaintext = generateApiKey(input.type)
  const hash = await hashApiKey(plaintext)
  const alias = computeKeyAlias(plaintext)

  const connection = await pool.connect()
  try {
    const tx = connection.createTransaction('create_project_api_key')
    await tx.begin()

    const inserted = await tx.queryObject<ApiKeyRow>`
      INSERT INTO traffic.project_api_keys (
        project_ref, name, description, key_hash, key_alias, type, tags
      ) VALUES (
        ${projectRef}, ${input.name}, ${input.description ?? ''},
        ${hash}, ${alias}, ${input.type},
        ${input.tags ?? []}::text[]
      )
      RETURNING id, project_ref, name, description, key_hash, key_alias, type, tags,
                created_at, updated_at, deleted_at
    `
    const row = inserted.rows[0]

    await tx.queryObject`
      INSERT INTO traffic.audit_logs (
        id, profile_id, organization_id, action_name, action_metadata,
        actor_id, actor_type, actor_metadata,
        target_description, target_metadata, occurred_at
      ) VALUES (
        gen_random_uuid(), ${profileId}, ${organizationId}, 'project.api_key_created',
        ${JSON.stringify([{ method: auditContext.method, route: auditContext.route, status: 201 }])}::jsonb,
        ${gotrueId}, 'user',
        ${JSON.stringify([{ email: auditContext.email, ip: auditContext.ip }])}::jsonb,
        ${'project_api_keys #' + row.id + ' (ref: ' + projectRef + ')'},
        ${JSON.stringify({ project_ref: projectRef, name: input.name, type: input.type })}::jsonb,
        now()
      )
    `

    await tx.commit()
    return { ...rowToApiKey(row), api_key: plaintext }
  } finally {
    connection.release()
  }
}

export async function updateApiKey(
  pool: Pool,
  projectRef: string,
  id: number,
  patch: UpdateApiKeyInput,
  profileId: number,
  organizationId: number,
  gotrueId: string,
  auditContext: AuditContext
): Promise<ApiKey | null> {
  const connection = await pool.connect()
  try {
    const tx = connection.createTransaction('update_project_api_key')
    await tx.begin()

    const result = await tx.queryObject<ApiKeyRow>`
      UPDATE traffic.project_api_keys
      SET name = COALESCE(${patch.name ?? null}, name),
          description = COALESCE(${patch.description ?? null}, description),
          tags = COALESCE(${patch.tags ?? null}::text[], tags),
          updated_at = now()
      WHERE project_ref = ${projectRef} AND id = ${id} AND deleted_at IS NULL
      RETURNING id, project_ref, name, description, key_hash, key_alias, type, tags,
                created_at, updated_at, deleted_at
    `
    if (result.rows.length === 0) {
      await tx.rollback()
      return null
    }
    const row = result.rows[0]

    const touchedKeys = Object.keys(patch)
    await tx.queryObject`
      INSERT INTO traffic.audit_logs (
        id, profile_id, organization_id, action_name, action_metadata,
        actor_id, actor_type, actor_metadata,
        target_description, target_metadata, occurred_at
      ) VALUES (
        gen_random_uuid(), ${profileId}, ${organizationId}, 'project.api_key_updated',
        ${JSON.stringify([{ method: auditContext.method, route: auditContext.route, status: 200 }])}::jsonb,
        ${gotrueId}, 'user',
        ${JSON.stringify([{ email: auditContext.email, ip: auditContext.ip }])}::jsonb,
        ${'project_api_keys #' + row.id + ' (ref: ' + projectRef + ')'},
        ${JSON.stringify({ project_ref: projectRef, keys: touchedKeys })}::jsonb,
        now()
      )
    `

    await tx.commit()
    return rowToApiKey(row)
  } finally {
    connection.release()
  }
}

export async function deleteApiKey(
  pool: Pool,
  projectRef: string,
  id: number,
  profileId: number,
  organizationId: number,
  gotrueId: string,
  auditContext: AuditContext
): Promise<ApiKey | null> {
  const connection = await pool.connect()
  try {
    const tx = connection.createTransaction('delete_project_api_key')
    await tx.begin()

    const result = await tx.queryObject<ApiKeyRow>`
      UPDATE traffic.project_api_keys
      SET deleted_at = now(), updated_at = now()
      WHERE project_ref = ${projectRef} AND id = ${id} AND deleted_at IS NULL
      RETURNING id, project_ref, name, description, key_hash, key_alias, type, tags,
                created_at, updated_at, deleted_at
    `
    if (result.rows.length === 0) {
      await tx.rollback()
      return null
    }
    const row = result.rows[0]

    await tx.queryObject`
      INSERT INTO traffic.audit_logs (
        id, profile_id, organization_id, action_name, action_metadata,
        actor_id, actor_type, actor_metadata,
        target_description, target_metadata, occurred_at
      ) VALUES (
        gen_random_uuid(), ${profileId}, ${organizationId}, 'project.api_key_revoked',
        ${JSON.stringify([{ method: auditContext.method, route: auditContext.route, status: 200 }])}::jsonb,
        ${gotrueId}, 'user',
        ${JSON.stringify([{ email: auditContext.email, ip: auditContext.ip }])}::jsonb,
        ${'project_api_keys #' + row.id + ' (ref: ' + projectRef + ')'},
        ${JSON.stringify({ project_ref: projectRef, name: row.name, type: row.type })}::jsonb,
        now()
      )
    `

    await tx.commit()
    return rowToApiKey(row)
  } finally {
    connection.release()
  }
}

// Env-derived anon + service keys. The GET /api-keys/legacy endpoint returns
// these read-only; they can't be mutated from the UI because self-hosted's
// GoTrue / PostgREST read them from container env vars.
export function listLegacyApiKeys(): LegacyApiKey[] {
  const anonKey = Deno.env.get('SUPABASE_ANON_KEY') ?? ''
  const serviceKey =
    Deno.env.get('SUPABASE_SERVICE_KEY') ?? Deno.env.get('SUPABASE_SECRET_KEY') ?? ''
  return [
    { name: 'anon', api_key: anonKey, tags: 'anon,public' },
    { name: 'service_role', api_key: serviceKey, tags: 'service_role' },
  ]
}

// Temporary (short-lived) API key. Persisted as a soft-deletable secret row
// with a `temporary` tag so it's auditable and distinguishable from
// long-lived keys; the expiry is advisory in the response (a future
// middleware can enforce it by comparing now() to the tag timestamp).
export async function createTemporaryApiKey(
  pool: Pool,
  projectRef: string,
  profileId: number,
  organizationId: number,
  input: CreateTemporaryApiKeyInput,
  gotrueId: string,
  auditContext: AuditContext
): Promise<TemporaryApiKeyResponse> {
  const ttlSeconds = Math.max(60, Math.min(3600, input.ttl_seconds ?? 600))
  const expiresAt = new Date(Date.now() + ttlSeconds * 1000).toISOString()
  const plaintext = generateApiKey('secret', 'sb_temp_')
  const hash = await hashApiKey(plaintext)
  const alias = computeKeyAlias(plaintext)
  const name = input.name ?? 'temporary'

  const connection = await pool.connect()
  try {
    const tx = connection.createTransaction('create_temp_api_key')
    await tx.begin()

    const inserted = await tx.queryObject<{ id: number }>`
      INSERT INTO traffic.project_api_keys (
        project_ref, name, description, key_hash, key_alias, type, tags
      ) VALUES (
        ${projectRef}, ${name}, ${'Temporary key; expires at ' + expiresAt},
        ${hash}, ${alias}, 'secret',
        ${['temporary', 'expires:' + expiresAt]}::text[]
      )
      RETURNING id
    `

    await tx.queryObject`
      INSERT INTO traffic.audit_logs (
        id, profile_id, organization_id, action_name, action_metadata,
        actor_id, actor_type, actor_metadata,
        target_description, target_metadata, occurred_at
      ) VALUES (
        gen_random_uuid(), ${profileId}, ${organizationId}, 'project.api_key_created',
        ${JSON.stringify([{ method: auditContext.method, route: auditContext.route, status: 201 }])}::jsonb,
        ${gotrueId}, 'user',
        ${JSON.stringify([{ email: auditContext.email, ip: auditContext.ip }])}::jsonb,
        ${'project_api_keys #' + inserted.rows[0].id + ' (ref: ' + projectRef + ', temporary)'},
        ${JSON.stringify({ project_ref: projectRef, name, type: 'secret', temporary: true, expires_at: expiresAt })}::jsonb,
        now()
      )
    `

    await tx.commit()
    return {
      api_key: plaintext,
      api_key_alias: alias,
      expires_at: expiresAt,
      type: 'secret',
    }
  } finally {
    connection.release()
  }
}

// ── Signing Keys ─────────────────────────────────────────────

export async function listSigningKeys(pool: Pool, projectRef: string): Promise<SigningKey[]> {
  const connection = await pool.connect()
  try {
    const result = await connection.queryObject<SigningKeyRow>`
      SELECT id, project_ref, algorithm, status, public_jwk,
             private_jwk_secret_id, created_at, updated_at
      FROM traffic.project_jwt_signing_keys
      WHERE project_ref = ${projectRef}
      ORDER BY created_at ASC
    `
    return result.rows.map(rowToSigningKey)
  } finally {
    connection.release()
  }
}

export async function getSigningKey(
  pool: Pool,
  projectRef: string,
  id: number
): Promise<SigningKey | null> {
  const connection = await pool.connect()
  try {
    const result = await connection.queryObject<SigningKeyRow>`
      SELECT id, project_ref, algorithm, status, public_jwk,
             private_jwk_secret_id, created_at, updated_at
      FROM traffic.project_jwt_signing_keys
      WHERE project_ref = ${projectRef} AND id = ${id}
    `
    return result.rows[0] ? rowToSigningKey(result.rows[0]) : null
  } finally {
    connection.release()
  }
}

function resolveSigningKeyStatus(
  input: { status?: SigningKeyStatus; active?: boolean },
  fallback: SigningKeyStatus
): SigningKeyStatus {
  if (input.status) return input.status
  if (input.active === true) return 'in_use'
  if (input.active === false) return 'standby'
  return fallback
}

// Create a signing key. If the incoming status is `in_use`, demote the
// currently-active key (if any) to `previously_used` in the same transaction
// so the single-active-key invariant holds.
export async function createSigningKey(
  pool: Pool,
  projectRef: string,
  profileId: number,
  organizationId: number,
  input: CreateSigningKeyInput,
  gotrueId: string,
  auditContext: AuditContext
): Promise<SigningKey> {
  const status = resolveSigningKeyStatus(input, 'standby')

  const connection = await pool.connect()
  try {
    const tx = connection.createTransaction('create_signing_key')
    await tx.begin()

    if (status === 'in_use') {
      await tx.queryObject`
        UPDATE traffic.project_jwt_signing_keys
        SET status = 'previously_used', updated_at = now()
        WHERE project_ref = ${projectRef} AND status = 'in_use'
      `
    }

    const inserted = await tx.queryObject<SigningKeyRow>`
      INSERT INTO traffic.project_jwt_signing_keys (
        project_ref, algorithm, status, public_jwk, private_jwk_secret_id
      ) VALUES (
        ${projectRef}, ${input.algorithm}, ${status},
        ${JSON.stringify(input.public_jwk ?? {})}::jsonb,
        ${input.private_jwk_secret_id ?? null}
      )
      RETURNING id, project_ref, algorithm, status, public_jwk,
                private_jwk_secret_id, created_at, updated_at
    `
    const row = inserted.rows[0]

    if (status === 'in_use') {
      await tx.queryObject`
        INSERT INTO traffic.audit_logs (
          id, profile_id, organization_id, action_name, action_metadata,
          actor_id, actor_type, actor_metadata,
          target_description, target_metadata, occurred_at
        ) VALUES (
          gen_random_uuid(), ${profileId}, ${organizationId}, 'project.signing_key_rotated',
          ${JSON.stringify([{ method: auditContext.method, route: auditContext.route, status: 201 }])}::jsonb,
          ${gotrueId}, 'user',
          ${JSON.stringify([{ email: auditContext.email, ip: auditContext.ip }])}::jsonb,
          ${'project_jwt_signing_keys #' + row.id + ' (ref: ' + projectRef + ')'},
          ${JSON.stringify({ project_ref: projectRef, algorithm: input.algorithm, status })}::jsonb,
          now()
        )
      `
    }

    await tx.commit()
    return rowToSigningKey(row)
  } finally {
    connection.release()
  }
}

export async function updateSigningKey(
  pool: Pool,
  projectRef: string,
  id: number,
  profileId: number,
  organizationId: number,
  patch: UpdateSigningKeyInput,
  gotrueId: string,
  auditContext: AuditContext
): Promise<SigningKey | null> {
  const requestedStatus: SigningKeyStatus | null = patch.status
    ? patch.status
    : patch.active === true
      ? 'in_use'
      : patch.active === false
        ? 'standby'
        : null

  const connection = await pool.connect()
  try {
    const tx = connection.createTransaction('update_signing_key')
    await tx.begin()

    const existing = await tx.queryObject<SigningKeyRow>`
      SELECT id, project_ref, algorithm, status, public_jwk,
             private_jwk_secret_id, created_at, updated_at
      FROM traffic.project_jwt_signing_keys
      WHERE project_ref = ${projectRef} AND id = ${id}
    `
    if (existing.rows.length === 0) {
      await tx.rollback()
      return null
    }

    if (requestedStatus === 'in_use') {
      await tx.queryObject`
        UPDATE traffic.project_jwt_signing_keys
        SET status = 'previously_used', updated_at = now()
        WHERE project_ref = ${projectRef} AND status = 'in_use' AND id <> ${id}
      `
    }

    const result = await tx.queryObject<SigningKeyRow>`
      UPDATE traffic.project_jwt_signing_keys
      SET algorithm = COALESCE(${patch.algorithm ?? null}, algorithm),
          status = COALESCE(${requestedStatus}, status),
          public_jwk = COALESCE(${patch.public_jwk ? JSON.stringify(patch.public_jwk) : null}::jsonb, public_jwk),
          updated_at = now()
      WHERE project_ref = ${projectRef} AND id = ${id}
      RETURNING id, project_ref, algorithm, status, public_jwk,
                private_jwk_secret_id, created_at, updated_at
    `
    const row = result.rows[0]

    if (requestedStatus === 'in_use' && existing.rows[0].status !== 'in_use') {
      await tx.queryObject`
        INSERT INTO traffic.audit_logs (
          id, profile_id, organization_id, action_name, action_metadata,
          actor_id, actor_type, actor_metadata,
          target_description, target_metadata, occurred_at
        ) VALUES (
          gen_random_uuid(), ${profileId}, ${organizationId}, 'project.signing_key_rotated',
          ${JSON.stringify([{ method: auditContext.method, route: auditContext.route, status: 200 }])}::jsonb,
          ${gotrueId}, 'user',
          ${JSON.stringify([{ email: auditContext.email, ip: auditContext.ip }])}::jsonb,
          ${'project_jwt_signing_keys #' + row.id + ' (ref: ' + projectRef + ')'},
          ${JSON.stringify({ project_ref: projectRef, algorithm: row.algorithm, status: row.status })}::jsonb,
          now()
        )
      `
    }

    await tx.commit()
    return rowToSigningKey(row)
  } finally {
    connection.release()
  }
}

export async function deleteSigningKey(
  pool: Pool,
  projectRef: string,
  id: number,
  profileId: number,
  organizationId: number,
  gotrueId: string,
  auditContext: AuditContext
): Promise<SigningKey | null> {
  const connection = await pool.connect()
  try {
    const tx = connection.createTransaction('delete_signing_key')
    await tx.begin()

    const result = await tx.queryObject<SigningKeyRow>`
      UPDATE traffic.project_jwt_signing_keys
      SET status = 'revoked', updated_at = now()
      WHERE project_ref = ${projectRef} AND id = ${id}
      RETURNING id, project_ref, algorithm, status, public_jwk,
                private_jwk_secret_id, created_at, updated_at
    `
    if (result.rows.length === 0) {
      await tx.rollback()
      return null
    }
    const row = result.rows[0]

    await tx.queryObject`
      INSERT INTO traffic.audit_logs (
        id, profile_id, organization_id, action_name, action_metadata,
        actor_id, actor_type, actor_metadata,
        target_description, target_metadata, occurred_at
      ) VALUES (
        gen_random_uuid(), ${profileId}, ${organizationId}, 'project.signing_key_revoked',
        ${JSON.stringify([{ method: auditContext.method, route: auditContext.route, status: 200 }])}::jsonb,
        ${gotrueId}, 'user',
        ${JSON.stringify([{ email: auditContext.email, ip: auditContext.ip }])}::jsonb,
        ${'project_jwt_signing_keys #' + row.id + ' (ref: ' + projectRef + ')'},
        ${JSON.stringify({ project_ref: projectRef, algorithm: row.algorithm })}::jsonb,
        now()
      )
    `

    await tx.commit()
    return rowToSigningKey(row)
  } finally {
    connection.release()
  }
}

// Env-derived legacy signing key (JWT_SECRET / HS256). Read-only view so
// Studio's settings page can surface the active algorithm; rotating this
// value in self-hosted requires restarting GoTrue with a new env var, so the
// POST equivalent returns 501.
export function listLegacySigningKeys(): SigningKey[] {
  const jwtSecret = Deno.env.get('JWT_SECRET') ?? ''
  return [
    {
      id: 0,
      algorithm: 'HS256',
      status: 'in_use',
      public_jwk: {
        kid: 'legacy',
        kty: 'oct',
        alg: 'HS256',
        has_secret: jwtSecret.length > 0,
      },
      inserted_at: new Date(0).toISOString(),
      updated_at: new Date(0).toISOString(),
    },
  ]
}
