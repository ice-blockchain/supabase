import type { Pool } from 'https://deno.land/x/postgres@v0.17.0/mod.ts'

import { corsHeaders } from '../index.ts'
import {
  deleteLintException,
  getConfigSection,
  getRotationStatus,
  InvalidSensitivityError,
  listLintExceptions,
  rotateJwtSecret,
  SENSITIVITY_VALUES,
  updateConfigSection,
  updateDbPassword,
  updateProjectSensitivity,
  upsertLintException,
  type ConfigSection,
  type SectionColumn,
} from '../services/project-config.service.ts'
import { getProjectByRef } from '../services/project.service.ts'
import { getClientIp } from '../utils/client-ip.ts'

// ── Response helpers ───────────────────────────────────────

function jsonResponse(body: unknown, status = 200): Response {
  return Response.json(body, { status, headers: corsHeaders })
}

function notFound(message = 'Not Found'): Response {
  return jsonResponse({ message }, 404)
}

function badRequest(message: string): Response {
  return jsonResponse({ message }, 400)
}

function methodNotAllowed(): Response {
  return jsonResponse({ message: 'Method not allowed' }, 405)
}

// ── Request helpers ────────────────────────────────────────

async function readJsonBody(req: Request): Promise<Record<string, unknown>> {
  try {
    const text = await req.text()
    if (!text) return {}
    const parsed = JSON.parse(text)
    return parsed && typeof parsed === 'object' && !Array.isArray(parsed)
      ? (parsed as Record<string, unknown>)
      : {}
  } catch {
    return {}
  }
}

function clientIp(req: Request): string {
  return getClientIp(req)
}

function asStringRecord(value: unknown): Record<string, unknown> {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return {}
  return value as Record<string, unknown>
}

// ── Dispatch ───────────────────────────────────────────────

export async function handleProjectConfig(
  req: Request,
  path: string,
  method: string,
  pool: Pool,
  profileId: number,
  gotrueId: string,
  email: string
): Promise<Response> {
  const refMatch = path.match(/^\/([^/]+)(\/.*)$/)
  if (!refMatch) {
    return notFound()
  }

  const ref = refMatch[1]
  const subPath = refMatch[2]

  const project = await getProjectByRef(pool, ref, profileId)
  if (!project) {
    return notFound('Project not found')
  }

  const orgId = project.organization_id
  const auditContext = {
    email,
    ip: clientIp(req),
    method,
    route: '/projects' + path,
  }

  // ── /config/postgrest|storage|realtime|pgbouncer ─────────
  const sectionMatch = subPath.match(/^\/config\/(postgrest|storage|realtime|pgbouncer)$/)
  if (sectionMatch) {
    const section = sectionMatch[1] as SectionColumn
    if (method === 'GET') {
      const data = await getConfigSection(pool, ref, section)
      return jsonResponse(data)
    }
    if (method === 'PATCH') {
      const body = await readJsonBody(req)
      const data = await updateConfigSection(
        pool,
        ref,
        section,
        body,
        profileId,
        orgId,
        gotrueId,
        auditContext
      )
      return jsonResponse(data)
    }
    return methodNotAllowed()
  }

  // ── /config/pgbouncer/status ─────────────────────────────
  if (subPath === '/config/pgbouncer/status') {
    if (method === 'GET') {
      return jsonResponse({ enabled: true })
    }
    return methodNotAllowed()
  }

  // ── /config/secrets ──────────────────────────────────────
  if (subPath === '/config/secrets') {
    if (method === 'GET') {
      const data = await getConfigSection(pool, ref, 'secrets' as ConfigSection)
      return jsonResponse(data)
    }
    if (method === 'PATCH') {
      const body = await readJsonBody(req)
      const providedRequestId =
        typeof body.request_id === 'string'
          ? body.request_id
          : typeof body.requestId === 'string'
            ? body.requestId
            : null
      const requestId = providedRequestId ?? crypto.randomUUID()
      const state = await rotateJwtSecret(
        pool,
        ref,
        requestId,
        profileId,
        orgId,
        gotrueId,
        auditContext
      )
      return jsonResponse(state)
    }
    return methodNotAllowed()
  }

  // ── /config/secrets/update-status ────────────────────────
  if (subPath === '/config/secrets/update-status') {
    if (method === 'GET') {
      const url = new URL(req.url)
      const requestId =
        url.searchParams.get('request_id') ?? url.searchParams.get('requestId') ?? undefined
      const state = await getRotationStatus(pool, ref, requestId ?? undefined)
      if (!state) {
        return jsonResponse({ status: 'idle', request_id: null })
      }
      return jsonResponse(state)
    }
    return methodNotAllowed()
  }

  // ── /settings/sensitivity ────────────────────────────────
  if (subPath === '/settings/sensitivity') {
    if (method === 'PATCH') {
      const body = await readJsonBody(req)
      const raw = body.sensitivity ?? body.level ?? body.value
      if (typeof raw !== 'string') {
        return badRequest(`sensitivity must be a string (one of: ${SENSITIVITY_VALUES.join(', ')})`)
      }
      try {
        const result = await updateProjectSensitivity(
          pool,
          ref,
          raw,
          profileId,
          orgId,
          gotrueId,
          auditContext
        )
        return jsonResponse(result)
      } catch (err) {
        if (err instanceof InvalidSensitivityError) {
          return badRequest(
            `Invalid sensitivity. Expected one of: ${SENSITIVITY_VALUES.join(', ')}`
          )
        }
        throw err
      }
    }
    return methodNotAllowed()
  }

  // ── /db-password ─────────────────────────────────────────
  if (subPath === '/db-password') {
    if (method === 'PATCH') {
      const body = await readJsonBody(req)
      const rawPassword = body.password ?? body.db_password ?? body.newPassword
      if (typeof rawPassword !== 'string' || rawPassword.length === 0) {
        return badRequest('password (non-empty string) is required')
      }
      const outcome = await updateDbPassword(
        pool,
        ref,
        rawPassword,
        profileId,
        orgId,
        gotrueId,
        auditContext
      )
      return jsonResponse({ result: outcome.result })
    }
    return methodNotAllowed()
  }

  // ── /notifications/advisor/exceptions ────────────────────
  if (subPath === '/notifications/advisor/exceptions') {
    if (method === 'GET') {
      const list = await listLintExceptions(pool, ref)
      return jsonResponse(list)
    }

    if (method === 'POST') {
      const body = await readJsonBody(req)
      const lintName =
        typeof body.lint_name === 'string'
          ? body.lint_name
          : typeof body.name === 'string'
            ? body.name
            : null
      if (!lintName) {
        return badRequest('lint_name is required')
      }
      const disabled = typeof body.disabled === 'boolean' ? body.disabled : true
      const metadata = asStringRecord(body.metadata)
      const exception = await upsertLintException(
        pool,
        ref,
        lintName,
        disabled,
        metadata,
        profileId,
        orgId,
        gotrueId,
        auditContext
      )
      return jsonResponse(exception, 201)
    }

    if (method === 'DELETE') {
      const url = new URL(req.url)
      const lintNameFromQuery = url.searchParams.get('lint_name') ?? url.searchParams.get('name')
      let lintName: string | null = lintNameFromQuery
      if (!lintName) {
        const body = await readJsonBody(req)
        if (typeof body.lint_name === 'string') lintName = body.lint_name
        else if (typeof body.name === 'string') lintName = body.name
      }
      if (!lintName) {
        return badRequest('lint_name (query or body) is required')
      }
      const deleted = await deleteLintException(
        pool,
        ref,
        lintName,
        profileId,
        orgId,
        gotrueId,
        auditContext
      )
      if (!deleted) {
        return notFound('Lint exception not found')
      }
      return jsonResponse({ deleted: true, lint_name: lintName })
    }

    return methodNotAllowed()
  }

  return notFound()
}
