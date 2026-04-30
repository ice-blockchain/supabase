import type { Pool } from 'https://deno.land/x/postgres@v0.19.3/mod.ts'

import { corsHeaders } from '../index.ts'
import { applyConfigPatch, getMergedConfig } from '../services/gotrue-admin.service.ts'
import {
  getProjectBackend,
  ProjectBackendNotProvisionedError,
} from '../services/project-backend.service.ts'
import { getProjectByRef } from '../services/project.service.ts'
import { getClientIp } from '../utils/client-ip.ts'
import { notProvisionedResponse } from '../utils/project-backend-response.ts'
import { assertValidRef } from '../utils/ref-validation.ts'

// Handles the three endpoints Studio's /auth/* pages call:
//
//   GET   /auth/{ref}/config        -> providers / URL config / hooks pages
//   PATCH /auth/{ref}/config        -> save from any of those pages
//   PATCH /auth/{ref}/config/hooks  -> save from /auth/hooks only
//
// `path` here is the project-scoped tail AFTER the /auth prefix has been
// stripped by index.ts (e.g. `/abcd1234.../config`). `ref` is validated
// against traffic.projects via getProjectByRef to keep cross-project
// access scoped to the caller's org membership.

export async function handleAuthConfig(
  req: Request,
  path: string,
  method: string,
  pool: Pool,
  profileId: number,
  gotrueId: string,
  email: string,
): Promise<Response> {
  const ip = getClientIp(req)

  const configMatch = path.match(/^\/([^/]+)\/config$/)
  const hooksMatch = path.match(/^\/([^/]+)\/config\/hooks$/)
  const match = configMatch ?? hooksMatch

  if (!match) {
    return Response.json(
      { message: 'Not Found' },
      {
        status: 404,
        headers: corsHeaders,
      },
    )
  }

  const ref = match[1]

  // L4: malformed ref → 400 before the DB lookup.
  const bad = assertValidRef(ref)
  if (bad) return bad

  const project = await getProjectByRef(pool, ref, profileId)
  if (!project) {
    return Response.json(
      { message: 'Project not found' },
      {
        status: 404,
        headers: corsHeaders,
      },
    )
  }

  const auditContext = { email, ip, method, route: '/auth' + path }

  let backend
  try {
    backend = await getProjectBackend(ref, pool)
  } catch (err) {
    if (err instanceof ProjectBackendNotProvisionedError) {
      return notProvisionedResponse(err)
    }
    throw err
  }

  if (method === 'GET' && configMatch) {
    const merged = await getMergedConfig(pool, backend)
    return Response.json(merged, { headers: corsHeaders })
  }

  if (method === 'PATCH' && (configMatch || hooksMatch)) {
    // M13: `applyConfigPatch` now fetches `/admin/settings` once and
    // composes the post-push merged view internally. We used to call
    // `getMergedConfig` again right after, which triggered a duplicate
    // GoTrue round-trip (push + settings-fetch + settings-fetch). When
    // the body isn't a usable JSON object we still need a full merge for
    // the response, so we fall through to `getMergedConfig` in that
    // narrow branch — single fetch either way.
    const body = await req.json().catch(() => ({}))
    if (body && typeof body === 'object' && !Array.isArray(body)) {
      const result = await applyConfigPatch(
        pool,
        backend,
        body as Record<string, unknown>,
        gotrueId,
        profileId,
        auditContext,
      )
      return Response.json(result.merged, { headers: corsHeaders })
    }
    const merged = await getMergedConfig(pool, backend)
    return Response.json(merged, { headers: corsHeaders })
  }

  return Response.json(
    { message: 'Method not allowed' },
    {
      status: 405,
      headers: corsHeaders,
    },
  )
}
