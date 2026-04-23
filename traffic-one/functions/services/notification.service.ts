import type { Pool } from 'https://deno.land/x/postgres@v0.17.0/mod.ts'

import type { NotificationResponse, NotificationStatus } from '../types/api.ts'

interface NotificationRow {
  id: string
  profile_id: number
  name: string
  data: unknown
  meta: unknown
  priority: string
  status: string
  inserted_at: string
}

function rowToResponse(row: NotificationRow): NotificationResponse {
  return {
    id: row.id,
    name: row.name,
    data: row.data,
    meta: row.meta,
    priority: row.priority as NotificationResponse['priority'],
    status: row.status as NotificationResponse['status'],
    inserted_at: row.inserted_at,
  }
}

export async function listNotifications(
  pool: Pool,
  profileId: number
): Promise<NotificationResponse[]> {
  const connection = await pool.connect()
  try {
    const result = await connection.queryObject<NotificationRow>`
      SELECT * FROM traffic.notifications
      WHERE profile_id = ${profileId}
      ORDER BY inserted_at DESC
    `
    return result.rows.map(rowToResponse)
  } finally {
    connection.release()
  }
}

export async function bulkUpdateNotificationStatus(
  pool: Pool,
  profileId: number,
  ids: string[],
  status: NotificationStatus,
  gotrueId: string,
  auditContext?: { email: string; ip: string; method: string; route: string }
): Promise<NotificationResponse[]> {
  const connection = await pool.connect()
  try {
    const tx = connection.createTransaction('bulk_update_notifications')
    await tx.begin()

    const result = await tx.queryObject<NotificationRow>`
      UPDATE traffic.notifications
      SET status = ${status}
      WHERE profile_id = ${profileId} AND id = ANY(${ids}::uuid[])
      RETURNING *
    `

    if (auditContext && result.rows.length > 0) {
      await tx.queryObject`
        INSERT INTO traffic.audit_logs (
          id, profile_id, action_name, action_metadata,
          actor_id, actor_type, actor_metadata,
          target_description, target_metadata, occurred_at
        ) VALUES (
          gen_random_uuid(), ${profileId}, 'notifications.update',
          ${JSON.stringify([{ method: auditContext.method, route: auditContext.route, status: 200 }])}::jsonb,
          ${gotrueId}, 'user',
          ${JSON.stringify([{ email: auditContext.email, ip: auditContext.ip }])}::jsonb,
          ${'notifications bulk update: ' + ids.length + ' items'}, '{}'::jsonb, now()
        )
      `
    }

    await tx.commit()
    return result.rows.map(rowToResponse)
  } finally {
    connection.release()
  }
}

export async function updateNotificationStatus(
  pool: Pool,
  profileId: number,
  notificationId: string,
  status: NotificationStatus,
  gotrueId: string,
  auditContext?: { email: string; ip: string; method: string; route: string }
): Promise<NotificationResponse | null> {
  const connection = await pool.connect()
  try {
    const tx = connection.createTransaction('update_notification')
    await tx.begin()

    const result = await tx.queryObject<NotificationRow>`
      UPDATE traffic.notifications
      SET status = ${status}
      WHERE profile_id = ${profileId} AND id = ${notificationId}::uuid
      RETURNING *
    `

    if (result.rows.length === 0) {
      await tx.rollback()
      return null
    }

    if (auditContext) {
      await tx.queryObject`
        INSERT INTO traffic.audit_logs (
          id, profile_id, action_name, action_metadata,
          actor_id, actor_type, actor_metadata,
          target_description, target_metadata, occurred_at
        ) VALUES (
          gen_random_uuid(), ${profileId}, 'notifications.update',
          ${JSON.stringify([{ method: auditContext.method, route: auditContext.route, status: 200 }])}::jsonb,
          ${gotrueId}, 'user',
          ${JSON.stringify([{ email: auditContext.email, ip: auditContext.ip }])}::jsonb,
          ${'notifications #' + notificationId}, '{}'::jsonb, now()
        )
      `
    }

    await tx.commit()
    return rowToResponse(result.rows[0])
  } finally {
    connection.release()
  }
}

export async function getSummary(
  pool: Pool,
  profileId: number
): Promise<{ unread_count: number; read_count: number }> {
  const connection = await pool.connect()
  try {
    const result = await connection.queryObject<{ status: string; count: string }>`
      SELECT status, COUNT(*)::text AS count
      FROM traffic.notifications
      WHERE profile_id = ${profileId}
      GROUP BY status
    `
    const counts: Record<string, number> = { new: 0, seen: 0, archived: 0 }
    for (const row of result.rows) {
      counts[row.status] = parseInt(row.count, 10)
    }
    // `read_count` must include both `seen` and `archived`. Otherwise the bell
    // drops to 0/0 immediately after "archive all" even though the user had
    // notifications a moment ago, and Studio's read/unread badge goes blank.
    return {
      unread_count: counts.new ?? 0,
      read_count: (counts.seen ?? 0) + (counts.archived ?? 0),
    }
  } finally {
    connection.release()
  }
}

export async function markAllArchived(
  pool: Pool,
  profileId: number,
  gotrueId: string,
  auditContext?: { email: string; ip: string; method: string; route: string }
): Promise<number> {
  const connection = await pool.connect()
  try {
    const tx = connection.createTransaction('archive_all_notifications')
    await tx.begin()

    const result = await tx.queryObject`
      UPDATE traffic.notifications
      SET status = 'archived'
      WHERE profile_id = ${profileId} AND status != 'archived'
    `

    const archivedCount = result.rowCount ?? 0

    if (auditContext && archivedCount > 0) {
      await tx.queryObject`
        INSERT INTO traffic.audit_logs (
          id, profile_id, action_name, action_metadata,
          actor_id, actor_type, actor_metadata,
          target_description, target_metadata, occurred_at
        ) VALUES (
          gen_random_uuid(), ${profileId}, 'notifications.archive_all',
          ${JSON.stringify([{ method: auditContext.method, route: auditContext.route, status: 200 }])}::jsonb,
          ${gotrueId}, 'user',
          ${JSON.stringify([{ email: auditContext.email, ip: auditContext.ip }])}::jsonb,
          ${'notifications archive_all: ' + archivedCount + ' items'}, '{}'::jsonb, now()
        )
      `
    }

    await tx.commit()
    return archivedCount
  } finally {
    connection.release()
  }
}
