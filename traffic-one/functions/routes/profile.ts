import type { Pool } from 'https://deno.land/x/postgres@v0.19.3/mod.ts'

import { corsHeaders } from '../index.ts'
import { getOrCreateProfile, updateProfile } from '../services/profile.service.ts'
import { getClientIp } from '../utils/client-ip.ts'

export async function handleProfile(
  req: Request,
  path: string,
  method: string,
  pool: Pool,
  gotrueId: string,
  email: string,
): Promise<Response> {
  if (method === 'GET' && (path === '/' || path === '')) {
    const profile = await getOrCreateProfile(pool, gotrueId, email)
    return Response.json(profile, { headers: corsHeaders })
  }

  if (method === 'PUT' && (path === '/' || path === '/update')) {
    const body = await req.json().catch(() => ({}))
    const ip = getClientIp(req)
    const profile = await updateProfile(pool, gotrueId, body, {
      email,
      ip,
      method,
      route: '/profile' + path,
    })
    return Response.json(profile, { headers: corsHeaders })
  }

  if (method === 'PATCH' && (path === '/' || path === '')) {
    const body = await req.json().catch(() => ({}))
    const ip = getClientIp(req)
    const profile = await updateProfile(pool, gotrueId, body, {
      email,
      ip,
      method,
      route: '/profile',
    })
    return Response.json(profile, { headers: corsHeaders })
  }

  if (method === 'POST' && (path === '/' || path === '')) {
    const profile = await getOrCreateProfile(pool, gotrueId, email)
    return Response.json(profile, { headers: corsHeaders })
  }

  return Response.json(
    { message: 'Method not allowed' },
    {
      status: 405,
      headers: corsHeaders,
    },
  )
}
