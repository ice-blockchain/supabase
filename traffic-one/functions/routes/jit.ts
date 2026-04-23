import type { Pool } from 'https://deno.land/x/postgres@v0.17.0/mod.ts'

import { corsHeaders } from '../index.ts'
import {
  getPolicy,
  issueGrant,
  listGrants,
  revokeGrant,
  upsertPolicy,
  type IssueGrantInput,
  type JitPolicy,
  type JitScope,
} from '../services/jit.service.ts'
import { getProjectByRef } from '../services/project.service.ts'
import { getClientIp } from '../utils/client-ip.ts'

// ── Response helpers ─────────────────────────────────────────

function notFoundResponse(message = 'Not Found'): Response {
  return Response.json({ message }, { status: 404, headers: corsHeaders })
}

function methodNotAllowedResponse(): Response {
  return Response.json({ message: 'Method not allowed' }, { status: 405, headers: corsHeaders })
}

function invalidBodyResponse(message: string): Response {
  return Response.json({ message }, { status: 400, headers: corsHeaders })
}

// ── Body normalizers ─────────────────────────────────────────

function normalizePolicyPatch(body: Record<string, unknown>): Partial<JitPolicy> {
  const patch: Partial<JitPolicy> = {}
  if (typeof body.enabled === 'boolean') {
    patch.enabled = body.enabled
  }
  if (
    typeof body.max_session_duration_minutes === 'number' &&
    Number.isFinite(body.max_session_duration_minutes) &&
    body.max_session_duration_minutes > 0
  ) {
    patch.max_session_duration_minutes = Math.floor(body.max_session_duration_minutes)
  }
  if (typeof body.approval_required === 'boolean') {
    patch.approval_required = body.approval_required
  }
  if (body.default_scope === 'read-only' || body.default_scope === 'read-write') {
    patch.default_scope = body.default_scope
  }
  return patch
}

function normalizeIssueInput(body: Record<string, unknown>): IssueGrantInput {
  const input: IssueGrantInput = {}
  if (typeof body.user_id === 'number' && Number.isInteger(body.user_id)) {
    input.user_id = body.user_id
  }
  if (
    typeof body.duration_minutes === 'number' &&
    Number.isFinite(body.duration_minutes) &&
    body.duration_minutes > 0
  ) {
    input.duration_minutes = Math.floor(body.duration_minutes)
  }
  if (body.scope === 'read-only' || body.scope === 'read-write') {
    input.scope = body.scope as JitScope
  }
  if (Array.isArray(body.tables)) {
    input.tables = body.tables.filter((t): t is string => typeof t === 'string')
  }
  return input
}

// ── Handler ─────────────────────────────────────────────────

export async function handleJit(
  req: Request,
  path: string,
  method: string,
  pool: Pool,
  profileId: number,
  gotrueId: string,
  email: string
): Promise<Response> {
  // Extract ref from path: /{ref}/jit-access, /{ref}/database/jit[/...]
  const match = path.match(/^\/([^/]+)(\/.+)$/)
  if (!match) {
    return notFoundResponse()
  }
  const ref = match[1]
  const subPath = match[2]

  const project = await getProjectByRef(pool, ref, profileId)
  if (!project) {
    return notFoundResponse('Project not found')
  }

  const ip = getClientIp(req)
  const auditContext = {
    email,
    ip,
    method,
    route: '/v1/projects/' + ref + subPath,
    organizationId: project.organization_id,
  }

  // ── /jit-access ───────────────────────────────────────────
  if (subPath === '/jit-access') {
    if (method === 'GET') {
      const policy = await getPolicy(pool, ref)
      return Response.json(policy, { headers: corsHeaders })
    }

    if (method === 'PUT') {
      let body: Record<string, unknown>
      try {
        body = (await req.json()) as Record<string, unknown>
      } catch {
        body = {}
      }
      const patch = normalizePolicyPatch(body)
      const policy = await upsertPolicy(pool, ref, patch, profileId, gotrueId, auditContext)
      return Response.json(policy, { headers: corsHeaders })
    }

    return methodNotAllowedResponse()
  }

  // ── /database/jit/list ────────────────────────────────────
  if (subPath === '/database/jit/list') {
    if (method === 'GET') {
      const grants = await listGrants(pool, ref)
      return Response.json(grants, { headers: corsHeaders })
    }
    return methodNotAllowedResponse()
  }

  // ── /database/jit ────────────────────────────────────────
  if (subPath === '/database/jit') {
    if (method === 'PUT' || method === 'POST') {
      let body: Record<string, unknown>
      try {
        body = (await req.json()) as Record<string, unknown>
      } catch {
        body = {}
      }
      const input = normalizeIssueInput(body)
      const result = await issueGrant(pool, ref, input, profileId, gotrueId, auditContext)
      return Response.json(result, { status: 201, headers: corsHeaders })
    }
    return methodNotAllowedResponse()
  }

  // ── /database/jit/{user_id} ──────────────────────────────
  const revokeMatch = subPath.match(/^\/database\/jit\/([^/]+)$/)
  if (revokeMatch) {
    if (method !== 'DELETE') {
      return methodNotAllowedResponse()
    }
    const rawUserId = revokeMatch[1]
    const userId = Number.parseInt(rawUserId, 10)
    if (!Number.isInteger(userId) || String(userId) !== rawUserId) {
      return invalidBodyResponse('user_id must be an integer')
    }
    const result = await revokeGrant(pool, ref, userId, profileId, gotrueId, auditContext)
    return Response.json(result, { headers: corsHeaders })
  }

  return notFoundResponse()
}
