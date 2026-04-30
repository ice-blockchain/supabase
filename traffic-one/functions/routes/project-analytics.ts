import type { Pool } from 'https://deno.land/x/postgres@v0.19.3/mod.ts'

import { corsHeaders } from '../index.ts'
import {
  createLogDrain,
  deleteLogDrain,
  getLogDrain,
  listLogDrainResponses,
  toBackendResponse,
  updateLogDrain,
} from '../services/log-drains.service.ts'
import { queryEndpoint } from '../services/logflare.client.ts'
import {
  fetchProjectJson,
  getProjectBackend,
  type ProjectBackend,
  ProjectBackendNotProvisionedError,
} from '../services/project-backend.service.ts'
import { getProjectByRef } from '../services/project.service.ts'
import { MAX_BODY_ANALYTICS, readBodyWithLimit } from '../utils/body-limits.ts'
import { getClientIp } from '../utils/client-ip.ts'
import { notProvisionedResponse } from '../utils/project-backend-response.ts'
import { assertValidRef } from '../utils/ref-validation.ts'

// M11: small wrapper so every POST/PATCH handler below can share a single
// body-size limit and failure path. Returns either parsed JSON, `undefined`
// (empty / malformed body — matches the old `.catch(() => undefined)`
// semantics used throughout this module), OR a pre-built 413 Response when
// the caller exceeds `MAX_BODY_ANALYTICS`. Call-sites branch on
// `instanceof Response` and `return` immediately on 413 to avoid auditing
// or calling upstream.
async function readAnalyticsBody(req: Request): Promise<unknown | Response> {
  let text: string
  try {
    text = await readBodyWithLimit(req, MAX_BODY_ANALYTICS)
  } catch (tooLarge) {
    if (tooLarge instanceof Response) return tooLarge
    return undefined
  }
  if (!text) return undefined
  try {
    return JSON.parse(text)
  } catch {
    return undefined
  }
}

// ── Response helpers ──────────────────────────────────────

function jsonResponse(body: unknown, status = 200): Response {
  return Response.json(body, { status, headers: corsHeaders })
}

function notFoundResponse(message = 'Not Found'): Response {
  return jsonResponse({ message }, 404)
}

function methodNotAllowedResponse(): Response {
  return jsonResponse({ message: 'Method not allowed' }, 405)
}

function invalidBodyResponse(message = 'Invalid request body'): Response {
  return jsonResponse({ message }, 400)
}

// ── Infra-monitoring ──────────────────────────────────────

/**
 * All attribute keys accepted by the Studio API (mirrors
 * `InfraMonitoringController_getUsageMetrics` in packages/api-types). Keeping
 * this list in sync ensures `response.series?.[attr]` is always defined for any
 * attribute the UI requests, so the "Cannot read properties of undefined
 * (reading 'map')" crash in `useInfraMonitoringQueries` cannot surface.
 */
const INFRA_MONITORING_ATTRIBUTES = [
  'cpu_usage',
  'cpu_usage_busy_system',
  'cpu_usage_busy_user',
  'cpu_usage_busy_iowait',
  'cpu_usage_busy_irqs',
  'cpu_usage_busy_other',
  'cpu_usage_busy_idle',
  'max_cpu_usage',
  'avg_cpu_usage',
  'ram_usage',
  'ram_usage_total',
  'ram_usage_available',
  'ram_usage_used',
  'ram_usage_free',
  'ram_usage_cache_and_buffers',
  'ram_usage_swap',
  'swap_usage',
  'client_connections_pgbouncer',
  'network_receive_bytes',
  'network_transmit_bytes',
  'pgbouncer_pools_client_active_connections',
  'supavisor_connections_active',
  'client_connections_postgres',
  'client_connections_authenticator',
  'client_connections_supabase_auth_admin',
  'client_connections_supabase_storage_admin',
  'client_connections_supabase_admin',
  'client_connections_other',
  'realtime_connections_connected',
  'realtime_channel_joins',
  'realtime_channel_events',
  'realtime_channel_presence_events',
  'realtime_channel_db_events',
  'realtime_authorization_rls_execution_time',
  'realtime_read_authorization_rls_execution_time',
  'realtime_write_authorization_rls_execution_time',
  'realtime_payload_size',
  'realtime_replication_connection_lag',
  'realtime_sum_connections_connected',
  'disk_io_budget',
  'disk_io_consumption',
  'disk_io_usage',
  'disk_iops_read',
  'disk_iops_write',
  'disk_bytes_read',
  'disk_bytes_written',
  'pg_database_size',
  'disk_fs_size',
  'disk_fs_avail',
  'disk_fs_used',
  'disk_fs_used_wal',
  'disk_fs_used_system',
  'physical_replication_lag_physical_replication_lag_seconds',
  'pg_stat_database_num_backends',
  'max_db_connections',
] as const

function buildInfraMonitoringResponse(): {
  data: { period_start: string; values: Record<string, string | undefined> }[]
  series: Record<
    string,
    { yAxisLimit: number; format: string; total: number; totalAverage: number }
  >
} {
  const series: Record<
    string,
    { yAxisLimit: number; format: string; total: number; totalAverage: number }
  > = {}
  for (const attribute of INFRA_MONITORING_ATTRIBUTES) {
    series[attribute] = {
      yAxisLimit: 100,
      format: '',
      total: 0,
      totalAverage: 0,
    }
  }
  return { data: [], series }
}

// ── Logflare endpoint proxy ───────────────────────────────

async function handleAnalyticsEndpoint(
  req: Request,
  backend: ProjectBackend,
  endpointName: string,
  method: string,
): Promise<Response> {
  const url = new URL(req.url)
  const params: Record<string, string | undefined> = {}
  for (const [key, value] of url.searchParams.entries()) {
    params[key] = value
  }

  let body: unknown
  if (method === 'POST') {
    const parsed = await readAnalyticsBody(req)
    if (parsed instanceof Response) return parsed
    body = parsed
    if (body && typeof body === 'object') {
      for (const [key, value] of Object.entries(body as Record<string, unknown>)) {
        if (typeof value === 'string' && value.length > 0 && params[key] === undefined) {
          params[key] = value
        }
      }
    }
  }

  const { result } = await queryEndpoint(
    backend,
    endpointName,
    params,
    body,
    method === 'POST' ? 'POST' : 'GET',
  )
  return jsonResponse({ result }, 200)
}

// ── REST OpenAPI proxy ────────────────────────────────────

const EMPTY_OPENAPI_SPEC = { openapi: '3.0.0', info: {}, paths: {} }

async function handleRestSpec(backend: ProjectBackend): Promise<Response> {
  if (!backend.endpoint) return jsonResponse(EMPTY_OPENAPI_SPEC, 200)

  // M8: PostgREST's `/rest/v1/` OpenAPI document enumerates every
  // table, view, and RPC the JWT's role can see. `fetchProjectJson` by
  // default signs with `backend.serviceKey`, which would leak
  // service_role-only schemas into Studio's "Docs" tab. The docs tab
  // targets developers who are writing client-side code against the
  // anon key, so the spec should reflect the anon role's view of the
  // API — i.e. only the public schema + RLS-visible columns. We pin
  // Authorization + apikey to `backend.anonKey` explicitly (and fall
  // back to an empty spec if the resolver never populated an anon key,
  // e.g. per-project mode where anon_key is NULL).
  if (!backend.anonKey) return jsonResponse(EMPTY_OPENAPI_SPEC, 200)

  try {
    const res = await fetchProjectJson(backend, '/rest/v1/', {
      method: 'GET',
      headers: {
        Accept: 'application/openapi+json,application/json',
        Authorization: `Bearer ${backend.anonKey}`,
        apikey: backend.anonKey,
      },
    })
    if (!res.ok) {
      const text = await res.text().catch(() => '')
      console.error(`PostgREST spec fetch ${res.status}: ${text.slice(0, 200)}`)
      return jsonResponse(EMPTY_OPENAPI_SPEC, 200)
    }
    const spec = await res.json().catch(() => null)
    if (!spec || typeof spec !== 'object') return jsonResponse(EMPTY_OPENAPI_SPEC, 200)
    return jsonResponse(spec, 200)
  } catch (err) {
    console.error('PostgREST spec fetch failed:', err)
    return jsonResponse(EMPTY_OPENAPI_SPEC, 200)
  }
}

// ── GraphQL introspection proxy ───────────────────────────

const EMPTY_GRAPHQL_RESPONSE = { data: { __schema: { types: [] } } }

const GRAPHQL_INTROSPECTION_QUERY = `query IntrospectionQuery {
  __schema {
    queryType { name }
    mutationType { name }
    subscriptionType { name }
    types { ...FullType }
    directives { name description locations args { ...InputValue } }
  }
}
fragment FullType on __Type {
  kind name description
  fields(includeDeprecated: true) { name description args { ...InputValue } type { ...TypeRef } isDeprecated deprecationReason }
  inputFields { ...InputValue }
  interfaces { ...TypeRef }
  enumValues(includeDeprecated: true) { name description isDeprecated deprecationReason }
  possibleTypes { ...TypeRef }
}
fragment InputValue on __InputValue { name description type { ...TypeRef } defaultValue }
fragment TypeRef on __Type { kind name ofType { kind name ofType { kind name ofType { kind name ofType { kind name ofType { kind name ofType { kind name ofType { kind name } } } } } } } }`

async function handleGraphqlProxy(
  req: Request,
  backend: ProjectBackend,
  method: string,
): Promise<Response> {
  if (!backend.endpoint) return jsonResponse(EMPTY_GRAPHQL_RESPONSE, 200)

  let body: unknown = undefined
  if (method === 'POST') {
    const parsed = await readAnalyticsBody(req)
    if (parsed instanceof Response) return parsed
    body = parsed
  }
  if (body === undefined || body === null) {
    body = { query: GRAPHQL_INTROSPECTION_QUERY }
  }

  // pg_graphql anon-role introspection: use the anon key when Studio doesn't
  // forward an x-graphql-authorization header. Studio proxies the admin token
  // through that header when users run authenticated queries from the GraphiQL
  // editor.
  const forwardedAuth = req.headers.get('x-graphql-authorization') ?? undefined
  const authHeader = forwardedAuth ?? `Bearer ${backend.anonKey}`

  try {
    const res = await fetchProjectJson(backend, '/graphql/v1', {
      method: 'POST',
      headers: { Authorization: authHeader },
      body: JSON.stringify(body),
    })
    if (!res.ok) {
      const text = await res.text().catch(() => '')
      console.error(`GraphQL introspection ${res.status}: ${text.slice(0, 200)}`)
      return jsonResponse(EMPTY_GRAPHQL_RESPONSE, 200)
    }
    const data = await res.json().catch(() => null)
    if (!data || typeof data !== 'object') {
      return jsonResponse(EMPTY_GRAPHQL_RESPONSE, 200)
    }
    return jsonResponse(data, 200)
  } catch (err) {
    console.error('GraphQL introspection fetch failed:', err)
    return jsonResponse(EMPTY_GRAPHQL_RESPONSE, 200)
  }
}

// ── Log drain CRUD ────────────────────────────────────────

async function handleLogDrainList(
  pool: Pool,
  projectRef: string,
  profileId: number,
): Promise<Response> {
  const drains = await listLogDrainResponses(pool, projectRef, profileId)
  return jsonResponse(drains, 200)
}

async function handleLogDrainCreate(
  req: Request,
  pool: Pool,
  projectRef: string,
  profileId: number,
  gotrueId: string,
  organizationId: number,
  auditContext: { email: string; ip: string; method: string; route: string },
): Promise<Response> {
  const parsed = await readAnalyticsBody(req)
  if (parsed instanceof Response) return parsed
  if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) {
    return invalidBodyResponse('Body must be valid JSON')
  }
  const body = parsed as Record<string, unknown>

  const name = typeof body.name === 'string' ? body.name : ''
  const type = typeof body.type === 'string' ? body.type : ''
  const description = typeof body.description === 'string' ? body.description : ''
  const config = body.config && typeof body.config === 'object' && !Array.isArray(body.config)
    ? (body.config as Record<string, unknown>)
    : {}
  const filters = Array.isArray(body.filters) ? (body.filters as unknown[]) : []

  if (!name.trim()) return invalidBodyResponse('name is required')
  if (!type.trim()) return invalidBodyResponse('type is required')

  const outcome = await createLogDrain(
    pool,
    projectRef,
    profileId,
    { name, description, type, config, filters },
    gotrueId,
    organizationId,
    auditContext,
  )
  if (outcome.status === 'conflict') {
    return jsonResponse({ code: 'conflict', message: outcome.message }, 409)
  }
  return jsonResponse(outcome.drain, 201)
}

async function handleLogDrainGet(
  pool: Pool,
  projectRef: string,
  token: string,
  userId: number,
): Promise<Response> {
  const row = await getLogDrain(pool, projectRef, token)
  if (!row) return notFoundResponse('Log drain not found')
  return jsonResponse(toBackendResponse(row, userId), 200)
}

async function handleLogDrainUpdate(
  req: Request,
  pool: Pool,
  projectRef: string,
  token: string,
  userId: number,
  profileId: number,
  organizationId: number,
  gotrueId: string,
  auditContext: Parameters<typeof updateLogDrain>[8],
): Promise<Response> {
  const parsed = await readAnalyticsBody(req)
  if (parsed instanceof Response) return parsed
  if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) {
    return invalidBodyResponse('Body must be valid JSON')
  }
  const body = parsed as Record<string, unknown>

  const patch: Parameters<typeof updateLogDrain>[3] = {}
  if (typeof body.name === 'string') patch.name = body.name
  if (typeof body.description === 'string' || body.description === null) {
    patch.description = body.description as string | null
  }
  if (typeof body.type === 'string') patch.type = body.type
  if (body.config && typeof body.config === 'object' && !Array.isArray(body.config)) {
    patch.config = body.config as Record<string, unknown>
  }
  if (Array.isArray(body.filters)) patch.filters = body.filters as unknown[]
  if (typeof body.active === 'boolean') patch.active = body.active

  const outcome = await updateLogDrain(
    pool,
    projectRef,
    token,
    patch,
    userId,
    profileId,
    organizationId,
    gotrueId,
    auditContext,
  )
  if (outcome.status === 'not_found') return notFoundResponse('Log drain not found')
  if (outcome.status === 'conflict') {
    return jsonResponse({ code: 'conflict', message: outcome.message }, 409)
  }
  return jsonResponse(outcome.drain, 200)
}

async function handleLogDrainDelete(
  pool: Pool,
  projectRef: string,
  token: string,
  profileId: number,
  gotrueId: string,
  organizationId: number,
  auditContext: { email: string; ip: string; method: string; route: string },
): Promise<Response> {
  const row = await deleteLogDrain(
    pool,
    projectRef,
    token,
    profileId,
    gotrueId,
    organizationId,
    auditContext,
  )
  if (!row) return notFoundResponse('Log drain not found')
  return jsonResponse(toBackendResponse(row, profileId), 200)
}

// ── Top-level handler ─────────────────────────────────────

export async function handleProjectAnalytics(
  req: Request,
  path: string,
  method: string,
  pool: Pool,
  profileId: number,
  gotrueId: string,
  email: string,
): Promise<Response> {
  const refMatch = path.match(/^\/([^/]+)(\/.*)$/)
  if (!refMatch) return notFoundResponse()

  const ref = refMatch[1]
  const subPath = refMatch[2]

  // L4: reject malformed refs before hitting the DB.
  const bad = assertValidRef(ref)
  if (bad) return bad

  const project = await getProjectByRef(pool, ref, profileId)
  if (!project) return notFoundResponse('Project not found')

  const ip = getClientIp(req)
  const auditContext = {
    email,
    ip,
    method,
    route: '/platform/projects/' + ref + subPath,
  }

  // ── Infra-monitoring ────────────────────────────────────
  // No backend roundtrip: this is a static shape that Studio uses to populate
  // the empty charts on self-hosted. Short-circuit BEFORE resolving the
  // backend so an un-provisioned project doesn't 501 on every dashboard load.
  if (subPath === '/infra-monitoring') {
    if (method === 'GET') return jsonResponse(buildInfraMonitoringResponse(), 200)
    return methodNotAllowedResponse()
  }

  // Everything below talks to either Logflare, PostgREST, or pg_graphql on
  // the project's own backend — resolve it once and translate the "not
  // provisioned" error into a 501 so Studio can render the empty state.
  let backend: ProjectBackend
  try {
    backend = await getProjectBackend(ref, pool)
  } catch (err) {
    if (err instanceof ProjectBackendNotProvisionedError) {
      return notProvisionedResponse(err)
    }
    throw err
  }

  // ── Analytics endpoints proxy ───────────────────────────
  const endpointMatch = subPath.match(/^\/analytics\/endpoints\/([^/]+)\/?$/)
  if (endpointMatch) {
    const endpointName = endpointMatch[1]
    if (method === 'GET' || method === 'POST') {
      return handleAnalyticsEndpoint(req, backend, endpointName, method)
    }
    return methodNotAllowedResponse()
  }

  // ── REST OpenAPI spec ───────────────────────────────────
  if (subPath === '/api/rest') {
    if (method === 'GET' || method === 'HEAD') return handleRestSpec(backend)
    return methodNotAllowedResponse()
  }

  // ── GraphQL introspection ───────────────────────────────
  if (subPath === '/api/graphql') {
    if (method === 'GET' || method === 'POST') return handleGraphqlProxy(req, backend, method)
    return methodNotAllowedResponse()
  }

  // ── Log drain CRUD ──────────────────────────────────────
  if (subPath === '/analytics/log-drains' || subPath === '/analytics/log-drains/') {
    if (method === 'GET') return handleLogDrainList(pool, ref, profileId)
    if (method === 'POST') {
      return handleLogDrainCreate(
        req,
        pool,
        ref,
        profileId,
        gotrueId,
        project.organization_id,
        auditContext,
      )
    }
    return methodNotAllowedResponse()
  }

  const tokenMatch = subPath.match(/^\/analytics\/log-drains\/([^/]+)\/?$/)
  if (tokenMatch) {
    const token = tokenMatch[1]
    if (method === 'GET') return handleLogDrainGet(pool, ref, token, profileId)
    if (method === 'PUT' || method === 'PATCH') {
      return handleLogDrainUpdate(
        req,
        pool,
        ref,
        token,
        profileId,
        profileId,
        project.organization_id,
        gotrueId,
        auditContext,
      )
    }
    if (method === 'DELETE') {
      return handleLogDrainDelete(
        pool,
        ref,
        token,
        profileId,
        gotrueId,
        project.organization_id,
        auditContext,
      )
    }
    return methodNotAllowedResponse()
  }

  return notFoundResponse()
}
