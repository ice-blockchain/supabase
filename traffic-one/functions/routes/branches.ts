import type { Pool } from 'https://deno.land/x/postgres@v0.17.0/mod.ts'

import { corsHeaders } from '../index.ts'
import {
  createBranch,
  getBranchById,
  listBranchesForProject,
  mergeBranch,
  pushBranch,
  resetBranch,
  restoreBranch,
  softDeleteBranch,
  updateBranch,
  type BranchRow,
  type TransitionOutcome,
} from '../services/branches.service.ts'
import { getProjectByRef } from '../services/project.service.ts'
import { getClientIp } from '../utils/client-ip.ts'

// ── Response helpers ──────────────────────────────────────

function notFoundResponse(message = 'Not Found'): Response {
  return Response.json({ message }, { status: 404, headers: corsHeaders })
}

function forbiddenResponse(message = 'Forbidden'): Response {
  return Response.json({ message }, { status: 403, headers: corsHeaders })
}

function methodNotAllowedResponse(): Response {
  return Response.json({ message: 'Method not allowed' }, { status: 405, headers: corsHeaders })
}

function invalidBodyResponse(message = 'Invalid request body'): Response {
  return Response.json({ message }, { status: 400, headers: corsHeaders })
}

// Studio expects UUID-shaped ids. Treat non-UUID path params as 404 rather
// than letting the DB layer surface a 500 from an invalid cast.
const UUID_REGEX = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i

function isValidUuid(id: string): boolean {
  return UUID_REGEX.test(id)
}

// Shape-stable output used by both list + single-branch responses. Keeps
// the JSON keys camelCase-free so Studio's BranchesQuery and the existing
// Supabase CLI types can consume the same payload without an adapter.
function toBranchResponse(row: BranchRow): Record<string, unknown> {
  return {
    id: row.id,
    project_ref: row.project_ref,
    parent_project_ref: row.parent_project_ref,
    branch_name: row.branch_name,
    is_default: row.is_default,
    git_branch: row.git_branch,
    status: row.status,
    pr_number: row.pr_number,
    created_at: row.created_at,
    updated_at: row.updated_at,
    merged_at: row.merged_at,
    deleted_at: row.deleted_at,
    persistent: row.is_default,
    review_requested_at: null,
  }
}

function getIp(req: Request): string {
  return getClientIp(req)
}

function transitionStatus(outcome: TransitionOutcome): number {
  if (outcome.status === 'not_found') return 404
  if (outcome.status === 'invalid_state') return 409
  return 200
}

function transitionBody(outcome: TransitionOutcome): Record<string, unknown> {
  if (outcome.status === 'not_found') return { message: 'Branch not found' }
  if (outcome.status === 'invalid_state') {
    return {
      code: 'invalid_state',
      message: outcome.message,
      current_status: outcome.current,
    }
  }
  return toBranchResponse(outcome.branch)
}

// ── /{ref}/branches — project-scoped list + create ────────

export async function handleProjectBranches(
  req: Request,
  path: string,
  method: string,
  pool: Pool,
  profileId: number,
  gotrueId: string,
  email: string
): Promise<Response> {
  const match = path.match(/^\/([^/]+)\/branches\/?$/)
  if (!match) {
    return notFoundResponse()
  }
  const ref = match[1]

  const project = await getProjectByRef(pool, ref, profileId)
  if (!project) {
    return notFoundResponse('Project not found')
  }

  if (method === 'GET') {
    const rows = await listBranchesForProject(pool, ref)
    return Response.json(rows.map(toBranchResponse), { headers: corsHeaders })
  }

  if (method === 'POST') {
    let body: Record<string, unknown>
    try {
      body = await req.json()
    } catch {
      return invalidBodyResponse('Body must be valid JSON')
    }

    const branchName = typeof body.branch_name === 'string' ? body.branch_name : undefined
    if (!branchName || !branchName.trim()) {
      return invalidBodyResponse('branch_name is required')
    }

    const auditContext = {
      email,
      ip: getIp(req),
      method,
      route: '/v1/projects/' + ref + '/branches',
    }

    const outcome = await createBranch(
      pool,
      ref,
      profileId,
      {
        branchName,
        isDefault: typeof body.is_default === 'boolean' ? body.is_default : false,
        gitBranch: typeof body.git_branch === 'string' ? body.git_branch : null,
        parentProjectRef:
          typeof body.parent_project_ref === 'string' ? body.parent_project_ref : null,
        prNumber: typeof body.pr_number === 'number' ? body.pr_number : null,
      },
      gotrueId,
      project.organization_id,
      auditContext
    )

    if (outcome.status === 'conflict') {
      return Response.json(
        { code: 'conflict', message: outcome.message },
        { status: 409, headers: corsHeaders }
      )
    }

    return Response.json(toBranchResponse(outcome.branch), {
      status: 201,
      headers: corsHeaders,
    })
  }

  return methodNotAllowedResponse()
}

// ── /{id} and /{id}/(diff|merge|push|reset|restore) ───────
//
// This handler lives under a dedicated Kong service (`v1-branches`) and
// receives paths stripped to `/{id}` / `/{id}/<action>`. Membership is
// enforced by first looking up the branch's project_ref, then calling
// getProjectByRef with the caller's profileId — non-members see 403.

export async function handleBranchById(
  req: Request,
  path: string,
  method: string,
  pool: Pool,
  profileId: number,
  gotrueId: string,
  email: string
): Promise<Response> {
  const match = path.match(/^\/([^/]+)(\/.*)?$/)
  if (!match) return notFoundResponse()

  const id = match[1]
  const action = (match[2] ?? '').replace(/\/$/, '')

  if (!isValidUuid(id)) {
    return notFoundResponse('Branch not found')
  }

  const branch = await getBranchById(pool, id)
  if (!branch) {
    return notFoundResponse('Branch not found')
  }

  // Membership: the caller must be a member of the branch's project.
  const project = await getProjectByRef(pool, branch.project_ref, profileId)
  if (!project) {
    // Treat unauthorized access to a known id as 403 (distinguishable from
    // "branch does not exist at all" which is handled above).
    return forbiddenResponse('Not a member of this project')
  }

  const auditContext = {
    email,
    ip: getIp(req),
    method,
    route: '/v1/branches/' + id + (action || ''),
  }

  // ── Action routes: /{id}/<action> ──

  if (action === '/diff') {
    if (method !== 'GET') return methodNotAllowedResponse()
    // Self-hosted has no schema-diff engine; return a shape-correct stub
    // so Studio's diff panel renders an empty state instead of a crash.
    return Response.json(
      {
        migrations_ahead: 0,
        schema_changes: [],
        data_changes: [],
      },
      { headers: corsHeaders }
    )
  }

  if (action === '/merge') {
    if (method !== 'POST') return methodNotAllowedResponse()
    const outcome = await mergeBranch(
      pool,
      id,
      profileId,
      gotrueId,
      project.organization_id,
      auditContext
    )
    return Response.json(transitionBody(outcome), {
      status: transitionStatus(outcome),
      headers: corsHeaders,
    })
  }

  if (action === '/push') {
    if (method !== 'POST') return methodNotAllowedResponse()
    const outcome = await pushBranch(
      pool,
      id,
      profileId,
      gotrueId,
      project.organization_id,
      auditContext
    )
    return Response.json(transitionBody(outcome), {
      status: transitionStatus(outcome),
      headers: corsHeaders,
    })
  }

  if (action === '/reset') {
    if (method !== 'POST') return methodNotAllowedResponse()
    const outcome = await resetBranch(
      pool,
      id,
      profileId,
      gotrueId,
      project.organization_id,
      auditContext
    )
    return Response.json(transitionBody(outcome), {
      status: transitionStatus(outcome),
      headers: corsHeaders,
    })
  }

  if (action === '/restore') {
    if (method !== 'POST') return methodNotAllowedResponse()
    if (!branch.deleted_at) {
      return Response.json(
        { code: 'invalid_state', message: 'Branch is not deleted' },
        { status: 409, headers: corsHeaders }
      )
    }
    const restored = await restoreBranch(
      pool,
      id,
      profileId,
      gotrueId,
      project.organization_id,
      auditContext
    )
    if (!restored) {
      return notFoundResponse('Branch not found')
    }
    return Response.json(toBranchResponse(restored), { headers: corsHeaders })
  }

  // ── Bare /{id} ──

  if (action !== '') {
    return notFoundResponse()
  }

  if (method === 'GET') {
    return Response.json(toBranchResponse(branch), { headers: corsHeaders })
  }

  if (method === 'PATCH') {
    if (branch.deleted_at) {
      return notFoundResponse('Branch not found')
    }
    let body: Record<string, unknown>
    try {
      body = await req.json()
    } catch {
      return invalidBodyResponse('Body must be valid JSON')
    }

    const outcome = await updateBranch(
      pool,
      id,
      {
        branchName: typeof body.branch_name === 'string' ? body.branch_name : undefined,
        isDefault: typeof body.is_default === 'boolean' ? body.is_default : undefined,
        gitBranch:
          typeof body.git_branch === 'string'
            ? body.git_branch
            : body.git_branch === null
              ? null
              : undefined,
        parentProjectRef:
          typeof body.parent_project_ref === 'string'
            ? body.parent_project_ref
            : body.parent_project_ref === null
              ? null
              : undefined,
        prNumber:
          typeof body.pr_number === 'number'
            ? body.pr_number
            : body.pr_number === null
              ? null
              : undefined,
      },
      profileId,
      gotrueId,
      project.organization_id,
      auditContext
    )

    if (outcome.status === 'not_found') {
      return notFoundResponse('Branch not found')
    }
    if (outcome.status === 'conflict') {
      return Response.json(
        { code: 'conflict', message: outcome.message },
        { status: 409, headers: corsHeaders }
      )
    }
    return Response.json(toBranchResponse(outcome.branch), {
      headers: corsHeaders,
    })
  }

  if (method === 'DELETE') {
    if (branch.deleted_at) {
      return notFoundResponse('Branch not found')
    }
    const deleted = await softDeleteBranch(
      pool,
      id,
      profileId,
      gotrueId,
      project.organization_id,
      auditContext
    )
    if (!deleted) {
      return notFoundResponse('Branch not found')
    }
    return Response.json(toBranchResponse(deleted), { headers: corsHeaders })
  }

  return methodNotAllowedResponse()
}
