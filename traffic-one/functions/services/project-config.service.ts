import type { Pool } from 'https://deno.land/x/postgres@v0.17.0/mod.ts'

// ── Types ──────────────────────────────────────────────────

export type ConfigSection = 'postgrest' | 'storage' | 'realtime' | 'pgbouncer' | 'secrets'

export type SectionColumn = 'postgrest' | 'storage' | 'realtime' | 'pgbouncer'

export type SensitivityLevel = 'LOW' | 'MEDIUM' | 'HIGH' | 'CRITICAL'

export type RotationStatus = 'pending' | 'running' | 'succeeded' | 'failed'

export interface RotationState {
  status: RotationStatus
  request_id: string
  requested_at: string
}

export interface LintException {
  lint_name: string
  disabled: boolean
  metadata: Record<string, unknown>
  inserted_at: string
  updated_at: string
}

export interface AuditContext {
  email: string
  ip: string
  method: string
  route: string
}

export interface DbPasswordOutcome {
  result: 'acknowledged'
  applied: boolean
}

export class InvalidSensitivityError extends Error {
  constructor(public readonly value: unknown) {
    super(`Invalid sensitivity value: ${String(value)}`)
    this.name = 'InvalidSensitivityError'
  }
}

// ── Defaults ───────────────────────────────────────────────

export const CONFIG_DEFAULTS: Record<ConfigSection, Record<string, unknown>> = {
  postgrest: {
    db_schema: 'public',
    max_rows: 1000,
    db_extra_search_path: 'public, extensions',
    db_pool: 100,
    jwt_secret: '***',
  },
  storage: {
    fileSizeLimit: 52428800,
    isFreeTier: true,
    features: {
      imageTransformation: { enabled: false },
      vectorBuckets: { enabled: false },
      icebergCatalog: { enabled: false },
      list_v2: { enabled: true },
    },
  },
  realtime: {
    enabled: true,
    db_publications: ['supabase_realtime'],
  },
  pgbouncer: {
    default_pool_size: 20,
    max_client_conn: 100,
    pool_mode: 'transaction',
  },
  secrets: {
    jwt_secret: '***',
    service_role_key: '***',
  },
}

export const SENSITIVITY_VALUES: readonly SensitivityLevel[] = ['LOW', 'MEDIUM', 'HIGH', 'CRITICAL']

export function isValidSensitivity(value: unknown): value is SensitivityLevel {
  return typeof value === 'string' && (SENSITIVITY_VALUES as readonly string[]).includes(value)
}

// ── Internal helpers ───────────────────────────────────────

interface ConfigRow {
  postgrest: Record<string, unknown> | null
  storage: Record<string, unknown> | null
  realtime: Record<string, unknown> | null
  pgbouncer: Record<string, unknown> | null
  secrets_rotation: Record<string, unknown> | null
}

type AuditAction = 'project.config_updated' | 'project.db_password_rotated'

// Section names are validated against a fixed allowlist before being
// substituted into SQL identifiers. Values never flow from user input.
function assertSectionColumn(section: SectionColumn): SectionColumn {
  switch (section) {
    case 'postgrest':
    case 'storage':
    case 'realtime':
    case 'pgbouncer':
      return section
    default:
      throw new Error(`Unknown config section: ${String(section)}`)
  }
}

function mergeWithDefaults<T extends ConfigSection>(
  section: T,
  overrides: Record<string, unknown> | null | undefined
): Record<string, unknown> {
  const defaults = CONFIG_DEFAULTS[section]
  return { ...defaults, ...(overrides ?? {}) }
}

function auditActionMetadata(auditContext: AuditContext, status: number): string {
  return JSON.stringify([{ method: auditContext.method, route: auditContext.route, status }])
}

function auditActorMetadata(auditContext: AuditContext): string {
  return JSON.stringify([{ email: auditContext.email, ip: auditContext.ip }])
}

// ── Get config ─────────────────────────────────────────────

export async function getConfigSection(
  pool: Pool,
  projectRef: string,
  section: ConfigSection
): Promise<Record<string, unknown>> {
  if (section === 'secrets') {
    return { ...CONFIG_DEFAULTS.secrets }
  }

  const column = assertSectionColumn(section)
  const connection = await pool.connect()
  try {
    const result = await connection.queryObject<ConfigRow>({
      text: `
        SELECT postgrest, storage, realtime, pgbouncer, secrets_rotation
        FROM traffic.project_config
        WHERE project_ref = $1
      `,
      args: [projectRef],
    })
    const row = result.rows[0]
    return mergeWithDefaults(column, row?.[column] ?? null)
  } finally {
    connection.release()
  }
}

// ── Update config (JSONB shallow-merge) ────────────────────

export async function updateConfigSection(
  pool: Pool,
  projectRef: string,
  section: SectionColumn,
  patch: Record<string, unknown>,
  profileId: number,
  organizationId: number,
  gotrueId: string,
  auditContext: AuditContext
): Promise<Record<string, unknown>> {
  const column = assertSectionColumn(section)
  const patchJson = JSON.stringify(patch ?? {})

  const upsertSql = `
    INSERT INTO traffic.project_config (project_ref, ${column})
    VALUES ($1, $2::jsonb)
    ON CONFLICT (project_ref) DO UPDATE
    SET ${column} = traffic.project_config.${column} || EXCLUDED.${column},
        updated_at = now()
    RETURNING postgrest, storage, realtime, pgbouncer, secrets_rotation
  `

  const connection = await pool.connect()
  try {
    const tx = connection.createTransaction('update_project_config')
    await tx.begin()

    const result = await tx.queryObject<ConfigRow>({
      text: upsertSql,
      args: [projectRef, patchJson],
    })
    const row = result.rows[0]

    const action: AuditAction = 'project.config_updated'
    const targetMetadata = JSON.stringify({ section, patch: patch ?? {} })
    await tx.queryObject`
      INSERT INTO traffic.audit_logs (
        id, profile_id, organization_id, action_name, action_metadata,
        actor_id, actor_type, actor_metadata,
        target_description, target_metadata, occurred_at
      ) VALUES (
        gen_random_uuid(), ${profileId}, ${organizationId}, ${action},
        ${auditActionMetadata(auditContext, 200)}::jsonb,
        ${gotrueId}, 'user',
        ${auditActorMetadata(auditContext)}::jsonb,
        ${'projects (ref: ' + projectRef + ') config.' + section},
        ${targetMetadata}::jsonb,
        now()
      )
    `

    await tx.commit()
    return mergeWithDefaults(column, row?.[column] ?? null)
  } finally {
    connection.release()
  }
}

// ── JWT secret rotation simulator ──────────────────────────

export async function rotateJwtSecret(
  pool: Pool,
  projectRef: string,
  requestId: string,
  profileId: number,
  organizationId: number,
  gotrueId: string,
  auditContext: AuditContext
): Promise<RotationState> {
  const connection = await pool.connect()
  try {
    const tx = connection.createTransaction('rotate_jwt_secret')
    await tx.begin()

    const existing = await tx.queryObject<{ secrets_rotation: RotationState | null }>`
      SELECT secrets_rotation
      FROM traffic.project_config
      WHERE project_ref = ${projectRef}
    `
    const current = existing.rows[0]?.secrets_rotation ?? null

    if (current && current.request_id === requestId) {
      await tx.commit()
      return current
    }

    const next: RotationState = {
      status: 'pending',
      request_id: requestId,
      requested_at: new Date().toISOString(),
    }

    await tx.queryObject`
      INSERT INTO traffic.project_config (project_ref, secrets_rotation)
      VALUES (${projectRef}, ${JSON.stringify(next)}::jsonb)
      ON CONFLICT (project_ref) DO UPDATE
      SET secrets_rotation = EXCLUDED.secrets_rotation,
          updated_at = now()
    `

    const action: AuditAction = 'project.config_updated'
    const targetMetadata = JSON.stringify({
      section: 'secrets',
      action: 'rotate_jwt_secret',
      request_id: requestId,
    })
    await tx.queryObject`
      INSERT INTO traffic.audit_logs (
        id, profile_id, organization_id, action_name, action_metadata,
        actor_id, actor_type, actor_metadata,
        target_description, target_metadata, occurred_at
      ) VALUES (
        gen_random_uuid(), ${profileId}, ${organizationId}, ${action},
        ${auditActionMetadata(auditContext, 200)}::jsonb,
        ${gotrueId}, 'user',
        ${auditActorMetadata(auditContext)}::jsonb,
        ${'projects (ref: ' + projectRef + ') secrets.rotate_jwt_secret'},
        ${targetMetadata}::jsonb,
        now()
      )
    `

    await tx.commit()
    return next
  } finally {
    connection.release()
  }
}

function advanceStatus(current: RotationStatus): RotationStatus {
  switch (current) {
    case 'pending':
      return 'running'
    case 'running':
      return 'succeeded'
    default:
      return current
  }
}

export async function getRotationStatus(
  pool: Pool,
  projectRef: string,
  requestId?: string
): Promise<RotationState | null> {
  const connection = await pool.connect()
  try {
    const tx = connection.createTransaction('advance_rotation_status')
    await tx.begin()

    const existing = await tx.queryObject<{ secrets_rotation: RotationState | null }>`
      SELECT secrets_rotation
      FROM traffic.project_config
      WHERE project_ref = ${projectRef}
    `
    const current = existing.rows[0]?.secrets_rotation ?? null

    if (!current || !current.request_id) {
      await tx.rollback()
      return null
    }

    if (requestId && requestId !== current.request_id) {
      await tx.rollback()
      return current
    }

    const nextStatus = advanceStatus(current.status)
    if (nextStatus === current.status) {
      await tx.commit()
      return current
    }

    const next: RotationState = { ...current, status: nextStatus }
    await tx.queryObject`
      UPDATE traffic.project_config
      SET secrets_rotation = ${JSON.stringify(next)}::jsonb,
          updated_at = now()
      WHERE project_ref = ${projectRef}
    `

    await tx.commit()
    return next
  } finally {
    connection.release()
  }
}

// ── Sensitivity ────────────────────────────────────────────

export async function updateProjectSensitivity(
  pool: Pool,
  projectRef: string,
  sensitivity: string,
  profileId: number,
  organizationId: number,
  gotrueId: string,
  auditContext: AuditContext
): Promise<{ ref: string; sensitivity: SensitivityLevel }> {
  if (!isValidSensitivity(sensitivity)) {
    throw new InvalidSensitivityError(sensitivity)
  }

  const connection = await pool.connect()
  try {
    const tx = connection.createTransaction('update_project_sensitivity')
    await tx.begin()

    const result = await tx.queryObject<{ ref: string; sensitivity: SensitivityLevel }>`
      UPDATE traffic.projects
      SET sensitivity = ${sensitivity}, updated_at = now()
      WHERE ref = ${projectRef}
      RETURNING ref, sensitivity
    `

    if (result.rows.length === 0) {
      await tx.rollback()
      throw new Error('Project not found')
    }

    const action: AuditAction = 'project.config_updated'
    const targetMetadata = JSON.stringify({
      section: 'settings.sensitivity',
      sensitivity,
    })
    await tx.queryObject`
      INSERT INTO traffic.audit_logs (
        id, profile_id, organization_id, action_name, action_metadata,
        actor_id, actor_type, actor_metadata,
        target_description, target_metadata, occurred_at
      ) VALUES (
        gen_random_uuid(), ${profileId}, ${organizationId}, ${action},
        ${auditActionMetadata(auditContext, 200)}::jsonb,
        ${gotrueId}, 'user',
        ${auditActorMetadata(auditContext)}::jsonb,
        ${'projects (ref: ' + projectRef + ') settings.sensitivity'},
        ${targetMetadata}::jsonb,
        now()
      )
    `

    await tx.commit()
    return result.rows[0]
  } finally {
    connection.release()
  }
}

// ── DB password rotation ───────────────────────────────────

// Quote a password using dollar-quoted syntax so single quotes and
// backslashes pass through unchanged. We deliberately swallow any error
// from ALTER ROLE because self-hosted deployments vary: traffic_api may not
// have CREATEROLE, or the Postgres role name may differ. The caller always
// returns 200 with `{ result: "acknowledged" }`.
function buildAlterRolePasswordSql(password: string): string {
  const tag = 'traffic_one_db_pw'
  if (password.includes(`$${tag}$`)) {
    const escaped = password.replace(/'/g, "''")
    return `ALTER ROLE postgres PASSWORD '${escaped}'`
  }
  return `ALTER ROLE postgres PASSWORD $${tag}$${password}$${tag}$`
}

export async function updateDbPassword(
  pool: Pool,
  projectRef: string,
  password: string,
  profileId: number,
  organizationId: number,
  gotrueId: string,
  auditContext: AuditContext
): Promise<DbPasswordOutcome> {
  let applied = false
  const connection = await pool.connect()
  try {
    try {
      const sql = buildAlterRolePasswordSql(password)
      await connection.queryArray(sql)
      applied = true
    } catch (err) {
      console.error('updateDbPassword: ALTER ROLE failed (non-fatal):', err)
    }

    const tx = connection.createTransaction('db_password_rotated')
    await tx.begin()

    await tx.queryObject`
      UPDATE traffic.projects SET updated_at = now() WHERE ref = ${projectRef}
    `

    const action: AuditAction = 'project.db_password_rotated'
    const targetMetadata = JSON.stringify({ applied })
    await tx.queryObject`
      INSERT INTO traffic.audit_logs (
        id, profile_id, organization_id, action_name, action_metadata,
        actor_id, actor_type, actor_metadata,
        target_description, target_metadata, occurred_at
      ) VALUES (
        gen_random_uuid(), ${profileId}, ${organizationId}, ${action},
        ${auditActionMetadata(auditContext, 200)}::jsonb,
        ${gotrueId}, 'user',
        ${auditActorMetadata(auditContext)}::jsonb,
        ${'projects (ref: ' + projectRef + ') db_password'},
        ${targetMetadata}::jsonb,
        now()
      )
    `

    await tx.commit()
    return { result: 'acknowledged', applied }
  } finally {
    connection.release()
  }
}

// ── Lint exceptions ────────────────────────────────────────

interface LintExceptionRow {
  lint_name: string
  disabled: boolean
  metadata: Record<string, unknown> | null
  inserted_at: string
  updated_at: string
}

function rowToLintException(row: LintExceptionRow): LintException {
  return {
    lint_name: row.lint_name,
    disabled: row.disabled,
    metadata: row.metadata ?? {},
    inserted_at: row.inserted_at,
    updated_at: row.updated_at,
  }
}

export async function listLintExceptions(pool: Pool, projectRef: string): Promise<LintException[]> {
  const connection = await pool.connect()
  try {
    const result = await connection.queryObject<LintExceptionRow>`
      SELECT lint_name, disabled, metadata, inserted_at, updated_at
      FROM traffic.lint_exceptions
      WHERE project_ref = ${projectRef}
      ORDER BY inserted_at ASC
    `
    return result.rows.map(rowToLintException)
  } finally {
    connection.release()
  }
}

export async function upsertLintException(
  pool: Pool,
  projectRef: string,
  lintName: string,
  disabled: boolean,
  metadata: Record<string, unknown>,
  profileId: number,
  organizationId: number,
  gotrueId: string,
  auditContext: AuditContext
): Promise<LintException> {
  const connection = await pool.connect()
  try {
    const tx = connection.createTransaction('upsert_lint_exception')
    await tx.begin()

    const result = await tx.queryObject<LintExceptionRow>`
      INSERT INTO traffic.lint_exceptions (project_ref, lint_name, disabled, metadata)
      VALUES (
        ${projectRef}, ${lintName}, ${disabled},
        ${JSON.stringify(metadata ?? {})}::jsonb
      )
      ON CONFLICT (project_ref, lint_name) DO UPDATE
      SET disabled = EXCLUDED.disabled,
          metadata = EXCLUDED.metadata,
          updated_at = now()
      RETURNING lint_name, disabled, metadata, inserted_at, updated_at
    `

    const action: AuditAction = 'project.config_updated'
    const targetMetadata = JSON.stringify({
      section: 'notifications.advisor.exceptions',
      lint_name: lintName,
      disabled,
    })
    await tx.queryObject`
      INSERT INTO traffic.audit_logs (
        id, profile_id, organization_id, action_name, action_metadata,
        actor_id, actor_type, actor_metadata,
        target_description, target_metadata, occurred_at
      ) VALUES (
        gen_random_uuid(), ${profileId}, ${organizationId}, ${action},
        ${auditActionMetadata(auditContext, 200)}::jsonb,
        ${gotrueId}, 'user',
        ${auditActorMetadata(auditContext)}::jsonb,
        ${'projects (ref: ' + projectRef + ') lint_exception.' + lintName},
        ${targetMetadata}::jsonb,
        now()
      )
    `

    await tx.commit()
    return rowToLintException(result.rows[0])
  } finally {
    connection.release()
  }
}

export async function deleteLintException(
  pool: Pool,
  projectRef: string,
  lintName: string,
  profileId: number,
  organizationId: number,
  gotrueId: string,
  auditContext: AuditContext
): Promise<boolean> {
  const connection = await pool.connect()
  try {
    const tx = connection.createTransaction('delete_lint_exception')
    await tx.begin()

    const result = await tx.queryObject<{ id: number }>`
      DELETE FROM traffic.lint_exceptions
      WHERE project_ref = ${projectRef} AND lint_name = ${lintName}
      RETURNING id
    `

    if (result.rows.length === 0) {
      await tx.rollback()
      return false
    }

    const action: AuditAction = 'project.config_updated'
    const targetMetadata = JSON.stringify({
      section: 'notifications.advisor.exceptions',
      lint_name: lintName,
      action: 'delete',
    })
    await tx.queryObject`
      INSERT INTO traffic.audit_logs (
        id, profile_id, organization_id, action_name, action_metadata,
        actor_id, actor_type, actor_metadata,
        target_description, target_metadata, occurred_at
      ) VALUES (
        gen_random_uuid(), ${profileId}, ${organizationId}, ${action},
        ${auditActionMetadata(auditContext, 200)}::jsonb,
        ${gotrueId}, 'user',
        ${auditActorMetadata(auditContext)}::jsonb,
        ${'projects (ref: ' + projectRef + ') lint_exception.' + lintName},
        ${targetMetadata}::jsonb,
        now()
      )
    `

    await tx.commit()
    return true
  } finally {
    connection.release()
  }
}
