import type { Pool } from 'https://deno.land/x/postgres@v0.19.3/mod.ts'

import { corsHeaders } from '../index.ts'
import {
  fetchProjectUrl,
  getProjectBackend,
  type ProjectBackend,
  ProjectBackendNotProvisionedError,
} from '../services/project-backend.service.ts'
import { getProjectByRef } from '../services/project.service.ts'
import { assertValidRef } from '../utils/ref-validation.ts'

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
    { status: 501, headers: corsHeaders },
  )
}

function methodNotAllowedResponse(): Response {
  return Response.json({ message: 'Method not allowed' }, { status: 405, headers: corsHeaders })
}

// ── Handler ──────────────────────────────────────────────────

// L9: `_gotrueId` and `_email` are part of the uniform handler signature
// dispatched from `index.ts`. Every project-scoped handler receives the
// caller's authenticated identity; most use it for audit-log writes.
// Project-lifecycle proxies only forward to pg-meta and never writes audit
// rows, so the underscore prefix marks them as "intentionally unused here
// but kept to match the shared signature". Don't remove them — doing so
// breaks the dispatcher's positional arg contract (see index.ts).
export async function handleProjectLifecycle(
  req: Request,
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

  // L4: reject malformed refs before hitting the DB.
  const bad = assertValidRef(ref)
  if (bad) return bad

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
        { headers: corsHeaders },
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
        { headers: corsHeaders },
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
      let backend: ProjectBackend
      try {
        backend = await getProjectBackend(ref, pool)
      } catch (err) {
        if (err instanceof ProjectBackendNotProvisionedError) {
          // M6: this one dispatcher INTENTIONALLY diverges from the
          // canonical 501 `notProvisionedResponse`. Studio's "Generate
          // types" button hits this path on every project load; a 501
          // would surface as an error toast even though the user didn't
          // ask to regenerate. Returning the empty-schema fallback keeps
          // the UX quiet while preserving the contract — operators who
          // need to know the backend is unprovisioned will see 501s from
          // every other route.
          return Response.json({ types: TYPES_FALLBACK }, { headers: corsHeaders })
        }
        throw err
      }
      return proxyTypescriptTypes(req, backend)
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
// `/generators/typescript` endpoint on this project's backend (resolved via
// `backend.pgMetaUrl`), preserving all query params (e.g. `included_schemas`,
// `excluded_schemas`). Uses the shared `fetchProjectUrl` helper so
// Authorization + apikey + JSON Content-Type are signed identically to
// every other per-project outbound call in the dispatcher (L3). Any
// failure — non-2xx, network error, timeout, or missing endpoint —
// swallows to a static `{ types }` fallback so the Studio "Generate
// types" button never surfaces a 5xx.
async function proxyTypescriptTypes(req: Request, backend: ProjectBackend): Promise<Response> {
  if (!backend.pgMetaUrl) {
    return Response.json({ types: TYPES_FALLBACK }, { headers: corsHeaders })
  }

  const incoming = new URL(req.url)
  let target: URL
  try {
    target = new URL(`${backend.pgMetaUrl.replace(/\/$/, '')}/generators/typescript`)
  } catch (err) {
    console.error('pg-meta URL construction failed:', err)
    return Response.json({ types: TYPES_FALLBACK }, { headers: corsHeaders })
  }
  for (const [key, value] of incoming.searchParams.entries()) {
    target.searchParams.set(key, value)
  }

  try {
    const res = await fetchProjectUrl(backend, target.toString(), {
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
