import type { Pool } from 'https://deno.land/x/postgres@v0.17.0/mod.ts'

import { corsHeaders } from '../index.ts'
import { applyConfigPatch, getMergedConfig } from '../services/gotrue-admin.service.ts'
import { getProjectByRef } from '../services/project.service.ts'
import { getClientIp } from '../utils/client-ip.ts'

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
  email: string
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
      }
    )
  }

  const ref = match[1]

  const project = await getProjectByRef(pool, ref, profileId)
  if (!project) {
    return Response.json(
      { message: 'Project not found' },
      {
        status: 404,
        headers: corsHeaders,
      }
    )
  }

  const auditContext = { email, ip, method, route: '/auth' + path }

  if (method === 'GET' && configMatch) {
    const merged = await getMergedConfig(pool, ref)
    return Response.json(merged, { headers: corsHeaders })
  }

  if (method === 'PATCH' && (configMatch || hooksMatch)) {
    const body = await req.json().catch(() => ({}))
    if (body && typeof body === 'object' && !Array.isArray(body)) {
      await applyConfigPatch(
        pool,
        ref,
        body as Record<string, unknown>,
        gotrueId,
        profileId,
        auditContext
      )
    }
    const merged = await getMergedConfig(pool, ref)
    return Response.json(merged, { headers: corsHeaders })
  }

  return Response.json(
    { message: 'Method not allowed' },
    {
      status: 405,
      headers: corsHeaders,
    }
  )
}
