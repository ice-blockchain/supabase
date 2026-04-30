import type { Pool } from 'https://deno.land/x/postgres@v0.19.3/mod.ts'

import { corsHeaders } from '../index.ts'
import {
  type FetchLike,
  fetchProjectUrl,
  getProjectBackend,
  type ProjectBackend,
  ProjectBackendNotProvisionedError,
} from '../services/project-backend.service.ts'
import { getProjectByRef } from '../services/project.service.ts'
import { MAX_BODY_PG_META, readBodyWithLimit } from '../utils/body-limits.ts'
import { getClientIp } from '../utils/client-ip.ts'
import { notProvisionedResponse } from '../utils/project-backend-response.ts'
import { assertValidRef } from '../utils/ref-validation.ts'

// ─────────────────────────────────────────────────────────────────────────────
//
// Project-scoped pg-meta proxy (Phase 4).
//
// Replaces Studio's own `apps/studio/pages/api/platform/pg-meta/[ref]/*` Next
// stubs, which all forward to a single shared `PG_META_URL` derived from env
// vars on the Studio container. That design breaks the moment Studio needs to
// talk to a project whose pg-meta lives on a different host (api-mode, where
// `ApiProvisioner.provision()` returns per-project URLs).
//
// traffic-one's dispatcher now resolves the per-project backend via
// `getProjectBackend(ref)` and forwards every pg-meta surface to
// `${backend.pgMetaUrl}/<surface>` using that project's service_role key as
// both `Authorization: Bearer …` and `apikey: …`.
//
// Routes (incoming path starts at `/{ref}` once index.ts strips the
// `/api/platform/pg-meta` prefix; Kong uses `strip_path: false` so the full
// incoming path reaches traffic-one intact):
//
//   POST  /{ref}/query                 -> POST  {pgMetaUrl}/query     (SQL runner; AUDITED)
//   GET   /{ref}/tables                -> GET   {pgMetaUrl}/tables
//   GET   /{ref}/triggers              -> GET   {pgMetaUrl}/triggers
//   GET   /{ref}/types                 -> GET   {pgMetaUrl}/types
//   GET   /{ref}/policies              -> GET   {pgMetaUrl}/policies
//   GET   /{ref}/extensions            -> GET   {pgMetaUrl}/extensions
//   GET   /{ref}/foreign-tables        -> GET   {pgMetaUrl}/foreign-tables
//   GET   /{ref}/materialized-views    -> GET   {pgMetaUrl}/materialized-views
//   GET   /{ref}/views                 -> GET   {pgMetaUrl}/views
//   GET   /{ref}/column-privileges     -> GET   {pgMetaUrl}/column-privileges
//   GET   /{ref}/publications          -> GET   {pgMetaUrl}/publications
//
// The `/query` surface is the only mutation path and the only one that emits
// an audit row. We deliberately do NOT persist the full SQL text or even a
// 512-char preview: the statement can contain literal secrets
// (`ALTER ROLE ... PASSWORD 'foo'`, `INSERT INTO … VALUES ('<API-token>')`),
// so any textual preview turns the audit log into a passive credential
// store. Instead we record:
//   - byte length of the raw SQL
//   - SHA-256 hex digest of the raw SQL (a stable fingerprint; operators can
//     re-hash a candidate statement to confirm it matches the row)
//   - `disable_statement_timeout` flag (harmless, auditing-relevant)
// Operators with pg-meta's own query log still have the full statement;
// this audit row only has to prove "user X ran *a* query of size Y at time
// T, with fingerprint Z" — which is enough for forensics without the
// secret-leakage risk. See M12.
//
// All surfaces are allow-listed; unknown sub-paths return 404 so traffic-one
// stays crisp when Studio starts probing a surface we haven't wired yet.
//
// ─────────────────────────────────────────────────────────────────────────────

const PG_META_TIMEOUT_MS = 30_000
const ALLOWED_SURFACES = new Set<string>([
  'tables',
  'triggers',
  'types',
  'policies',
  'extensions',
  'foreign-tables',
  'materialized-views',
  'views',
  'column-privileges',
  'publications',
])

// ── Response helpers ────────────────────────────────────────

function jsonResponse(body: unknown, status = 200): Response {
  return Response.json(body, { status, headers: corsHeaders })
}

function methodNotAllowed(): Response {
  return jsonResponse({ message: 'Method not allowed' }, 405)
}

function notFound(message = 'Not Found'): Response {
  return jsonResponse({ message }, 404)
}

function badRequest(message: string): Response {
  return jsonResponse({ message }, 400)
}

// M6: the local `notProvisioned(...)` used to hand-roll the 501 shape. The
// helper now lives in `utils/project-backend-response.ts` so Studio sees
// the exact same JSON body ({ message, code, missing }) regardless of
// which dispatcher emitted it. See M6 in the plan.
const notProvisioned = notProvisionedResponse

function bubbleUpstreamError(status: number, body: string): Response {
  // pg-meta returns { error: string } on failure. Mirror that shape when the
  // body is non-JSON so Studio's error toaster doesn't explode on malformed
  // JSON.parse.
  try {
    const parsed = JSON.parse(body)
    return jsonResponse(parsed, status)
  } catch {
    return jsonResponse({ error: body || `pg-meta returned ${status}` }, status)
  }
}

// ── Audit helpers ───────────────────────────────────────────

interface AuditContext {
  email: string
  ip: string
  method: string
  route: string
  organizationId?: number | null
}

// M12: the audit row stores a non-reversible fingerprint of the SQL (hex
// SHA-256) plus byte length, never the statement text itself. See the
// file-level comment above for the threat model.
interface SqlFingerprint {
  bytes: number
  sha256: string
  disable_statement_timeout?: boolean
}

async function hashSql(sql: string): Promise<string> {
  const digest = await crypto.subtle.digest('SHA-256', new TextEncoder().encode(sql))
  const bytes = new Uint8Array(digest)
  let out = ''
  for (const b of bytes) out += b.toString(16).padStart(2, '0')
  return out
}

async function writeQueryAuditLog(
  pool: Pool,
  profileId: number,
  gotrueId: string,
  projectRef: string,
  ctx: AuditContext,
  sqlSummary: SqlFingerprint,
  status: number,
): Promise<void> {
  const connection = await pool.connect()
  try {
    await connection.queryObject`
      INSERT INTO traffic.audit_logs (
        id, organization_id, profile_id, action_name, action_metadata,
        actor_id, actor_type, actor_metadata,
        target_description, target_metadata, occurred_at
      ) VALUES (
        gen_random_uuid(), ${ctx.organizationId ?? null}, ${profileId},
        ${'project.pg_meta.query'},
        ${JSON.stringify([{ method: ctx.method, route: ctx.route, status }])}::jsonb,
        ${gotrueId}, 'user',
        ${JSON.stringify([{ email: ctx.email, ip: ctx.ip }])}::jsonb,
        ${'project pg-meta ref: ' + projectRef},
        ${JSON.stringify({ ref: projectRef, sql: sqlSummary })}::jsonb,
        now()
      )
    `
  } finally {
    connection.release()
  }
}

// ── Upstream call helpers ───────────────────────────────────

// Build a URL on `{backend.pgMetaUrl}/<surface>` preserving any query-string
// params from the incoming request. Returns null if the backend hasn't
// surfaced a pg-meta URL (shouldn't happen post-resolver, but guards against
// malformed provisioner payloads).
function buildTargetUrl(backend: ProjectBackend, surface: string, incoming: URL): URL | null {
  if (!backend.pgMetaUrl) return null
  let target: URL
  try {
    target = new URL(`${backend.pgMetaUrl.replace(/\/$/, '')}/${surface}`)
  } catch {
    return null
  }
  for (const [k, v] of incoming.searchParams.entries()) {
    target.searchParams.set(k, v)
  }
  return target
}

// Forward through headers we want pg-meta to see. We drop everything else so
// Studio's `Authorization: Bearer <user JWT>` doesn't leak past traffic-one.
// `fetchProjectUrl` sets Authorization + apikey to the project service key.
function forwardableHeaders(req: Request): Headers {
  const out = new Headers()
  const ct = req.headers.get('Content-Type')
  if (ct) out.set('Content-Type', ct)
  const appName = req.headers.get('x-pg-application-name')
  if (appName) out.set('x-pg-application-name', appName)
  const connEnc = req.headers.get('x-connection-encrypted')
  // Per-project pg-meta already knows which database to hit (it was
  // provisioned alongside the project DB). `x-connection-encrypted` only
  // matters for the multi-tenant managed platform, where one pg-meta
  // container routes to many DBs. We still forward it — harmless if the
  // runtime ignores it, useful if an operator wires in a fleet pg-meta.
  if (connEnc) out.set('x-connection-encrypted', connEnc)
  return out
}

async function dispatchGet(
  req: Request,
  backend: ProjectBackend,
  surface: string,
  fetchImpl: FetchLike,
): Promise<Response> {
  const target = buildTargetUrl(backend, surface, new URL(req.url))
  if (!target) {
    return jsonResponse({ message: 'pg-meta URL is not configured for this project' }, 501)
  }
  try {
    const res = await fetchProjectUrl(
      backend,
      target.toString(),
      {
        method: 'GET',
        headers: forwardableHeaders(req),
        signal: AbortSignal.timeout(PG_META_TIMEOUT_MS),
      },
      fetchImpl,
    )
    const body = await res.text()
    if (!res.ok) return bubbleUpstreamError(res.status, body)
    const contentType = res.headers.get('content-type') ?? 'application/json'
    return new Response(body, {
      status: res.status,
      headers: { ...corsHeaders, 'Content-Type': contentType },
    })
  } catch (err) {
    console.error(`pg-meta GET ${surface} failed:`, err)
    return jsonResponse({ error: 'pg-meta dispatch failed' }, 502)
  }
}

async function dispatchQuery(
  req: Request,
  backend: ProjectBackend,
  pool: Pool,
  projectRef: string,
  profileId: number,
  gotrueId: string,
  ctx: AuditContext,
  fetchImpl: FetchLike,
): Promise<Response> {
  const target = buildTargetUrl(backend, 'query', new URL(req.url))
  if (!target) {
    return jsonResponse({ message: 'pg-meta URL is not configured for this project' }, 501)
  }

  // M11: cap the /query body at `MAX_BODY_PG_META` (1 MiB). Studio's SQL
  // editor realistically never ships a >1MB statement; anything bigger is
  // either a pathological CSV insert (which should run via COPY, not
  // HTTP-proxied SQL) or an attacker trying to pin an outbound pg-meta
  // connection. We fail closed with a canonical 413 before touching the
  // upstream and before auditing anything.
  let rawBody: string
  try {
    rawBody = await readBodyWithLimit(req, MAX_BODY_PG_META)
  } catch (tooLarge) {
    if (tooLarge instanceof Response) return tooLarge
    return badRequest('Invalid request body')
  }
  let parsedBody: { query?: unknown; disable_statement_timeout?: unknown }
  try {
    parsedBody = rawBody ? JSON.parse(rawBody) : {}
  } catch {
    return badRequest('Request body must be JSON')
  }

  if (typeof parsedBody.query !== 'string' || parsedBody.query.length === 0) {
    return badRequest("'query' (non-empty string) is required")
  }
  const sql = parsedBody.query
  const disableStmtTimeout = typeof parsedBody.disable_statement_timeout === 'boolean'
    ? parsedBody.disable_statement_timeout
    : undefined

  // M12: no textual preview — hash instead. `bytes` + `sha256` together
  // still give operators a stable identifier to correlate with pg-meta's
  // own query log ("did user X run the same statement I see in the DB
  // audit trail?") while leaking zero SQL text / literals to anyone who
  // can read `traffic.audit_logs`.
  const sqlSummary: SqlFingerprint = {
    bytes: new TextEncoder().encode(sql).length,
    sha256: await hashSql(sql),
    ...(disableStmtTimeout !== undefined ? { disable_statement_timeout: disableStmtTimeout } : {}),
  }

  let upstreamStatus = 0
  let upstreamBody = ''
  try {
    const res = await fetchProjectUrl(
      backend,
      target.toString(),
      {
        method: 'POST',
        headers: forwardableHeaders(req),
        body: rawBody,
        signal: AbortSignal.timeout(PG_META_TIMEOUT_MS),
      },
      fetchImpl,
    )
    upstreamStatus = res.status
    upstreamBody = await res.text()
  } catch (err) {
    console.error('pg-meta POST /query dispatch failed:', err)
    await writeQueryAuditLog(pool, profileId, gotrueId, projectRef, ctx, sqlSummary, 502).catch(
      (logErr) => console.warn('pg-meta audit log failed:', logErr),
    )
    return jsonResponse({ error: 'pg-meta dispatch failed' }, 502)
  }

  // Audit every query regardless of upstream success; the action_metadata
  // captures the response status so we have an immutable trail of "who ran
  // what, when, and did it succeed?".
  await writeQueryAuditLog(
    pool,
    profileId,
    gotrueId,
    projectRef,
    ctx,
    sqlSummary,
    upstreamStatus,
  ).catch((logErr) => console.warn('pg-meta audit log failed:', logErr))

  if (upstreamStatus >= 200 && upstreamStatus < 300) {
    const contentType = 'application/json'
    return new Response(upstreamBody, {
      status: upstreamStatus,
      headers: { ...corsHeaders, 'Content-Type': contentType },
    })
  }
  return bubbleUpstreamError(upstreamStatus, upstreamBody)
}

// ── Handler ─────────────────────────────────────────────────

export async function handleProjectPgMeta(
  req: Request,
  path: string, // e.g. "/{ref}/query" or "/{ref}/tables"
  method: string,
  pool: Pool,
  profileId: number,
  gotrueId: string,
  email: string,
  // H4: injectable fetch so unit tests can assert outbound URL / method /
  // headers without a live pg-meta. Defaults to global `fetch` in prod.
  fetchImpl: FetchLike = fetch,
): Promise<Response> {
  const refMatch = path.match(/^\/([^/]+)(\/.*)$/)
  if (!refMatch) return notFound()

  const ref = refMatch[1]
  const subPath = refMatch[2]

  // L4: reject obviously-malformed refs before the DB round-trip.
  const bad = assertValidRef(ref)
  if (bad) return bad

  const project = await getProjectByRef(pool, ref, profileId)
  if (!project) return notFound('Project not found')

  const ctx: AuditContext = {
    email,
    ip: getClientIp(req),
    method,
    route: `/api/platform/pg-meta${path}`,
    organizationId: project.organization_id,
  }

  let backend: ProjectBackend
  try {
    backend = await getProjectBackend(ref, pool)
  } catch (err) {
    if (err instanceof ProjectBackendNotProvisionedError) return notProvisioned(err)
    throw err
  }

  // POST /{ref}/query — SQL runner (audited)
  if (subPath === '/query' || subPath === '/query/') {
    if (method !== 'POST') return methodNotAllowed()
    return dispatchQuery(req, backend, pool, ref, profileId, gotrueId, ctx, fetchImpl)
  }

  // GET /{ref}/<surface> — read-through proxy
  const surfaceMatch = subPath.match(/^\/([^/]+)\/?$/)
  if (surfaceMatch) {
    const surface = surfaceMatch[1]
    if (!ALLOWED_SURFACES.has(surface)) return notFound()
    if (method !== 'GET' && method !== 'HEAD') return methodNotAllowed()
    return dispatchGet(req, backend, surface, fetchImpl)
  }

  return notFound()
}
