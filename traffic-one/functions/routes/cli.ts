import type { Pool } from 'https://deno.land/x/postgres@v0.19.3/mod.ts'

import { corsHeaders } from '../index.ts'
import { createScopedAccessToken } from '../services/access-token.service.ts'
import { getClientIp } from '../utils/client-ip.ts'

const DEFAULT_CLI_PERMISSIONS = [
  'organizations_read',
  'projects_read',
  'organization_admin_read',
  'project_admin_read',
]

function pickString(body: Record<string, unknown>, ...keys: string[]): string | undefined {
  for (const key of keys) {
    const value = body[key]
    if (typeof value === 'string' && value.length > 0) return value
  }
  return undefined
}

export async function handleCli(
  req: Request,
  path: string,
  method: string,
  pool: Pool,
  profileId: number,
  gotrueId: string,
  email: string,
): Promise<Response> {
  if (method === 'POST' && path === '/login') {
    const body = (await req.json().catch(() => ({}))) as Record<string, unknown>

    const ip = getClientIp(req)
    const auditContext = { email, ip, method, route: '/cli' + path }

    const name = pickString(body, 'token_name', 'name') ?? `cli-${Date.now()}`
    const expiresAt = pickString(body, 'expires_at')

    const token = await createScopedAccessToken(
      pool,
      profileId,
      {
        name,
        permissions: DEFAULT_CLI_PERMISSIONS,
        expires_at: expiresAt,
      },
      gotrueId,
      auditContext,
    )

    return Response.json(token, { status: 201, headers: corsHeaders })
  }

  return Response.json({ message: 'Method not allowed' }, { status: 405, headers: corsHeaders })
}
