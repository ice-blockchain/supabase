import type { Pool } from 'https://deno.land/x/postgres@v0.19.3/mod.ts'

import { corsHeaders } from '../index.ts'
import {
  deleteRemoteFunction,
  deployRemoteFunction,
  type FunctionMeta,
  FUNCTIONS_DIR,
  loadFunctionMeta,
  parseFunctionDir,
  patchRemoteFunction,
} from '../services/edge-functions.service.ts'
import {
  getProjectBackend,
  isSharedStack,
  type ProjectBackend,
  ProjectBackendNotProvisionedError,
} from '../services/project-backend.service.ts'
import { getProjectByRef } from '../services/project.service.ts'
import { getClientIp } from '../utils/client-ip.ts'
import { notProvisionedResponse } from '../utils/project-backend-response.ts'
import { assertValidRef } from '../utils/ref-validation.ts'

// ── Constants ──────────────────────────────────────────────
//
// L4: `FUNCTIONS_DIR`, `FunctionEntry`, `FunctionMeta`, `parseFunctionDir`,
// and `loadFunctionMeta` are imported from
// `services/edge-functions.service.ts`. The read handlers in
// routes/projects.ts use the same helpers, which means a function returned
// by GET and the same function after a PATCH now go through a single
// implementation — no more silent drift between the two copies.

const RESERVED_SLUGS = new Set(['main', 'traffic-one'])
const SLUG_PATTERN = /^[a-z0-9_-]+$/
const FS_READONLY_MESSAGE = 'Functions directory is not writable'

interface AuditParams {
  profileId: number
  organizationId: number
  gotrueId: string
  email: string
  ip: string
  method: string
  route: string
  status: number
  action: string
  target: string
}

interface RequestContext {
  profileId: number
  gotrueId: string
  email: string
  ip: string
  method: string
}

// ── Response helpers ───────────────────────────────────────

function notFoundResponse(message = 'Not found'): Response {
  return Response.json({ message }, { status: 404, headers: corsHeaders })
}

function methodNotAllowedResponse(): Response {
  return Response.json({ message: 'Method not allowed' }, { status: 405, headers: corsHeaders })
}

function badRequestResponse(message: string, code?: string): Response {
  const body: Record<string, unknown> = { message }
  if (code) body.code = code
  return Response.json(body, { status: 400, headers: corsHeaders })
}

function reservedSlugResponse(): Response {
  return Response.json(
    { code: 'reserved_slug', message: 'This slug is reserved' },
    { status: 403, headers: corsHeaders },
  )
}

function invalidSlugResponse(): Response {
  return badRequestResponse('Slug must match /^[a-z0-9_-]+$/', 'invalid_slug')
}

function fsReadonlyResponse(): Response {
  return Response.json(
    { code: 'fs_readonly', message: FS_READONLY_MESSAGE },
    { status: 503, headers: corsHeaders },
  )
}

// ── FS writability probe (cached per-process) ──────────────

let fsWritableCache: boolean | null = null

async function isFunctionsDirWritable(): Promise<boolean> {
  if (fsWritableCache !== null) return fsWritableCache
  try {
    const stat = await Deno.stat(FUNCTIONS_DIR)
    if (!stat.isDirectory) {
      fsWritableCache = false
      return false
    }
    const marker = `${FUNCTIONS_DIR}/.traffic-one-write-probe-${crypto.randomUUID()}`
    await Deno.writeTextFile(marker, 'probe')
    await Deno.remove(marker).catch(() => undefined)
    fsWritableCache = true
    return true
  } catch {
    fsWritableCache = false
    return false
  }
}

function isReadonlyFsError(err: unknown): boolean {
  if (err instanceof Deno.errors.PermissionDenied) return true
  const code = (err as { code?: string })?.code
  return code === 'EROFS' || code === 'EACCES'
}

// ── Meta sidecar IO ────────────────────────────────────────
//
// L4: `loadFunctionMeta` (formerly local `loadMeta`) is imported from the
// shared service. `writeMeta` stays local because the mutation side is the
// only caller that persists `.meta.json`.

async function writeMeta(slug: string, meta: FunctionMeta): Promise<void> {
  const path = `${FUNCTIONS_DIR}/${slug}/.meta.json`
  await Deno.writeTextFile(path, JSON.stringify(meta, null, 2))
}

// ── Audit logging ──────────────────────────────────────────

async function writeAudit(pool: Pool, params: AuditParams): Promise<void> {
  const connection = await pool.connect()
  try {
    await connection.queryObject`
      INSERT INTO traffic.audit_logs (
        id, profile_id, organization_id, action_name, action_metadata,
        actor_id, actor_type, actor_metadata,
        target_description, target_metadata, occurred_at
      ) VALUES (
        gen_random_uuid(), ${params.profileId}, ${params.organizationId}, ${params.action},
        ${
      JSON.stringify([
        { method: params.method, route: params.route, status: params.status },
      ])
    }::jsonb,
        ${params.gotrueId}, 'user',
        ${JSON.stringify([{ email: params.email, ip: params.ip }])}::jsonb,
        ${params.target}, '{}'::jsonb, now()
      )
    `
  } finally {
    connection.release()
  }
}

// ── Filename safety ────────────────────────────────────────

function sanitizeFilename(name: string): string | null {
  if (!name || name.length === 0) return null
  if (name.includes('..') || name.includes('/') || name.includes('\\')) return null
  // Reserve the dotfile namespace for the `.meta.json` sidecar.
  if (name.startsWith('.')) return null
  return name
}

function auditTarget(ref: string, slug: string): string {
  return `edge_function ${slug} (project: ${ref})`
}

// ── Deploy body parsing ────────────────────────────────────

interface DeployInput {
  slug?: string
  name?: string
  verify_jwt?: boolean
  entrypoint_path?: string
  import_map_path?: string
  files: Array<{ name: string; content: string }>
}

function coerceBool(value: unknown): boolean | undefined {
  if (typeof value === 'boolean') return value
  if (typeof value === 'string') {
    if (value === 'true' || value === '1') return true
    if (value === 'false' || value === '0') return false
  }
  return undefined
}

async function parseDeployBody(req: Request): Promise<DeployInput | Response> {
  const contentType = req.headers.get('content-type') ?? ''
  const input: DeployInput = { files: [] }

  if (contentType.includes('multipart/form-data')) {
    let formData: FormData
    try {
      formData = await req.formData()
    } catch {
      return badRequestResponse('Invalid multipart body')
    }

    const slugField = formData.get('slug')
    if (typeof slugField === 'string') input.slug = slugField
    const nameField = formData.get('name')
    if (typeof nameField === 'string') input.name = nameField
    const verifyJwt = coerceBool(formData.get('verify_jwt'))
    if (verifyJwt !== undefined) input.verify_jwt = verifyJwt
    const entrypointField = formData.get('entrypoint_path')
    if (typeof entrypointField === 'string') input.entrypoint_path = entrypointField
    const importMapField = formData.get('import_map_path')
    if (typeof importMapField === 'string') input.import_map_path = importMapField

    for (const fieldName of ['file', 'files']) {
      for (const entry of formData.getAll(fieldName)) {
        if (entry instanceof File) {
          const filename = entry.name || 'index.ts'
          input.files.push({ name: filename, content: await entry.text() })
        }
      }
    }

    return input
  }

  let body: Record<string, unknown> | null
  try {
    body = (await req.json()) as Record<string, unknown>
  } catch {
    return badRequestResponse('Invalid JSON body')
  }
  if (!body || typeof body !== 'object') {
    return badRequestResponse('Invalid body')
  }

  if (typeof body.slug === 'string') input.slug = body.slug
  if (typeof body.name === 'string') input.name = body.name
  if (typeof body.verify_jwt === 'boolean') input.verify_jwt = body.verify_jwt
  if (typeof body.entrypoint_path === 'string') input.entrypoint_path = body.entrypoint_path
  if (typeof body.import_map_path === 'string') input.import_map_path = body.import_map_path

  const rawFiles = Array.isArray(body.body)
    ? body.body
    : Array.isArray(body.files)
    ? body.files
    : []
  for (const f of rawFiles as unknown[]) {
    if (f && typeof f === 'object') {
      const entry = f as { name?: unknown; content?: unknown }
      if (typeof entry.name === 'string' && typeof entry.content === 'string') {
        input.files.push({ name: entry.name, content: entry.content })
      }
    }
  }

  return input
}

// ── Sub-handlers ───────────────────────────────────────────

async function handleDeploy(
  req: Request,
  pool: Pool,
  project: { id: number; ref: string; organization_id: number },
  backend: ProjectBackend,
  ctx: RequestContext,
): Promise<Response> {
  const parsed = await parseDeployBody(req)
  if (parsed instanceof Response) return parsed

  const { slug, name, verify_jwt, entrypoint_path, import_map_path, files } = parsed

  if (!slug) return badRequestResponse('slug is required')
  if (!SLUG_PATTERN.test(slug)) return invalidSlugResponse()
  if (RESERVED_SLUGS.has(slug)) return reservedSlugResponse()
  if (files.length === 0) return badRequestResponse('at least one file is required')
  for (const file of files) {
    if (!sanitizeFilename(file.name)) {
      return badRequestResponse(`invalid filename: ${file.name}`)
    }
  }

  // Per-project path: proxy to the project's runtime over HTTPS. The
  // orchestrator-owned service owns the filesystem, so we never touch disk
  // here. Audit on success.
  if (!isSharedStack(backend)) {
    const result = await deployRemoteFunction(backend, {
      slug,
      name,
      verify_jwt,
      entrypoint_path,
      import_map_path,
      files,
    })
    if (result.ok !== true) {
      return Response.json(
        { message: result.message },
        { status: result.status, headers: corsHeaders },
      )
    }
    await writeAudit(pool, {
      profileId: ctx.profileId,
      organizationId: project.organization_id,
      gotrueId: ctx.gotrueId,
      email: ctx.email,
      ip: ctx.ip,
      method: ctx.method,
      route: `/v1/projects/${project.ref}/functions/deploy`,
      status: 201,
      action: 'project.edge_function_deployed',
      target: auditTarget(project.ref, slug),
    }).catch((err) => console.error('edge_function_deployed audit insert failed:', err))
    return Response.json(result.entry, { status: 201, headers: corsHeaders })
  }

  // Shared-stack path: traffic-one owns the filesystem mount and writes
  // directly. This is the local Docker / single-tenant mode.
  if (!(await isFunctionsDirWritable())) return fsReadonlyResponse()

  const dir = `${FUNCTIONS_DIR}/${slug}`

  try {
    await Deno.mkdir(dir, { recursive: true })
    for (const file of files) {
      const safeName = sanitizeFilename(file.name)
      if (!safeName) return badRequestResponse(`invalid filename: ${file.name}`)
      await Deno.writeTextFile(`${dir}/${safeName}`, file.content)
    }

    const existingMeta = await loadFunctionMeta(slug)
    const meta: FunctionMeta = { ...existingMeta }
    if (name !== undefined) meta.name = name
    if (verify_jwt !== undefined) meta.verify_jwt = verify_jwt
    if (entrypoint_path !== undefined) meta.entrypoint_path = entrypoint_path
    if (import_map_path !== undefined) meta.import_map_path = import_map_path
    await writeMeta(slug, meta)

    // NOTE: We intentionally do NOT call Deno.reload() here. The edge-runtime
    // service (`supabase-edge-functions`) picks up new function directories on
    // the next cold start of the request handler; there is no supported
    // hot-reload signal, and forcing a process-level reload would interrupt
    // other in-flight function invocations. Document this contract so Studio
    // users know to invoke the function once to warm the new version.

    const entry = await parseFunctionDir(slug, meta)

    await writeAudit(pool, {
      profileId: ctx.profileId,
      organizationId: project.organization_id,
      gotrueId: ctx.gotrueId,
      email: ctx.email,
      ip: ctx.ip,
      method: ctx.method,
      route: `/v1/projects/${project.ref}/functions/deploy`,
      status: 201,
      action: 'project.edge_function_deployed',
      target: auditTarget(project.ref, slug),
    }).catch((err) => console.error('edge_function_deployed audit insert failed:', err))

    return Response.json(entry ?? { slug, name: name ?? slug }, {
      status: 201,
      headers: corsHeaders,
    })
  } catch (err) {
    if (isReadonlyFsError(err)) return fsReadonlyResponse()
    console.error('edge function deploy error:', err)
    return Response.json(
      { message: 'Failed to deploy function' },
      { status: 500, headers: corsHeaders },
    )
  }
}

async function handlePatch(
  req: Request,
  slug: string,
  pool: Pool,
  project: { id: number; ref: string; organization_id: number },
  backend: ProjectBackend,
  ctx: RequestContext,
): Promise<Response> {
  if (!SLUG_PATTERN.test(slug)) return invalidSlugResponse()
  if (RESERVED_SLUGS.has(slug)) return reservedSlugResponse()

  let body: Record<string, unknown>
  try {
    body = (await req.json()) as Record<string, unknown>
  } catch {
    return badRequestResponse('Invalid JSON body')
  }
  if (!body || typeof body !== 'object') {
    return badRequestResponse('Invalid body')
  }

  const updates: FunctionMeta = {}
  if (typeof body.name === 'string') updates.name = body.name
  if (typeof body.verify_jwt === 'boolean') updates.verify_jwt = body.verify_jwt
  if (typeof body.entrypoint_path === 'string') updates.entrypoint_path = body.entrypoint_path
  if (typeof body.import_map_path === 'string') updates.import_map_path = body.import_map_path

  if (!isSharedStack(backend)) {
    const entry = await patchRemoteFunction(backend, slug, updates)
    if (!entry) return notFoundResponse('Function not found')
    await writeAudit(pool, {
      profileId: ctx.profileId,
      organizationId: project.organization_id,
      gotrueId: ctx.gotrueId,
      email: ctx.email,
      ip: ctx.ip,
      method: ctx.method,
      route: `/v1/projects/${project.ref}/functions/${slug}`,
      status: 200,
      action: 'project.edge_function_updated',
      target: auditTarget(project.ref, slug),
    }).catch((err) => console.error('edge_function_updated audit insert failed:', err))
    return Response.json(entry, { headers: corsHeaders })
  }

  if (!(await isFunctionsDirWritable())) return fsReadonlyResponse()

  const dir = `${FUNCTIONS_DIR}/${slug}`
  try {
    const stat = await Deno.stat(dir)
    if (!stat.isDirectory) return notFoundResponse('Function not found')
  } catch {
    return notFoundResponse('Function not found')
  }

  const existing = await loadFunctionMeta(slug)
  const merged: FunctionMeta = { ...existing, ...updates }

  try {
    await writeMeta(slug, merged)
  } catch (err) {
    if (isReadonlyFsError(err)) return fsReadonlyResponse()
    throw err
  }

  const entry = await parseFunctionDir(slug, merged)
  if (!entry) return notFoundResponse('Function not found')

  await writeAudit(pool, {
    profileId: ctx.profileId,
    organizationId: project.organization_id,
    gotrueId: ctx.gotrueId,
    email: ctx.email,
    ip: ctx.ip,
    method: ctx.method,
    route: `/v1/projects/${project.ref}/functions/${slug}`,
    status: 200,
    action: 'project.edge_function_updated',
    target: auditTarget(project.ref, slug),
  }).catch((err) => console.error('edge_function_updated audit insert failed:', err))

  return Response.json(entry, { headers: corsHeaders })
}

async function handleDelete(
  slug: string,
  pool: Pool,
  project: { id: number; ref: string; organization_id: number },
  backend: ProjectBackend,
  ctx: RequestContext,
): Promise<Response> {
  if (!SLUG_PATTERN.test(slug)) return invalidSlugResponse()
  if (RESERVED_SLUGS.has(slug)) return reservedSlugResponse()

  if (!isSharedStack(backend)) {
    const ok = await deleteRemoteFunction(backend, slug)
    if (!ok) return notFoundResponse('Function not found')
    await writeAudit(pool, {
      profileId: ctx.profileId,
      organizationId: project.organization_id,
      gotrueId: ctx.gotrueId,
      email: ctx.email,
      ip: ctx.ip,
      method: ctx.method,
      route: `/v1/projects/${project.ref}/functions/${slug}`,
      status: 200,
      action: 'project.edge_function_deleted',
      target: auditTarget(project.ref, slug),
    }).catch((err) => console.error('edge_function_deleted audit insert failed:', err))
    return Response.json({ slug, deleted: true }, { headers: corsHeaders })
  }

  if (!(await isFunctionsDirWritable())) return fsReadonlyResponse()

  const dir = `${FUNCTIONS_DIR}/${slug}`
  try {
    const stat = await Deno.stat(dir)
    if (!stat.isDirectory) return notFoundResponse('Function not found')
  } catch {
    return notFoundResponse('Function not found')
  }

  try {
    await Deno.remove(dir, { recursive: true })
  } catch (err) {
    if (err instanceof Deno.errors.NotFound) {
      return notFoundResponse('Function not found')
    }
    if (isReadonlyFsError(err)) return fsReadonlyResponse()
    throw err
  }

  await writeAudit(pool, {
    profileId: ctx.profileId,
    organizationId: project.organization_id,
    gotrueId: ctx.gotrueId,
    email: ctx.email,
    ip: ctx.ip,
    method: ctx.method,
    route: `/v1/projects/${project.ref}/functions/${slug}`,
    status: 200,
    action: 'project.edge_function_deleted',
    target: auditTarget(project.ref, slug),
  }).catch((err) => console.error('edge_function_deleted audit insert failed:', err))

  return Response.json({ slug, deleted: true }, { headers: corsHeaders })
}

// ── Main dispatcher ────────────────────────────────────────

// Parent routes PATCH/DELETE `/{ref}/functions/{slug}` and POST
// `/{ref}/functions/deploy` here. GET handlers remain in projects.ts.
export async function handleEdgeFunctionMutations(
  req: Request,
  path: string,
  method: string,
  pool: Pool,
  profileId: number,
  gotrueId: string,
  email: string,
): Promise<Response> {
  const deployMatch = path.match(/^\/([^/]+)\/functions\/deploy\/?$/)
  const slugMatch = path.match(/^\/([^/]+)\/functions\/([^/]+)\/?$/)

  if (!deployMatch && !slugMatch) {
    return notFoundResponse()
  }

  const ref = (deployMatch ?? slugMatch)![1]

  // L4: malformed ref → 400 before we touch the DB, the backend resolver,
  // or the functions filesystem. Applies to both `/deploy` and `/{slug}`.
  const bad = assertValidRef(ref)
  if (bad) return bad

  const project = await getProjectByRef(pool, ref, profileId)
  if (!project) {
    return notFoundResponse('Project not found')
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

  const ip = getClientIp(req)
  const ctx: RequestContext = { profileId, gotrueId, email, ip, method }

  if (deployMatch) {
    if (method !== 'POST') return methodNotAllowedResponse()
    return handleDeploy(req, pool, project, backend, ctx)
  }

  const slug = slugMatch![2]

  if (method === 'PATCH') return handlePatch(req, slug, pool, project, backend, ctx)
  if (method === 'DELETE') return handleDelete(slug, pool, project, backend, ctx)
  return methodNotAllowedResponse()
}
