// Shared filesystem scanner for Supabase Edge Functions living under the
// self-hosted Deno runtime mount point.
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
// This module is the single source of truth. `parseFunctionDir(slug)` is
// equivalent to the old read-side helper; `parseFunctionDir(slug, meta)`
// layers the meta overrides exactly like the mutation-side copy. Callers
// that need the meta-aware form pass the result of `loadMeta(slug)`.
//
// We intentionally keep the filesystem constant (`FUNCTIONS_DIR`) and the
// `FunctionEntry` / `FunctionMeta` types exported from here so there is
// only one place to update when the runtime mount path changes.

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
  meta: FunctionMeta = {}
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
