import type { Pool } from 'https://deno.land/x/postgres@v0.17.0/mod.ts'

import { corsHeaders } from '../index.ts'
import { getProjectByRef } from '../services/project.service.ts'
import { insertMigration, listMigrations } from '../services/schema-migrations.service.ts'
import { getClientIp } from '../utils/client-ip.ts'

function notFoundResponse(message = 'Not Found'): Response {
  return Response.json({ message }, { status: 404, headers: corsHeaders })
}

function invalidBodyResponse(message = 'Invalid request body'): Response {
  return Response.json({ message }, { status: 400, headers: corsHeaders })
}

function methodNotAllowedResponse(): Response {
  return Response.json({ message: 'Method not allowed' }, { status: 405, headers: corsHeaders })
}

function generateVersionTimestamp(): string {
  const now = new Date()
  const pad = (n: number) => n.toString().padStart(2, '0')
  return (
    now.getUTCFullYear().toString() +
    pad(now.getUTCMonth() + 1) +
    pad(now.getUTCDate()) +
    pad(now.getUTCHours()) +
    pad(now.getUTCMinutes()) +
    pad(now.getUTCSeconds())
  )
}

// ── Handler for /{ref}/database/migrations ────────────────

export async function handleDatabaseMigrations(
  req: Request,
  path: string,
  method: string,
  pool: Pool,
  profileId: number,
  gotrueId: string,
  email: string
): Promise<Response> {
  const match = path.match(/^\/([^/]+)\/database\/migrations\/?$/)
  if (!match) {
    return notFoundResponse()
  }
  const ref = match[1]

  const project = await getProjectByRef(pool, ref, profileId)
  if (!project) {
    return notFoundResponse('Project not found')
  }

  if (method === 'GET') {
    const migrations = await listMigrations(pool, ref)
    return Response.json(migrations, { headers: corsHeaders })
  }

  if (method === 'PUT') {
    let body: Record<string, unknown>
    try {
      body = await req.json()
    } catch {
      return invalidBodyResponse('Body must be valid JSON')
    }

    const statements = extractStatements(body)
    if (statements.length === 0) {
      return invalidBodyResponse('query (string) or statements (string[]) is required')
    }

    const idempotencyKey = req.headers.get('Idempotency-Key') ?? undefined
    const version = extractVersion(body, idempotencyKey)
    const name = typeof body.name === 'string' ? body.name : ''

    const ip = getClientIp(req)
    const auditContext = {
      email,
      ip,
      method,
      route: '/v1/projects/' + ref + '/database/migrations',
    }

    const outcome = await insertMigration(
      pool,
      ref,
      version,
      name,
      statements,
      profileId,
      project.organization_id,
      gotrueId,
      auditContext
    )

    if (outcome.status === 'conflict') {
      return Response.json(
        {
          code: 'conflict',
          message: 'Migration version already exists',
          migration: outcome.migration,
        },
        { status: 409, headers: corsHeaders }
      )
    }

    return Response.json(outcome.migration, { status: 201, headers: corsHeaders })
  }

  return methodNotAllowedResponse()
}

function extractStatements(body: Record<string, unknown>): string[] {
  if (Array.isArray(body.statements)) {
    return body.statements.filter((s): s is string => typeof s === 'string')
  }
  if (typeof body.query === 'string' && body.query.trim().length > 0) {
    return [body.query]
  }
  return []
}

function extractVersion(body: Record<string, unknown>, idempotencyKey: string | undefined): string {
  if (typeof body.version === 'string' && body.version.trim().length > 0) {
    return body.version.trim()
  }
  if (idempotencyKey && idempotencyKey.trim().length > 0) {
    return idempotencyKey.trim()
  }
  return generateVersionTimestamp()
}
