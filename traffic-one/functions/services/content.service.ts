import type { Pool } from 'https://deno.land/x/postgres@v0.19.3/mod.ts'

// ── Typed forbidden marker ─────────────────────────────────

export class ContentForbiddenError extends Error {
  constructor(message = 'Forbidden') {
    super(message)
    this.name = 'ContentForbiddenError'
  }
}

// ── Types ──────────────────────────────────────────────────

export type ContentType = 'sql' | 'report' | 'log_sql'
export type ContentVisibility = 'user' | 'project'

export interface AuditContext {
  email: string
  ip: string
  method: string
  route: string
}

export interface ContentItemRow {
  id: string
  project_ref: string
  owner_id: number
  folder_id: string | null
  name: string
  description: string
  type: ContentType
  visibility: ContentVisibility
  content: Record<string, unknown>
  favorite: boolean
  inserted_at: string
  updated_at: string
  owner_username: string
}

export interface ContentFolderRow {
  id: string
  project_ref: string
  owner_id: number
  parent_id: string | null
  name: string
  inserted_at: string
  updated_at: string
}

export interface ContentListOptions {
  type?: ContentType
  visibility?: ContentVisibility
  favorite?: boolean
  name?: string
  limit?: number
  offset?: number
  sortBy?: 'name' | 'inserted_at'
  sortOrder?: 'asc' | 'desc'
}

export interface ContentFolderListOptions {
  type?: ContentType
  name?: string
  limit?: number
  offset?: number
  sortBy?: 'name' | 'inserted_at'
  sortOrder?: 'asc' | 'desc'
}

export interface UpsertContentInput {
  id?: string
  name?: string
  description?: string
  type: ContentType
  visibility?: ContentVisibility
  content?: Record<string, unknown>
  favorite?: boolean
  folder_id?: string | null
}

export interface PatchContentInput {
  name?: string
  description?: string
  visibility?: ContentVisibility
  content?: Record<string, unknown>
  favorite?: boolean
  folder_id?: string | null
}

// ── Shape helpers ──────────────────────────────────────────

export interface ContentListItem {
  id: string
  name: string
  description: string
  type: ContentType
  visibility: ContentVisibility
  content: Record<string, unknown>
  favorite: boolean
  folder_id: string | null
  owner_id: number
  project_id: number
  inserted_at: string
  updated_at: string
  last_updated_by: number
  owner: { id: number; username: string }
  updated_by: { id: number; username: string }
}

export interface ContentDetailItem {
  id: string
  name: string
  description: string
  type: ContentType
  visibility: ContentVisibility
  content: Record<string, unknown>
  favorite: boolean
  folder_id: string | null
  owner_id: number
  project_id: number
  inserted_at: string
  updated_at: string
  last_updated_by: number
}

export interface ContentFolderMetadata {
  id: string
  name: string
  owner_id: number
  parent_id: string | null
  project_id: number
}

export interface ContentFolderListItem {
  id: string
  name: string
  description: string
  type: ContentType
  visibility: ContentVisibility
  favorite: boolean
  folder_id: string | null
  owner_id: number
  project_id: number
  inserted_at: string
  updated_at: string
  last_updated_by: number
}

export function toListItem(row: ContentItemRow, projectId: number): ContentListItem {
  return {
    id: row.id,
    name: row.name,
    description: row.description,
    type: row.type,
    visibility: row.visibility,
    content: row.content,
    favorite: row.favorite,
    folder_id: row.folder_id,
    owner_id: row.owner_id,
    project_id: projectId,
    inserted_at: row.inserted_at,
    updated_at: row.updated_at,
    last_updated_by: row.owner_id,
    owner: { id: row.owner_id, username: row.owner_username },
    updated_by: { id: row.owner_id, username: row.owner_username },
  }
}

export function toDetailItem(row: ContentItemRow, projectId: number): ContentDetailItem {
  return {
    id: row.id,
    name: row.name,
    description: row.description,
    type: row.type,
    visibility: row.visibility,
    content: row.content,
    favorite: row.favorite,
    folder_id: row.folder_id,
    owner_id: row.owner_id,
    project_id: projectId,
    inserted_at: row.inserted_at,
    updated_at: row.updated_at,
    last_updated_by: row.owner_id,
  }
}

export function toFolderListItem(row: ContentItemRow, projectId: number): ContentFolderListItem {
  return {
    id: row.id,
    name: row.name,
    description: row.description,
    type: row.type,
    visibility: row.visibility,
    favorite: row.favorite,
    folder_id: row.folder_id,
    owner_id: row.owner_id,
    project_id: projectId,
    inserted_at: row.inserted_at,
    updated_at: row.updated_at,
    last_updated_by: row.owner_id,
  }
}

export function toFolderMetadata(row: ContentFolderRow, projectId: number): ContentFolderMetadata {
  return {
    id: row.id,
    name: row.name,
    owner_id: row.owner_id,
    parent_id: row.parent_id,
    project_id: projectId,
  }
}

function clampLimit(limit: number | undefined): number {
  if (typeof limit !== 'number' || Number.isNaN(limit) || limit <= 0) return 100
  return Math.min(limit, 1000)
}

function clampOffset(offset: number | undefined): number {
  if (typeof offset !== 'number' || Number.isNaN(offset) || offset < 0) return 0
  return offset
}

function encodeCursor(offset: number): string {
  return String(offset)
}

function computeNextCursor(returnedCount: number, limit: number, offset: number): string | null {
  if (returnedCount < limit) return null
  return encodeCursor(offset + limit)
}

// ── List content ───────────────────────────────────────────

export async function listContent(
  pool: Pool,
  projectRef: string,
  profileId: number,
  opts: ContentListOptions,
): Promise<{ rows: ContentItemRow[]; cursor: string | null }> {
  const limit = clampLimit(opts.limit)
  const offset = clampOffset(opts.offset)
  const type = opts.type ?? null
  const visibility = opts.visibility ?? null
  const favorite = typeof opts.favorite === 'boolean' ? opts.favorite : null
  const nameFilter = opts.name && opts.name.length > 0 ? `%${opts.name}%` : null
  const sortBy = opts.sortBy === 'name' ? 'name' : 'inserted_at'
  const sortDir = opts.sortOrder === 'asc' ? 'ASC' : 'DESC'

  const connection = await pool.connect()
  try {
    const text = `
      SELECT ci.*, p.username AS owner_username
      FROM traffic.content_items ci
      JOIN traffic.profiles p ON p.id = ci.owner_id
      WHERE ci.project_ref = $1
        AND (ci.owner_id = $2 OR ci.visibility = 'project')
        AND ($3::text IS NULL OR ci.type = $3::text)
        AND ($4::text IS NULL OR ci.visibility = $4::text)
        AND ($5::boolean IS NULL OR ci.favorite = $5::boolean)
        AND ($6::text IS NULL OR ci.name ILIKE $6::text)
      ORDER BY
        CASE WHEN $7::text = 'name' AND $8::text = 'ASC'  THEN ci.name END ASC,
        CASE WHEN $7::text = 'name' AND $8::text = 'DESC' THEN ci.name END DESC,
        CASE WHEN $7::text = 'inserted_at' AND $8::text = 'ASC'  THEN ci.inserted_at END ASC,
        CASE WHEN $7::text = 'inserted_at' AND $8::text = 'DESC' THEN ci.inserted_at END DESC,
        ci.id ASC
      LIMIT $9 OFFSET $10
    `
    const result = await connection.queryObject<ContentItemRow>({
      text,
      args: [
        projectRef,
        profileId,
        type,
        visibility,
        favorite,
        nameFilter,
        sortBy,
        sortDir,
        limit,
        offset,
      ],
    })
    const cursor = computeNextCursor(result.rows.length, limit, offset)
    return { rows: result.rows, cursor }
  } finally {
    connection.release()
  }
}

// ── Count ──────────────────────────────────────────────────

export async function countContent(
  pool: Pool,
  projectRef: string,
  profileId: number,
  opts: { type?: ContentType; name?: string },
): Promise<{ count: number; favorites: number; private: number; shared: number }> {
  const type = opts.type ?? null
  const nameFilter = opts.name && opts.name.length > 0 ? `%${opts.name}%` : null

  const connection = await pool.connect()
  try {
    const text = `
      SELECT
        COUNT(*)::int AS count,
        COUNT(*) FILTER (WHERE ci.favorite = true)::int AS favorites,
        COUNT(*) FILTER (WHERE ci.visibility = 'user' AND ci.owner_id = $2)::int AS private_count,
        COUNT(*) FILTER (WHERE ci.visibility = 'project')::int AS shared
      FROM traffic.content_items ci
      WHERE ci.project_ref = $1
        AND (ci.owner_id = $2 OR ci.visibility = 'project')
        AND ($3::text IS NULL OR ci.type = $3::text)
        AND ($4::text IS NULL OR ci.name ILIKE $4::text)
    `
    const result = await connection.queryObject<{
      count: number
      favorites: number
      private_count: number
      shared: number
    }>({
      text,
      args: [projectRef, profileId, type, nameFilter],
    })
    const row = result.rows[0]
    return {
      count: row?.count ?? 0,
      favorites: row?.favorites ?? 0,
      private: row?.private_count ?? 0,
      shared: row?.shared ?? 0,
    }
  } finally {
    connection.release()
  }
}

// ── Get single item by id ──────────────────────────────────

export async function getContentById(
  pool: Pool,
  projectRef: string,
  profileId: number,
  id: string,
): Promise<ContentItemRow | null> {
  const connection = await pool.connect()
  try {
    const result = await connection.queryObject<ContentItemRow>`
      SELECT ci.*, p.username AS owner_username
      FROM traffic.content_items ci
      JOIN traffic.profiles p ON p.id = ci.owner_id
      WHERE ci.project_ref = ${projectRef} AND ci.id = ${id}::uuid
    `
    if (result.rows.length === 0) return null
    const row = result.rows[0]
    if (row.visibility === 'user' && row.owner_id !== profileId) {
      throw new ContentForbiddenError("Cannot read another user's private content")
    }
    return row
  } finally {
    connection.release()
  }
}

// ── Upsert (POST + PUT) ────────────────────────────────────

export async function upsertContent(
  pool: Pool,
  projectRef: string,
  projectOrgId: number,
  profileId: number,
  gotrueId: string,
  input: UpsertContentInput,
  auditContext: AuditContext,
): Promise<ContentItemRow> {
  const connection = await pool.connect()
  try {
    const tx = connection.createTransaction('upsert_content')
    await tx.begin()

    const id = input.id ?? crypto.randomUUID()
    const name = input.name ?? 'Untitled'
    const description = input.description ?? ''
    const type: ContentType = input.type
    const visibility: ContentVisibility = input.visibility ?? 'user'
    const content = input.content ?? {}
    const favorite = input.favorite ?? false
    const folderId = input.folder_id ?? null

    const existing = await tx.queryObject<{ owner_id: number; visibility: ContentVisibility }>`
      SELECT owner_id, visibility FROM traffic.content_items
      WHERE id = ${id}::uuid AND project_ref = ${projectRef}
    `

    let actionName: 'project.content_created' | 'project.content_updated'

    if (existing.rows.length > 0) {
      if (existing.rows[0].owner_id !== profileId) {
        await tx.rollback()
        throw new ContentForbiddenError('Only the owner can update this item')
      }
      actionName = 'project.content_updated'
      await tx.queryObject`
        UPDATE traffic.content_items
        SET name = ${name},
            description = ${description},
            type = ${type},
            visibility = ${visibility},
            content = ${JSON.stringify(content)}::jsonb,
            favorite = ${favorite},
            folder_id = ${folderId},
            updated_at = now()
        WHERE id = ${id}::uuid AND project_ref = ${projectRef}
      `
    } else {
      actionName = 'project.content_created'
      await tx.queryObject`
        INSERT INTO traffic.content_items (
          id, project_ref, owner_id, folder_id,
          name, description, type, visibility, content, favorite
        ) VALUES (
          ${id}::uuid, ${projectRef}, ${profileId}, ${folderId},
          ${name}, ${description}, ${type}, ${visibility},
          ${JSON.stringify(content)}::jsonb, ${favorite}
        )
      `
    }

    await tx.queryObject`
      INSERT INTO traffic.audit_logs (
        id, profile_id, organization_id, action_name, action_metadata,
        actor_id, actor_type, actor_metadata,
        target_description, target_metadata, occurred_at
      ) VALUES (
        gen_random_uuid(), ${profileId}, ${projectOrgId}, ${actionName},
        ${
      JSON.stringify([{ method: auditContext.method, route: auditContext.route, status: 200 }])
    }::jsonb,
        ${gotrueId}, 'user',
        ${JSON.stringify([{ email: auditContext.email, ip: auditContext.ip }])}::jsonb,
        ${'content #' + id + ' (project ' + projectRef + ')'},
        ${JSON.stringify({ type, visibility })}::jsonb, now()
      )
    `

    const refreshed = await tx.queryObject<ContentItemRow>`
      SELECT ci.*, p.username AS owner_username
      FROM traffic.content_items ci
      JOIN traffic.profiles p ON p.id = ci.owner_id
      WHERE ci.id = ${id}::uuid AND ci.project_ref = ${projectRef}
    `

    await tx.commit()
    return refreshed.rows[0]
  } finally {
    connection.release()
  }
}

// ── Patch (owner-only partial update) ──────────────────────

export async function patchContent(
  pool: Pool,
  projectRef: string,
  projectOrgId: number,
  profileId: number,
  gotrueId: string,
  id: string,
  patch: PatchContentInput,
  auditContext: AuditContext,
): Promise<ContentItemRow | null> {
  const connection = await pool.connect()
  try {
    const tx = connection.createTransaction('patch_content')
    await tx.begin()

    const existing = await tx.queryObject<{ owner_id: number; visibility: ContentVisibility }>`
      SELECT owner_id, visibility FROM traffic.content_items
      WHERE id = ${id}::uuid AND project_ref = ${projectRef}
    `
    if (existing.rows.length === 0) {
      await tx.rollback()
      return null
    }
    if (existing.rows[0].owner_id !== profileId) {
      await tx.rollback()
      throw new ContentForbiddenError('Only the owner can update this item')
    }

    const nameVal = patch.name !== undefined ? patch.name : null
    const descriptionVal = patch.description !== undefined ? patch.description : null
    const visibilityVal = patch.visibility !== undefined ? patch.visibility : null
    const favoriteVal = typeof patch.favorite === 'boolean' ? patch.favorite : null
    const contentVal = patch.content !== undefined ? JSON.stringify(patch.content) : null
    const setFolder = Object.prototype.hasOwnProperty.call(patch, 'folder_id')
    const folderIdVal = setFolder ? (patch.folder_id ?? null) : null

    await tx.queryObject({
      text: `
        UPDATE traffic.content_items
        SET name = COALESCE($3, name),
            description = COALESCE($4, description),
            visibility = COALESCE($5, visibility),
            favorite = COALESCE($6, favorite),
            content = COALESCE($7::jsonb, content),
            folder_id = CASE WHEN $8::boolean THEN $9::uuid ELSE folder_id END,
            updated_at = now()
        WHERE id = $1::uuid AND project_ref = $2
      `,
      args: [
        id,
        projectRef,
        nameVal,
        descriptionVal,
        visibilityVal,
        favoriteVal,
        contentVal,
        setFolder,
        folderIdVal,
      ],
    })

    await tx.queryObject`
      INSERT INTO traffic.audit_logs (
        id, profile_id, organization_id, action_name, action_metadata,
        actor_id, actor_type, actor_metadata,
        target_description, target_metadata, occurred_at
      ) VALUES (
        gen_random_uuid(), ${profileId}, ${projectOrgId}, 'project.content_updated',
        ${
      JSON.stringify([{ method: auditContext.method, route: auditContext.route, status: 200 }])
    }::jsonb,
        ${gotrueId}, 'user',
        ${JSON.stringify([{ email: auditContext.email, ip: auditContext.ip }])}::jsonb,
        ${'content #' + id + ' (project ' + projectRef + ')'}, '{}'::jsonb, now()
      )
    `

    const refreshed = await tx.queryObject<ContentItemRow>`
      SELECT ci.*, p.username AS owner_username
      FROM traffic.content_items ci
      JOIN traffic.profiles p ON p.id = ci.owner_id
      WHERE ci.id = ${id}::uuid AND ci.project_ref = ${projectRef}
    `

    await tx.commit()
    return refreshed.rows[0] ?? null
  } finally {
    connection.release()
  }
}

// ── Bulk delete items ──────────────────────────────────────

export async function deleteContentBulk(
  pool: Pool,
  projectRef: string,
  projectOrgId: number,
  profileId: number,
  gotrueId: string,
  ids: string[],
  auditContext: AuditContext,
): Promise<{ deletedIds: string[] }> {
  if (ids.length === 0) return { deletedIds: [] }

  const connection = await pool.connect()
  try {
    const tx = connection.createTransaction('delete_content_bulk')
    await tx.begin()

    const result = await tx.queryObject<{ id: string }>`
      DELETE FROM traffic.content_items
      WHERE project_ref = ${projectRef}
        AND owner_id = ${profileId}
        AND id = ANY(${ids}::uuid[])
      RETURNING id
    `

    if (result.rows.length > 0) {
      await tx.queryObject`
        INSERT INTO traffic.audit_logs (
          id, profile_id, organization_id, action_name, action_metadata,
          actor_id, actor_type, actor_metadata,
          target_description, target_metadata, occurred_at
        ) VALUES (
          gen_random_uuid(), ${profileId}, ${projectOrgId}, 'project.content_deleted',
          ${
        JSON.stringify([{ method: auditContext.method, route: auditContext.route, status: 200 }])
      }::jsonb,
          ${gotrueId}, 'user',
          ${JSON.stringify([{ email: auditContext.email, ip: auditContext.ip }])}::jsonb,
          ${'content bulk delete (project ' + projectRef + '): ' + result.rows.length + ' items'},
          ${JSON.stringify({ ids: result.rows.map((r) => r.id) })}::jsonb, now()
        )
      `
    }

    await tx.commit()
    return { deletedIds: result.rows.map((r) => r.id) }
  } finally {
    connection.release()
  }
}

// ── Folder root list (folders + root-level items) ──────────

export async function listRootFolder(
  pool: Pool,
  projectRef: string,
  profileId: number,
  opts: ContentFolderListOptions,
): Promise<{
  folders: ContentFolderRow[]
  contents: ContentItemRow[]
  cursor: string | null
}> {
  const limit = clampLimit(opts.limit)
  const offset = clampOffset(opts.offset)
  const type = opts.type ?? null
  const nameFilter = opts.name && opts.name.length > 0 ? `%${opts.name}%` : null
  const sortBy = opts.sortBy === 'name' ? 'name' : 'inserted_at'
  const sortDir = opts.sortOrder === 'asc' ? 'ASC' : 'DESC'

  const connection = await pool.connect()
  try {
    const foldersResult = await connection.queryObject<ContentFolderRow>`
      SELECT * FROM traffic.content_folders
      WHERE project_ref = ${projectRef}
        AND owner_id = ${profileId}
        AND parent_id IS NULL
      ORDER BY name ASC
    `

    const text = `
      SELECT ci.*, p.username AS owner_username
      FROM traffic.content_items ci
      JOIN traffic.profiles p ON p.id = ci.owner_id
      WHERE ci.project_ref = $1
        AND (ci.owner_id = $2 OR ci.visibility = 'project')
        AND ci.folder_id IS NULL
        AND ($3::text IS NULL OR ci.type = $3::text)
        AND ($4::text IS NULL OR ci.name ILIKE $4::text)
      ORDER BY
        CASE WHEN $5::text = 'name' AND $6::text = 'ASC'  THEN ci.name END ASC,
        CASE WHEN $5::text = 'name' AND $6::text = 'DESC' THEN ci.name END DESC,
        CASE WHEN $5::text = 'inserted_at' AND $6::text = 'ASC'  THEN ci.inserted_at END ASC,
        CASE WHEN $5::text = 'inserted_at' AND $6::text = 'DESC' THEN ci.inserted_at END DESC,
        ci.id ASC
      LIMIT $7 OFFSET $8
    `
    const itemsResult = await connection.queryObject<ContentItemRow>({
      text,
      args: [projectRef, profileId, type, nameFilter, sortBy, sortDir, limit, offset],
    })

    const cursor = computeNextCursor(itemsResult.rows.length, limit, offset)
    return { folders: foldersResult.rows, contents: itemsResult.rows, cursor }
  } finally {
    connection.release()
  }
}

// ── Folder contents (by folder id) ─────────────────────────

export async function listFolderContents(
  pool: Pool,
  projectRef: string,
  profileId: number,
  folderId: string,
  opts: ContentFolderListOptions,
): Promise<{
  folder: ContentFolderRow | null
  folders: ContentFolderRow[]
  contents: ContentItemRow[]
  cursor: string | null
}> {
  const limit = clampLimit(opts.limit)
  const offset = clampOffset(opts.offset)
  const nameFilter = opts.name && opts.name.length > 0 ? `%${opts.name}%` : null
  const sortBy = opts.sortBy === 'name' ? 'name' : 'inserted_at'
  const sortDir = opts.sortOrder === 'asc' ? 'ASC' : 'DESC'

  const connection = await pool.connect()
  try {
    const folderResult = await connection.queryObject<ContentFolderRow>`
      SELECT * FROM traffic.content_folders
      WHERE project_ref = ${projectRef} AND id = ${folderId}::uuid
    `
    if (folderResult.rows.length === 0) {
      return { folder: null, folders: [], contents: [], cursor: null }
    }
    const folder = folderResult.rows[0]

    if (folder.owner_id !== profileId) {
      throw new ContentForbiddenError('Folder belongs to another user')
    }

    const subfolders = await connection.queryObject<ContentFolderRow>`
      SELECT * FROM traffic.content_folders
      WHERE project_ref = ${projectRef} AND parent_id = ${folderId}::uuid
      ORDER BY name ASC
    `

    const text = `
      SELECT ci.*, p.username AS owner_username
      FROM traffic.content_items ci
      JOIN traffic.profiles p ON p.id = ci.owner_id
      WHERE ci.project_ref = $1
        AND (ci.owner_id = $2 OR ci.visibility = 'project')
        AND ci.folder_id = $3::uuid
        AND ($4::text IS NULL OR ci.name ILIKE $4::text)
      ORDER BY
        CASE WHEN $5::text = 'name' AND $6::text = 'ASC'  THEN ci.name END ASC,
        CASE WHEN $5::text = 'name' AND $6::text = 'DESC' THEN ci.name END DESC,
        CASE WHEN $5::text = 'inserted_at' AND $6::text = 'ASC'  THEN ci.inserted_at END ASC,
        CASE WHEN $5::text = 'inserted_at' AND $6::text = 'DESC' THEN ci.inserted_at END DESC,
        ci.id ASC
      LIMIT $7 OFFSET $8
    `
    const itemsResult = await connection.queryObject<ContentItemRow>({
      text,
      args: [projectRef, profileId, folderId, nameFilter, sortBy, sortDir, limit, offset],
    })

    const cursor = computeNextCursor(itemsResult.rows.length, limit, offset)
    return {
      folder,
      folders: subfolders.rows,
      contents: itemsResult.rows,
      cursor,
    }
  } finally {
    connection.release()
  }
}

// ── Create folder ──────────────────────────────────────────

export async function createFolder(
  pool: Pool,
  projectRef: string,
  projectOrgId: number,
  profileId: number,
  gotrueId: string,
  name: string,
  parentId: string | null,
  auditContext: AuditContext,
): Promise<ContentFolderRow> {
  const connection = await pool.connect()
  try {
    const tx = connection.createTransaction('create_content_folder')
    await tx.begin()

    if (parentId) {
      const parentRes = await tx.queryObject<{ owner_id: number }>`
        SELECT owner_id FROM traffic.content_folders
        WHERE id = ${parentId}::uuid AND project_ref = ${projectRef}
      `
      if (parentRes.rows.length === 0) {
        await tx.rollback()
        throw new Error('Parent folder not found')
      }
      if (parentRes.rows[0].owner_id !== profileId) {
        await tx.rollback()
        throw new ContentForbiddenError("Cannot create a folder under another user's folder")
      }
    }

    const result = await tx.queryObject<ContentFolderRow>`
      INSERT INTO traffic.content_folders (project_ref, owner_id, parent_id, name)
      VALUES (${projectRef}, ${profileId}, ${parentId}, ${name})
      RETURNING *
    `
    const folder = result.rows[0]

    await tx.queryObject`
      INSERT INTO traffic.audit_logs (
        id, profile_id, organization_id, action_name, action_metadata,
        actor_id, actor_type, actor_metadata,
        target_description, target_metadata, occurred_at
      ) VALUES (
        gen_random_uuid(), ${profileId}, ${projectOrgId}, 'project.content_folder_created',
        ${
      JSON.stringify([{ method: auditContext.method, route: auditContext.route, status: 201 }])
    }::jsonb,
        ${gotrueId}, 'user',
        ${JSON.stringify([{ email: auditContext.email, ip: auditContext.ip }])}::jsonb,
        ${'content folder #' + folder.id + ' (project ' + projectRef + ')'}, '{}'::jsonb, now()
      )
    `

    await tx.commit()
    return folder
  } finally {
    connection.release()
  }
}

// ── Update folder (rename / move) ──────────────────────────

export async function updateFolder(
  pool: Pool,
  projectRef: string,
  projectOrgId: number,
  profileId: number,
  gotrueId: string,
  folderId: string,
  updates: { name?: string; parentId?: string | null },
  auditContext: AuditContext,
): Promise<ContentFolderRow | null> {
  const connection = await pool.connect()
  try {
    const tx = connection.createTransaction('update_content_folder')
    await tx.begin()

    const existing = await tx.queryObject<{ owner_id: number }>`
      SELECT owner_id FROM traffic.content_folders
      WHERE id = ${folderId}::uuid AND project_ref = ${projectRef}
    `
    if (existing.rows.length === 0) {
      await tx.rollback()
      return null
    }
    if (existing.rows[0].owner_id !== profileId) {
      await tx.rollback()
      throw new ContentForbiddenError('Only the folder owner can update it')
    }

    if (updates.parentId !== undefined && updates.parentId !== null) {
      if (updates.parentId === folderId) {
        await tx.rollback()
        throw new Error('Cannot set a folder as its own parent')
      }
      const parentRes = await tx.queryObject<{ owner_id: number }>`
        SELECT owner_id FROM traffic.content_folders
        WHERE id = ${updates.parentId}::uuid AND project_ref = ${projectRef}
      `
      if (parentRes.rows.length === 0) {
        await tx.rollback()
        throw new Error('Parent folder not found')
      }
      if (parentRes.rows[0].owner_id !== profileId) {
        await tx.rollback()
        throw new ContentForbiddenError("Cannot move folder under another user's folder")
      }
    }

    const nameVal = updates.name !== undefined ? updates.name : null
    const setParent = updates.parentId !== undefined
    const parentVal = setParent ? (updates.parentId ?? null) : null

    const result = await tx.queryObject<ContentFolderRow>({
      text: `
        UPDATE traffic.content_folders
        SET name = COALESCE($3, name),
            parent_id = CASE WHEN $4::boolean THEN $5::uuid ELSE parent_id END,
            updated_at = now()
        WHERE id = $1::uuid AND project_ref = $2
        RETURNING *
      `,
      args: [folderId, projectRef, nameVal, setParent, parentVal],
    })

    if (result.rows.length === 0) {
      await tx.rollback()
      return null
    }
    const folder = result.rows[0]

    const keys = [
      ...(updates.name !== undefined ? ['name'] : []),
      ...(updates.parentId !== undefined ? ['parent_id'] : []),
    ]
    await tx.queryObject`
      INSERT INTO traffic.audit_logs (
        id, profile_id, organization_id, action_name, action_metadata,
        actor_id, actor_type, actor_metadata,
        target_description, target_metadata, occurred_at
      ) VALUES (
        gen_random_uuid(), ${profileId}, ${projectOrgId}, 'project.content_folder_updated',
        ${
      JSON.stringify([{ method: auditContext.method, route: auditContext.route, status: 200 }])
    }::jsonb,
        ${gotrueId}, 'user',
        ${JSON.stringify([{ email: auditContext.email, ip: auditContext.ip }])}::jsonb,
        ${'content folder #' + folder.id + ' (project ' + projectRef + ')'},
        ${JSON.stringify({ keys })}::jsonb,
        now()
      )
    `

    await tx.commit()
    return folder
  } finally {
    connection.release()
  }
}

// ── Bulk delete folders (cascades children via FK) ─────────

export async function deleteFoldersBulk(
  pool: Pool,
  projectRef: string,
  projectOrgId: number,
  profileId: number,
  gotrueId: string,
  ids: string[],
  auditContext: AuditContext,
): Promise<{ deletedIds: string[] }> {
  if (ids.length === 0) return { deletedIds: [] }

  const connection = await pool.connect()
  try {
    const tx = connection.createTransaction('delete_content_folders')
    await tx.begin()

    const result = await tx.queryObject<{ id: string }>`
      DELETE FROM traffic.content_folders
      WHERE project_ref = ${projectRef}
        AND owner_id = ${profileId}
        AND id = ANY(${ids}::uuid[])
      RETURNING id
    `

    if (result.rows.length > 0) {
      await tx.queryObject`
        INSERT INTO traffic.audit_logs (
          id, profile_id, organization_id, action_name, action_metadata,
          actor_id, actor_type, actor_metadata,
          target_description, target_metadata, occurred_at
        ) VALUES (
          gen_random_uuid(), ${profileId}, ${projectOrgId}, 'project.content_folder_deleted',
          ${
        JSON.stringify([{ method: auditContext.method, route: auditContext.route, status: 200 }])
      }::jsonb,
          ${gotrueId}, 'user',
          ${JSON.stringify([{ email: auditContext.email, ip: auditContext.ip }])}::jsonb,
          ${
        'content folder bulk delete (project ' + projectRef + '): ' + result.rows.length + ' items'
      },
          ${JSON.stringify({ ids: result.rows.map((r) => r.id) })}::jsonb, now()
        )
      `
    }

    await tx.commit()
    return { deletedIds: result.rows.map((r) => r.id) }
  } finally {
    connection.release()
  }
}
