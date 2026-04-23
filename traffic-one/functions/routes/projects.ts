import type { Pool } from 'https://deno.land/x/postgres@v0.17.0/mod.ts'

import { corsHeaders } from '../index.ts'
import {
  FUNCTIONS_DIR,
  parseFunctionDir,
  type FunctionEntry,
} from '../services/edge-functions.service.ts'
import {
  createProject,
  deleteProject,
  getProjectByRef,
  getProjectStatus,
  listProjectsPaginated,
  setProjectStatus,
  transferProject,
  transferProjectPreview,
  updateProject,
} from '../services/project.service.ts'
import { ProvisionerNotConfiguredError } from '../services/provisioners/api.provisioner.ts'
import { getClientIp } from '../utils/client-ip.ts'
import { handleProjectBilling } from './billing.ts'
import { handleProjectBranches } from './branches.ts'
import { handleContent } from './content.ts'
import { handleCustomHostname } from './custom-hostname.ts'
import { handleEdgeFunctionMutations } from './edge-function-mutations.ts'
import { handleJit } from './jit.ts'
import { handleProjectAnalytics } from './project-analytics.ts'
import { handleProjectApiKeys } from './project-api-keys.ts'
import { handleProjectAuth } from './project-auth.ts'
import { handleProjectConfig } from './project-config.ts'
import { handleAvailableRegions, handleProjectDisk } from './project-disk.ts'
import { handleProjectLifecycle } from './project-lifecycle.ts'
import { handleProjectNetwork } from './project-network.ts'

export async function handleProjects(
  req: Request,
  path: string,
  method: string,
  pool: Pool,
  profileId: number,
  gotrueId: string,
  email: string
): Promise<Response> {
  const ip = getClientIp(req)
  const auditContext = { email, ip, method, route: '/projects' + path }

  // POST /projects — create project
  if (method === 'POST' && path === '/') {
    const body = await req.json()
    if (!body.name || !body.organization_slug) {
      return Response.json(
        { message: 'name and organization_slug are required' },
        { status: 400, headers: corsHeaders }
      )
    }
    try {
      const project = await createProject(pool, profileId, gotrueId, body, auditContext)
      if (!project) {
        return Response.json(
          { message: 'Organization not found or not a member' },
          { status: 404, headers: corsHeaders }
        )
      }
      return Response.json(project, { status: 201, headers: corsHeaders })
    } catch (err) {
      // M4: when PROJECT_PROVISIONER=api but PROVISIONER_API_URL is missing,
      // the ApiProvisioner now throws a structured `ProvisionerNotConfiguredError`
      // (was: opaque 500). Surface that as 503 with a machine-readable code so
      // Studio can toast the specific "operator has not configured provisioner"
      // state rather than a generic "something went wrong".
      if (err instanceof ProvisionerNotConfiguredError) {
        return Response.json(
          { code: err.code, message: err.message },
          { status: 503, headers: corsHeaders }
        )
      }
      throw err
    }
  }

  // Delegate billing sub-paths before other matching. `handleProjectBilling`
  // now gates every request on project ownership via `profileId`.
  const billingMatch = path.match(/^\/([^/]+)(\/billing.*)$/)
  if (billingMatch && pool) {
    return handleProjectBilling(req, billingMatch[2], method, pool, billingMatch[1], profileId)
  }

  // ── Wave 3 dispatches ──────────────────────────────────────
  // Non-project-scoped: /available-regions must fire BEFORE refOnlyMatch
  // (otherwise "available-regions" gets treated as a project ref).
  if (path === '/available-regions' || path === '/available-regions/') {
    return handleAvailableRegions(req, method)
  }

  // Bundle E: POST /{ref}/api-keys/temporary → dynamic short-lived JWTs
  if (/^\/[^/]+\/api-keys\/temporary\/?$/.test(path)) {
    return handleProjectApiKeys(req, path, method, pool, profileId, gotrueId, email)
  }

  // Bundle I: project configuration + lint exceptions
  // /{ref}/config/(postgrest|storage|realtime|pgbouncer[/status]|secrets[/update-status])
  // /{ref}/settings/sensitivity
  // /{ref}/db-password
  // /{ref}/notifications/advisor/exceptions
  if (
    /^\/[^/]+\/config\/(postgrest|storage|realtime|pgbouncer(\/status)?|secrets(\/update-status)?)\/?$/.test(
      path
    ) ||
    /^\/[^/]+\/settings\/sensitivity\/?$/.test(path) ||
    /^\/[^/]+\/db-password\/?$/.test(path) ||
    /^\/[^/]+\/notifications\/advisor\/exceptions\/?$/.test(path)
  ) {
    return handleProjectConfig(req, path, method, pool, profileId, gotrueId, email)
  }

  // Bundle J: disk + resize + restore versions
  if (
    /^\/[^/]+\/disk(\/util|\/custom-config)?\/?$/.test(path) ||
    /^\/[^/]+\/resize\/?$/.test(path) ||
    /^\/[^/]+\/restore\/versions\/?$/.test(path)
  ) {
    return handleProjectDisk(req, path, method, pool, profileId)
  }

  // Bundle F: analytics, infra-monitoring, log drains, REST/GraphQL introspection
  if (
    /^\/[^/]+\/infra-monitoring\/?$/.test(path) ||
    /^\/[^/]+\/analytics\/endpoints\/[^/]+\/?$/.test(path) ||
    /^\/[^/]+\/analytics\/log-drains(\/[^/]+)?\/?$/.test(path) ||
    /^\/[^/]+\/api\/(rest|graphql)\/?$/.test(path)
  ) {
    return handleProjectAnalytics(req, path, method, pool, profileId, gotrueId, email)
  }

  // Bundle H: content persistence (SQL snippets + folders)
  if (/^\/[^/]+\/content(\/.*)?$/.test(path)) {
    return handleContent(req, path, method, pool, profileId, gotrueId, email)
  }

  // Bundle K: privatelink (platform surface — v1 network lives in handleProjectHealth)
  if (/^\/[^/]+\/privatelink\/associations(\/aws-account(\/[^/]+)?)?\/?$/.test(path)) {
    return handleProjectNetwork(req, path, method, pool, profileId, gotrueId, email)
  }

  // GET /projects — paginated list
  if (method === 'GET' && path === '/') {
    const url = new URL(req.url)
    const limit = parseInt(url.searchParams.get('limit') || '100', 10)
    const offset = parseInt(url.searchParams.get('offset') || '0', 10)
    const result = await listProjectsPaginated(pool, profileId, limit, offset)
    return Response.json(result, { headers: corsHeaders })
  }

  // GET /projects/{ref} — project detail (must be exact match, not sub-resource)
  const refOnlyMatch = path.match(/^\/([^/]+)$/)
  if (method === 'GET' && refOnlyMatch) {
    const ref = refOnlyMatch[1]
    const project = await getProjectByRef(pool, ref, profileId)
    if (!project) {
      return Response.json({ message: 'Project not found' }, { status: 404, headers: corsHeaders })
    }
    return Response.json(project, { headers: corsHeaders })
  }

  // PATCH /projects/{ref} — update project
  if (method === 'PATCH' && refOnlyMatch) {
    const ref = refOnlyMatch[1]
    const body = await req.json()
    const result = await updateProject(
      pool,
      ref,
      profileId,
      { name: body.name },
      gotrueId,
      auditContext
    )
    if (!result) {
      return Response.json({ message: 'Project not found' }, { status: 404, headers: corsHeaders })
    }
    return Response.json(result, { headers: corsHeaders })
  }

  // DELETE /projects/{ref} — delete project
  if (method === 'DELETE' && refOnlyMatch) {
    const ref = refOnlyMatch[1]
    const result = await deleteProject(pool, ref, profileId, gotrueId, auditContext)
    if (!result) {
      return Response.json({ message: 'Project not found' }, { status: 404, headers: corsHeaders })
    }
    return Response.json(result, { headers: corsHeaders })
  }

  // Sub-resource routes: /{ref}/subpath
  const subMatch = path.match(/^\/([^/]+)(\/.+)$/)
  if (subMatch) {
    const ref = subMatch[1]
    const subPath = subMatch[2]

    // POST /{ref}/pause
    if (method === 'POST' && subPath === '/pause') {
      const result = await setProjectStatus(
        pool,
        ref,
        profileId,
        'INACTIVE',
        gotrueId,
        auditContext
      )
      if (!result) {
        return Response.json(
          { message: 'Project not found' },
          { status: 404, headers: corsHeaders }
        )
      }
      return Response.json(result, { headers: corsHeaders })
    }

    // POST /{ref}/restore
    if (method === 'POST' && subPath === '/restore') {
      const result = await setProjectStatus(
        pool,
        ref,
        profileId,
        'ACTIVE_HEALTHY',
        gotrueId,
        auditContext
      )
      if (!result) {
        return Response.json(
          { message: 'Project not found' },
          { status: 404, headers: corsHeaders }
        )
      }
      return Response.json(result, { headers: corsHeaders })
    }

    // POST /{ref}/restart — no-op
    if (method === 'POST' && subPath === '/restart') {
      return Response.json({ message: 'ok' }, { headers: corsHeaders })
    }

    // POST /{ref}/restart-services — no-op
    if (method === 'POST' && subPath === '/restart-services') {
      return Response.json({ message: 'ok' }, { headers: corsHeaders })
    }

    // POST /{ref}/transfer/preview
    if (method === 'POST' && subPath === '/transfer/preview') {
      const body = await req.json()
      const result = await transferProjectPreview(
        pool,
        ref,
        profileId,
        body.target_organization_slug
      )
      // H6: preview returns `valid: false` for non-members (404) and
      // admin/owner-only forbiddens (403). Map explicitly so Studio sees the
      // right status code and error toast.
      if (result.valid === false && result.forbidden) {
        return Response.json({ message: result.message }, { status: 403, headers: corsHeaders })
      }
      return Response.json(result, { headers: corsHeaders })
    }

    // POST /{ref}/transfer
    if (method === 'POST' && subPath === '/transfer') {
      const body = await req.json()
      const result = await transferProject(
        pool,
        ref,
        profileId,
        body.target_organization_slug,
        gotrueId,
        auditContext
      )
      // H6: only admins and owners (role_id >= 4) may trigger a transfer.
      // Return 403 when the caller is a member without the required role;
      // 400 is reserved for a missing source project / target org.
      if (result.ok === false && result.forbidden) {
        return Response.json(
          { message: 'Only administrators and owners can transfer projects' },
          { status: 403, headers: corsHeaders }
        )
      }
      if (result.ok === false) {
        return Response.json({ message: 'Transfer failed' }, { status: 400, headers: corsHeaders })
      }
      return Response.json(result.project, { headers: corsHeaders })
    }

    // GET-only sub-resources
    if (method === 'GET') {
      // GET /{ref}/status
      if (subPath === '/status') {
        const status = await getProjectStatus(pool, ref, profileId)
        if (!status) {
          return Response.json(
            { message: 'Project not found' },
            { status: 404, headers: corsHeaders }
          )
        }
        return Response.json(status, { headers: corsHeaders })
      }

      // GET /{ref}/pause/status
      if (subPath === '/pause/status') {
        const status = await getProjectStatus(pool, ref, profileId)
        if (!status) {
          return Response.json(
            { message: 'Project not found' },
            { status: 404, headers: corsHeaders }
          )
        }
        return Response.json(status, { headers: corsHeaders })
      }

      // GET /{ref}/service-versions — hardcoded
      if (subPath === '/service-versions') {
        return Response.json({}, { headers: corsHeaders })
      }

      // Static sub-resource stubs for surfaces not yet backed by real handlers.
      // NOTE: /content, /config/(realtime|pgbouncer|storage), /analytics/log-drains,
      // /notifications/advisor/exceptions, /branches, /secrets were removed — they
      // are now handled by dedicated Wave 3 route handlers dispatched above.
      const subResourceStubs: Record<string, unknown> = {
        '/databases': [
          {
            cloud_provider: 'AWS',
            identifier: ref,
            infra_compute_size: 'nano',
            region: 'local',
            status: 'ACTIVE_HEALTHY',
            inserted_at: '2024-01-01T00:00:00Z',
            read_replicas: [],
          },
        ],
        '/databases-statuses': [],
        '/load-balancers': [],
        '/members': [],
        '/run-lints': [],
        '/config/network-bans': { banned_ipv4_addresses: [], banned_ipv6_addresses: [] },
        '/integrations': [],
      }

      // Dynamic: /config/supavisor — return pooler configuration from env vars
      if (subPath === '/config/supavisor') {
        const tenantId = Deno.env.get('POOLER_TENANT_ID') || ref
        const poolSize = parseInt(Deno.env.get('POOLER_DEFAULT_POOL_SIZE') || '20', 10)
        const maxClientConn = parseInt(Deno.env.get('POOLER_MAX_CLIENT_CONN') || '100', 10)
        const txPort = parseInt(Deno.env.get('POOLER_PROXY_PORT_TRANSACTION') || '6543', 10)
        const dbName = Deno.env.get('POSTGRES_DB') || 'postgres'

        const supavisorConfig = [
          {
            connection_string: `postgres://postgres.[${tenantId}]@supabase-pooler:${txPort}/${dbName}`,
            connectionString: `postgres://postgres.[${tenantId}]@supabase-pooler:${txPort}/${dbName}`,
            database_type: 'PRIMARY',
            db_host: 'supabase-pooler',
            db_name: dbName,
            db_port: txPort,
            db_user: `postgres.${tenantId}`,
            default_pool_size: poolSize,
            identifier: ref,
            is_using_scram_auth: false,
            max_client_conn: maxClientConn,
            pool_mode: 'transaction',
          },
        ]
        return Response.json(supavisorConfig, { headers: corsHeaders })
      }

      const stubData = subResourceStubs[subPath]
      if (stubData !== undefined) {
        return Response.json(stubData, { headers: corsHeaders })
      }
    }
  }

  // H4: previously returned `Response.json({})` which silently let Studio
  // destructure `undefined` off unmatched paths (no error toast, no console
  // error — just a broken UI). Returning an explicit 404 matches
  // `handleProjectHealth` and makes misroutes visible.
  return Response.json({ message: 'Not Found' }, { status: 404, headers: corsHeaders })
}

// Handler for /v1/projects/{ref}/* (routed separately via Kong)
export async function handleProjectHealth(
  req: Request,
  path: string,
  method: string,
  pool: Pool,
  profileId: number,
  gotrueId: string,
  email: string
): Promise<Response> {
  // ── Wave 3 v1 dispatches ───────────────────────────────────
  // Bundle E: api-keys CRUD + /api-keys/legacy + JWT signing keys
  if (
    /^\/[^/]+\/api-keys(\/.*)?$/.test(path) ||
    /^\/[^/]+\/config\/auth\/signing-keys(\/.*)?$/.test(path)
  ) {
    return handleProjectApiKeys(req, path, method, pool, profileId, gotrueId, email)
  }

  // Bundle M: third-party auth + SSL enforcement + project secrets (Vault-backed)
  if (
    /^\/[^/]+\/config\/auth\/third-party-auth(\/[^/]+)?\/?$/.test(path) ||
    /^\/[^/]+\/ssl-enforcement\/?$/.test(path) ||
    /^\/[^/]+\/secrets\/?$/.test(path)
  ) {
    return handleProjectAuth(req, path, method, pool, profileId, gotrueId, email)
  }

  // Bundle K: network restrictions + bans + read-replicas (v1 surface)
  if (
    /^\/[^/]+\/network-restrictions(\/apply)?\/?$/.test(path) ||
    /^\/[^/]+\/network-bans(\/retrieve)?\/?$/.test(path) ||
    /^\/[^/]+\/read-replicas\/(setup|remove)\/?$/.test(path)
  ) {
    return handleProjectNetwork(req, path, method, pool, profileId, gotrueId, email)
  }

  // Bundle L: upgrade eligibility/status + TS types + readonly + actions
  if (
    /^\/[^/]+\/upgrade(\/eligibility|\/status)?\/?$/.test(path) ||
    /^\/[^/]+\/types\/typescript\/?$/.test(path) ||
    /^\/[^/]+\/readonly\/temporary-disable\/?$/.test(path) ||
    /^\/[^/]+\/actions(\/[^/]+(\/logs)?)?\/?$/.test(path)
  ) {
    return handleProjectLifecycle(req, path, method, pool, profileId, gotrueId, email)
  }

  // Bundle Q: JIT access policies + grants
  if (/^\/[^/]+\/jit-access\/?$/.test(path) || /^\/[^/]+\/database\/jit(\/.*)?$/.test(path)) {
    return handleJit(req, path, method, pool, profileId, gotrueId, email)
  }

  // Bundle O: branches (replaces the old /{ref}/branches stub)
  if (/^\/[^/]+\/branches\/?$/.test(path)) {
    return handleProjectBranches(req, path, method, pool, profileId, gotrueId, email)
  }

  // Bundle O: custom hostnames
  if (/^\/[^/]+\/custom-hostname(\/initialize|\/activate|\/reverify)?\/?$/.test(path)) {
    return handleCustomHostname(req, path, method, pool, profileId, gotrueId, email)
  }

  // Bundle P: edge function mutations (POST /functions/deploy, PATCH/DELETE /functions/{slug}).
  // GET paths fall through to the existing filesystem-backed handlers below.
  if (
    (method === 'POST' || method === 'PATCH' || method === 'DELETE') &&
    /^\/[^/]+\/functions\/(deploy|[^/]+)\/?$/.test(path)
  ) {
    return handleEdgeFunctionMutations(req, path, method, pool, profileId, gotrueId, email)
  }

  // GET /{ref}/health
  const healthMatch = path.match(/^\/([^/]+)\/health$/)
  if (method === 'GET' && healthMatch) {
    const ref = healthMatch[1]
    const status = await getProjectStatus(pool, ref, profileId)
    if (!status) {
      return Response.json({ message: 'Project not found' }, { status: 404, headers: corsHeaders })
    }

    const healthy = status.status === 'ACTIVE_HEALTHY'
    const svcStatus = healthy ? 'ACTIVE_HEALTHY' : 'UNHEALTHY'

    return Response.json(
      [
        { name: 'auth', status: svcStatus },
        { name: 'rest', status: svcStatus },
        { name: 'realtime', status: svcStatus },
        { name: 'storage', status: svcStatus },
        { name: 'db', status: svcStatus },
      ],
      { headers: corsHeaders }
    )
  }

  // /{ref}/branches is now handled by handleProjectBranches (Bundle O) above.
  // /{ref}/api-keys is now handled by handleProjectApiKeys (Bundle E) above;
  // the legacy env-derived anon/service_role list lives at /{ref}/api-keys/legacy.

  // GET /{ref}/functions — list edge functions from disk
  const functionsListMatch = path.match(/^\/([^/]+)\/functions\/?$/)
  if (method === 'GET' && functionsListMatch) {
    return listEdgeFunctions()
  }

  // GET /{ref}/functions/{slug} — single function detail
  const functionDetailMatch = path.match(/^\/([^/]+)\/functions\/([^/]+)\/?$/)
  if (method === 'GET' && functionDetailMatch) {
    const slug = functionDetailMatch[2]
    return getEdgeFunctionBySlug(slug)
  }

  // GET /{ref}/functions/{slug}/body — function source code
  const functionBodyMatch = path.match(/^\/([^/]+)\/functions\/([^/]+)\/body$/)
  if (method === 'GET' && functionBodyMatch) {
    const slug = functionBodyMatch[2]
    return getEdgeFunctionBody(slug)
  }

  return Response.json({ message: 'Not found' }, { status: 404, headers: corsHeaders })
}

// ── Edge Functions filesystem helpers ──────────────────────
//
// L4: the filesystem scanner (`parseFunctionDir`) and the runtime mount
// path (`FUNCTIONS_DIR`) live in
// `services/edge-functions.service.ts`. We previously carried a second
// copy here and in routes/edge-function-mutations.ts; both are now
// imported from the shared helper so the read and write paths agree on
// entrypoint / metadata resolution.

async function listEdgeFunctions(): Promise<Response> {
  try {
    const functions: FunctionEntry[] = []

    for await (const entry of Deno.readDir(FUNCTIONS_DIR)) {
      if (!entry.isDirectory || entry.name === 'main' || entry.name === 'traffic-one') continue

      const func = await parseFunctionDir(entry.name)
      if (func) functions.push(func)
    }

    return Response.json(functions, { headers: corsHeaders })
  } catch (err) {
    console.error('listEdgeFunctions error:', err)
    return Response.json([], { headers: corsHeaders })
  }
}

async function getEdgeFunctionBySlug(slug: string): Promise<Response> {
  if (slug === 'main' || slug === 'traffic-one') {
    return Response.json({ message: 'Function not found' }, { status: 404, headers: corsHeaders })
  }

  try {
    const func = await parseFunctionDir(slug)
    if (!func) {
      return Response.json({ message: 'Function not found' }, { status: 404, headers: corsHeaders })
    }
    return Response.json(func, { headers: corsHeaders })
  } catch {
    return Response.json({ message: 'Function not found' }, { status: 404, headers: corsHeaders })
  }
}

async function getEdgeFunctionBody(slug: string): Promise<Response> {
  if (slug === 'main' || slug === 'traffic-one') {
    return Response.json({ message: 'Function not found' }, { status: 404, headers: corsHeaders })
  }

  const dirPath = `${FUNCTIONS_DIR}/${slug}`
  try {
    const files: Array<{ name: string; content: string }> = []

    for await (const entry of Deno.readDir(dirPath)) {
      if (!entry.isFile) continue
      const content = await Deno.readTextFile(`${dirPath}/${entry.name}`)
      files.push({ name: entry.name, content })
    }

    return Response.json(files, { headers: corsHeaders })
  } catch {
    return Response.json({ message: 'Function not found' }, { status: 404, headers: corsHeaders })
  }
}
