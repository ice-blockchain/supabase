import type { Pool } from 'https://deno.land/x/postgres@v0.19.3/mod.ts'

import { corsHeaders } from '../index.ts'
import {
  type ApiKeyType,
  createApiKey,
  createSigningKey,
  type CreateSigningKeyInput,
  createTemporaryApiKey,
  deleteApiKey,
  deleteSigningKey,
  getApiKey,
  getSigningKey,
  listApiKeys,
  listLegacyApiKeys,
  listLegacySigningKeys,
  listSigningKeys,
  type SigningKeyStatus,
  updateApiKey,
  updateSigningKey,
} from '../services/project-api-keys.service.ts'
import {
  getProjectBackend,
  ProjectBackendNotProvisionedError,
} from '../services/project-backend.service.ts'
import { getProjectByRef } from '../services/project.service.ts'
import { getClientIp } from '../utils/client-ip.ts'
import { notProvisionedResponse } from '../utils/project-backend-response.ts'
import { assertValidRef } from '../utils/ref-validation.ts'

// ── Response helpers ─────────────────────────────────────────

function notFoundResponse(message = 'Not Found'): Response {
  return Response.json({ message }, { status: 404, headers: corsHeaders })
}

function methodNotAllowedResponse(): Response {
  return Response.json({ message: 'Method not allowed' }, { status: 405, headers: corsHeaders })
}

function badRequestResponse(message: string): Response {
  return Response.json({ message }, { status: 400, headers: corsHeaders })
}

function notSupportedResponse(message: string): Response {
  return Response.json(
    { code: 'self_hosted_unsupported', message },
    { status: 501, headers: corsHeaders },
  )
}

async function readJson(req: Request): Promise<Record<string, unknown>> {
  try {
    const body = await req.json()
    if (body && typeof body === 'object') return body as Record<string, unknown>
    return {}
  } catch {
    return {}
  }
}

function parseId(raw: string): number | null {
  const parsed = Number.parseInt(raw, 10)
  if (!Number.isInteger(parsed) || String(parsed) !== raw) return null
  return parsed
}

function isApiKeyType(value: unknown): value is ApiKeyType {
  return value === 'publishable' || value === 'secret'
}

function isSigningKeyStatus(value: unknown): value is SigningKeyStatus {
  return (
    value === 'in_use' || value === 'standby' || value === 'previously_used' || value === 'revoked'
  )
}

// ── Handler ──────────────────────────────────────────────────

export async function handleProjectApiKeys(
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
  const organizationId = project.organization_id

  const ip = getClientIp(req)
  const auditContext = { email, ip, method, route: path }

  // ── /api-keys/legacy ─────────────────────────────────────
  if (subPath === '/api-keys/legacy' || subPath === '/api-keys/legacy/') {
    if (method === 'GET') {
      try {
        const backend = await getProjectBackend(ref, pool)
        return Response.json(listLegacyApiKeys(backend), { headers: corsHeaders })
      } catch (err) {
        if (err instanceof ProjectBackendNotProvisionedError) {
          return notProvisionedResponse(err)
        }
        throw err
      }
    }
    if (method === 'PUT') {
      return notSupportedResponse(
        'Rotating the legacy anon / service_role keys requires restarting the stack with new env vars',
      )
    }
    return methodNotAllowedResponse()
  }

  // ── /api-keys/temporary ──────────────────────────────────
  if (subPath === '/api-keys/temporary' || subPath === '/api-keys/temporary/') {
    if (method === 'POST') {
      const body = await readJson(req)
      const name = typeof body.name === 'string' ? body.name : undefined
      const ttl = typeof body.ttl_seconds === 'number'
        ? body.ttl_seconds
        : typeof body.ttlSeconds === 'number'
        ? body.ttlSeconds
        : undefined
      const response = await createTemporaryApiKey(
        pool,
        ref,
        profileId,
        organizationId,
        { name, ttl_seconds: ttl },
        gotrueId,
        auditContext,
      )
      return Response.json(response, { status: 201, headers: corsHeaders })
    }
    return methodNotAllowedResponse()
  }

  // ── /api-keys (list / create) ────────────────────────────
  if (subPath === '/api-keys' || subPath === '/api-keys/') {
    if (method === 'GET') {
      const keys = await listApiKeys(pool, ref)
      return Response.json(keys, { headers: corsHeaders })
    }
    if (method === 'POST') {
      const body = await readJson(req)
      if (typeof body.name !== 'string' || body.name.length === 0) {
        return badRequestResponse('name is required')
      }
      if (!isApiKeyType(body.type)) {
        return badRequestResponse("type must be 'publishable' or 'secret'")
      }
      const tags = Array.isArray(body.tags)
        ? body.tags.filter((t): t is string => typeof t === 'string')
        : undefined
      const description = typeof body.description === 'string' ? body.description : undefined

      const created = await createApiKey(
        pool,
        ref,
        profileId,
        organizationId,
        { name: body.name, description, type: body.type, tags },
        gotrueId,
        auditContext,
      )
      return Response.json(created, { status: 201, headers: corsHeaders })
    }
    return methodNotAllowedResponse()
  }

  // ── /api-keys/{id} ───────────────────────────────────────
  const apiKeyIdMatch = subPath.match(/^\/api-keys\/([^/]+)\/?$/)
  if (apiKeyIdMatch && apiKeyIdMatch[1] !== 'legacy' && apiKeyIdMatch[1] !== 'temporary') {
    const id = parseId(apiKeyIdMatch[1])
    if (id === null) return notFoundResponse('Api key not found')

    if (method === 'GET') {
      const key = await getApiKey(pool, ref, id)
      if (!key) return notFoundResponse('Api key not found')
      return Response.json(key, { headers: corsHeaders })
    }
    if (method === 'PATCH') {
      const body = await readJson(req)
      const patch: { name?: string; description?: string; tags?: string[] } = {}
      if (typeof body.name === 'string') patch.name = body.name
      if (typeof body.description === 'string') patch.description = body.description
      if (Array.isArray(body.tags)) {
        patch.tags = body.tags.filter((t): t is string => typeof t === 'string')
      }
      const updated = await updateApiKey(
        pool,
        ref,
        id,
        patch,
        profileId,
        organizationId,
        gotrueId,
        auditContext,
      )
      if (!updated) return notFoundResponse('Api key not found')
      return Response.json(updated, { headers: corsHeaders })
    }
    if (method === 'DELETE') {
      const deleted = await deleteApiKey(
        pool,
        ref,
        id,
        profileId,
        organizationId,
        gotrueId,
        auditContext,
      )
      if (!deleted) return notFoundResponse('Api key not found')
      return Response.json(deleted, { headers: corsHeaders })
    }
    return methodNotAllowedResponse()
  }

  // ── /config/auth/signing-keys/legacy ─────────────────────
  if (
    subPath === '/config/auth/signing-keys/legacy' ||
    subPath === '/config/auth/signing-keys/legacy/'
  ) {
    if (method === 'GET') {
      return Response.json(listLegacySigningKeys(), { headers: corsHeaders })
    }
    if (method === 'POST') {
      return notSupportedResponse(
        'Rotating the legacy HS256 signing secret requires restarting GoTrue with new env vars',
      )
    }
    return methodNotAllowedResponse()
  }

  // ── /config/auth/signing-keys (list / create) ────────────
  if (subPath === '/config/auth/signing-keys' || subPath === '/config/auth/signing-keys/') {
    if (method === 'GET') {
      const keys = await listSigningKeys(pool, ref)
      return Response.json(keys, { headers: corsHeaders })
    }
    if (method === 'POST') {
      const body = await readJson(req)
      if (typeof body.algorithm !== 'string' || body.algorithm.length === 0) {
        return badRequestResponse('algorithm is required')
      }
      if (body.status !== undefined && !isSigningKeyStatus(body.status)) {
        return badRequestResponse(
          "status must be one of 'in_use', 'standby', 'previously_used', 'revoked'",
        )
      }
      const input: CreateSigningKeyInput = {
        algorithm: body.algorithm,
        status: isSigningKeyStatus(body.status) ? body.status : undefined,
        active: typeof body.active === 'boolean' ? body.active : undefined,
        public_jwk: body.public_jwk && typeof body.public_jwk === 'object'
          ? (body.public_jwk as Record<string, unknown>)
          : undefined,
        private_jwk_secret_id: typeof body.private_jwk_secret_id === 'string'
          ? body.private_jwk_secret_id
          : null,
      }
      const created = await createSigningKey(
        pool,
        ref,
        profileId,
        organizationId,
        input,
        gotrueId,
        auditContext,
      )
      return Response.json(created, { status: 201, headers: corsHeaders })
    }
    return methodNotAllowedResponse()
  }

  // ── /config/auth/signing-keys/{id} ───────────────────────
  const signingIdMatch = subPath.match(/^\/config\/auth\/signing-keys\/([^/]+)\/?$/)
  if (signingIdMatch && signingIdMatch[1] !== 'legacy') {
    const id = parseId(signingIdMatch[1])
    if (id === null) return notFoundResponse('Signing key not found')

    if (method === 'GET') {
      const key = await getSigningKey(pool, ref, id)
      if (!key) return notFoundResponse('Signing key not found')
      return Response.json(key, { headers: corsHeaders })
    }
    if (method === 'PATCH') {
      const body = await readJson(req)
      if (body.status !== undefined && !isSigningKeyStatus(body.status)) {
        return badRequestResponse(
          "status must be one of 'in_use', 'standby', 'previously_used', 'revoked'",
        )
      }
      const patch: {
        algorithm?: string
        status?: SigningKeyStatus
        active?: boolean
        public_jwk?: Record<string, unknown>
      } = {}
      if (typeof body.algorithm === 'string') patch.algorithm = body.algorithm
      if (isSigningKeyStatus(body.status)) patch.status = body.status
      if (typeof body.active === 'boolean') patch.active = body.active
      if (body.public_jwk && typeof body.public_jwk === 'object') {
        patch.public_jwk = body.public_jwk as Record<string, unknown>
      }
      const updated = await updateSigningKey(
        pool,
        ref,
        id,
        profileId,
        organizationId,
        patch,
        gotrueId,
        auditContext,
      )
      if (!updated) return notFoundResponse('Signing key not found')
      return Response.json(updated, { headers: corsHeaders })
    }
    if (method === 'DELETE') {
      const deleted = await deleteSigningKey(
        pool,
        ref,
        id,
        profileId,
        organizationId,
        gotrueId,
        auditContext,
      )
      if (!deleted) return notFoundResponse('Signing key not found')
      return Response.json(deleted, { headers: corsHeaders })
    }
    return methodNotAllowedResponse()
  }

  return notFoundResponse()
}
