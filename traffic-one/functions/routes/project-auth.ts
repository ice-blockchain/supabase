import type { Pool } from 'https://deno.land/x/postgres@v0.19.3/mod.ts'

import { corsHeaders } from '../index.ts'
import { createSecret, deleteSecret, listSecretNames } from '../services/project-secrets.service.ts'
import {
  createThirdPartyAuth,
  deleteThirdPartyAuth,
  getThirdPartyAuth,
  InvalidThirdPartyAuthInputError,
  listThirdPartyAuth,
  type ThirdPartyAuthInput,
  type ThirdPartyAuthRow,
} from '../services/project-third-party-auth.service.ts'
import { getProjectByRef } from '../services/project.service.ts'
import { getClientIp } from '../utils/client-ip.ts'
import { assertValidRef } from '../utils/ref-validation.ts'

// Handler for /v1/projects/{ref}/* auth-related paths:
//   /{ref}/config/auth/third-party-auth[/{id}]  (GET, POST, DELETE)
//   /{ref}/ssl-enforcement                       (GET, PUT)
//   /{ref}/secrets                               (GET, POST, DELETE)
//
// Routed via handleProjectHealth in routes/projects.ts.

const UUID_PATTERN = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i

type SslDatabaseMode = 'enforced' | 'not_enforced'

interface SslEnforcementStorage {
  database?: SslDatabaseMode
}

interface ProjectConfigSslRow {
  ssl_enforcement: SslEnforcementStorage | null
}

interface AuditContext {
  email: string
  ip: string
  method: string
  route: string
}

function notFoundResponse(message = 'Not Found'): Response {
  return Response.json({ message }, { status: 404, headers: corsHeaders })
}

function invalidBodyResponse(message = 'Invalid request body'): Response {
  return Response.json({ message }, { status: 400, headers: corsHeaders })
}

function methodNotAllowedResponse(): Response {
  return Response.json({ message: 'Method not allowed' }, { status: 405, headers: corsHeaders })
}

async function parseJson(req: Request): Promise<unknown> {
  try {
    return await req.json()
  } catch {
    return null
  }
}

function serializeThirdPartyAuth(row: ThirdPartyAuthRow): Record<string, unknown> {
  return {
    id: row.id,
    type: row.type,
    oidc_issuer_url: row.oidc_issuer_url,
    jwks_url: row.jwks_url,
    custom_jwks: row.custom_jwks,
    resolved_jwks: row.resolved_jwks,
    inserted_at: row.inserted_at,
    updated_at: row.updated_at,
  }
}

// ── Third-party auth handlers ──────────────────────────────

async function handleThirdPartyAuthCollection(
  req: Request,
  method: string,
  pool: Pool,
  projectRef: string,
  organizationId: number,
  profileId: number,
  gotrueId: string,
  auditContext: AuditContext,
): Promise<Response> {
  if (method === 'GET') {
    const rows = await listThirdPartyAuth(pool, projectRef)
    return Response.json(rows.map(serializeThirdPartyAuth), { headers: corsHeaders })
  }

  if (method === 'POST') {
    const body = await parseJson(req)
    if (!body || typeof body !== 'object') {
      return invalidBodyResponse('Body must be a JSON object')
    }
    const input = body as ThirdPartyAuthInput
    try {
      const row = await createThirdPartyAuth(
        pool,
        projectRef,
        organizationId,
        input,
        profileId,
        gotrueId,
        auditContext,
      )
      return Response.json(serializeThirdPartyAuth(row), {
        status: 201,
        headers: corsHeaders,
      })
    } catch (err) {
      if (err instanceof InvalidThirdPartyAuthInputError) {
        return invalidBodyResponse(err.message)
      }
      throw err
    }
  }

  return methodNotAllowedResponse()
}

async function handleThirdPartyAuthItem(
  method: string,
  pool: Pool,
  projectRef: string,
  organizationId: number,
  id: string,
  profileId: number,
  gotrueId: string,
  auditContext: AuditContext,
): Promise<Response> {
  if (!UUID_PATTERN.test(id)) {
    return notFoundResponse('Integration not found')
  }

  if (method === 'GET') {
    const row = await getThirdPartyAuth(pool, projectRef, id)
    if (!row) return notFoundResponse('Integration not found')
    return Response.json(serializeThirdPartyAuth(row), { headers: corsHeaders })
  }

  if (method === 'DELETE') {
    const row = await deleteThirdPartyAuth(
      pool,
      projectRef,
      organizationId,
      id,
      profileId,
      gotrueId,
      auditContext,
    )
    if (!row) return notFoundResponse('Integration not found')
    return Response.json(serializeThirdPartyAuth(row), { headers: corsHeaders })
  }

  return methodNotAllowedResponse()
}

// ── SSL enforcement ────────────────────────────────────────

async function readSslEnforcement(pool: Pool, projectRef: string): Promise<SslDatabaseMode> {
  const connection = await pool.connect()
  try {
    const result = await connection.queryObject<ProjectConfigSslRow>`
      SELECT ssl_enforcement
      FROM traffic.project_config
      WHERE project_ref = ${projectRef}
    `
    const stored = result.rows[0]?.ssl_enforcement ?? null
    if (stored && (stored.database === 'enforced' || stored.database === 'not_enforced')) {
      return stored.database
    }
    return 'enforced'
  } finally {
    connection.release()
  }
}

async function writeSslEnforcement(
  pool: Pool,
  projectRef: string,
  organizationId: number,
  mode: SslDatabaseMode,
  profileId: number,
  gotrueId: string,
  auditContext: AuditContext,
): Promise<void> {
  const connection = await pool.connect()
  try {
    const tx = connection.createTransaction(`ssl_enforcement_update_${projectRef}_${Date.now()}`)
    await tx.begin()

    await tx.queryObject`
      INSERT INTO traffic.project_config (project_ref, ssl_enforcement, updated_at)
      VALUES (${projectRef}, ${JSON.stringify({ database: mode })}::jsonb, now())
      ON CONFLICT (project_ref) DO UPDATE
      SET ssl_enforcement = EXCLUDED.ssl_enforcement,
          updated_at = now()
    `

    await tx.queryObject`
      INSERT INTO traffic.audit_logs (
        id, profile_id, organization_id, action_name, action_metadata,
        actor_id, actor_type, actor_metadata,
        target_description, target_metadata, occurred_at
      ) VALUES (
        gen_random_uuid(), ${profileId}, ${organizationId}, 'project.ssl_enforcement_updated',
        ${
      JSON.stringify([{ method: auditContext.method, route: auditContext.route, status: 200 }])
    }::jsonb,
        ${gotrueId}, 'user',
        ${JSON.stringify([{ email: auditContext.email, ip: auditContext.ip }])}::jsonb,
        ${'project_config ssl_enforcement (ref: ' + projectRef + ')'},
        ${JSON.stringify({ database: mode })}::jsonb,
        now()
      )
    `

    await tx.commit()
  } finally {
    connection.release()
  }
}

async function handleSslEnforcement(
  req: Request,
  method: string,
  pool: Pool,
  projectRef: string,
  organizationId: number,
  profileId: number,
  gotrueId: string,
  auditContext: AuditContext,
): Promise<Response> {
  if (method === 'GET') {
    const mode = await readSslEnforcement(pool, projectRef)
    return Response.json(
      {
        currentConfig: { database: mode },
        appliedSuccessfully: true,
      },
      { headers: corsHeaders },
    )
  }

  if (method === 'PUT') {
    const body = await parseJson(req)
    if (!body || typeof body !== 'object') {
      return invalidBodyResponse('Body must be a JSON object')
    }
    const requested = (body as { requestedConfig?: { database?: unknown } }).requestedConfig
    const db = requested?.database
    if (db !== 'enforced' && db !== 'not_enforced') {
      return invalidBodyResponse("requestedConfig.database must be 'enforced' or 'not_enforced'")
    }
    await writeSslEnforcement(
      pool,
      projectRef,
      organizationId,
      db,
      profileId,
      gotrueId,
      auditContext,
    )
    return Response.json(
      {
        currentConfig: { database: db },
        appliedSuccessfully: true,
      },
      { headers: corsHeaders },
    )
  }

  return methodNotAllowedResponse()
}

// ── Secrets ────────────────────────────────────────────────

interface SecretPayload {
  name: string
  value: string
}

function extractSecretPayloads(body: unknown): SecretPayload[] | null {
  const accept = (entry: unknown): SecretPayload | null => {
    if (!entry || typeof entry !== 'object') return null
    const candidate = entry as Record<string, unknown>
    const name = candidate.name
    const value = candidate.value
    if (typeof name !== 'string' || name.length === 0) return null
    if (typeof value !== 'string') return null
    return { name, value }
  }

  if (Array.isArray(body)) {
    const out: SecretPayload[] = []
    for (const entry of body) {
      const parsed = accept(entry)
      if (!parsed) return null
      out.push(parsed)
    }
    return out
  }
  const single = accept(body)
  return single ? [single] : null
}

function extractSecretNames(body: unknown): string[] | null {
  const fromArray = (arr: unknown): string[] | null => {
    if (!Array.isArray(arr)) return null
    const out: string[] = []
    for (const entry of arr) {
      if (typeof entry !== 'string' || entry.length === 0) return null
      out.push(entry)
    }
    return out
  }

  if (Array.isArray(body)) return fromArray(body)
  if (body && typeof body === 'object') {
    return fromArray((body as { names?: unknown }).names)
  }
  return null
}

async function insertSecretAudit(
  pool: Pool,
  action: 'project.secret_set' | 'project.secret_deleted',
  projectRef: string,
  organizationId: number,
  secretName: string,
  profileId: number,
  gotrueId: string,
  auditContext: AuditContext,
): Promise<void> {
  const connection = await pool.connect()
  try {
    const status = action === 'project.secret_set' ? 201 : 200
    await connection.queryObject`
      INSERT INTO traffic.audit_logs (
        id, profile_id, organization_id, action_name, action_metadata,
        actor_id, actor_type, actor_metadata,
        target_description, target_metadata, occurred_at
      ) VALUES (
        gen_random_uuid(), ${profileId}, ${organizationId}, ${action},
        ${
      JSON.stringify([{ method: auditContext.method, route: auditContext.route, status }])
    }::jsonb,
        ${gotrueId}, 'user',
        ${JSON.stringify([{ email: auditContext.email, ip: auditContext.ip }])}::jsonb,
        ${'project_secrets (ref: ' + projectRef + ', name: ' + secretName + ')'},
        ${JSON.stringify({ name: secretName })}::jsonb,
        now()
      )
    `
  } finally {
    connection.release()
  }
}

async function handleSecrets(
  req: Request,
  method: string,
  pool: Pool,
  projectRef: string,
  organizationId: number,
  profileId: number,
  gotrueId: string,
  auditContext: AuditContext,
): Promise<Response> {
  if (method === 'GET') {
    const names = await listSecretNames(pool, projectRef)
    return Response.json(names, { headers: corsHeaders })
  }

  if (method === 'POST') {
    const body = await parseJson(req)
    const payloads = extractSecretPayloads(body)
    if (!payloads || payloads.length === 0) {
      return invalidBodyResponse('Body must be { name, value } or an array of { name, value }')
    }

    const results: { name: string; status: 'created' | 'updated' }[] = []
    for (const payload of payloads) {
      const result = await createSecret(pool, projectRef, payload.name, payload.value)
      await insertSecretAudit(
        pool,
        'project.secret_set',
        projectRef,
        organizationId,
        payload.name,
        profileId,
        gotrueId,
        auditContext,
      )
      results.push({ name: result.name, status: result.status })
    }

    return Response.json({ secrets: results }, { status: 201, headers: corsHeaders })
  }

  if (method === 'DELETE') {
    const body = await parseJson(req)
    const names = extractSecretNames(body)
    if (!names || names.length === 0) {
      return invalidBodyResponse('Body must be a string[] of names or { names: string[] }')
    }

    const deleted: string[] = []
    for (const name of names) {
      const removed = await deleteSecret(pool, projectRef, name)
      if (removed) {
        await insertSecretAudit(
          pool,
          'project.secret_deleted',
          projectRef,
          organizationId,
          name,
          profileId,
          gotrueId,
          auditContext,
        )
        deleted.push(name)
      }
    }

    return Response.json({ deleted }, { headers: corsHeaders })
  }

  return methodNotAllowedResponse()
}

// ── Dispatcher ─────────────────────────────────────────────

export async function handleProjectAuth(
  req: Request,
  path: string,
  method: string,
  pool: Pool,
  profileId: number,
  gotrueId: string,
  email: string,
): Promise<Response> {
  const refMatch = path.match(/^\/([^/]+)(\/.*)?$/)
  if (!refMatch) return notFoundResponse()
  const ref = refMatch[1]
  const subPath = refMatch[2] || ''

  // L4: reject malformed refs before hitting the DB.
  const bad = assertValidRef(ref)
  if (bad) return bad

  const project = await getProjectByRef(pool, ref, profileId)
  if (!project) return notFoundResponse('Project not found')

  const ip = getClientIp(req)
  const auditContext: AuditContext = {
    email,
    ip,
    method,
    route: '/v1/projects/' + ref + subPath,
  }

  if (subPath === '/config/auth/third-party-auth') {
    return handleThirdPartyAuthCollection(
      req,
      method,
      pool,
      ref,
      project.organization_id,
      profileId,
      gotrueId,
      auditContext,
    )
  }

  const itemMatch = subPath.match(/^\/config\/auth\/third-party-auth\/([^/]+)$/)
  if (itemMatch) {
    return handleThirdPartyAuthItem(
      method,
      pool,
      ref,
      project.organization_id,
      itemMatch[1],
      profileId,
      gotrueId,
      auditContext,
    )
  }

  if (subPath === '/ssl-enforcement') {
    return handleSslEnforcement(
      req,
      method,
      pool,
      ref,
      project.organization_id,
      profileId,
      gotrueId,
      auditContext,
    )
  }

  if (subPath === '/secrets') {
    return handleSecrets(
      req,
      method,
      pool,
      ref,
      project.organization_id,
      profileId,
      gotrueId,
      auditContext,
    )
  }

  return notFoundResponse()
}
