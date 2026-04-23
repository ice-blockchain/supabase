import type { Pool } from 'https://deno.land/x/postgres@v0.17.0/mod.ts'

import { corsHeaders } from '../index.ts'
import { getProjectByRef } from '../services/project.service.ts'

// Wave 3 / Bundle L — Project lifecycle v1 (upgrade, types, readonly, actions).
//
// This handler is dispatched from `handleProjectHealth` in `projects.ts` for
// v1 sub-paths that aren't real cloud operations in self-hosted deployments:
//
//   • /api/v1/projects/{ref}/upgrade                         — POST 501
//   • /api/v1/projects/{ref}/upgrade/eligibility              — GET shape stub
//   • /api/v1/projects/{ref}/upgrade/status                   — GET shape stub
//   • /api/v1/projects/{ref}/types/typescript                 — GET pg-meta proxy
//   • /api/v1/projects/{ref}/readonly/temporary-disable       — POST no-op
//   • /api/v1/projects/{ref}/actions[/{run_id}[/logs]]        — GET empty list / 404
//
// Self-hosted stacks don't have a managed-upgrade pipeline, a read-only
// auto-mode, or a cloud "actions" runner, so mutations return 501 with the
// shared `self_hosted_unsupported` reason code. The only real integration is
// the typescript-types proxy, which forwards to pg-meta inside the docker
// network and falls back to an inert stub on failure so the Studio download
// button never hangs.

const UPGRADE_UNSUPPORTED_MESSAGE = 'Project upgrades are not available in self-hosted deployments'

const PG_META_URL = Deno.env.get('PG_META_URL') ?? 'http://meta:8080'
const PG_META_TIMEOUT_MS = 5000
// Matches the shape Studio's `generateTypescriptTypes` reader expects, so
// download-types buttons still produce a valid file when pg-meta is down.
const TYPES_FALLBACK = 'export type Database = {} as any;'

// ── Response helpers ─────────────────────────────────────────

function notFoundResponse(message = 'Not Found'): Response {
  return Response.json({ message }, { status: 404, headers: corsHeaders })
}

function notSupportedResponse(message = UPGRADE_UNSUPPORTED_MESSAGE): Response {
  return Response.json(
    { code: 'self_hosted_unsupported', message },
    { status: 501, headers: corsHeaders }
  )
}

function methodNotAllowedResponse(): Response {
  return Response.json({ message: 'Method not allowed' }, { status: 405, headers: corsHeaders })
}

// ── Handler ──────────────────────────────────────────────────

export async function handleProjectLifecycle(
  req: Request,
  path: string,
  method: string,
  pool: Pool,
  profileId: number,
  _gotrueId: string,
  _email: string
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

  // ── /upgrade/eligibility ───────────────────────────────────
  if (subPath === '/upgrade/eligibility') {
    if (method === 'GET') {
      return Response.json(
        {
          eligible: false,
          target_upgrade_versions: [],
          potential_breaking_changes: [],
          extension_dependent_objects: [],
        },
        { headers: corsHeaders }
      )
    }
    return methodNotAllowedResponse()
  }

  // ── /upgrade/status ────────────────────────────────────────
  if (subPath === '/upgrade/status') {
    if (method === 'GET') {
      return Response.json(
        {
          progress: 'complete',
          target_version: null,
          target_version_is_latest: true,
          initiated_at: null,
        },
        { headers: corsHeaders }
      )
    }
    return methodNotAllowedResponse()
  }

  // ── /upgrade (POST → 501) ──────────────────────────────────
  if (subPath === '/upgrade') {
    if (method === 'POST') {
      return notSupportedResponse()
    }
    return methodNotAllowedResponse()
  }

  // ── /types/typescript (pg-meta proxy) ──────────────────────
  if (subPath === '/types/typescript') {
    if (method === 'GET') {
      return proxyTypescriptTypes(req)
    }
    return methodNotAllowedResponse()
  }

  // ── /readonly/temporary-disable ────────────────────────────
  if (subPath === '/readonly/temporary-disable') {
    if (method === 'POST') {
      return Response.json({ success: true }, { headers: corsHeaders })
    }
    return methodNotAllowedResponse()
  }

  // ── /actions (list) ────────────────────────────────────────
  if (subPath === '/actions' || subPath === '/actions/') {
    if (method === 'GET') {
      return Response.json({ runs: [] }, { headers: corsHeaders })
    }
    return methodNotAllowedResponse()
  }

  // ── /actions/{run_id}/logs ─────────────────────────────────
  const runLogsMatch = subPath.match(/^\/actions\/([^/]+)\/logs\/?$/)
  if (runLogsMatch) {
    if (method === 'GET') {
      return Response.json({ message: 'Run not found' }, { status: 404, headers: corsHeaders })
    }
    return methodNotAllowedResponse()
  }

  // ── /actions/{run_id} ──────────────────────────────────────
  const runMatch = subPath.match(/^\/actions\/([^/]+)\/?$/)
  if (runMatch) {
    if (method === 'GET') {
      return Response.json({ message: 'Run not found' }, { status: 404, headers: corsHeaders })
    }
    return methodNotAllowedResponse()
  }

  return notFoundResponse()
}

// ── pg-meta proxy ────────────────────────────────────────────

// Forwards `GET /v1/projects/{ref}/types/typescript?...` to pg-meta's
// `/generators/typescript` endpoint, preserving all query params (e.g.
// `included_schemas`, `excluded_schemas`). Any failure — non-2xx, network
// error, or timeout — swallows to a static `{ types }` fallback so the
// Studio "Generate types" button never surfaces a 5xx.
async function proxyTypescriptTypes(req: Request): Promise<Response> {
  const incoming = new URL(req.url)
  const target = new URL(`${PG_META_URL}/generators/typescript`)
  for (const [key, value] of incoming.searchParams.entries()) {
    target.searchParams.set(key, value)
  }

  try {
    const res = await fetch(target.toString(), {
      headers: { 'Content-Type': 'application/json' },
      signal: AbortSignal.timeout(PG_META_TIMEOUT_MS),
    })

    if (!res.ok) {
      const errorBody = await res.text().catch(() => '')
      console.error(`pg-meta types proxy failed (${res.status}): ${errorBody}`)
      return Response.json({ types: TYPES_FALLBACK }, { headers: corsHeaders })
    }

    const contentType = res.headers.get('content-type') ?? ''
    if (contentType.includes('application/json')) {
      const data = (await res.json().catch(() => null)) as { types?: unknown } | null
      if (data && typeof data.types === 'string') {
        return Response.json({ types: data.types }, { headers: corsHeaders })
      }
      return Response.json({ types: TYPES_FALLBACK }, { headers: corsHeaders })
    }

    const types = await res.text()
    return Response.json({ types }, { headers: corsHeaders })
  } catch (err) {
    console.error('pg-meta types proxy error:', err)
    return Response.json({ types: TYPES_FALLBACK }, { headers: corsHeaders })
  }
}
