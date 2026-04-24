import type { Pool } from 'https://deno.land/x/postgres@v0.19.3/mod.ts'

import { corsHeaders } from '../index.ts'
import {
  createAccessToken,
  deleteAccessToken,
  listAccessTokens,
} from '../services/access-token.service.ts'
import { getClientIp } from '../utils/client-ip.ts'

export async function handleAccessTokens(
  req: Request,
  path: string,
  method: string,
  pool: Pool,
  gotrueId: string,
  email: string,
  profileId: number,
): Promise<Response> {
  const ip = getClientIp(req)
  const auditContext = { email, ip, method, route: '/profile' + path }

  if (method === 'GET' && path === '/access-tokens') {
    const tokens = await listAccessTokens(pool, profileId)
    return Response.json(tokens, { headers: corsHeaders })
  }

  if (method === 'POST' && path === '/access-tokens') {
    const body = await req.json().catch(() => ({}))
    if (!body.name) {
      return Response.json({ message: 'name is required' }, { status: 400, headers: corsHeaders })
    }
    const token = await createAccessToken(pool, profileId, body.name, gotrueId, auditContext)
    return Response.json(token, { status: 201, headers: corsHeaders })
  }

  const deleteMatch = path.match(/^\/access-tokens\/(\d+)$/)
  if (method === 'DELETE' && deleteMatch) {
    const tokenId = parseInt(deleteMatch[1], 10)
    const deleted = await deleteAccessToken(pool, profileId, tokenId, gotrueId, auditContext)
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
    },
  )
}
