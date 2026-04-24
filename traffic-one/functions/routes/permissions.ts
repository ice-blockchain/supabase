import type { Pool } from 'https://deno.land/x/postgres@v0.19.3/mod.ts'

import { corsHeaders } from '../index.ts'
import { getPermissions } from '../services/permission.service.ts'

export async function handlePermissions(
  _req: Request,
  _path: string,
  method: string,
  pool: Pool,
  profileId: number,
): Promise<Response> {
  if (method !== 'GET') {
    return Response.json(
      { message: 'Method not allowed' },
      {
        status: 405,
        headers: corsHeaders,
      },
    )
  }

  const permissions = await getPermissions(pool, profileId)
  return Response.json(permissions, { headers: corsHeaders })
}
