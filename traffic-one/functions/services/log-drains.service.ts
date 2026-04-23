import type { Pool } from 'https://deno.land/x/postgres@v0.17.0/mod.ts'

export interface LogDrainRow {
  id: number
  project_ref: string
  token: string
  name: string
  description: string
  type: string
  config: Record<string, unknown>
  filters: unknown[]
  active: boolean
  created_at: string
  updated_at: string
  deleted_at: string | null
}

export interface LogDrainInput {
  name: string
  description?: string | null
  type: string
  config?: Record<string, unknown> | null
  filters?: unknown[] | null
}

export interface LogDrainPatch {
  name?: string
  description?: string | null
  type?: string
  config?: Record<string, unknown> | null
  filters?: unknown[] | null
  active?: boolean
}

export interface AuditContext {
  email: string
  ip: string
  method: string
  route: string
}

export interface LFBackendResponse {
  id: number
  token: string
  name: string
  description: string
  type: string
  config: Record<string, unknown>
  metadata: { project_ref: string; type: 'log-drain' } | null
  user_id: number
}

export interface CreateDrainSuccess {
  status: 'created'
  drain: LFBackendResponse
}

export interface CreateDrainConflict {
  status: 'conflict'
  message: string
}

export type CreateDrainOutcome = CreateDrainSuccess | CreateDrainConflict

export interface UpdateDrainSuccess {
  status: 'updated'
  drain: LFBackendResponse
}

export interface UpdateDrainNotFound {
  status: 'not_found'
}

export interface UpdateDrainConflict {
  status: 'conflict'
  message: string
}

export type UpdateDrainOutcome = UpdateDrainSuccess | UpdateDrainNotFound | UpdateDrainConflict

// Postgres SQLSTATE for unique_violation.
const UNIQUE_VIOLATION = '23505'

function toBackendResponse(row: LogDrainRow, userId: number): LFBackendResponse {
  return {
    id: row.id,
    token: row.token,
    name: row.name,
    description: row.description,
    type: row.type,
    config: row.config ?? {},
    metadata: { project_ref: row.project_ref, type: 'log-drain' },
    user_id: userId,
  }
}

function isUniqueViolation(err: unknown): boolean {
  if (!err || typeof err !== 'object') return false
  const record = err as { code?: unknown; fields?: { code?: unknown } }
  if (record.code === UNIQUE_VIOLATION) return true
  if (record.fields && record.fields.code === UNIQUE_VIOLATION) return true
  return false
}

// ── Create ────────────────────────────────────────────────

export async function createLogDrain(
  pool: Pool,
  projectRef: string,
  profileId: number,
  input: LogDrainInput,
  gotrueId: string,
  organizationId: number,
  auditContext: AuditContext
): Promise<CreateDrainOutcome> {
  if (!input.name || !input.name.trim()) {
    return { status: 'conflict', message: 'name is required' }
  }
  if (!input.type || !input.type.trim()) {
    return { status: 'conflict', message: 'type is required' }
  }

  const connection = await pool.connect()
  try {
    const tx = connection.createTransaction('create_log_drain')
    await tx.begin()

    let row: LogDrainRow
    try {
      const inserted = await tx.queryObject<LogDrainRow>`
        INSERT INTO traffic.log_drains (
          project_ref, name, description, type, config, filters
        ) VALUES (
          ${projectRef},
          ${input.name.trim()},
          ${input.description ?? ''},
          ${input.type.trim()},
          ${JSON.stringify(input.config ?? {})}::jsonb,
          ${JSON.stringify(input.filters ?? [])}::jsonb
        )
        RETURNING *
      `
      row = inserted.rows[0]
    } catch (err) {
      await tx.rollback()
      if (isUniqueViolation(err)) {
        return {
          status: 'conflict',
          message: `A log drain named "${input.name}" already exists for this project`,
        }
      }
      throw err
    }

    await tx.queryObject`
      INSERT INTO traffic.audit_logs (
        id, profile_id, organization_id, action_name, action_metadata,
        actor_id, actor_type, actor_metadata,
        target_description, target_metadata, occurred_at
      ) VALUES (
        gen_random_uuid(), ${profileId}, ${organizationId}, 'project.log_drain_created',
        ${JSON.stringify([{ method: auditContext.method, route: auditContext.route, status: 201 }])}::jsonb,
        ${gotrueId}, 'user',
        ${JSON.stringify([{ email: auditContext.email, ip: auditContext.ip }])}::jsonb,
        ${'log_drains #' + row.id + ' (ref: ' + projectRef + ', name: ' + row.name + ')'},
        ${JSON.stringify({ token: row.token, type: row.type })}::jsonb,
        now()
      )
    `

    await tx.commit()
    return { status: 'created', drain: toBackendResponse(row, profileId) }
  } finally {
    connection.release()
  }
}

// ── List ──────────────────────────────────────────────────

export async function listLogDrains(pool: Pool, projectRef: string): Promise<LogDrainRow[]> {
  const connection = await pool.connect()
  try {
    const result = await connection.queryObject<LogDrainRow>`
      SELECT * FROM traffic.log_drains
      WHERE project_ref = ${projectRef} AND deleted_at IS NULL
      ORDER BY created_at ASC
    `
    return result.rows
  } finally {
    connection.release()
  }
}

export async function listLogDrainResponses(
  pool: Pool,
  projectRef: string,
  userId: number
): Promise<LFBackendResponse[]> {
  const rows = await listLogDrains(pool, projectRef)
  return rows.map((row) => toBackendResponse(row, userId))
}

// ── Get one ───────────────────────────────────────────────

export async function getLogDrain(
  pool: Pool,
  projectRef: string,
  token: string
): Promise<LogDrainRow | null> {
  const connection = await pool.connect()
  try {
    const result = await connection.queryObject<LogDrainRow>`
      SELECT * FROM traffic.log_drains
      WHERE project_ref = ${projectRef}
        AND token = ${token}::uuid
        AND deleted_at IS NULL
    `
    return result.rows[0] ?? null
  } finally {
    connection.release()
  }
}

// ── Update ────────────────────────────────────────────────

export async function updateLogDrain(
  pool: Pool,
  projectRef: string,
  token: string,
  patch: LogDrainPatch,
  userId: number,
  profileId: number,
  organizationId: number,
  gotrueId: string,
  auditContext: AuditContext
): Promise<UpdateDrainOutcome> {
  const touchedKeys = Object.entries(patch)
    .filter(([, v]) => v !== undefined)
    .map(([k]) => k)
  if (touchedKeys.length === 0) {
    const existing = await getLogDrain(pool, projectRef, token)
    if (!existing) return { status: 'not_found' }
    return { status: 'updated', drain: toBackendResponse(existing, userId) }
  }

  const connection = await pool.connect()
  try {
    const tx = connection.createTransaction('update_log_drain')
    await tx.begin()

    const existing = await tx.queryObject<LogDrainRow>`
      SELECT * FROM traffic.log_drains
      WHERE project_ref = ${projectRef}
        AND token = ${token}::uuid
        AND deleted_at IS NULL
    `
    if (existing.rows.length === 0) {
      await tx.rollback()
      return { status: 'not_found' }
    }
    const current = existing.rows[0]

    const nextName = patch.name !== undefined ? patch.name : current.name
    const nextDescription =
      patch.description !== undefined ? (patch.description ?? '') : current.description
    const nextType = patch.type !== undefined ? patch.type : current.type
    const nextConfig = patch.config !== undefined ? (patch.config ?? {}) : (current.config ?? {})
    const nextFilters =
      patch.filters !== undefined ? (patch.filters ?? []) : (current.filters ?? [])
    const nextActive = patch.active !== undefined ? patch.active : current.active

    let updated: LogDrainRow
    try {
      const result = await tx.queryObject<LogDrainRow>`
        UPDATE traffic.log_drains
        SET name = ${nextName},
            description = ${nextDescription},
            type = ${nextType},
            config = ${JSON.stringify(nextConfig)}::jsonb,
            filters = ${JSON.stringify(nextFilters)}::jsonb,
            active = ${nextActive},
            updated_at = now()
        WHERE project_ref = ${projectRef}
          AND token = ${token}::uuid
          AND deleted_at IS NULL
        RETURNING *
      `
      if (result.rows.length === 0) {
        await tx.rollback()
        return { status: 'not_found' }
      }
      updated = result.rows[0]
    } catch (err) {
      await tx.rollback()
      if (isUniqueViolation(err)) {
        return {
          status: 'conflict',
          message: `A log drain named "${nextName}" already exists for this project`,
        }
      }
      throw err
    }

    await tx.queryObject`
      INSERT INTO traffic.audit_logs (
        id, profile_id, organization_id, action_name, action_metadata,
        actor_id, actor_type, actor_metadata,
        target_description, target_metadata, occurred_at
      ) VALUES (
        gen_random_uuid(), ${profileId}, ${organizationId}, 'project.log_drain_updated',
        ${JSON.stringify([{ method: auditContext.method, route: auditContext.route, status: 200 }])}::jsonb,
        ${gotrueId}, 'user',
        ${JSON.stringify([{ email: auditContext.email, ip: auditContext.ip }])}::jsonb,
        ${'log_drains #' + updated.id + ' (ref: ' + projectRef + ', name: ' + updated.name + ')'},
        ${JSON.stringify({ token: updated.token, type: updated.type, keys: touchedKeys })}::jsonb,
        now()
      )
    `

    await tx.commit()
    return { status: 'updated', drain: toBackendResponse(updated, userId) }
  } finally {
    connection.release()
  }
}

// ── Delete (soft) ─────────────────────────────────────────

export async function deleteLogDrain(
  pool: Pool,
  projectRef: string,
  token: string,
  profileId: number,
  gotrueId: string,
  organizationId: number,
  auditContext: AuditContext
): Promise<LogDrainRow | null> {
  const connection = await pool.connect()
  try {
    const tx = connection.createTransaction('delete_log_drain')
    await tx.begin()

    const result = await tx.queryObject<LogDrainRow>`
      UPDATE traffic.log_drains
      SET deleted_at = now(), active = false, updated_at = now()
      WHERE project_ref = ${projectRef}
        AND token = ${token}::uuid
        AND deleted_at IS NULL
      RETURNING *
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
        gen_random_uuid(), ${profileId}, ${organizationId}, 'project.log_drain_deleted',
        ${JSON.stringify([{ method: auditContext.method, route: auditContext.route, status: 200 }])}::jsonb,
        ${gotrueId}, 'user',
        ${JSON.stringify([{ email: auditContext.email, ip: auditContext.ip }])}::jsonb,
        ${'log_drains #' + row.id + ' (ref: ' + projectRef + ', name: ' + row.name + ')'},
        ${JSON.stringify({ token: row.token, type: row.type })}::jsonb,
        now()
      )
    `

    await tx.commit()
    return row
  } finally {
    connection.release()
  }
}

export { toBackendResponse }
