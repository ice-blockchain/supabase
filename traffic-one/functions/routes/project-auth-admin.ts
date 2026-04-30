import type { Pool } from 'https://deno.land/x/postgres@v0.19.3/mod.ts'

import { corsHeaders } from '../index.ts'
import {
  type FetchLike,
  fetchProjectJson,
  getProjectBackend,
  type ProjectBackend,
  ProjectBackendNotProvisionedError,
} from '../services/project-backend.service.ts'
import { getProjectByRef } from '../services/project.service.ts'
import { MAX_BODY_AUTH_ADMIN, readBodyWithLimit } from '../utils/body-limits.ts'
import { getClientIp } from '../utils/client-ip.ts'
import { notProvisionedResponse } from '../utils/project-backend-response.ts'
import { assertValidRef } from '../utils/ref-validation.ts'

// ─────────────────────────────────────────────────────────────────────────────
//
// Project-scoped GoTrue admin proxy (Phase 2).
//
// Replaces Studio's own `apps/studio/pages/api/platform/auth/[ref]/*` Next
// stubs — those stubs signed outbound calls with `SUPABASE_SERVICE_KEY` and
// `SUPABASE_URL`, which breaks the moment Studio needs to manage users on a
// different project than the one Studio itself is logged into. Now every call
// resolves the per-project backend via `getProjectBackend(ref)` first, then
// dispatches to that backend's GoTrue using its service_role key.
//
// Routes (incoming is `/api/platform/auth/{ref}/...`; Kong strip_path: false
// on the `platform-auth` route leaves the full path intact; traffic-one's
// `index.ts` trims the `/api/platform/auth` prefix, so `path` here starts
// at `/{ref}`):
//
//   POST   /{ref}/users                    -> /auth/v1/admin/users
//   PATCH  /{ref}/users/{id}               -> /auth/v1/admin/users/{id}
//   DELETE /{ref}/users/{id}               -> /auth/v1/admin/users/{id}
//   DELETE /{ref}/users/{id}/factors       -> list + delete all MFA factors
//   POST   /{ref}/invite                   -> /auth/v1/invite
//   POST   /{ref}/magiclink                -> /auth/v1/magiclink
//   POST   /{ref}/recover                  -> /auth/v1/recover
//   POST   /{ref}/otp                      -> /auth/v1/otp
//   POST   /{ref}/validate/spam            -> local heuristic stub
//
// Every successful mutation emits a `traffic.audit_logs` row; sensitive body
// fields (`password`) are stripped before they land in `action_metadata`.
//
// ─────────────────────────────────────────────────────────────────────────────

// ── Response helpers ────────────────────────────────────────

function jsonResponse(body: unknown, status = 200): Response {
  return Response.json(body, { status, headers: corsHeaders })
}

function errorResponse(message: string, status = 400, extra?: Record<string, unknown>): Response {
  return jsonResponse({ ...(extra ?? {}), message }, status)
}

function methodNotAllowed(): Response {
  return errorResponse('Method not allowed', 405)
}

function notFound(message = 'Not Found'): Response {
  return errorResponse(message, 404)
}

// M6: local `notProvisioned(ref, missing)` used to emit a bespoke 501
// body ({ code, message }) that was missing the `missing` field most
// other dispatchers expose. All project routes now share
// `notProvisionedResponse` so Studio can switch on a single canonical
// shape. See M6 in the plan.

// ── Audit helpers ───────────────────────────────────────────

interface AuditContext {
  email: string
  ip: string
  method: string
  route: string
  organizationId?: number | null
}

const SAFE_BODY_KEYS = new Set<string>([
  'email',
  'phone',
  'ban_duration',
  'email_confirm',
  'phone_confirm',
  'app_metadata',
  'user_metadata',
  'redirectTo',
  'redirect_to',
])

function sanitizeBodyForAudit(body: unknown): Record<string, unknown> {
  if (!body || typeof body !== 'object' || Array.isArray(body)) return {}
  const out: Record<string, unknown> = {}
  for (const [k, v] of Object.entries(body)) {
    if (!SAFE_BODY_KEYS.has(k)) continue
    if (k === 'email' && typeof v === 'string') {
      // Record only the domain part — raw addresses get emitted by GoTrue's
      // own audit log if the operator forwards it. We log the action + domain
      // for platform-side auditing without duplicating PII.
      const at = v.lastIndexOf('@')
      out[k] = at >= 0 ? `***${v.slice(at)}` : '***'
    } else {
      out[k] = v
    }
  }
  return out
}

async function writeAuditLog(
  pool: Pool,
  profileId: number,
  gotrueId: string,
  action: string,
  projectRef: string,
  ctx: AuditContext,
  bodySummary: Record<string, unknown>,
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
        gen_random_uuid(), ${ctx.organizationId ?? null}, ${profileId}, ${action},
        ${JSON.stringify([{ method: ctx.method, route: ctx.route, status }])}::jsonb,
        ${gotrueId}, 'user',
        ${JSON.stringify([{ email: ctx.email, ip: ctx.ip }])}::jsonb,
        ${'project auth ref: ' + projectRef},
        ${JSON.stringify({ ref: projectRef, body: bodySummary })}::jsonb,
        now()
      )
    `
  } finally {
    connection.release()
  }
}

// ── Body helpers ────────────────────────────────────────────

// M11 / L9: returns either the parsed JSON body OR a pre-built Response
// (413 when the caller exceeds `maxBytes`, 400 when the body is not valid
// JSON or not a JSON object). Dispatchers branch on `instanceof Response`
// before using the parsed payload. An empty body remains `{}` because
// several downstream endpoints (e.g. admin magic-link / recover) legitimately
// accept empty bodies and rely on default behaviour.
//
// L9: before this refactor, malformed JSON silently became `{}`, which let
// the handler proceed as if the caller had sent a well-formed but empty
// object — masking client bugs and making the `if (body.foo)` branches
// behave unpredictably. Arrays / primitives now also 400 rather than being
// coerced to `{}`, since no downstream admin endpoint actually expects
// either.
function invalidJsonBodyResponse(message: string): Response {
  return Response.json({ code: 'invalid_body', message }, { status: 400, headers: corsHeaders })
}

async function readJsonBody(
  req: Request,
  maxBytes: number = MAX_BODY_AUTH_ADMIN,
): Promise<Record<string, unknown> | Response> {
  let text: string
  try {
    text = await readBodyWithLimit(req, maxBytes)
  } catch (tooLarge) {
    if (tooLarge instanceof Response) return tooLarge
    throw tooLarge
  }
  if (!text) return {}
  let parsed: unknown
  try {
    parsed = JSON.parse(text)
  } catch {
    return invalidJsonBodyResponse('Body must be valid JSON')
  }
  if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) {
    return invalidJsonBodyResponse('Body must be a JSON object')
  }
  return parsed as Record<string, unknown>
}

// ── GoTrue admin factor listing ─────────────────────────────

interface GoTrueFactor {
  id: string
  friendly_name?: string
  factor_type?: string
  status?: string
}

type FactorListOutcome =
  | { ok: true; factors: GoTrueFactor[] }
  | { ok: false; status: number; reason: 'upstream_error' | 'malformed_body' | 'network' }

// H5: the old implementation swallowed every failure by returning `[]`,
// which caused the factor-clear handler to audit a success on 200 while
// actually having done nothing (or having returned 5xx from GoTrue).
// Callers now see an explicit outcome and can translate failures into a
// 502 without auditing.
async function listUserFactors(
  backend: ProjectBackend,
  userId: string,
  fetchImpl: FetchLike,
): Promise<FactorListOutcome> {
  let res: Response
  try {
    res = await fetchProjectJson(backend, `/auth/v1/admin/users/${userId}/factors`, {}, fetchImpl)
  } catch (err) {
    console.error('listUserFactors: network error:', err)
    return { ok: false, status: 0, reason: 'network' }
  }
  if (!res.ok) {
    await res.body?.cancel()
    return { ok: false, status: res.status, reason: 'upstream_error' }
  }
  try {
    const body = (await res.json()) as { factors?: GoTrueFactor[] } | GoTrueFactor[] | null
    if (Array.isArray(body)) return { ok: true, factors: body }
    if (body && Array.isArray(body.factors)) return { ok: true, factors: body.factors }
    return { ok: true, factors: [] }
  } catch {
    return { ok: false, status: res.status, reason: 'malformed_body' }
  }
}

// ── Spam scoring (proxy + heuristic fallback) ──────────────
//
// The ValidateSpamResponse shape Studio expects is
// `{ rules: [{ name, desc, score }] }`. Supabase Cloud runs this behind a
// dedicated SpamAssassin microservice; open-source GoTrue has no such
// endpoint. We try three paths in order (M4 decision):
//
//   1. If `TRAFFIC_SPAM_CHECK_URL` is configured, POST to that URL — this
//      lets operators plug in their own scorer (SpamAssassin, rspamd, an
//      LLM guardrail, …) without rebuilding traffic-one.
//   2. Otherwise, try `{backend.endpoint}/auth/v1/validate/spam` on the
//      project's GoTrue — cloud / forks may implement it; if they do, we
//      surface those rules untouched.
//   3. Fall back to a minimal keyword heuristic so Studio's "Check for
//      spam" button always returns a usable shape (never a 501/502).
//
// The heuristic is intentional (deterministic, offline, zero network). It
// is NOT a substitute for SpamAssassin and is documented as such in
// `traffic-one/README.md` and `ARCHITECTURE.md`.

interface SpamRule {
  name: string
  desc: string
  score: number
}

function checkSpamHeuristic(subject: string, content: string): SpamRule[] {
  const rules: SpamRule[] = []
  const lowered = (subject + '\n' + content).toLowerCase()
  const patterns: [RegExp, string, string, number][] = [
    [/\bviagra\b/i, 'VIAGRA', 'Contains pharmaceutical spam keyword', 4.0],
    [/\b(?:lottery|prize|winner|jackpot)\b/i, 'LOTTERY', 'Mentions lottery / prize keywords', 2.5],
    [/\bfree\b.*\b(money|cash|gift)\b/i, 'FREE_MONEY', 'Offers free money / cash / gifts', 3.0],
    [/\bclick here\b/i, 'CLICK_HERE', 'Uses generic "click here" call-to-action', 0.5],
    [/[A-Z]{15,}/, 'ALL_CAPS', 'Contains a long ALL-CAPS run', 0.8],
  ]
  for (const [re, name, desc, score] of patterns) {
    if (re.test(lowered)) rules.push({ name, desc, score })
  }
  if (subject.trim().length === 0) {
    rules.push({ name: 'EMPTY_SUBJECT', desc: 'Subject line is empty', score: 1.0 })
  }
  return rules
}

type SpamSource = 'external' | 'gotrue' | 'heuristic'

interface SpamResult {
  rules: SpamRule[]
  source: SpamSource
}

async function runSpamScore(
  backend: ProjectBackend,
  subject: string,
  content: string,
  fetchImpl: FetchLike,
): Promise<SpamResult> {
  const externalUrl = Deno.env.get('TRAFFIC_SPAM_CHECK_URL')?.trim()
  const bodyPayload = JSON.stringify({ subject, content })

  // (1) external scorer if configured. We intentionally send ONLY
  // {subject, content} so the external service never sees project refs
  // or credentials.
  if (externalUrl) {
    try {
      const res = await fetchImpl(externalUrl, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: bodyPayload,
      })
      if (res.ok) {
        const data = (await res.json()) as { rules?: SpamRule[] } | null
        if (data && Array.isArray(data.rules)) {
          return { rules: data.rules, source: 'external' }
        }
      } else {
        await res.body?.cancel()
      }
    } catch (err) {
      console.warn('runSpamScore: external scorer failed, falling back:', err)
    }
  }

  // (2) per-project GoTrue — Cloud / forks may ship this endpoint.
  try {
    const res = await fetchProjectJson(
      backend,
      '/auth/v1/validate/spam',
      { method: 'POST', body: bodyPayload },
      fetchImpl,
    )
    if (res.ok) {
      const data = (await res.json()) as { rules?: SpamRule[] } | null
      if (data && Array.isArray(data.rules)) {
        return { rules: data.rules, source: 'gotrue' }
      }
    } else {
      await res.body?.cancel()
    }
  } catch (err) {
    console.warn('runSpamScore: gotrue probe failed, falling back to heuristic:', err)
  }

  // (3) deterministic offline heuristic.
  return { rules: checkSpamHeuristic(subject, content), source: 'heuristic' }
}

// ── Main handler ────────────────────────────────────────────

export async function handleProjectAuthAdmin(
  req: Request,
  path: string,
  method: string,
  pool: Pool,
  profileId: number,
  gotrueId: string,
  email: string,
  // H4: injectable fetch so unit tests can assert outbound URL / method /
  // headers without a live GoTrue. Defaults to global `fetch` in prod.
  fetchImpl: FetchLike = fetch,
): Promise<Response> {
  // Path here begins with `/{ref}/...` (index.ts strips `/api/platform/auth`).
  const refMatch = path.match(/^\/([^/]+)(\/.*)$/)
  if (!refMatch) return notFound()

  const ref = refMatch[1]
  const subPath = refMatch[2]

  // L4: bail on malformed refs before we touch the DB. A 20-char
  // lowercase-alphanumeric check matches both `generateRef()` output
  // (hex) and cloud-style refs, and rejects paths with `..`, encoded
  // slashes, etc. before they ever reach `getProjectByRef`.
  const bad = assertValidRef(ref)
  if (bad) return bad

  const project = await getProjectByRef(pool, ref, profileId)
  if (!project) return notFound('Project not found')

  const auditContext: AuditContext = {
    email,
    ip: getClientIp(req),
    method,
    route: '/api/platform/auth' + path,
    organizationId: project.organization_id,
  }

  let backend: ProjectBackend
  try {
    backend = await getProjectBackend(ref, pool)
  } catch (err) {
    if (err instanceof ProjectBackendNotProvisionedError) {
      return notProvisionedResponse(err)
    }
    throw err
  }

  // ── POST /{ref}/users ─────────────────────────────────────
  if (subPath === '/users' && method === 'POST') {
    const body = await readJsonBody(req)
    if (body instanceof Response) return body
    const res = await fetchProjectJson(
      backend,
      '/auth/v1/admin/users',
      {
        method: 'POST',
        body: JSON.stringify(body),
      },
      fetchImpl,
    )
    const text = await res.text()
    if (res.ok) {
      await writeAuditLog(
        pool,
        profileId,
        gotrueId,
        'project.app_user_create',
        ref,
        auditContext,
        sanitizeBodyForAudit(body),
        res.status,
      )
    }
    return new Response(text, {
      status: res.status,
      headers: {
        ...corsHeaders,
        'Content-Type': res.headers.get('Content-Type') ?? 'application/json',
      },
    })
  }

  // ── PATCH/DELETE /{ref}/users/{id} ────────────────────────
  const userIdMatch = subPath.match(/^\/users\/([^/]+)$/)
  if (userIdMatch) {
    const userId = userIdMatch[1]
    if (method === 'PATCH') {
      const body = await readJsonBody(req)
      if (body instanceof Response) return body
      const res = await fetchProjectJson(
        backend,
        `/auth/v1/admin/users/${userId}`,
        {
          method: 'PUT',
          body: JSON.stringify(body),
        },
        fetchImpl,
      )
      const text = await res.text()
      if (res.ok) {
        await writeAuditLog(
          pool,
          profileId,
          gotrueId,
          'project.app_user_update',
          ref,
          auditContext,
          { ...sanitizeBodyForAudit(body), user_id: userId },
          res.status,
        )
      }
      return new Response(text, {
        status: res.status,
        headers: {
          ...corsHeaders,
          'Content-Type': res.headers.get('Content-Type') ?? 'application/json',
        },
      })
    }
    if (method === 'DELETE') {
      const res = await fetchProjectJson(
        backend,
        `/auth/v1/admin/users/${userId}`,
        { method: 'DELETE' },
        fetchImpl,
      )
      // Swallow the response body — the Next stub returned `data` verbatim,
      // which is typically `{}` from GoTrue on 200.
      const text = (await res.text()) || '{}'
      if (res.ok) {
        await writeAuditLog(
          pool,
          profileId,
          gotrueId,
          'project.app_user_delete',
          ref,
          auditContext,
          { user_id: userId },
          res.status,
        )
      }
      return new Response(text, {
        status: res.status,
        headers: {
          ...corsHeaders,
          'Content-Type': res.headers.get('Content-Type') ?? 'application/json',
        },
      })
    }
    return methodNotAllowed()
  }

  // ── DELETE /{ref}/users/{id}/factors ──────────────────────
  const factorsMatch = subPath.match(/^\/users\/([^/]+)\/factors$/)
  if (factorsMatch) {
    if (method !== 'DELETE') return methodNotAllowed()
    const userId = factorsMatch[1]

    // H5: when the LIST step fails (upstream 5xx, network, malformed body)
    // return 502 and skip the success audit. Prior code returned `[]` for
    // every failure, which caused the handler to audit a successful
    // "mfa_factors_delete" on 200 when in reality nothing happened (the
    // list call itself errored). Operators would see a green audit row for
    // a no-op, then be surprised when the user still had factors.
    const listOutcome = await listUserFactors(backend, userId, fetchImpl)
    if (listOutcome.ok === false) {
      return jsonResponse(
        {
          data: null,
          error: {
            message: 'Failed to list MFA factors',
            reason: listOutcome.reason,
            upstream_status: listOutcome.status,
          },
        },
        502,
      )
    }
    const factors = listOutcome.factors

    // GoTrue exposes factor deletion per-id. Fire them sequentially to keep
    // ordering deterministic and preserve "first failure stops loop" (which
    // matches the cloud dashboard semantics).
    const results: Array<{ id: string; ok: boolean; status: number }> = []
    for (const factor of factors) {
      const res = await fetchProjectJson(
        backend,
        `/auth/v1/admin/users/${userId}/factors/${factor.id}`,
        { method: 'DELETE' },
        fetchImpl,
      )
      await res.body?.cancel()
      results.push({ id: factor.id, ok: res.ok, status: res.status })
      if (!res.ok) break
    }
    // H5: only audit the success path when EVERY per-factor DELETE
    // returned 2xx. Partial failures (one or more 5xx-on-DELETE) skip the
    // audit write so the trail doesn't record a false "cleared" row —
    // consistent with how the other mutation handlers (user_create,
    // user_delete, invite, magiclink, recover, otp) only write the audit
    // log when `res.ok` is true. The dispatcher still surfaces the 502 so
    // Studio can show the failure to the operator.
    const allOk = results.every((r) => r.ok)
    const status = allOk ? 200 : 502
    if (allOk) {
      await writeAuditLog(
        pool,
        profileId,
        gotrueId,
        'project.app_user_mfa_factors_delete',
        ref,
        auditContext,
        { user_id: userId, factors: results.map((r) => r.id), deleted: true },
        status,
      )
    }
    // Match the Next stub shape: `{ data: null, error: null }`.
    return jsonResponse({ data: null, error: allOk ? null : { results } }, status)
  }

  // ── POST /{ref}/invite, /magiclink, /recover, /otp ─────────
  const simplePost: Array<[string, string, string]> = [
    ['/invite', '/auth/v1/invite', 'project.app_user_invite'],
    ['/magiclink', '/auth/v1/magiclink', 'project.app_user_magiclink'],
    ['/recover', '/auth/v1/recover', 'project.app_user_recover'],
    ['/otp', '/auth/v1/otp', 'project.app_user_otp'],
  ]
  for (const [fromPath, toPath, action] of simplePost) {
    if (subPath === fromPath) {
      if (method !== 'POST') return methodNotAllowed()
      const body = await readJsonBody(req)
      if (body instanceof Response) return body
      const res = await fetchProjectJson(
        backend,
        toPath,
        {
          method: 'POST',
          body: JSON.stringify(body),
        },
        fetchImpl,
      )
      const text = await res.text()
      if (res.ok) {
        await writeAuditLog(
          pool,
          profileId,
          gotrueId,
          action,
          ref,
          auditContext,
          sanitizeBodyForAudit(body),
          res.status,
        )
      }
      return new Response(text, {
        status: res.status,
        headers: {
          ...corsHeaders,
          'Content-Type': res.headers.get('Content-Type') ?? 'application/json',
        },
      })
    }
  }

  // ── POST /{ref}/validate/spam ─────────────────────────────
  if (subPath === '/validate/spam') {
    if (method !== 'POST') return methodNotAllowed()
    const body = await readJsonBody(req)
    if (body instanceof Response) return body
    const subject = typeof body.subject === 'string' ? body.subject : ''
    const content = typeof body.content === 'string' ? body.content : ''
    // M4: try external scorer → project GoTrue → local heuristic. The
    // audit log records which backend actually produced the rules so
    // operators can tell whether cloud scoring or the fallback was used.
    const { rules, source } = await runSpamScore(backend, subject, content, fetchImpl)
    await writeAuditLog(
      pool,
      profileId,
      gotrueId,
      'project.app_user_validate_spam',
      ref,
      auditContext,
      {
        subject_len: subject.length,
        content_len: content.length,
        rule_count: rules.length,
        source,
      },
      200,
    )
    return jsonResponse({ rules })
  }

  return notFound()
}
