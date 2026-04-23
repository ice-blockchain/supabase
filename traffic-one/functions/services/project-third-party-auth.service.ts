import type { Pool } from 'https://deno.land/x/postgres@v0.17.0/mod.ts'

// Third-party auth integrations.
//
// Studio's `useCreateThirdPartyAuthIntegrationMutation` accepts one of:
//   { oidc_issuer_url: string }  -> remote OIDC discovery
//   { jwks_url: string }         -> remote JWKS URL
//   { custom_jwks: object }      -> user-pasted JWKS JSON
//
// We collapse the first two into `type='oidc'` (both reference an external
// issuer/jwks endpoint) and the third into `type='custom_jwks'`. The CHECK
// constraint in migration 019 enforces the enum.

export type ThirdPartyAuthType = 'oidc' | 'custom_jwks'

export interface ThirdPartyAuthInput {
  oidc_issuer_url?: string | null
  jwks_url?: string | null
  custom_jwks?: Record<string, unknown> | null
}

export interface ThirdPartyAuthRow {
  id: string
  project_ref: string
  type: ThirdPartyAuthType
  oidc_issuer_url: string | null
  jwks_url: string | null
  custom_jwks: Record<string, unknown> | null
  resolved_jwks: Record<string, unknown> | null
  inserted_at: string
  updated_at: string
}

interface AuditContext {
  email: string
  ip: string
  method: string
  route: string
}

export class InvalidThirdPartyAuthInputError extends Error {
  constructor(message: string) {
    super(message)
    this.name = 'InvalidThirdPartyAuthInputError'
  }
}

function resolveType(input: ThirdPartyAuthInput): {
  type: ThirdPartyAuthType
  oidcIssuerUrl: string | null
  jwksUrl: string | null
  customJwks: Record<string, unknown> | null
} {
  const hasCustom =
    input.custom_jwks !== undefined &&
    input.custom_jwks !== null &&
    typeof input.custom_jwks === 'object' &&
    Object.keys(input.custom_jwks).length > 0
  const hasIssuer = typeof input.oidc_issuer_url === 'string' && input.oidc_issuer_url.length > 0
  const hasJwks = typeof input.jwks_url === 'string' && input.jwks_url.length > 0

  if (!hasCustom && !hasIssuer && !hasJwks) {
    throw new InvalidThirdPartyAuthInputError(
      'one of oidc_issuer_url, jwks_url, or custom_jwks is required'
    )
  }

  if (hasCustom) {
    return {
      type: 'custom_jwks',
      oidcIssuerUrl: null,
      jwksUrl: null,
      customJwks: input.custom_jwks as Record<string, unknown>,
    }
  }

  return {
    type: 'oidc',
    oidcIssuerUrl: hasIssuer ? (input.oidc_issuer_url as string) : null,
    jwksUrl: hasJwks ? (input.jwks_url as string) : null,
    customJwks: null,
  }
}

// ── Create ─────────────────────────────────────────────────

export async function createThirdPartyAuth(
  pool: Pool,
  projectRef: string,
  organizationId: number,
  input: ThirdPartyAuthInput,
  profileId: number,
  gotrueId: string,
  auditContext: AuditContext
): Promise<ThirdPartyAuthRow> {
  const { type, oidcIssuerUrl, jwksUrl, customJwks } = resolveType(input)

  const connection = await pool.connect()
  try {
    const tx = connection.createTransaction(`create_third_party_auth_${projectRef}_${Date.now()}`)
    await tx.begin()

    const inserted = await tx.queryObject<ThirdPartyAuthRow>`
      INSERT INTO traffic.project_third_party_auth (
        project_ref, type, oidc_issuer_url, jwks_url, custom_jwks
      ) VALUES (
        ${projectRef}, ${type}, ${oidcIssuerUrl}, ${jwksUrl},
        ${customJwks === null ? null : JSON.stringify(customJwks)}::jsonb
      )
      RETURNING *
    `
    const row = inserted.rows[0]

    await tx.queryObject`
      INSERT INTO traffic.audit_logs (
        id, profile_id, organization_id, action_name, action_metadata,
        actor_id, actor_type, actor_metadata,
        target_description, target_metadata, occurred_at
      ) VALUES (
        gen_random_uuid(), ${profileId}, ${organizationId}, 'project.third_party_auth_added',
        ${JSON.stringify([{ method: auditContext.method, route: auditContext.route, status: 201 }])}::jsonb,
        ${gotrueId}, 'user',
        ${JSON.stringify([{ email: auditContext.email, ip: auditContext.ip }])}::jsonb,
        ${'project_third_party_auth #' + row.id + ' (ref: ' + projectRef + ')'},
        ${JSON.stringify({ type })}::jsonb,
        now()
      )
    `

    await tx.commit()
    return row
  } finally {
    connection.release()
  }
}

// ── List ──────────────────────────────────────────────────

export async function listThirdPartyAuth(
  pool: Pool,
  projectRef: string
): Promise<ThirdPartyAuthRow[]> {
  const connection = await pool.connect()
  try {
    const result = await connection.queryObject<ThirdPartyAuthRow>`
      SELECT * FROM traffic.project_third_party_auth
      WHERE project_ref = ${projectRef}
      ORDER BY inserted_at ASC
    `
    return result.rows
  } finally {
    connection.release()
  }
}

// ── Get by id ─────────────────────────────────────────────

export async function getThirdPartyAuth(
  pool: Pool,
  projectRef: string,
  id: string
): Promise<ThirdPartyAuthRow | null> {
  const connection = await pool.connect()
  try {
    const result = await connection.queryObject<ThirdPartyAuthRow>`
      SELECT * FROM traffic.project_third_party_auth
      WHERE project_ref = ${projectRef} AND id = ${id}::uuid
    `
    return result.rows[0] ?? null
  } finally {
    connection.release()
  }
}

// ── Delete ────────────────────────────────────────────────

export async function deleteThirdPartyAuth(
  pool: Pool,
  projectRef: string,
  organizationId: number,
  id: string,
  profileId: number,
  gotrueId: string,
  auditContext: AuditContext
): Promise<ThirdPartyAuthRow | null> {
  const connection = await pool.connect()
  try {
    const tx = connection.createTransaction(`delete_third_party_auth_${projectRef}_${Date.now()}`)
    await tx.begin()

    const existing = await tx.queryObject<ThirdPartyAuthRow>`
      SELECT * FROM traffic.project_third_party_auth
      WHERE project_ref = ${projectRef} AND id = ${id}::uuid
    `
    if (existing.rows.length === 0) {
      await tx.rollback()
      return null
    }
    const row = existing.rows[0]

    await tx.queryObject`
      DELETE FROM traffic.project_third_party_auth
      WHERE project_ref = ${projectRef} AND id = ${id}::uuid
    `

    await tx.queryObject`
      INSERT INTO traffic.audit_logs (
        id, profile_id, organization_id, action_name, action_metadata,
        actor_id, actor_type, actor_metadata,
        target_description, target_metadata, occurred_at
      ) VALUES (
        gen_random_uuid(), ${profileId}, ${organizationId}, 'project.third_party_auth_removed',
        ${JSON.stringify([{ method: auditContext.method, route: auditContext.route, status: 200 }])}::jsonb,
        ${gotrueId}, 'user',
        ${JSON.stringify([{ email: auditContext.email, ip: auditContext.ip }])}::jsonb,
        ${'project_third_party_auth #' + row.id + ' (ref: ' + projectRef + ')'},
        ${JSON.stringify({ type: row.type })}::jsonb,
        now()
      )
    `

    await tx.commit()
    return row
  } finally {
    connection.release()
  }
}
