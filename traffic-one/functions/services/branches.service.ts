import type { Pool } from 'https://deno.land/x/postgres@v0.19.3/mod.ts'

export type BranchStatus = 'created' | 'pushing' | 'pushed' | 'merged' | 'revoked'

export interface BranchRow {
  id: string
  project_ref: string
  branch_name: string
  parent_project_ref: string | null
  is_default: boolean
  git_branch: string | null
  status: BranchStatus
  pr_number: number | null
  created_at: string
  updated_at: string
  merged_at: string | null
  deleted_at: string | null
}

export interface BranchCreateInput {
  branchName: string
  isDefault?: boolean
  gitBranch?: string | null
  parentProjectRef?: string | null
  prNumber?: number | null
}

export interface BranchUpdateInput {
  branchName?: string
  isDefault?: boolean
  gitBranch?: string | null
  parentProjectRef?: string | null
  prNumber?: number | null
}

export interface AuditContext {
  email: string
  ip: string
  method: string
  route: string
}

// Postgres SQLSTATE for unique_violation.
const UNIQUE_VIOLATION = '23505'

function isUniqueViolation(err: unknown): boolean {
  if (!err || typeof err !== 'object') return false
  const record = err as { code?: unknown; fields?: { code?: unknown } }
  if (record.code === UNIQUE_VIOLATION) return true
  if (record.fields && record.fields.code === UNIQUE_VIOLATION) return true
  return false
}

// ── Conflict-aware result types ───────────────────────────

export interface CreateBranchSuccess {
  status: 'created'
  branch: BranchRow
}

export interface CreateBranchConflict {
  status: 'conflict'
  message: string
}

export type CreateBranchOutcome = CreateBranchSuccess | CreateBranchConflict

export interface UpdateBranchSuccess {
  status: 'updated'
  branch: BranchRow
}

export interface UpdateBranchNotFound {
  status: 'not_found'
}

export interface UpdateBranchConflict {
  status: 'conflict'
  message: string
}

export type UpdateBranchOutcome = UpdateBranchSuccess | UpdateBranchNotFound | UpdateBranchConflict

// ── List ──────────────────────────────────────────────────

export async function listBranchesForProject(pool: Pool, projectRef: string): Promise<BranchRow[]> {
  const connection = await pool.connect()
  try {
    const result = await connection.queryObject<BranchRow>`
      SELECT * FROM traffic.branches
      WHERE project_ref = ${projectRef} AND deleted_at IS NULL
      ORDER BY created_at ASC
    `
    return result.rows
  } finally {
    connection.release()
  }
}

// ── Get by id ─────────────────────────────────────────────

export async function getBranchById(pool: Pool, id: string): Promise<BranchRow | null> {
  const connection = await pool.connect()
  try {
    const result = await connection.queryObject<BranchRow>`
      SELECT * FROM traffic.branches WHERE id = ${id}::uuid
    `
    return result.rows[0] ?? null
  } finally {
    connection.release()
  }
}

// ── Create ────────────────────────────────────────────────

export async function createBranch(
  pool: Pool,
  projectRef: string,
  profileId: number,
  input: BranchCreateInput,
  gotrueId: string,
  organizationId: number,
  auditContext: AuditContext,
): Promise<CreateBranchOutcome> {
  const branchName = input.branchName?.trim()
  if (!branchName) {
    return { status: 'conflict', message: 'branch_name is required' }
  }

  const connection = await pool.connect()
  try {
    const tx = connection.createTransaction('create_branch')
    await tx.begin()

    let row: BranchRow
    try {
      const inserted = await tx.queryObject<BranchRow>`
        INSERT INTO traffic.branches (
          project_ref, branch_name, parent_project_ref,
          is_default, git_branch, pr_number, status
        ) VALUES (
          ${projectRef},
          ${branchName},
          ${input.parentProjectRef ?? null},
          ${input.isDefault ?? false},
          ${input.gitBranch ?? null},
          ${input.prNumber ?? null},
          'created'
        )
        RETURNING *
      `
      row = inserted.rows[0]
    } catch (err) {
      await tx.rollback()
      if (isUniqueViolation(err)) {
        return {
          status: 'conflict',
          message: `A branch named "${branchName}" already exists for this project`,
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
        gen_random_uuid(), ${profileId}, ${organizationId}, 'project.branch_created',
        ${
      JSON.stringify([{ method: auditContext.method, route: auditContext.route, status: 201 }])
    }::jsonb,
        ${gotrueId}, 'user',
        ${JSON.stringify([{ email: auditContext.email, ip: auditContext.ip }])}::jsonb,
        ${'branches #' + row.id + ' (ref: ' + projectRef + ', name: ' + row.branch_name + ')'},
        ${JSON.stringify({ branch_name: row.branch_name, is_default: row.is_default })}::jsonb,
        now()
      )
    `

    await tx.commit()
    return { status: 'created', branch: row }
  } finally {
    connection.release()
  }
}

// ── Update (metadata only: name, git_branch, is_default, pr_number) ──

export async function updateBranch(
  pool: Pool,
  id: string,
  patch: BranchUpdateInput,
  profileId: number,
  gotrueId: string,
  organizationId: number,
  auditContext: AuditContext,
): Promise<UpdateBranchOutcome> {
  const touchedKeys = Object.entries(patch)
    .filter(([, v]) => v !== undefined)
    .map(([k]) => k)

  const connection = await pool.connect()
  try {
    const tx = connection.createTransaction('update_branch')
    await tx.begin()

    const existing = await tx.queryObject<BranchRow>`
      SELECT * FROM traffic.branches WHERE id = ${id}::uuid AND deleted_at IS NULL
    `
    if (existing.rows.length === 0) {
      await tx.rollback()
      return { status: 'not_found' }
    }
    const current = existing.rows[0]

    const nextName = patch.branchName !== undefined ? patch.branchName.trim() : current.branch_name
    if (!nextName) {
      await tx.rollback()
      return { status: 'conflict', message: 'branch_name cannot be empty' }
    }
    const nextIsDefault = patch.isDefault !== undefined ? patch.isDefault : current.is_default
    const nextGitBranch = patch.gitBranch !== undefined
      ? (patch.gitBranch ?? null)
      : current.git_branch
    const nextParentRef = patch.parentProjectRef !== undefined
      ? (patch.parentProjectRef ?? null)
      : current.parent_project_ref
    const nextPrNumber = patch.prNumber !== undefined ? (patch.prNumber ?? null) : current.pr_number

    let updated: BranchRow
    try {
      const result = await tx.queryObject<BranchRow>`
        UPDATE traffic.branches
        SET branch_name = ${nextName},
            is_default = ${nextIsDefault},
            git_branch = ${nextGitBranch},
            parent_project_ref = ${nextParentRef},
            pr_number = ${nextPrNumber},
            updated_at = now()
        WHERE id = ${id}::uuid AND deleted_at IS NULL
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
          message: `A branch named "${nextName}" already exists for this project`,
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
        gen_random_uuid(), ${profileId}, ${organizationId}, 'project.branch_updated',
        ${
      JSON.stringify([{ method: auditContext.method, route: auditContext.route, status: 200 }])
    }::jsonb,
        ${gotrueId}, 'user',
        ${JSON.stringify([{ email: auditContext.email, ip: auditContext.ip }])}::jsonb,
        ${
      'branches #' + updated.id + ' (ref: ' + updated.project_ref + ', name: ' +
      updated.branch_name + ')'
    },
        ${JSON.stringify({ branch_name: updated.branch_name, keys: touchedKeys })}::jsonb,
        now()
      )
    `

    await tx.commit()
    return { status: 'updated', branch: updated }
  } finally {
    connection.release()
  }
}

// ── Soft delete ───────────────────────────────────────────

export async function softDeleteBranch(
  pool: Pool,
  id: string,
  profileId: number,
  gotrueId: string,
  organizationId: number,
  auditContext: AuditContext,
): Promise<BranchRow | null> {
  const connection = await pool.connect()
  try {
    const tx = connection.createTransaction('soft_delete_branch')
    await tx.begin()

    const result = await tx.queryObject<BranchRow>`
      UPDATE traffic.branches
      SET deleted_at = now(), updated_at = now()
      WHERE id = ${id}::uuid AND deleted_at IS NULL
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
        gen_random_uuid(), ${profileId}, ${organizationId}, 'project.branch_deleted',
        ${
      JSON.stringify([{ method: auditContext.method, route: auditContext.route, status: 200 }])
    }::jsonb,
        ${gotrueId}, 'user',
        ${JSON.stringify([{ email: auditContext.email, ip: auditContext.ip }])}::jsonb,
        ${'branches #' + row.id + ' (ref: ' + row.project_ref + ', name: ' + row.branch_name + ')'},
        ${JSON.stringify({ branch_name: row.branch_name })}::jsonb,
        now()
      )
    `

    await tx.commit()
    return row
  } finally {
    connection.release()
  }
}

// ── Restore (un-soft-delete) ──────────────────────────────

export async function restoreBranch(
  pool: Pool,
  id: string,
  profileId: number,
  gotrueId: string,
  organizationId: number,
  auditContext: AuditContext,
): Promise<BranchRow | null> {
  const connection = await pool.connect()
  try {
    const tx = connection.createTransaction('restore_branch')
    await tx.begin()

    const result = await tx.queryObject<BranchRow>`
      UPDATE traffic.branches
      SET deleted_at = NULL, updated_at = now()
      WHERE id = ${id}::uuid AND deleted_at IS NOT NULL
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
        gen_random_uuid(), ${profileId}, ${organizationId}, 'project.branch_restored',
        ${
      JSON.stringify([{ method: auditContext.method, route: auditContext.route, status: 200 }])
    }::jsonb,
        ${gotrueId}, 'user',
        ${JSON.stringify([{ email: auditContext.email, ip: auditContext.ip }])}::jsonb,
        ${'branches #' + row.id + ' (ref: ' + row.project_ref + ', name: ' + row.branch_name + ')'},
        ${JSON.stringify({ branch_name: row.branch_name })}::jsonb,
        now()
      )
    `

    await tx.commit()
    return row
  } finally {
    connection.release()
  }
}

// ── State transitions ─────────────────────────────────────
//
// State machine: created → pushing → pushed ⇄ merged, with reset returning
// to pushed. The service layer performs all transitions inside a single
// transaction so the audit row and the status update are always consistent.

export interface TransitionSuccess {
  status: 'ok'
  branch: BranchRow
}

export interface TransitionNotFound {
  status: 'not_found'
}

export interface TransitionInvalidState {
  status: 'invalid_state'
  message: string
  current: BranchStatus
}

export type TransitionOutcome = TransitionSuccess | TransitionNotFound | TransitionInvalidState

export async function pushBranch(
  pool: Pool,
  id: string,
  profileId: number,
  gotrueId: string,
  organizationId: number,
  auditContext: AuditContext,
): Promise<TransitionOutcome> {
  const connection = await pool.connect()
  try {
    const tx = connection.createTransaction('push_branch')
    await tx.begin()

    const existing = await tx.queryObject<BranchRow>`
      SELECT * FROM traffic.branches
      WHERE id = ${id}::uuid AND deleted_at IS NULL
    `
    if (existing.rows.length === 0) {
      await tx.rollback()
      return { status: 'not_found' }
    }
    const current = existing.rows[0]

    if (current.status === 'merged' || current.status === 'revoked') {
      await tx.rollback()
      return {
        status: 'invalid_state',
        message: `Cannot push a branch in state "${current.status}"`,
        current: current.status,
      }
    }

    // Transient pushing state, then finalize to pushed. In self-hosted
    // there's no async worker to finish the push, so we collapse the two
    // writes into a single transaction.
    await tx.queryObject`
      UPDATE traffic.branches
      SET status = 'pushing', updated_at = now()
      WHERE id = ${id}::uuid
    `

    const finalized = await tx.queryObject<BranchRow>`
      UPDATE traffic.branches
      SET status = 'pushed', updated_at = now()
      WHERE id = ${id}::uuid
      RETURNING *
    `
    const row = finalized.rows[0]

    await tx.queryObject`
      INSERT INTO traffic.audit_logs (
        id, profile_id, organization_id, action_name, action_metadata,
        actor_id, actor_type, actor_metadata,
        target_description, target_metadata, occurred_at
      ) VALUES (
        gen_random_uuid(), ${profileId}, ${organizationId}, 'project.branch_pushed',
        ${
      JSON.stringify([{ method: auditContext.method, route: auditContext.route, status: 200 }])
    }::jsonb,
        ${gotrueId}, 'user',
        ${JSON.stringify([{ email: auditContext.email, ip: auditContext.ip }])}::jsonb,
        ${'branches #' + row.id + ' (ref: ' + row.project_ref + ', name: ' + row.branch_name + ')'},
        ${JSON.stringify({ branch_name: row.branch_name, prev_status: current.status })}::jsonb,
        now()
      )
    `

    await tx.commit()
    return { status: 'ok', branch: row }
  } finally {
    connection.release()
  }
}

export async function mergeBranch(
  pool: Pool,
  id: string,
  profileId: number,
  gotrueId: string,
  organizationId: number,
  auditContext: AuditContext,
): Promise<TransitionOutcome> {
  const connection = await pool.connect()
  try {
    const tx = connection.createTransaction('merge_branch')
    await tx.begin()

    const existing = await tx.queryObject<BranchRow>`
      SELECT * FROM traffic.branches
      WHERE id = ${id}::uuid AND deleted_at IS NULL
    `
    if (existing.rows.length === 0) {
      await tx.rollback()
      return { status: 'not_found' }
    }
    const current = existing.rows[0]

    if (current.status !== 'pushed') {
      await tx.rollback()
      return {
        status: 'invalid_state',
        message: `Cannot merge a branch in state "${current.status}" (must be "pushed")`,
        current: current.status,
      }
    }

    const result = await tx.queryObject<BranchRow>`
      UPDATE traffic.branches
      SET status = 'merged', merged_at = now(), updated_at = now()
      WHERE id = ${id}::uuid
      RETURNING *
    `
    const row = result.rows[0]

    await tx.queryObject`
      INSERT INTO traffic.audit_logs (
        id, profile_id, organization_id, action_name, action_metadata,
        actor_id, actor_type, actor_metadata,
        target_description, target_metadata, occurred_at
      ) VALUES (
        gen_random_uuid(), ${profileId}, ${organizationId}, 'project.branch_merged',
        ${
      JSON.stringify([{ method: auditContext.method, route: auditContext.route, status: 200 }])
    }::jsonb,
        ${gotrueId}, 'user',
        ${JSON.stringify([{ email: auditContext.email, ip: auditContext.ip }])}::jsonb,
        ${'branches #' + row.id + ' (ref: ' + row.project_ref + ', name: ' + row.branch_name + ')'},
        ${JSON.stringify({ branch_name: row.branch_name, merged_at: row.merged_at })}::jsonb,
        now()
      )
    `

    await tx.commit()
    return { status: 'ok', branch: row }
  } finally {
    connection.release()
  }
}

export async function resetBranch(
  pool: Pool,
  id: string,
  profileId: number,
  gotrueId: string,
  organizationId: number,
  auditContext: AuditContext,
): Promise<TransitionOutcome> {
  const connection = await pool.connect()
  try {
    const tx = connection.createTransaction('reset_branch')
    await tx.begin()

    const existing = await tx.queryObject<BranchRow>`
      SELECT * FROM traffic.branches
      WHERE id = ${id}::uuid AND deleted_at IS NULL
    `
    if (existing.rows.length === 0) {
      await tx.rollback()
      return { status: 'not_found' }
    }
    const current = existing.rows[0]

    // Reset rolls back to the pushed baseline. From "created" it's a no-op
    // because there's no baseline to revert to; we reject that case so the
    // caller knows nothing happened.
    if (current.status === 'created') {
      await tx.rollback()
      return {
        status: 'invalid_state',
        message: 'Cannot reset a branch in state "created" (no baseline)',
        current: current.status,
      }
    }

    const result = await tx.queryObject<BranchRow>`
      UPDATE traffic.branches
      SET status = 'pushed', merged_at = NULL, updated_at = now()
      WHERE id = ${id}::uuid
      RETURNING *
    `
    const row = result.rows[0]

    await tx.queryObject`
      INSERT INTO traffic.audit_logs (
        id, profile_id, organization_id, action_name, action_metadata,
        actor_id, actor_type, actor_metadata,
        target_description, target_metadata, occurred_at
      ) VALUES (
        gen_random_uuid(), ${profileId}, ${organizationId}, 'project.branch_reset',
        ${
      JSON.stringify([{ method: auditContext.method, route: auditContext.route, status: 200 }])
    }::jsonb,
        ${gotrueId}, 'user',
        ${JSON.stringify([{ email: auditContext.email, ip: auditContext.ip }])}::jsonb,
        ${'branches #' + row.id + ' (ref: ' + row.project_ref + ', name: ' + row.branch_name + ')'},
        ${JSON.stringify({ branch_name: row.branch_name, prev_status: current.status })}::jsonb,
        now()
      )
    `

    await tx.commit()
    return { status: 'ok', branch: row }
  } finally {
    connection.release()
  }
}
