import type { Pool } from 'https://deno.land/x/postgres@v0.19.3/mod.ts'

import type {
  AuditLog,
  AuditLogsResponse,
  CreateSSOProviderBody,
  MfaEnforcementResponse,
  SSOProviderResponse,
  UpdateSSOProviderBody,
} from '../types/api.ts'

const DEFAULT_RETENTION_PERIOD = 7

// ── Row interfaces ───────────────────────────────────────

interface AuditLogRow {
  id: string
  profile_id: number
  action_name: string
  action_metadata: Array<{ method?: string; route?: string; status?: number }>
  actor_id: string
  actor_type: string
  actor_metadata: Array<{ email?: string; ip?: string; tokenType?: string }>
  target_description: string
  target_metadata: Record<string, unknown>
  occurred_at: string
}

interface SSOProviderRow {
  id: string
  organization_id: number
  enabled: boolean
  metadata_xml_file: string | null
  metadata_xml_url: string | null
  domains: string[]
  email_mapping: string[]
  first_name_mapping: string[]
  last_name_mapping: string[]
  user_name_mapping: string[]
  join_org_on_signup_enabled: boolean
  join_org_on_signup_role: string
  created_at: string
  updated_at: string
}

// ── Row converters ───────────────────────────────────────

function rowToAuditLog(row: AuditLogRow): AuditLog {
  return {
    action: {
      name: row.action_name,
      metadata: row.action_metadata ?? [],
    },
    actor: {
      id: row.actor_id,
      type: row.actor_type,
      metadata: row.actor_metadata ?? [],
    },
    target: {
      description: row.target_description ?? '',
      metadata: row.target_metadata ?? {},
    },
    occurred_at: row.occurred_at,
  }
}

function rowToSSOProvider(row: SSOProviderRow): SSOProviderResponse {
  return {
    id: row.id,
    organization_id: row.organization_id,
    enabled: row.enabled,
    metadata_xml_file: row.metadata_xml_file,
    metadata_xml_url: row.metadata_xml_url,
    domains: row.domains ?? [],
    email_mapping: row.email_mapping ?? [],
    first_name_mapping: row.first_name_mapping ?? [],
    last_name_mapping: row.last_name_mapping ?? [],
    user_name_mapping: row.user_name_mapping ?? [],
    join_org_on_signup_enabled: row.join_org_on_signup_enabled,
    join_org_on_signup_role: row.join_org_on_signup_role,
    created_at: row.created_at,
    updated_at: row.updated_at,
  }
}

// ── Org Audit Logs ───────────────────────────────────────

export async function getOrgAuditLogs(
  pool: Pool,
  orgId: number,
  startTs: string,
  endTs: string,
): Promise<AuditLogsResponse> {
  const connection = await pool.connect()
  try {
    const result = await connection.queryObject<AuditLogRow>`
      SELECT * FROM traffic.audit_logs
      WHERE organization_id = ${orgId}
        AND occurred_at >= ${startTs}::timestamptz
        AND occurred_at <= ${endTs}::timestamptz
      ORDER BY occurred_at DESC
    `
    return {
      result: result.rows.map(rowToAuditLog),
      retention_period: DEFAULT_RETENTION_PERIOD,
    }
  } finally {
    connection.release()
  }
}

// ── MFA Enforcement ──────────────────────────────────────

export async function getMfaEnforcement(
  pool: Pool,
  orgId: number,
): Promise<MfaEnforcementResponse> {
  const connection = await pool.connect()
  try {
    const result = await connection.queryObject<{ mfa_enforced: boolean }>`
      SELECT mfa_enforced FROM traffic.organizations WHERE id = ${orgId}
    `
    return { enforced: result.rows[0]?.mfa_enforced ?? false }
  } finally {
    connection.release()
  }
}

export async function setMfaEnforcement(
  pool: Pool,
  orgId: number,
  enforced: boolean,
  profileId: number,
  gotrueId: string,
  auditCtx: { email: string; ip: string; method: string; route: string },
): Promise<MfaEnforcementResponse> {
  const connection = await pool.connect()
  try {
    const tx = connection.createTransaction('set_mfa_enforcement')
    await tx.begin()

    await tx.queryObject`
      UPDATE traffic.organizations
      SET mfa_enforced = ${enforced}, updated_at = now()
      WHERE id = ${orgId}
    `

    await tx.queryObject`
      INSERT INTO traffic.audit_logs (
        id, profile_id, organization_id, action_name, action_metadata,
        actor_id, actor_type, actor_metadata,
        target_description, target_metadata, occurred_at
      ) VALUES (
        gen_random_uuid(), ${profileId}, ${orgId}, 'organizations.mfa_update',
        ${JSON.stringify([{ method: auditCtx.method, route: auditCtx.route, status: 200 }])}::jsonb,
        ${gotrueId}, 'user',
        ${JSON.stringify([{ email: auditCtx.email, ip: auditCtx.ip }])}::jsonb,
        ${'organizations #' + orgId}, ${JSON.stringify({ enforced })}::jsonb, now()
      )
    `

    await tx.commit()
    return { enforced }
  } finally {
    connection.release()
  }
}

// ── SSO Provider CRUD ────────────────────────────────────

export async function getSSOProvider(
  pool: Pool,
  orgId: number,
): Promise<SSOProviderResponse | null> {
  const connection = await pool.connect()
  try {
    const result = await connection.queryObject<SSOProviderRow>`
      SELECT * FROM traffic.sso_providers WHERE organization_id = ${orgId}
    `
    if (result.rows.length === 0) return null
    return rowToSSOProvider(result.rows[0])
  } finally {
    connection.release()
  }
}

export async function createSSOProvider(
  pool: Pool,
  orgId: number,
  body: CreateSSOProviderBody,
  profileId: number,
  gotrueId: string,
  auditCtx: { email: string; ip: string; method: string; route: string },
): Promise<SSOProviderResponse> {
  const connection = await pool.connect()
  try {
    const tx = connection.createTransaction('create_sso_provider')
    await tx.begin()

    const result = await tx.queryObject<SSOProviderRow>`
      INSERT INTO traffic.sso_providers (
        organization_id, enabled,
        metadata_xml_file, metadata_xml_url,
        domains, email_mapping,
        first_name_mapping, last_name_mapping, user_name_mapping,
        join_org_on_signup_enabled, join_org_on_signup_role
      ) VALUES (
        ${orgId},
        ${body.enabled ?? false},
        ${body.metadata_xml_file ?? null},
        ${body.metadata_xml_url ?? null},
        ${body.domains ?? []},
        ${body.email_mapping ?? []},
        ${body.first_name_mapping ?? []},
        ${body.last_name_mapping ?? []},
        ${body.user_name_mapping ?? []},
        ${body.join_org_on_signup_enabled ?? false},
        ${body.join_org_on_signup_role ?? 'Developer'}
      )
      RETURNING *
    `

    await tx.queryObject`
      INSERT INTO traffic.audit_logs (
        id, profile_id, organization_id, action_name, action_metadata,
        actor_id, actor_type, actor_metadata,
        target_description, target_metadata, occurred_at
      ) VALUES (
        gen_random_uuid(), ${profileId}, ${orgId}, 'sso_providers.insert',
        ${JSON.stringify([{ method: auditCtx.method, route: auditCtx.route, status: 201 }])}::jsonb,
        ${gotrueId}, 'user',
        ${JSON.stringify([{ email: auditCtx.email, ip: auditCtx.ip }])}::jsonb,
        ${'sso_providers #' + result.rows[0].id}, '{}'::jsonb, now()
      )
    `

    await tx.commit()
    return rowToSSOProvider(result.rows[0])
  } finally {
    connection.release()
  }
}

export async function updateSSOProvider(
  pool: Pool,
  orgId: number,
  body: UpdateSSOProviderBody,
  profileId: number,
  gotrueId: string,
  auditCtx: { email: string; ip: string; method: string; route: string },
): Promise<SSOProviderResponse | null> {
  const connection = await pool.connect()
  try {
    const tx = connection.createTransaction('update_sso_provider')
    await tx.begin()

    const setClauses: string[] = []
    const values: unknown[] = []
    let paramIdx = 1

    if (body.enabled !== undefined) {
      setClauses.push(`enabled = $${paramIdx++}`)
      values.push(body.enabled)
    }
    if (body.metadata_xml_file !== undefined) {
      setClauses.push(`metadata_xml_file = $${paramIdx++}`)
      values.push(body.metadata_xml_file)
    }
    if (body.metadata_xml_url !== undefined) {
      setClauses.push(`metadata_xml_url = $${paramIdx++}`)
      values.push(body.metadata_xml_url)
    }
    if (body.domains !== undefined) {
      setClauses.push(`domains = $${paramIdx++}`)
      values.push(body.domains)
    }
    if (body.email_mapping !== undefined) {
      setClauses.push(`email_mapping = $${paramIdx++}`)
      values.push(body.email_mapping)
    }
    if (body.first_name_mapping !== undefined) {
      setClauses.push(`first_name_mapping = $${paramIdx++}`)
      values.push(body.first_name_mapping)
    }
    if (body.last_name_mapping !== undefined) {
      setClauses.push(`last_name_mapping = $${paramIdx++}`)
      values.push(body.last_name_mapping)
    }
    if (body.user_name_mapping !== undefined) {
      setClauses.push(`user_name_mapping = $${paramIdx++}`)
      values.push(body.user_name_mapping)
    }
    if (body.join_org_on_signup_enabled !== undefined) {
      setClauses.push(`join_org_on_signup_enabled = $${paramIdx++}`)
      values.push(body.join_org_on_signup_enabled)
    }
    if (body.join_org_on_signup_role !== undefined) {
      setClauses.push(`join_org_on_signup_role = $${paramIdx++}`)
      values.push(body.join_org_on_signup_role)
    }

    setClauses.push(`updated_at = now()`)

    const setClause = setClauses.join(', ')
    values.push(orgId)
    const query =
      `UPDATE traffic.sso_providers SET ${setClause} WHERE organization_id = $${paramIdx} RETURNING *`

    const result = await tx.queryObject<SSOProviderRow>({ text: query, args: values })
    if (result.rows.length === 0) {
      await tx.rollback()
      return null
    }

    await tx.queryObject`
      INSERT INTO traffic.audit_logs (
        id, profile_id, organization_id, action_name, action_metadata,
        actor_id, actor_type, actor_metadata,
        target_description, target_metadata, occurred_at
      ) VALUES (
        gen_random_uuid(), ${profileId}, ${orgId}, 'sso_providers.update',
        ${JSON.stringify([{ method: auditCtx.method, route: auditCtx.route, status: 200 }])}::jsonb,
        ${gotrueId}, 'user',
        ${JSON.stringify([{ email: auditCtx.email, ip: auditCtx.ip }])}::jsonb,
        ${'sso_providers #' + result.rows[0].id}, '{}'::jsonb, now()
      )
    `

    await tx.commit()
    return rowToSSOProvider(result.rows[0])
  } finally {
    connection.release()
  }
}

export async function deleteSSOProvider(
  pool: Pool,
  orgId: number,
  profileId: number,
  gotrueId: string,
  auditCtx: { email: string; ip: string; method: string; route: string },
): Promise<boolean> {
  const connection = await pool.connect()
  try {
    const tx = connection.createTransaction('delete_sso_provider')
    await tx.begin()

    const existing = await tx.queryObject<{ id: string }>`
      SELECT id FROM traffic.sso_providers WHERE organization_id = ${orgId}
    `
    if (existing.rows.length === 0) {
      await tx.rollback()
      return false
    }

    await tx.queryObject`
      DELETE FROM traffic.sso_providers WHERE organization_id = ${orgId}
    `

    await tx.queryObject`
      INSERT INTO traffic.audit_logs (
        id, profile_id, organization_id, action_name, action_metadata,
        actor_id, actor_type, actor_metadata,
        target_description, target_metadata, occurred_at
      ) VALUES (
        gen_random_uuid(), ${profileId}, ${orgId}, 'sso_providers.delete',
        ${JSON.stringify([{ method: auditCtx.method, route: auditCtx.route, status: 200 }])}::jsonb,
        ${gotrueId}, 'user',
        ${JSON.stringify([{ email: auditCtx.email, ip: auditCtx.ip }])}::jsonb,
        ${'sso_providers #' + existing.rows[0].id}, '{}'::jsonb, now()
      )
    `

    await tx.commit()
    return true
  } finally {
    connection.release()
  }
}
