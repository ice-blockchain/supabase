import type { Pool } from 'https://deno.land/x/postgres@v0.17.0/mod.ts'

import { corsHeaders } from '../index.ts'
import {
  bulkUpdateNotificationStatus,
  getSummary,
  listNotifications,
  markAllArchived,
  updateNotificationStatus,
} from '../services/notification.service.ts'
import type { NotificationResponse, NotificationStatus } from '../types/api.ts'
import { getClientIp } from '../utils/client-ip.ts'

export async function handleNotifications(
  req: Request,
  path: string,
  method: string,
  pool: Pool,
  gotrueId: string,
  email: string,
  profileId: number
): Promise<Response> {
  const ip = getClientIp(req)
  // L1: this handler was originally mounted under `/profile/notifications` and
  // still logs audit `route` with that legacy prefix. Studio now calls
  // `/api/platform/notifications/*` directly and Kong strips the `/api/platform`
  // prefix before delegation, so the incoming `path` already starts with
  // `/notifications`. Use it verbatim so audit log entries reflect the real
  // Kong route instead of a stale profile-scoped one.
  const auditContext = { email, ip, method, route: path }

  if (method === 'GET' && path === '/notifications') {
    const notifications = await listNotifications(pool, profileId)
    return Response.json(notifications, { headers: corsHeaders })
  }

  if (method === 'GET' && path === '/notifications/summary') {
    const summary = await getSummary(pool, profileId)
    return Response.json(summary, { headers: corsHeaders })
  }

  if (method === 'PATCH' && path === '/notifications/archive-all') {
    const archived = await markAllArchived(pool, profileId, gotrueId, auditContext)
    return Response.json({ archived_count: archived }, { headers: corsHeaders })
  }

  if (method === 'PATCH' && path === '/notifications') {
    const body = await req.json().catch(() => ({}))

    if (Array.isArray(body)) {
      const byStatus = new Map<string, string[]>()
      for (const entry of body) {
        if (!entry?.id || !entry?.status) {
          return Response.json(
            { message: 'each entry must have id and status' },
            { status: 400, headers: corsHeaders }
          )
        }
        const group = byStatus.get(entry.status)
        if (group) {
          group.push(entry.id)
        } else {
          byStatus.set(entry.status, [entry.id])
        }
      }
      const allUpdated: NotificationResponse[] = []
      for (const [status, ids] of byStatus) {
        const updated = await bulkUpdateNotificationStatus(
          pool,
          profileId,
          ids,
          status as NotificationStatus,
          gotrueId,
          auditContext
        )
        allUpdated.push(...updated)
      }
      return Response.json(allUpdated, { headers: corsHeaders })
    }

    if (!body.ids || !body.status) {
      return Response.json(
        { message: 'ids and status are required' },
        { status: 400, headers: corsHeaders }
      )
    }
    const updated = await bulkUpdateNotificationStatus(
      pool,
      profileId,
      body.ids,
      body.status,
      gotrueId,
      auditContext
    )
    return Response.json(updated, { headers: corsHeaders })
  }

  const singleMatch = path.match(/^\/notifications\/([a-f0-9-]+)$/i)
  if (method === 'PATCH' && singleMatch) {
    const notifId = singleMatch[1]
    const body = await req.json().catch(() => ({}))
    if (!body.status) {
      return Response.json({ message: 'status is required' }, { status: 400, headers: corsHeaders })
    }
    const updated = await updateNotificationStatus(
      pool,
      profileId,
      notifId,
      body.status,
      gotrueId,
      auditContext
    )
    if (!updated) {
      return Response.json(
        { message: 'Notification not found' },
        { status: 404, headers: corsHeaders }
      )
    }
    return Response.json(updated, { headers: corsHeaders })
  }

  return Response.json(
    { message: 'Method not allowed' },
    {
      status: 405,
      headers: corsHeaders,
    }
  )
}
