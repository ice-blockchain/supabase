import { createClient } from 'npm:@supabase/supabase-js@2'

import { pool } from './db.ts'
import { handleAccessTokens } from './routes/access-tokens.ts'
import { handleAudit } from './routes/audit.ts'
import { handleAuthConfig } from './routes/auth-config.ts'
import { handleResetPassword, handleSignup } from './routes/auth.ts'
import { handleBackups } from './routes/backups.ts'
import { handleConfirmSubscription, handleStripe } from './routes/billing.ts'
import { handleBranchById } from './routes/branches.ts'
import { handleCli } from './routes/cli.ts'
import { handleDatabaseMigrations } from './routes/database-migrations.ts'
import { handleFeedback } from './routes/feedback.ts'
import { handleNotifications } from './routes/notifications.ts'
import { handleOrganizations, handleV1Organizations } from './routes/organizations.ts'
import { handlePermissions } from './routes/permissions.ts'
import { handleProfile } from './routes/profile.ts'
import { handleProjectHealth, handleProjects } from './routes/projects.ts'
import { handleReplication } from './routes/replication.ts'
import { handleScopedAccessTokens } from './routes/scoped-access-tokens.ts'
import { handleUpdateEmail } from './routes/update-email.ts'
import { getOrCreateProfile } from './services/profile.service.ts'

export const corsHeaders = {
  'Access-Control-Allow-Origin': '*',
  'Access-Control-Allow-Headers': 'authorization, x-client-info, apikey, content-type',
}

const supabaseUrl = Deno.env.get('SUPABASE_URL')!
const supabaseAnonKey = Deno.env.get('SUPABASE_ANON_KEY')!

const supabase = createClient(supabaseUrl, supabaseAnonKey, {
  auth: { autoRefreshToken: false, persistSession: false, detectSessionInUrl: false },
})

Deno.serve(async (req: Request) => {
  if (req.method === 'OPTIONS') {
    return new Response('ok', { headers: corsHeaders })
  }

  const url = new URL(req.url)
  const path = url.pathname.replace(/^\/traffic-one/, '') || '/'
  const method = req.method

  // Unauthenticated routes (public, like GoTrue itself)
  if (path === '/signup' && method === 'POST') {
    return handleSignup(req, supabase)
  }
  if (path === '/reset-password' && method === 'POST') {
    return handleResetPassword(req, supabase)
  }

  // Telemetry endpoints are anon-friendly in Studio (signed-out users also fire PostHog events).
  // Keep them PUBLIC and return shape-correct no-op responses; we don't forward to PostHog from here.
  if (path.startsWith('/telemetry')) {
    // /telemetry/feature-flags -> Studio reads this as a flag map; must stay {}.
    // /telemetry/event | /telemetry/identify | /telemetry/reset -> { success: true }.
    if (path.startsWith('/telemetry/feature-flags')) {
      return Response.json({}, { headers: corsHeaders })
    }
    return Response.json({ success: true }, { headers: corsHeaders })
  }

  const authHeader = req.headers.get('Authorization')
  if (!authHeader) {
    return Response.json(
      { msg: 'Missing authorization' },
      {
        status: 401,
        headers: corsHeaders,
      }
    )
  }

  const token = authHeader.replace('Bearer ', '')

  let gotrueId: string
  let email: string

  try {
    const {
      data: { user },
      error,
    } = await supabase.auth.getUser(token)
    if (error || !user) {
      return Response.json({ msg: 'Invalid JWT' }, { status: 401, headers: corsHeaders })
    }
    gotrueId = user.id
    email = user.email ?? ''
  } catch {
    return Response.json({ msg: 'Invalid JWT' }, { status: 401, headers: corsHeaders })
  }

  try {
    const profile = await getOrCreateProfile(pool, gotrueId, email)
    const profileId = profile.id

    if (path === '/' || path === '/update') {
      return handleProfile(req, path, method, pool, gotrueId, email)
    }

    if (path === '/update-email' && method === 'PUT') {
      return handleUpdateEmail(req, method, pool, gotrueId, email, profileId)
    }

    if (path.startsWith('/access-tokens')) {
      return handleAccessTokens(req, path, method, pool, gotrueId, email, profileId)
    }

    if (path.startsWith('/scoped-access-tokens')) {
      return handleScopedAccessTokens(req, path, method, pool, gotrueId, email, profileId)
    }

    if (path.startsWith('/notifications')) {
      return handleNotifications(req, path, method, pool, gotrueId, email, profileId)
    }

    if (path === '/permissions') {
      return handlePermissions(req, path, method, pool, profileId)
    }

    if (path === '/organizations/confirm-subscription' && method === 'POST') {
      return handleConfirmSubscription(req, method)
    }

    if (path.startsWith('/organizations')) {
      const orgPath = path.replace(/^\/organizations/, '') || '/'
      return handleOrganizations(req, orgPath, method, pool, profileId, gotrueId, email)
    }

    if (path === '/api/platform/auth' || path.startsWith('/api/platform/auth/')) {
      const authPath = path.replace(/^\/api\/platform\/auth/, '') || '/'
      return handleAuthConfig(req, authPath, method, pool, profileId, gotrueId, email)
    }

    if (path.startsWith('/stripe')) {
      const stripePath = path.replace(/^\/stripe/, '') || '/'
      return handleStripe(req, stripePath, method)
    }

    if (path === '/projects-resource-warnings') {
      return Response.json([], { headers: corsHeaders })
    }

    if (path === '/database' || path.startsWith('/database/')) {
      const dbPath = path.replace(/^\/database/, '') || '/'
      return handleBackups(req, dbPath, method, pool, profileId, gotrueId, email)
    }

    if (path === '/replication' || path.startsWith('/replication/')) {
      const replPath = path.replace(/^\/replication/, '') || '/'
      return handleReplication(req, replPath, method, pool, profileId, gotrueId, email)
    }

    if (path.startsWith('/projects')) {
      const projectPath = path.replace(/^\/projects/, '') || '/'
      return handleProjects(req, projectPath, method, pool, profileId, gotrueId, email)
    }

    if (path.startsWith('/v1-projects')) {
      const v1Path = path.replace(/^\/v1-projects/, '') || '/'
      // Intercept /{ref}/database/migrations before handleProjectHealth (Wave 1: projects.ts untouched).
      const dbMigrationsMatch = v1Path.match(/^\/([^/]+)\/database\/migrations\/?$/)
      if (dbMigrationsMatch) {
        return handleDatabaseMigrations(req, v1Path, method, pool, profileId, gotrueId, email)
      }
      return handleProjectHealth(req, v1Path, method, pool, profileId, gotrueId, email)
    }

    if (path.startsWith('/v1-organizations')) {
      const v1OrgPath = path.replace(/^\/v1-organizations/, '') || '/'
      return handleV1Organizations(req, v1OrgPath, method, pool, profileId)
    }

    // Wave 3 Bundle O: /api/v1/branches/{id}/* is not project-scoped, so it arrives
    // under its own Kong route → stripped to /v1-branches/{id}/*.
    if (path.startsWith('/v1-branches')) {
      const branchPath = path.replace(/^\/v1-branches/, '') || '/'
      return handleBranchById(req, branchPath, method, pool, profileId, gotrueId, email)
    }

    if (path === '/profile/audit-log') {
      return handleAudit(req, '/audit', method, pool, gotrueId, email, profileId)
    }

    if (path === '/audit' || path === '/audit-login') {
      return handleAudit(req, path, method, pool, gotrueId, email, profileId)
    }

    if (path.startsWith('/feedback')) {
      const fbPath = path.replace(/^\/feedback/, '') || '/'
      return handleFeedback(req, fbPath, method, pool, profileId, gotrueId, email)
    }

    if (path.startsWith('/cli')) {
      const cliPath = path.replace(/^\/cli/, '') || '/'
      return handleCli(req, cliPath, method, pool, profileId, gotrueId, email)
    }

    return Response.json(
      { message: 'Not Found' },
      {
        status: 404,
        headers: corsHeaders,
      }
    )
  } catch (err) {
    console.error('traffic-one error:', err)
    return Response.json(
      { message: 'Internal Server Error' },
      { status: 500, headers: corsHeaders }
    )
  }
})
