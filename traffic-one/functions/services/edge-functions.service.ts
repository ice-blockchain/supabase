// Shared filesystem scanner + remote dispatcher for Supabase Edge
// Functions.
//
// Background (L4): the read handlers in `routes/projects.ts` and the
// mutation handlers in `routes/edge-function-mutations.ts` each used to
// carry their own copy of `parseFunctionDir`. The duplication was flagged
// by an explicit TODO at the top of the mutations copy because the shapes
// were almost identical: both walk `FUNCTIONS_DIR`, pick an `index*` file
// as the entrypoint, and synthesize a `FunctionEntry`. The only delta was
// that the mutation side layered `.meta.json` overrides (`name`,
// `verify_jwt`, `entrypoint_path`) over the filesystem scan, while the
// read side returned only the raw scan result.
//
// Phase 3 (per-project backends): when `backend.endpoint !== SUPABASE_URL`
// the filesystem view no longer applies — the project's functions live on
// a runtime owned by the external orchestrator. The remote helpers
// (`listRemoteFunctions`, `deployRemoteFunction`, ...) proxy to
// `${backend.functionsApiUrl}/_meta[...]` / `/_deploy` with the project's
// service key. The *shared-stack* path (local Docker, single tenant)
// continues to use the filesystem; `routes/edge-function-mutations.ts`
// and `routes/projects.ts` pick the branch at request-time via
// `isSharedStack(backend)`.
//
// We intentionally keep the filesystem constant (`FUNCTIONS_DIR`) and the
// `FunctionEntry` / `FunctionMeta` types exported from here so there is
// only one place to update when the runtime mount path changes.

import { type FetchLike, fetchProjectUrl, type ProjectBackend } from './project-backend.service.ts'

export const FUNCTIONS_DIR = '/home/deno/functions'

export interface FunctionEntry {
  id: string
  slug: string
  name: string
  version: number
  status: 'ACTIVE'
  entrypoint_path: string
  created_at: number
  updated_at: number
  verify_jwt: boolean
}

export interface FunctionMeta {
  name?: string
  verify_jwt?: boolean
  entrypoint_path?: string
  // `import_map_path` is currently only consumed by
  // routes/edge-function-mutations.ts but lives here so the `.meta.json`
  // shape has a single authoritative definition.
  import_map_path?: string
}

// Read `.meta.json` from the function directory if present. Missing file /
// invalid JSON returns `{}` so callers never have to special-case the
// bootstrap case where a function hasn't had a PATCH land yet.
export async function loadFunctionMeta(slug: string): Promise<FunctionMeta> {
  const path = `${FUNCTIONS_DIR}/${slug}/.meta.json`
  try {
    const raw = await Deno.readTextFile(path)
    const parsed = JSON.parse(raw) as unknown
    if (parsed && typeof parsed === 'object') return parsed as FunctionMeta
    return {}
  } catch {
    return {}
  }
}

// Scan `${FUNCTIONS_DIR}/<slug>` and synthesize a `FunctionEntry`. Returns
// `null` if the directory does not exist or is not a directory. If `meta`
// is supplied its fields override the filesystem defaults (name,
// verify_jwt, entrypoint_path) so that the shape returned after a PATCH
// matches the shape returned by a subsequent GET.
export async function parseFunctionDir(
  slug: string,
  meta: FunctionMeta = {},
): Promise<FunctionEntry | null> {
  const dirPath = `${FUNCTIONS_DIR}/${slug}`

  try {
    const stat = await Deno.stat(dirPath)
    if (!stat.isDirectory) return null

    let entrypointName = meta.entrypoint_path || 'index.ts'
    if (!meta.entrypoint_path) {
      for await (const entry of Deno.readDir(dirPath)) {
        if (entry.isFile && entry.name.startsWith('index')) {
          entrypointName = entry.name
          break
        }
      }
    }

    const entrypointStat = await Deno.stat(`${dirPath}/${entrypointName}`).catch(() => null)
    const createdAt = entrypointStat?.birthtime?.getTime() ?? stat.mtime?.getTime() ?? Date.now()
    const updatedAt = entrypointStat?.mtime?.getTime() ?? stat.mtime?.getTime() ?? Date.now()

    return {
      id: crypto.randomUUID(),
      slug,
      name: meta.name ?? slug,
      version: 1,
      status: 'ACTIVE',
      entrypoint_path: entrypointName,
      created_at: createdAt,
      updated_at: updatedAt,
      verify_jwt: meta.verify_jwt ?? false,
    }
  } catch {
    return null
  }
}

// ── Remote dispatcher (api mode) ────────────────────────────────────────────
//
// Per-project functions runtime contract. `functionsApiUrl` is expected to
// expose a small admin surface that mirrors what our filesystem scanner
// produces. Each helper fails soft — network errors bubble up as `null`
// for GETs and rethrow for writes so the mutation route can audit the
// failure and surface a 500.
//
// Endpoints:
//   GET    {base}/_meta            → FunctionEntry[]
//   GET    {base}/_meta/{slug}     → FunctionEntry | 404
//   GET    {base}/_meta/{slug}/body → Array<{ name, content }> | 404
//   POST   {base}/_deploy          → FunctionEntry | 500
//   PATCH  {base}/_meta/{slug}     → FunctionEntry | 404
//   DELETE {base}/_meta/{slug}     → { slug, deleted } | 404

export interface DeployRemoteInput {
  slug: string
  name?: string
  verify_jwt?: boolean
  entrypoint_path?: string
  import_map_path?: string
  files: Array<{ name: string; content: string }>
}

function baseFunctionsUrl(backend: ProjectBackend): string {
  return backend.functionsApiUrl.replace(/\/$/, '')
}

export async function listRemoteFunctions(
  backend: ProjectBackend,
  fetchImpl: FetchLike = fetch,
): Promise<FunctionEntry[]> {
  if (!backend.functionsApiUrl) return []
  try {
    const res = await fetchProjectUrl(
      backend,
      `${baseFunctionsUrl(backend)}/_meta`,
      { method: 'GET', headers: { Accept: 'application/json' } },
      fetchImpl,
    )
    if (!res.ok) {
      await res.body?.cancel()
      return []
    }
    const body = await res.json().catch(() => null)
    return Array.isArray(body) ? (body as FunctionEntry[]) : []
  } catch (err) {
    console.warn('listRemoteFunctions failed:', err)
    return []
  }
}

export async function getRemoteFunction(
  backend: ProjectBackend,
  slug: string,
  fetchImpl: FetchLike = fetch,
): Promise<FunctionEntry | null> {
  if (!backend.functionsApiUrl) return null
  try {
    const res = await fetchProjectUrl(
      backend,
      `${baseFunctionsUrl(backend)}/_meta/${encodeURIComponent(slug)}`,
      { method: 'GET', headers: { Accept: 'application/json' } },
      fetchImpl,
    )
    if (!res.ok) {
      await res.body?.cancel()
      return null
    }
    const body = await res.json().catch(() => null)
    return body && typeof body === 'object' ? (body as FunctionEntry) : null
  } catch (err) {
    console.warn('getRemoteFunction failed:', err)
    return null
  }
}

export async function getRemoteFunctionBody(
  backend: ProjectBackend,
  slug: string,
  fetchImpl: FetchLike = fetch,
): Promise<Array<{ name: string; content: string }> | null> {
  if (!backend.functionsApiUrl) return null
  try {
    const res = await fetchProjectUrl(
      backend,
      `${baseFunctionsUrl(backend)}/_meta/${encodeURIComponent(slug)}/body`,
      { method: 'GET', headers: { Accept: 'application/json' } },
      fetchImpl,
    )
    if (!res.ok) {
      await res.body?.cancel()
      return null
    }
    const body = await res.json().catch(() => null)
    return Array.isArray(body) ? (body as Array<{ name: string; content: string }>) : null
  } catch (err) {
    console.warn('getRemoteFunctionBody failed:', err)
    return null
  }
}

export async function deployRemoteFunction(
  backend: ProjectBackend,
  input: DeployRemoteInput,
  fetchImpl: FetchLike = fetch,
): Promise<{ ok: true; entry: FunctionEntry } | { ok: false; status: number; message: string }> {
  if (!backend.functionsApiUrl) {
    return { ok: false, status: 501, message: 'functions API url not configured' }
  }
  const res = await fetchProjectUrl(
    backend,
    `${baseFunctionsUrl(backend)}/_deploy`,
    {
      method: 'POST',
      headers: { Accept: 'application/json' },
      body: JSON.stringify(input),
    },
    fetchImpl,
  )
  if (!res.ok) {
    const text = await res.text().catch(() => '')
    return { ok: false, status: res.status, message: text || `deploy failed (${res.status})` }
  }
  const body = await res.json().catch(() => null)
  if (!body || typeof body !== 'object') {
    return { ok: false, status: 502, message: 'invalid deploy response' }
  }
  return { ok: true, entry: body as FunctionEntry }
}

export async function patchRemoteFunction(
  backend: ProjectBackend,
  slug: string,
  meta: FunctionMeta,
  fetchImpl: FetchLike = fetch,
): Promise<FunctionEntry | null> {
  if (!backend.functionsApiUrl) return null
  const res = await fetchProjectUrl(
    backend,
    `${baseFunctionsUrl(backend)}/_meta/${encodeURIComponent(slug)}`,
    {
      method: 'PATCH',
      headers: { Accept: 'application/json' },
      body: JSON.stringify(meta),
    },
    fetchImpl,
  )
  if (!res.ok) {
    await res.body?.cancel()
    return null
  }
  const body = await res.json().catch(() => null)
  return body && typeof body === 'object' ? (body as FunctionEntry) : null
}

export async function deleteRemoteFunction(
  backend: ProjectBackend,
  slug: string,
  fetchImpl: FetchLike = fetch,
): Promise<boolean> {
  if (!backend.functionsApiUrl) return false
  const res = await fetchProjectUrl(
    backend,
    `${baseFunctionsUrl(backend)}/_meta/${encodeURIComponent(slug)}`,
    { method: 'DELETE', headers: { Accept: 'application/json' } },
    fetchImpl,
  )
  await res.body?.cancel()
  return res.ok
}
