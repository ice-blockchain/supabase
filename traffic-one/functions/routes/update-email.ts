import type { Pool } from 'https://deno.land/x/postgres@v0.17.0/mod.ts'
import { createClient } from 'npm:@supabase/supabase-js@2'

import { corsHeaders } from '../index.ts'
import { updatePrimaryEmail } from '../services/profile.service.ts'
import { getClientIp } from '../utils/client-ip.ts'

const EMAIL_REGEX = /^[^\s@]+@[^\s@]+\.[^\s@]+$/

export async function handleUpdateEmail(
  req: Request,
  method: string,
  pool: Pool,
  gotrueId: string,
  email: string,
  _profileId: number
): Promise<Response> {
  if (method !== 'PUT') {
    return Response.json(
      { message: 'Method not allowed' },
      {
        status: 405,
        headers: corsHeaders,
      }
    )
  }

  const body = await req.json().catch(() => ({}))
  const newEmail: unknown = body?.newEmail

  if (typeof newEmail !== 'string' || !EMAIL_REGEX.test(newEmail)) {
    return Response.json(
      { message: 'Invalid email' },
      {
        status: 400,
        headers: corsHeaders,
      }
    )
  }

  const supabaseUrl = Deno.env.get('SUPABASE_URL')
  const serviceKey =
    Deno.env.get('SUPABASE_SERVICE_ROLE_KEY') ?? Deno.env.get('SUPABASE_SERVICE_KEY')

  if (!supabaseUrl || !serviceKey) {
    return Response.json(
      { message: 'Server misconfigured: missing SUPABASE_SERVICE_ROLE_KEY' },
      { status: 500, headers: corsHeaders }
    )
  }

  const admin = createClient(supabaseUrl, serviceKey, {
    auth: {
      autoRefreshToken: false,
      persistSession: false,
      detectSessionInUrl: false,
    },
  })

  const { error } = await admin.auth.admin.updateUserById(gotrueId, {
    email: newEmail,
  })

  if (error) {
    return Response.json(
      { message: error.message },
      {
        status: error.status ?? 500,
        headers: corsHeaders,
      }
    )
  }

  const ip = getClientIp(req)

  const profile = await updatePrimaryEmail(pool, gotrueId, newEmail, {
    email,
    ip,
    method,
    route: '/update-email',
  })

  return Response.json(profile, { headers: corsHeaders })
}
