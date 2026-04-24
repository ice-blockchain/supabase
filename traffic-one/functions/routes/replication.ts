import type { Pool } from 'https://deno.land/x/postgres@v0.19.3/mod.ts'

import { corsHeaders } from '../index.ts'
import { getProjectByRef } from '../services/project.service.ts'

const REPLICATION_UNSUPPORTED_MESSAGE =
  'Logical replication is not available in self-hosted deployments'

function notSupportedResponse(): Response {
  return Response.json(
    { code: 'self_hosted_unsupported', message: REPLICATION_UNSUPPORTED_MESSAGE },
    { status: 501, headers: corsHeaders },
  )
}

function notFoundResponse(message = 'Not Found'): Response {
  return Response.json({ message }, { status: 404, headers: corsHeaders })
}

function methodNotAllowedResponse(): Response {
  return Response.json({ message: 'Method not allowed' }, { status: 405, headers: corsHeaders })
}

function parsePipelineId(raw: string): number {
  const parsed = Number.parseInt(raw, 10)
  return Number.isFinite(parsed) ? parsed : 0
}

// ── Handler ────────────────────────────────────────────────

export async function handleReplication(
  _req: Request,
  path: string,
  method: string,
  pool: Pool,
  profileId: number,
  _gotrueId: string,
  _email: string,
): Promise<Response> {
  const refMatch = path.match(/^\/([^/]+)(\/.*)?$/)
  if (!refMatch) {
    return notFoundResponse()
  }

  const ref = refMatch[1]
  const subPath = refMatch[2] || ''

  const project = await getProjectByRef(pool, ref, profileId)
  if (!project) {
    return notFoundResponse('Project not found')
  }

  // ── Destinations ───────────────────────────────────────
  if (subPath === '/destinations') {
    if (method === 'GET') {
      return Response.json({ destinations: [] }, { headers: corsHeaders })
    }
    if (method === 'POST') return notSupportedResponse()
    return methodNotAllowedResponse()
  }

  if (subPath === '/destinations/validate') {
    if (method === 'POST') return notSupportedResponse()
    return methodNotAllowedResponse()
  }

  const destByIdMatch = subPath.match(/^\/destinations\/([^/]+)$/)
  if (destByIdMatch) {
    if (method === 'GET') {
      return notFoundResponse('Destination not found')
    }
    if (method === 'PATCH' || method === 'PUT' || method === 'DELETE') {
      return notSupportedResponse()
    }
    return methodNotAllowedResponse()
  }

  // ── Destinations-Pipelines ─────────────────────────────
  if (subPath === '/destinations-pipelines') {
    if (method === 'GET') {
      return Response.json({ destinations_pipelines: [] }, { headers: corsHeaders })
    }
    if (method === 'POST') return notSupportedResponse()
    return methodNotAllowedResponse()
  }

  const destPipelineMatch = subPath.match(/^\/destinations-pipelines\/([^/]+)\/([^/]+)$/)
  if (destPipelineMatch) {
    if (method === 'POST' || method === 'DELETE') {
      return notSupportedResponse()
    }
    return methodNotAllowedResponse()
  }

  // ── Tenants-Sources ────────────────────────────────────
  if (subPath === '/tenants-sources') {
    if (method === 'GET') {
      return Response.json({ tenants_sources: [] }, { headers: corsHeaders })
    }
    if (method === 'POST') return notSupportedResponse()
    return methodNotAllowedResponse()
  }

  // ── Pipelines ──────────────────────────────────────────
  if (subPath === '/pipelines') {
    if (method === 'GET') {
      return Response.json({ pipelines: [] }, { headers: corsHeaders })
    }
    if (method === 'POST') return notSupportedResponse()
    return methodNotAllowedResponse()
  }

  if (subPath === '/pipelines/validate') {
    if (method === 'POST') return notSupportedResponse()
    return methodNotAllowedResponse()
  }

  const pipelineStatusMatch = subPath.match(/^\/pipelines\/([^/]+)\/status$/)
  if (pipelineStatusMatch) {
    if (method === 'GET') {
      return Response.json(
        {
          pipeline_id: parsePipelineId(pipelineStatusMatch[1]),
          status: { name: 'stopped' },
        },
        { headers: corsHeaders },
      )
    }
    return methodNotAllowedResponse()
  }

  const pipelineReplicationStatusMatch = subPath.match(/^\/pipelines\/([^/]+)\/replication-status$/)
  if (pipelineReplicationStatusMatch) {
    if (method === 'GET') {
      return Response.json(
        {
          pipeline_id: parsePipelineId(pipelineReplicationStatusMatch[1]),
          replication_slots: [],
          table_statuses: [],
        },
        { headers: corsHeaders },
      )
    }
    return methodNotAllowedResponse()
  }

  const pipelineVersionMatch = subPath.match(/^\/pipelines\/([^/]+)\/version$/)
  if (pipelineVersionMatch) {
    if (method === 'GET') {
      return Response.json(
        {
          pipeline_id: parsePipelineId(pipelineVersionMatch[1]),
          versions: [],
        },
        { headers: corsHeaders },
      )
    }
    if (method === 'POST') return notSupportedResponse()
    return methodNotAllowedResponse()
  }

  const pipelineActionMatch = subPath.match(/^\/pipelines\/([^/]+)\/(start|stop|rollback-tables)$/)
  if (pipelineActionMatch) {
    if (method === 'POST') return notSupportedResponse()
    return methodNotAllowedResponse()
  }

  const pipelineByIdMatch = subPath.match(/^\/pipelines\/([^/]+)$/)
  if (pipelineByIdMatch) {
    if (method === 'GET') {
      return notFoundResponse('Pipeline not found')
    }
    if (method === 'PATCH' || method === 'PUT' || method === 'DELETE') {
      return notSupportedResponse()
    }
    return methodNotAllowedResponse()
  }

  // ── Sources ────────────────────────────────────────────
  if (subPath === '/sources') {
    if (method === 'GET') {
      return Response.json({ sources: [] }, { headers: corsHeaders })
    }
    if (method === 'POST') return notSupportedResponse()
    return methodNotAllowedResponse()
  }

  const sourceTablesMatch = subPath.match(/^\/sources\/([^/]+)\/tables$/)
  if (sourceTablesMatch) {
    if (method === 'GET') {
      return Response.json({ tables: [] }, { headers: corsHeaders })
    }
    return methodNotAllowedResponse()
  }

  if (subPath.match(/^\/sources\/([^/]+)\/publications$/)) {
    if (method === 'GET') {
      return Response.json({ publications: [] }, { headers: corsHeaders })
    }
    if (method === 'POST') return notSupportedResponse()
    return methodNotAllowedResponse()
  }

  if (subPath.match(/^\/sources\/([^/]+)\/publications\/([^/]+)$/)) {
    if (method === 'GET') {
      return notFoundResponse('Publication not found')
    }
    if (method === 'POST' || method === 'PATCH' || method === 'PUT' || method === 'DELETE') {
      return notSupportedResponse()
    }
    return methodNotAllowedResponse()
  }

  const sourceByIdMatch = subPath.match(/^\/sources\/([^/]+)$/)
  if (sourceByIdMatch) {
    if (method === 'GET') {
      return notFoundResponse('Source not found')
    }
    if (method === 'PATCH' || method === 'PUT' || method === 'DELETE') {
      return notSupportedResponse()
    }
    return methodNotAllowedResponse()
  }

  return notFoundResponse()
}
