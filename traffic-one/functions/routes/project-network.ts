import type { Pool } from 'https://deno.land/x/postgres@v0.19.3/mod.ts'

import { corsHeaders } from '../index.ts'
import { getProjectByRef } from '../services/project.service.ts'
import { assertValidRef } from '../utils/ref-validation.ts'

// Wave 3 / Bundle K — Project network + read-replicas + privatelink.
//
// This handler covers sub-paths from two different Kong services:
//   • /api/v1/projects/{ref}/network-restrictions[/apply]
//   • /api/v1/projects/{ref}/network-bans[/retrieve]
//   • /api/v1/projects/{ref}/read-replicas/{setup,remove}
//   • /api/platform/projects/{ref}/privatelink/associations[/aws-account[/{id}]]
//
// The parent dispatches to `handleProjectNetwork` from both `handleProjects`
// (for the /platform/... privatelink sub-paths) and `handleProjectHealth`
// (for the /v1/... network-* and read-replicas sub-paths). The handler is
// agnostic to which entry point is used — it inspects the sub-path only.
//
// Self-hosted stacks have no cloud network-layer controls, no replica topology
// and no AWS PrivateLink, so every mutation replies 501 with the shared
// `self_hosted_unsupported` reason code. Reads return shape-correct empty
// responses so Studio's UI renders instead of crashing.

const NETWORK_RESTRICTIONS_UNSUPPORTED_MESSAGE =
  'Applying network restrictions is not available in self-hosted deployments'
const READ_REPLICAS_UNSUPPORTED_MESSAGE =
  'Read replicas are not available in self-hosted deployments'
const PRIVATELINK_UNSUPPORTED_MESSAGE =
  'PrivateLink associations are not available in self-hosted deployments'

function notSupportedResponse(message: string): Response {
  return Response.json(
    { code: 'self_hosted_unsupported', message },
    { status: 501, headers: corsHeaders },
  )
}

function notFoundResponse(message = 'Not Found'): Response {
  return Response.json({ message }, { status: 404, headers: corsHeaders })
}

function methodNotAllowedResponse(): Response {
  return Response.json({ message: 'Method not allowed' }, { status: 405, headers: corsHeaders })
}

export async function handleProjectNetwork(
  _req: Request,
  path: string,
  method: string,
  pool: Pool,
  profileId: number,
  _gotrueId: string,
  _email: string,
): Promise<Response> {
  const refMatch = path.match(/^\/([^/]+)(\/.*)?$/)
  if (!refMatch) {
    return notFoundResponse()
  }

  const ref = refMatch[1]
  const subPath = refMatch[2] || ''

  // L4: reject malformed refs before hitting the DB.
  const bad = assertValidRef(ref)
  if (bad) return bad

  const project = await getProjectByRef(pool, ref, profileId)
  if (!project) {
    return notFoundResponse('Project not found')
  }

  // ── v1: network restrictions ────────────────────────────
  if (subPath === '/network-restrictions') {
    if (method === 'GET') {
      return Response.json(
        {
          entries: { dbAllowedCidrs: [], dbAllowedCidrsV6: [] },
          old_config: { dbAllowedCidrs: [], dbAllowedCidrsV6: [] },
          new_config: { dbAllowedCidrs: [], dbAllowedCidrsV6: [] },
          status: 'applied',
        },
        { headers: corsHeaders },
      )
    }
    return methodNotAllowedResponse()
  }

  if (subPath === '/network-restrictions/apply') {
    if (method === 'POST') {
      return notSupportedResponse(NETWORK_RESTRICTIONS_UNSUPPORTED_MESSAGE)
    }
    return methodNotAllowedResponse()
  }

  // ── v1: network bans ────────────────────────────────────
  if (subPath === '/network-bans') {
    if (method === 'DELETE') {
      return Response.json({ success: true }, { headers: corsHeaders })
    }
    return methodNotAllowedResponse()
  }

  if (subPath === '/network-bans/retrieve') {
    if (method === 'POST') {
      return Response.json(
        { banned_ipv4_addresses: [], banned_ipv6_addresses: [] },
        { headers: corsHeaders },
      )
    }
    return methodNotAllowedResponse()
  }

  // ── v1: read replicas ───────────────────────────────────
  if (subPath === '/read-replicas/setup' || subPath === '/read-replicas/remove') {
    if (method === 'POST') {
      return notSupportedResponse(READ_REPLICAS_UNSUPPORTED_MESSAGE)
    }
    return methodNotAllowedResponse()
  }

  // ── Platform: privatelink associations ──────────────────
  if (subPath === '/privatelink/associations') {
    if (method === 'GET') {
      return Response.json({ associations: [] }, { headers: corsHeaders })
    }
    return methodNotAllowedResponse()
  }

  if (subPath === '/privatelink/associations/aws-account') {
    if (method === 'POST') {
      return notSupportedResponse(PRIVATELINK_UNSUPPORTED_MESSAGE)
    }
    return methodNotAllowedResponse()
  }

  if (/^\/privatelink\/associations\/aws-account\/[^/]+$/.test(subPath)) {
    if (method === 'DELETE') {
      return notSupportedResponse(PRIVATELINK_UNSUPPORTED_MESSAGE)
    }
    return methodNotAllowedResponse()
  }

  return notFoundResponse()
}
