import type { Pool } from 'https://deno.land/x/postgres@v0.17.0/mod.ts'

export type FeedbackCategory = 'general' | 'upgrade_survey' | 'downgrade_survey' | 'support_ticket'

export interface FeedbackCreateInput {
  category: FeedbackCategory
  message: string
  projectRef?: string | null
  organizationSlug?: string | null
  tags?: string[]
  metadata?: Record<string, unknown>
}

export interface FeedbackRow {
  id: number
  profile_id: number | null
  category: FeedbackCategory
  message: string
  project_ref: string | null
  organization_slug: string | null
  tags: string[]
  metadata: Record<string, unknown>
  custom_fields: Record<string, unknown>
  created_at: string
  updated_at: string
}

export interface FeedbackAuditContext {
  email: string
  ip: string
  method: string
  route: string
}

// Inserts the feedback row and a matching audit log entry in a single
// transaction so the audit trail never drifts from the feedback table.
export async function createFeedback(
  pool: Pool,
  profileId: number,
  input: FeedbackCreateInput,
  gotrueId: string,
  auditContext: FeedbackAuditContext
): Promise<FeedbackRow> {
  const connection = await pool.connect()
  try {
    const tx = connection.createTransaction('feedback_create')
    await tx.begin()

    const result = await tx.queryObject<FeedbackRow>`
      INSERT INTO traffic.feedback (
        profile_id, category, message,
        project_ref, organization_slug,
        tags, metadata
      ) VALUES (
        ${profileId}, ${input.category}, ${input.message},
        ${input.projectRef ?? null}, ${input.organizationSlug ?? null},
        ${input.tags ?? []}::text[],
        ${JSON.stringify(input.metadata ?? {})}::jsonb
      )
      RETURNING *
    `
    const row = result.rows[0]

    await tx.queryObject`
      INSERT INTO traffic.audit_logs (
        id, profile_id, action_name, action_metadata,
        actor_id, actor_type, actor_metadata,
        target_description, target_metadata, occurred_at
      ) VALUES (
        gen_random_uuid(), ${profileId}, 'profile.feedback_submitted',
        ${JSON.stringify([
          {
            method: auditContext.method,
            route: auditContext.route,
            status: 201,
          },
        ])}::jsonb,
        ${gotrueId}, 'user',
        ${JSON.stringify([{ email: auditContext.email, ip: auditContext.ip }])}::jsonb,
        ${'feedback #' + row.id},
        ${JSON.stringify({
          category: row.category,
          project_ref: row.project_ref,
          organization_slug: row.organization_slug,
        })}::jsonb,
        now()
      )
    `

    await tx.commit()
    return row
  } finally {
    connection.release()
  }
}

// Updates custom_fields scoped to (id, profile_id) so user A cannot mutate
// user B's feedback row. Returns null when the row doesn't exist OR doesn't
// belong to the caller — both cases surface as 404 at the HTTP layer.
export async function updateFeedbackCustomFields(
  pool: Pool,
  id: number,
  profileId: number,
  customFields: Record<string, unknown>,
  gotrueId: string,
  auditContext: FeedbackAuditContext
): Promise<FeedbackRow | null> {
  const connection = await pool.connect()
  try {
    const tx = connection.createTransaction('feedback_custom_fields_update')
    await tx.begin()

    const result = await tx.queryObject<FeedbackRow>`
      UPDATE traffic.feedback
      SET custom_fields = custom_fields || ${JSON.stringify(customFields)}::jsonb,
          updated_at = now()
      WHERE id = ${id} AND profile_id = ${profileId}
      RETURNING *
    `
    const row = result.rows[0] ?? null
    if (!row) {
      await tx.rollback()
      return null
    }

    await tx.queryObject`
      INSERT INTO traffic.audit_logs (
        id, profile_id, action_name, action_metadata,
        actor_id, actor_type, actor_metadata,
        target_description, target_metadata, occurred_at
      ) VALUES (
        gen_random_uuid(), ${profileId}, 'profile.feedback_updated',
        ${JSON.stringify([
          {
            method: auditContext.method,
            route: auditContext.route,
            status: 200,
          },
        ])}::jsonb,
        ${gotrueId}, 'user',
        ${JSON.stringify([{ email: auditContext.email, ip: auditContext.ip }])}::jsonb,
        ${'feedback #' + row.id},
        ${JSON.stringify({ keys: Object.keys(customFields) })}::jsonb,
        now()
      )
    `

    await tx.commit()
    return row
  } finally {
    connection.release()
  }
}
