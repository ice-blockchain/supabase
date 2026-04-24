import type { Pool } from 'https://deno.land/x/postgres@v0.19.3/mod.ts'

import { corsHeaders } from '../index.ts'
import {
  type CustomHostnameRow,
  getCustomHostnameByRef,
  upsertInitializedCustomHostname,
} from '../services/custom-hostnames.service.ts'
import { getProjectByRef } from '../services/project.service.ts'
import { getClientIp } from '../utils/client-ip.ts'
import { assertValidRef } from '../utils/ref-validation.ts'

const CUSTOM_HOSTNAME_UNSUPPORTED_MESSAGE =
  'Custom hostname activation is not available in self-hosted deployments'

function notFoundResponse(message = 'Not Found'): Response {
  return Response.json({ message }, { status: 404, headers: corsHeaders })
}

function methodNotAllowedResponse(): Response {
  return Response.json({ message: 'Method not allowed' }, { status: 405, headers: corsHeaders })
}

function invalidBodyResponse(message = 'Invalid request body'): Response {
  return Response.json({ message }, { status: 400, headers: corsHeaders })
}

function notSupportedResponse(message = CUSTOM_HOSTNAME_UNSUPPORTED_MESSAGE): Response {
  return Response.json(
    { code: 'self_hosted_unsupported', message },
    { status: 501, headers: corsHeaders },
  )
}

function toCustomHostnameResponse(row: CustomHostnameRow): Record<string, unknown> {
  return {
    status: row.status,
    custom_hostname: row.custom_hostname,
    verification_errors: row.verification_errors ?? [],
    ownership_verification: {
      verified: row.ownership_verified,
    },
    ssl: { verified: row.ssl_verified },
    inserted_at: row.inserted_at,
    updated_at: row.updated_at,
  }
}

function emptyCustomHostnameResponse(): Record<string, unknown> {
  return {
    status: 'not_configured',
    custom_hostname: null,
    verification_errors: [],
    ownership_verification: { verified: false },
    ssl: { verified: false },
  }
}

async function emitInitializeAudit(
  pool: Pool,
  profileId: number,
  organizationId: number,
  gotrueId: string,
  projectRef: string,
  customHostname: string,
  auditContext: { email: string; ip: string; method: string; route: string },
): Promise<void> {
  const connection = await pool.connect()
  try {
    await connection.queryObject`
      INSERT INTO traffic.audit_logs (
        id, profile_id, organization_id, action_name, action_metadata,
        actor_id, actor_type, actor_metadata,
        target_description, target_metadata, occurred_at
      ) VALUES (
        gen_random_uuid(), ${profileId}, ${organizationId},
        'project.custom_hostname_initialized',
        ${
      JSON.stringify([{ method: auditContext.method, route: auditContext.route, status: 200 }])
    }::jsonb,
        ${gotrueId}, 'user',
        ${JSON.stringify([{ email: auditContext.email, ip: auditContext.ip }])}::jsonb,
        ${'custom_hostnames (ref: ' + projectRef + ', hostname: ' + customHostname + ')'},
        ${JSON.stringify({ custom_hostname: customHostname })}::jsonb,
        now()
      )
    `
  } finally {
    connection.release()
  }
}

// ── Handler ───────────────────────────────────────────────

export async function handleCustomHostname(
  req: Request,
  path: string,
  method: string,
  pool: Pool,
  profileId: number,
  gotrueId: string,
  email: string,
): Promise<Response> {
  const match = path.match(/^\/([^/]+)\/custom-hostname(\/initialize|\/activate|\/reverify)?\/?$/)
  if (!match) return notFoundResponse()

  const ref = match[1]
  const action = match[2] ?? ''

  // L4: malformed ref → 400 before DB lookup.
  const bad = assertValidRef(ref)
  if (bad) return bad

  const project = await getProjectByRef(pool, ref, profileId)
  if (!project) {
    return notFoundResponse('Project not found')
  }

  // GET /{ref}/custom-hostname — return stored row, or a not_configured stub.
  if (action === '') {
    if (method !== 'GET') return methodNotAllowedResponse()
    const row = await getCustomHostnameByRef(pool, ref)
    if (!row) {
      return Response.json(emptyCustomHostnameResponse(), {
        headers: corsHeaders,
      })
    }
    return Response.json(toCustomHostnameResponse(row), { headers: corsHeaders })
  }

  // POST /{ref}/custom-hostname/initialize — persist + flip to pending.
  if (action === '/initialize') {
    if (method !== 'POST') return methodNotAllowedResponse()

    let body: Record<string, unknown>
    try {
      body = await req.json()
    } catch {
      return invalidBodyResponse('Body must be valid JSON')
    }

    const hostname = typeof body.custom_hostname === 'string' ? body.custom_hostname.trim() : ''
    if (!hostname) {
      return invalidBodyResponse('custom_hostname is required')
    }

    const row = await upsertInitializedCustomHostname(pool, ref, hostname)

    const auditContext = {
      email,
      ip: getClientIp(req),
      method,
      route: '/v1/projects/' + ref + '/custom-hostname/initialize',
    }
    await emitInitializeAudit(
      pool,
      profileId,
      project.organization_id,
      gotrueId,
      ref,
      hostname,
      auditContext,
    )

    return Response.json(toCustomHostnameResponse(row), { headers: corsHeaders })
  }

  // POST /{ref}/custom-hostname/activate — self-hosted doesn't control DNS.
  if (action === '/activate') {
    if (method !== 'POST') return methodNotAllowedResponse()
    return notSupportedResponse()
  }

  // POST /{ref}/custom-hostname/reverify — same reason as /activate.
  if (action === '/reverify') {
    if (method !== 'POST') return methodNotAllowedResponse()
    return notSupportedResponse()
  }

  return notFoundResponse()
}
