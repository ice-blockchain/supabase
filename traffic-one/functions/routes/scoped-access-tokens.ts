import type { Pool } from 'https://deno.land/x/postgres@v0.17.0/mod.ts'

import { corsHeaders } from '../index.ts'
import {
  createScopedAccessToken,
  deleteScopedAccessToken,
  listScopedAccessTokens,
} from '../services/access-token.service.ts'
import { getClientIp } from '../utils/client-ip.ts'

export async function handleScopedAccessTokens(
  req: Request,
  path: string,
  method: string,
  pool: Pool,
  gotrueId: string,
  email: string,
  profileId: number
): Promise<Response> {
  const ip = getClientIp(req)
  const auditContext = { email, ip, method, route: '/profile' + path }

  if (method === 'GET' && path === '/scoped-access-tokens') {
    const tokens = await listScopedAccessTokens(pool, profileId)
    return Response.json(tokens, { headers: corsHeaders })
  }

  if (method === 'POST' && path === '/scoped-access-tokens') {
    const body = await req.json().catch(() => ({}))
    if (!body.name || !body.permissions) {
      return Response.json(
        { message: 'name and permissions are required' },
        { status: 400, headers: corsHeaders }
      )
    }
    const token = await createScopedAccessToken(pool, profileId, body, gotrueId, auditContext)
    return Response.json(token, { status: 201, headers: corsHeaders })
  }

  const deleteMatch = path.match(/^\/scoped-access-tokens\/([a-f0-9-]+)$/i)
  if (method === 'DELETE' && deleteMatch) {
    const tokenId = deleteMatch[1]
    const deleted = await deleteScopedAccessToken(pool, profileId, tokenId, gotrueId, auditContext)
    if (!deleted) {
      return Response.json({ message: 'Token not found' }, { status: 404, headers: corsHeaders })
    }
    return Response.json({ message: 'Token deleted' }, { headers: corsHeaders })
  }

  return Response.json(
    { message: 'Method not allowed' },
    {
      status: 405,
      headers: corsHeaders,
    }
  )
}
