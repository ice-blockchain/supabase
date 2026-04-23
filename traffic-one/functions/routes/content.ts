import type { Pool } from 'https://deno.land/x/postgres@v0.17.0/mod.ts'

import { corsHeaders } from '../index.ts'
import {
  ContentForbiddenError,
  countContent,
  createFolder,
  deleteContentBulk,
  deleteFoldersBulk,
  getContentById,
  listContent,
  listFolderContents,
  listRootFolder,
  patchContent,
  toDetailItem,
  toFolderListItem,
  toFolderMetadata,
  toListItem,
  updateFolder,
  upsertContent,
  type AuditContext,
  type ContentType,
  type ContentVisibility,
  type UpsertContentInput,
} from '../services/content.service.ts'
import { getProjectByRef } from '../services/project.service.ts'
import { getClientIp } from '../utils/client-ip.ts'

// ── Response helpers ───────────────────────────────────────

function json(body: unknown, status = 200): Response {
  return Response.json(body, { status, headers: corsHeaders })
}

function badRequest(message: string): Response {
  return json({ message }, 400)
}

function forbidden(message = 'Forbidden'): Response {
  return json({ message }, 403)
}

function notFound(message = 'Not Found'): Response {
  return json({ message }, 404)
}

function methodNotAllowed(): Response {
  return json({ message: 'Method not allowed' }, 405)
}

// ── Parsing helpers ────────────────────────────────────────

const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i

function isUuid(v: string): boolean {
  return UUID_RE.test(v)
}

function parseIntSafe(raw: string | null): number | undefined {
  if (raw === null) return undefined
  const parsed = Number.parseInt(raw, 10)
  return Number.isFinite(parsed) ? parsed : undefined
}

function parseBooleanSafe(raw: string | null): boolean | undefined {
  if (raw === null) return undefined
  if (raw === 'true') return true
  if (raw === 'false') return false
  return undefined
}

function parseType(raw: string | null | undefined): ContentType | undefined {
  if (raw === 'sql' || raw === 'report' || raw === 'log_sql') return raw
  return undefined
}

function parseVisibility(raw: string | null | undefined): ContentVisibility | undefined {
  if (raw === 'user' || raw === 'project') return raw
  return undefined
}

function parseSortBy(raw: string | null | undefined): 'name' | 'inserted_at' | undefined {
  if (raw === 'name' || raw === 'inserted_at') return raw
  return undefined
}

function parseSortOrder(raw: string | null | undefined): 'asc' | 'desc' | undefined {
  if (raw === 'asc' || raw === 'desc') return raw
  return undefined
}

function offsetFromCursor(cursor: string | null): number | undefined {
  if (!cursor) return undefined
  const n = Number.parseInt(cursor, 10)
  return Number.isFinite(n) && n >= 0 ? n : undefined
}

async function readJsonBody(req: Request): Promise<Record<string, unknown>> {
  try {
    const body = await req.json()
    if (body && typeof body === 'object' && !Array.isArray(body)) {
      return body as Record<string, unknown>
    }
  } catch {
    // ignore
  }
  return {}
}

function parseIdsList(raw: unknown): string[] {
  if (Array.isArray(raw)) {
    return raw.filter((x): x is string => typeof x === 'string' && isUuid(x))
  }
  if (typeof raw === 'string' && raw.length > 0) {
    return raw
      .split(',')
      .map((s) => s.trim())
      .filter(isUuid)
  }
  return []
}

function mapServiceError(err: unknown): Response {
  if (err instanceof ContentForbiddenError) {
    return forbidden(err.message)
  }
  if (err instanceof Error) {
    const msg = err.message
    if (msg === 'Parent folder not found' || msg === 'Cannot set a folder as its own parent') {
      return badRequest(msg)
    }
  }
  throw err
}

// ── Handler ────────────────────────────────────────────────

export async function handleContent(
  req: Request,
  path: string,
  method: string,
  pool: Pool,
  profileId: number,
  gotrueId: string,
  email: string
): Promise<Response> {
  const refMatch = path.match(/^\/([^/]+)\/content(\/.*)?$/)
  if (!refMatch) return notFound()

  const ref = refMatch[1]
  const subPath = refMatch[2] ?? ''

  const project = await getProjectByRef(pool, ref, profileId)
  if (!project) {
    return notFound('Project not found')
  }
  const projectId = project.id
  const projectOrgId = project.organization_id

  const ip = getClientIp(req)
  const auditContext: AuditContext = {
    email,
    ip,
    method,
    route: '/projects/' + ref + '/content' + subPath,
  }

  const url = new URL(req.url)

  try {
    // ── /content (root resource) ──────────────────────────
    if (subPath === '' || subPath === '/') {
      if (method === 'GET') {
        return await handleListRoot(url, pool, ref, profileId, projectId)
      }
      if (method === 'POST' || method === 'PUT') {
        return await handleUpsert(
          req,
          pool,
          ref,
          projectId,
          projectOrgId,
          profileId,
          gotrueId,
          auditContext,
          method === 'POST'
        )
      }
      if (method === 'DELETE') {
        return await handleBulkDelete(
          req,
          url,
          pool,
          ref,
          projectOrgId,
          profileId,
          gotrueId,
          auditContext
        )
      }
      return methodNotAllowed()
    }

    // ── /content/count ────────────────────────────────────
    if (subPath === '/count') {
      if (method === 'GET') {
        return await handleCount(url, pool, ref, profileId)
      }
      return methodNotAllowed()
    }

    // ── /content/item/{id} ────────────────────────────────
    const itemMatch = subPath.match(/^\/item\/([^/]+)$/)
    if (itemMatch) {
      const id = itemMatch[1]
      if (!isUuid(id)) return notFound('Invalid content id')

      if (method === 'GET') {
        return await handleGetItem(pool, ref, profileId, projectId, id)
      }
      if (method === 'PATCH') {
        return await handlePatchItem(
          req,
          pool,
          ref,
          projectId,
          projectOrgId,
          profileId,
          gotrueId,
          auditContext,
          id
        )
      }
      return methodNotAllowed()
    }

    // ── /content/folders ──────────────────────────────────
    if (subPath === '/folders') {
      if (method === 'GET') {
        return await handleListRootFolders(url, pool, ref, profileId, projectId)
      }
      if (method === 'POST') {
        return await handleCreateFolder(
          req,
          pool,
          ref,
          projectId,
          projectOrgId,
          profileId,
          gotrueId,
          auditContext
        )
      }
      if (method === 'DELETE') {
        return await handleBulkDeleteFolders(
          req,
          url,
          pool,
          ref,
          projectOrgId,
          profileId,
          gotrueId,
          auditContext
        )
      }
      return methodNotAllowed()
    }

    // ── /content/folders/{id} ─────────────────────────────
    const folderMatch = subPath.match(/^\/folders\/([^/]+)$/)
    if (folderMatch) {
      const id = folderMatch[1]
      if (!isUuid(id)) return notFound('Invalid folder id')

      if (method === 'GET') {
        return await handleGetFolder(url, pool, ref, profileId, projectId, id)
      }
      if (method === 'PATCH') {
        return await handlePatchFolder(
          req,
          pool,
          ref,
          projectId,
          projectOrgId,
          profileId,
          gotrueId,
          auditContext,
          id
        )
      }
      return methodNotAllowed()
    }

    return notFound()
  } catch (err) {
    return mapServiceError(err)
  }
}

// ── GET /content — list ────────────────────────────────────

async function handleListRoot(
  url: URL,
  pool: Pool,
  ref: string,
  profileId: number,
  projectId: number
): Promise<Response> {
  const q = url.searchParams
  const limit = parseIntSafe(q.get('limit'))
  const cursor = q.get('cursor')
  const offset = offsetFromCursor(cursor) ?? parseIntSafe(q.get('offset'))

  const result = await listContent(pool, ref, profileId, {
    type: parseType(q.get('type')),
    visibility: parseVisibility(q.get('visibility')),
    favorite: parseBooleanSafe(q.get('favorite')),
    name: q.get('name') ?? undefined,
    limit,
    offset,
    sortBy: parseSortBy(q.get('sort_by')),
    sortOrder: parseSortOrder(q.get('sort_order')),
  })

  return json({
    data: result.rows.map((row) => toListItem(row, projectId)),
    cursor: result.cursor,
  })
}

// ── GET /content/count ─────────────────────────────────────

async function handleCount(
  url: URL,
  pool: Pool,
  ref: string,
  profileId: number
): Promise<Response> {
  const q = url.searchParams
  const result = await countContent(pool, ref, profileId, {
    type: parseType(q.get('type')),
    name: q.get('name') ?? undefined,
  })
  return json(result)
}

// ── GET /content/item/{id} ─────────────────────────────────

async function handleGetItem(
  pool: Pool,
  ref: string,
  profileId: number,
  projectId: number,
  id: string
): Promise<Response> {
  const row = await getContentById(pool, ref, profileId, id)
  if (!row) return notFound('Content not found')
  return json(toDetailItem(row, projectId))
}

// ── POST/PUT /content — upsert ─────────────────────────────

async function handleUpsert(
  req: Request,
  pool: Pool,
  ref: string,
  projectId: number,
  projectOrgId: number,
  profileId: number,
  gotrueId: string,
  auditContext: AuditContext,
  isCreate: boolean
): Promise<Response> {
  const body = await readJsonBody(req)
  const typeRaw = typeof body.type === 'string' ? body.type : undefined
  const type = parseType(typeRaw) ?? 'sql'
  const visibility = parseVisibility(
    typeof body.visibility === 'string' ? body.visibility : undefined
  )

  const rawId = typeof body.id === 'string' ? body.id : undefined
  if (rawId !== undefined && !isUuid(rawId)) {
    return badRequest('Invalid id format')
  }

  const folderIdRaw = body.folder_id
  let folderId: string | null | undefined = undefined
  if (folderIdRaw === null) {
    folderId = null
  } else if (typeof folderIdRaw === 'string') {
    if (!isUuid(folderIdRaw)) return badRequest('Invalid folder_id')
    folderId = folderIdRaw
  }

  const input: UpsertContentInput = {
    id: rawId,
    name: typeof body.name === 'string' ? body.name : undefined,
    description: typeof body.description === 'string' ? body.description : undefined,
    type,
    visibility,
    content:
      body.content && typeof body.content === 'object' && !Array.isArray(body.content)
        ? (body.content as Record<string, unknown>)
        : undefined,
    favorite: typeof body.favorite === 'boolean' ? body.favorite : undefined,
    folder_id: folderId,
  }

  const row = await upsertContent(pool, ref, projectOrgId, profileId, gotrueId, input, auditContext)
  return json(toListItem(row, projectId), isCreate ? 201 : 200)
}

// ── DELETE /content — bulk ────────────────────────────────

async function handleBulkDelete(
  req: Request,
  url: URL,
  pool: Pool,
  ref: string,
  projectOrgId: number,
  profileId: number,
  gotrueId: string,
  auditContext: AuditContext
): Promise<Response> {
  const queryIds = parseIdsList(url.searchParams.get('ids'))
  let ids = queryIds
  if (ids.length === 0) {
    const body = await readJsonBody(req)
    ids = parseIdsList(body.ids)
  }
  if (ids.length === 0) {
    return json({ deleted: 0 })
  }

  const result = await deleteContentBulk(
    pool,
    ref,
    projectOrgId,
    profileId,
    gotrueId,
    ids,
    auditContext
  )
  return json({ deleted: result.deletedIds.length, ids: result.deletedIds })
}

// ── PATCH /content/item/{id} ───────────────────────────────

async function handlePatchItem(
  req: Request,
  pool: Pool,
  ref: string,
  projectId: number,
  projectOrgId: number,
  profileId: number,
  gotrueId: string,
  auditContext: AuditContext,
  id: string
): Promise<Response> {
  const body = await readJsonBody(req)

  const visibility = parseVisibility(
    typeof body.visibility === 'string' ? body.visibility : undefined
  )

  const folderIdRaw = body.folder_id
  let folderId: string | null | undefined = undefined
  if (folderIdRaw === null) {
    folderId = null
  } else if (typeof folderIdRaw === 'string') {
    if (!isUuid(folderIdRaw)) return badRequest('Invalid folder_id')
    folderId = folderIdRaw
  }

  const patch = {
    name: typeof body.name === 'string' ? body.name : undefined,
    description: typeof body.description === 'string' ? body.description : undefined,
    visibility,
    content:
      body.content && typeof body.content === 'object' && !Array.isArray(body.content)
        ? (body.content as Record<string, unknown>)
        : undefined,
    favorite: typeof body.favorite === 'boolean' ? body.favorite : undefined,
    ...(folderId !== undefined ? { folder_id: folderId } : {}),
  }

  const row = await patchContent(
    pool,
    ref,
    projectOrgId,
    profileId,
    gotrueId,
    id,
    patch,
    auditContext
  )
  if (!row) return notFound('Content not found')
  return json(toDetailItem(row, projectId))
}

// ── GET /content/folders — root listing ────────────────────

async function handleListRootFolders(
  url: URL,
  pool: Pool,
  ref: string,
  profileId: number,
  projectId: number
): Promise<Response> {
  const q = url.searchParams
  const limit = parseIntSafe(q.get('limit'))
  const cursor = q.get('cursor')
  const offset = offsetFromCursor(cursor) ?? parseIntSafe(q.get('offset'))

  const result = await listRootFolder(pool, ref, profileId, {
    type: parseType(q.get('type')),
    name: q.get('name') ?? undefined,
    limit,
    offset,
    sortBy: parseSortBy(q.get('sort_by')),
    sortOrder: parseSortOrder(q.get('sort_order')),
  })

  return json({
    data: {
      folders: result.folders.map((f) => toFolderMetadata(f, projectId)),
      contents: result.contents.map((row) => toFolderListItem(row, projectId)),
    },
    cursor: result.cursor,
  })
}

// ── POST /content/folders ──────────────────────────────────

async function handleCreateFolder(
  req: Request,
  pool: Pool,
  ref: string,
  projectId: number,
  projectOrgId: number,
  profileId: number,
  gotrueId: string,
  auditContext: AuditContext
): Promise<Response> {
  const body = await readJsonBody(req)
  const name = typeof body.name === 'string' ? body.name.trim() : ''
  if (name.length === 0) return badRequest('name is required')

  const parentRaw =
    typeof body.parent_id === 'string'
      ? body.parent_id
      : typeof body.parentId === 'string'
        ? body.parentId
        : null
  const parentId = parentRaw && isUuid(parentRaw) ? parentRaw : null
  if (parentRaw && !parentId) {
    return badRequest('Invalid parent folder id')
  }

  const folder = await createFolder(
    pool,
    ref,
    projectOrgId,
    profileId,
    gotrueId,
    name,
    parentId,
    auditContext
  )
  return json(toFolderMetadata(folder, projectId), 201)
}

// ── DELETE /content/folders — bulk ────────────────────────

async function handleBulkDeleteFolders(
  req: Request,
  url: URL,
  pool: Pool,
  ref: string,
  projectOrgId: number,
  profileId: number,
  gotrueId: string,
  auditContext: AuditContext
): Promise<Response> {
  const queryIds = parseIdsList(url.searchParams.getAll('ids').join(','))
  let ids = queryIds
  if (ids.length === 0) {
    const singleQueryIds = parseIdsList(url.searchParams.get('ids'))
    if (singleQueryIds.length > 0) ids = singleQueryIds
  }
  if (ids.length === 0) {
    const body = await readJsonBody(req)
    ids = parseIdsList(body.ids)
  }
  if (ids.length === 0) {
    return json({ deleted: 0, ids: [] })
  }

  const result = await deleteFoldersBulk(
    pool,
    ref,
    projectOrgId,
    profileId,
    gotrueId,
    ids,
    auditContext
  )
  return json({ deleted: result.deletedIds.length, ids: result.deletedIds })
}

// ── GET /content/folders/{id} ─────────────────────────────

async function handleGetFolder(
  url: URL,
  pool: Pool,
  ref: string,
  profileId: number,
  projectId: number,
  folderId: string
): Promise<Response> {
  const q = url.searchParams
  const limit = parseIntSafe(q.get('limit'))
  const cursor = q.get('cursor')
  const offset = offsetFromCursor(cursor) ?? parseIntSafe(q.get('offset'))

  const result = await listFolderContents(pool, ref, profileId, folderId, {
    name: q.get('name') ?? undefined,
    limit,
    offset,
    sortBy: parseSortBy(q.get('sort_by')),
    sortOrder: parseSortOrder(q.get('sort_order')),
  })

  if (!result.folder) return notFound('Folder not found')

  return json({
    data: {
      folders: result.folders.map((f) => toFolderMetadata(f, projectId)),
      contents: result.contents.map((row) => toFolderListItem(row, projectId)),
    },
    cursor: result.cursor,
  })
}

// ── PATCH /content/folders/{id} ───────────────────────────

async function handlePatchFolder(
  req: Request,
  pool: Pool,
  ref: string,
  projectId: number,
  projectOrgId: number,
  profileId: number,
  gotrueId: string,
  auditContext: AuditContext,
  folderId: string
): Promise<Response> {
  const body = await readJsonBody(req)
  const name = typeof body.name === 'string' ? body.name.trim() : undefined

  let parentId: string | null | undefined
  if (body.parent_id === null || body.parentId === null) {
    parentId = null
  } else if (typeof body.parent_id === 'string') {
    if (!isUuid(body.parent_id)) return badRequest('Invalid parent_id')
    parentId = body.parent_id
  } else if (typeof body.parentId === 'string') {
    if (!isUuid(body.parentId)) return badRequest('Invalid parentId')
    parentId = body.parentId
  }

  if (name === undefined && parentId === undefined) {
    return badRequest('At least one of name or parent_id must be provided')
  }
  if (name !== undefined && name.length === 0) {
    return badRequest('name cannot be empty')
  }

  const folder = await updateFolder(
    pool,
    ref,
    projectOrgId,
    profileId,
    gotrueId,
    folderId,
    { name, parentId },
    auditContext
  )
  if (!folder) return notFound('Folder not found')
  return json(toFolderMetadata(folder, projectId))
}
