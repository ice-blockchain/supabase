import type { Pool } from 'https://deno.land/x/postgres@v0.17.0/mod.ts'

import { corsHeaders } from '../index.ts'
import {
  createFeedback,
  updateFeedbackCustomFields,
  type FeedbackAuditContext,
  type FeedbackCategory,
  type FeedbackCreateInput,
} from '../services/feedback.service.ts'
import { getClientIp } from '../utils/client-ip.ts'

function pickString(body: Record<string, unknown>, ...keys: string[]): string | undefined {
  for (const key of keys) {
    const value = body[key]
    if (typeof value === 'string' && value.length > 0) return value
  }
  return undefined
}

function pickStringArray(body: Record<string, unknown>, ...keys: string[]): string[] | undefined {
  for (const key of keys) {
    const value = body[key]
    if (Array.isArray(value) && value.every((v) => typeof v === 'string')) {
      return value as string[]
    }
  }
  return undefined
}

function buildMetadata(body: Record<string, unknown>, omit: Set<string>): Record<string, unknown> {
  const metadata: Record<string, unknown> = {}
  for (const [key, value] of Object.entries(body)) {
    if (omit.has(key)) continue
    metadata[key] = value
  }
  return metadata
}

async function insertAndRespond(
  pool: Pool,
  profileId: number,
  input: FeedbackCreateInput,
  gotrueId: string,
  auditContext: FeedbackAuditContext
): Promise<Response> {
  const row = await createFeedback(pool, profileId, input, gotrueId, auditContext)
  return Response.json(
    { id: row.id, created_at: row.created_at },
    { status: 201, headers: corsHeaders }
  )
}

async function handleSend(
  req: Request,
  pool: Pool,
  profileId: number,
  gotrueId: string,
  auditContext: FeedbackAuditContext
): Promise<Response> {
  const body = (await req.json().catch(() => ({}))) as Record<string, unknown>
  const message = pickString(body, 'message')
  if (!message) {
    return Response.json({ message: 'message is required' }, { status: 400, headers: corsHeaders })
  }
  return insertAndRespond(
    pool,
    profileId,
    {
      category: 'general',
      message,
      projectRef: pickString(body, 'projectRef', 'project_ref'),
      organizationSlug: pickString(body, 'organizationSlug', 'orgSlug', 'organization_slug'),
      tags: pickStringArray(body, 'tags'),
      metadata: buildMetadata(
        body,
        new Set([
          'message',
          'projectRef',
          'project_ref',
          'organizationSlug',
          'orgSlug',
          'organization_slug',
          'tags',
        ])
      ),
    },
    gotrueId,
    auditContext
  )
}

async function handleSurvey(
  req: Request,
  pool: Pool,
  profileId: number,
  category: Extract<FeedbackCategory, 'upgrade_survey' | 'downgrade_survey'>,
  gotrueId: string,
  auditContext: FeedbackAuditContext
): Promise<Response> {
  const body = (await req.json().catch(() => ({}))) as Record<string, unknown>
  const message = pickString(body, 'message', 'additionalFeedback')
  if (!message) {
    return Response.json({ message: 'message is required' }, { status: 400, headers: corsHeaders })
  }
  return insertAndRespond(
    pool,
    profileId,
    {
      category,
      message,
      projectRef: pickString(body, 'projectRef', 'project_ref'),
      organizationSlug: pickString(body, 'organizationSlug', 'orgSlug', 'organization_slug'),
      metadata: buildMetadata(
        body,
        new Set([
          'message',
          'additionalFeedback',
          'projectRef',
          'project_ref',
          'organizationSlug',
          'orgSlug',
          'organization_slug',
        ])
      ),
    },
    gotrueId,
    auditContext
  )
}

export async function handleFeedback(
  req: Request,
  path: string,
  method: string,
  pool: Pool,
  profileId: number,
  gotrueId: string,
  email: string
): Promise<Response> {
  const ip = getClientIp(req)
  const auditContext: FeedbackAuditContext = { email, ip, method, route: '/feedback' + path }

  if (method === 'POST' && path === '/send') {
    return handleSend(req, pool, profileId, gotrueId, auditContext)
  }

  if (method === 'POST' && path === '/upgrade') {
    return handleSurvey(req, pool, profileId, 'upgrade_survey', gotrueId, auditContext)
  }

  if (method === 'POST' && path === '/downgrade') {
    return handleSurvey(req, pool, profileId, 'downgrade_survey', gotrueId, auditContext)
  }

  const customFieldsMatch = path.match(/^\/conversations\/([^/]+)\/custom-fields$/)
  if (method === 'PATCH' && customFieldsMatch) {
    const rawId = customFieldsMatch[1]
    const id = Number.parseInt(rawId, 10)
    if (!Number.isInteger(id) || String(id) !== rawId) {
      return Response.json(
        { message: 'Conversation not found' },
        { status: 404, headers: corsHeaders }
      )
    }
    const body = (await req.json().catch(() => ({}))) as Record<string, unknown>
    const updated = await updateFeedbackCustomFields(
      pool,
      id,
      profileId,
      body,
      gotrueId,
      auditContext
    )
    if (!updated) {
      return Response.json(
        { message: 'Conversation not found' },
        { status: 404, headers: corsHeaders }
      )
    }
    return Response.json({ id: updated.id }, { headers: corsHeaders })
  }

  return Response.json({ message: 'Method not allowed' }, { status: 405, headers: corsHeaders })
}
