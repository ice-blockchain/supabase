import type { Pool } from 'https://deno.land/x/postgres@v0.17.0/mod.ts'

import { corsHeaders } from '../index.ts'
import { getProjectByRef } from '../services/project.service.ts'

const DISK_UNSUPPORTED_MESSAGE =
  'Disk configuration changes are not available in self-hosted deployments'
const RESIZE_UNSUPPORTED_MESSAGE = 'Project resize is not available in self-hosted deployments'

function notSupportedResponse(message: string): Response {
  return Response.json(
    { code: 'self_hosted_unsupported', message },
    { status: 501, headers: corsHeaders }
  )
}

function notFoundResponse(message = 'Not Found'): Response {
  return Response.json({ message }, { status: 404, headers: corsHeaders })
}

function methodNotAllowedResponse(): Response {
  return Response.json({ message: 'Method not allowed' }, { status: 405, headers: corsHeaders })
}

function parseNumberEnv(value: string | undefined, fallback: number): number {
  if (value === undefined || value === '') return fallback
  const parsed = Number(value)
  return Number.isFinite(parsed) ? parsed : fallback
}

interface DiskConfig {
  size_gb: number
  type: string
  iops: number
  throughput_mbps: number
}

function diskDefaults(): DiskConfig {
  return {
    size_gb: parseNumberEnv(Deno.env.get('LOCAL_DISK_SIZE_GB'), 8),
    type: Deno.env.get('LOCAL_DISK_TYPE') || 'gp3',
    iops: parseNumberEnv(Deno.env.get('LOCAL_DISK_IOPS'), 3000),
    throughput_mbps: parseNumberEnv(Deno.env.get('LOCAL_DISK_THROUGHPUT_MBPS'), 125),
  }
}

// Hard-coded fallback when the platform can't report disk usage.
// Kept numeric + self-consistent so Studio's gauge renders sensibly.
const DISK_UTIL_FALLBACK = { used_gb: 0.5, total_gb: 8, percent_used: 6.25 } as const

async function computeDiskUtil(): Promise<{
  used_gb: number
  total_gb: number
  percent_used: number
}> {
  try {
    // Deno has no stable cross-platform disk-total API. Some runtimes expose a
    // non-standard `Deno.statfs`; probe for it defensively. Anything thrown
    // below funnels into the hardcoded fallback — this must never reject.
    const denoMaybeStatfs = Deno as unknown as {
      statfs?: (path: string) => Promise<{
        blocks: number
        bfree: number
        bavail?: number
        bsize: number
      }>
    }

    if (typeof denoMaybeStatfs.statfs === 'function') {
      try {
        const s = await denoMaybeStatfs.statfs('/')
        const totalBytes = s.blocks * s.bsize
        const freeBytes = s.bfree * s.bsize
        const usedBytes = Math.max(totalBytes - freeBytes, 0)
        const gib = 1024 ** 3
        const total_gb = totalBytes / gib
        const used_gb = usedBytes / gib
        if (total_gb > 0 && Number.isFinite(total_gb) && Number.isFinite(used_gb)) {
          const percent_used = (used_gb / total_gb) * 100
          return {
            used_gb: Number(used_gb.toFixed(2)),
            total_gb: Number(total_gb.toFixed(2)),
            percent_used: Number(percent_used.toFixed(2)),
          }
        }
      } catch (err) {
        console.warn('project-disk: statfs probe failed:', err)
      }
    }

    // Non-fatal sanity check that '/' is reachable; ignore the result.
    try {
      await Deno.stat('/')
    } catch {
      // swallow
    }
  } catch {
    // swallow; we must never throw from here
  }

  return { ...DISK_UTIL_FALLBACK }
}

// ── Handlers ──────────────────────────────────────────────

export async function handleProjectDisk(
  _req: Request,
  path: string,
  method: string,
  pool: Pool,
  profileId: number
): Promise<Response> {
  const refMatch = path.match(/^\/([^/]+)(\/.*)?$/)
  if (!refMatch) {
    return notFoundResponse()
  }

  const ref = refMatch[1]
  const subPath = refMatch[2] || ''

  const project = await getProjectByRef(pool, ref, profileId)
  if (!project) {
    return notFoundResponse('Project not found')
  }

  // ── /disk ───────────────────────────────────────────────
  if (subPath === '/disk') {
    if (method === 'GET') {
      return Response.json(diskDefaults(), { headers: corsHeaders })
    }
    if (method === 'POST') {
      return notSupportedResponse(DISK_UNSUPPORTED_MESSAGE)
    }
    return methodNotAllowedResponse()
  }

  // ── /disk/util ──────────────────────────────────────────
  if (subPath === '/disk/util') {
    if (method === 'GET') {
      const util = await computeDiskUtil()
      return Response.json(util, { headers: corsHeaders })
    }
    return methodNotAllowedResponse()
  }

  // ── /disk/custom-config ─────────────────────────────────
  if (subPath === '/disk/custom-config') {
    if (method === 'GET') {
      const defaults = diskDefaults()
      return Response.json(
        {
          compute_size: 'nano',
          provisioned_iops: defaults.iops,
          provisioned_throughput_mbps: defaults.throughput_mbps,
        },
        { headers: corsHeaders }
      )
    }
    if (method === 'POST') {
      return notSupportedResponse(DISK_UNSUPPORTED_MESSAGE)
    }
    return methodNotAllowedResponse()
  }

  // ── /resize ─────────────────────────────────────────────
  if (subPath === '/resize') {
    if (method === 'POST') {
      return notSupportedResponse(RESIZE_UNSUPPORTED_MESSAGE)
    }
    return methodNotAllowedResponse()
  }

  // ── /restore/versions ───────────────────────────────────
  if (subPath === '/restore/versions') {
    if (method === 'GET') {
      const currentPgVersion = Deno.env.get('POSTGRES_VERSION') ?? '15'
      return Response.json([{ postgres_version: currentPgVersion }], { headers: corsHeaders })
    }
    return methodNotAllowedResponse()
  }

  return notFoundResponse()
}

// Top-level, not project-scoped. Parent dispatches this BEFORE matching
// `/{ref}` or `/{ref}/subpath`, otherwise `/available-regions` would be
// interpreted as a project ref by `handleProjects`.
export function handleAvailableRegions(_req: Request, method: string): Response {
  if (method === 'GET') {
    return Response.json([{ region: 'local', name: 'Local', country_code: 'XX' }], {
      headers: corsHeaders,
    })
  }
  return methodNotAllowedResponse()
}
