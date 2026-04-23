import type { Pool } from 'https://deno.land/x/postgres@v0.17.0/mod.ts'

import { corsHeaders } from '../index.ts'
import {
  acceptInvitation,
  assignMemberRole,
  createInvitation,
  deleteInvitation,
  deleteMember,
  getInvitationByToken,
  getMemberHighestRoleId,
  getMembersAtFreeProjectLimit,
  getMfaEnforcement,
  listInvitations,
  listMembers,
  listRoles,
  unassignMemberRole,
  updateMemberRole,
  updateMfaEnforcement,
} from '../services/member.service.ts'
import type {
  AssignMemberRoleBodyV2,
  CreateInvitationBody,
  UpdateMemberRoleBody,
} from '../types/api.ts'
import { getClientIp } from '../utils/client-ip.ts'

const ADMIN_ROLE_ID = 4

export async function handleMembers(
  req: Request,
  subPath: string,
  method: string,
  pool: Pool,
  orgId: number,
  profileId: number,
  gotrueId: string,
  email: string
): Promise<Response> {
  const ip = getClientIp(req)
  const auditCtx = { email, ip, method, route: '/organizations/*/members' + subPath }

  // GET /roles
  if (subPath === '/roles' && method === 'GET') {
    const roles = await listRoles(pool, orgId)
    return Response.json(roles, { headers: corsHeaders })
  }

  // Strip /members prefix for sub-routing
  const memberPath = subPath.startsWith('/members') ? subPath.slice('/members'.length) : subPath

  // GET /members
  if (memberPath === '' && method === 'GET') {
    const members = await listMembers(pool, orgId)
    return Response.json(members, { headers: corsHeaders })
  }

  // GET /members/reached-free-project-limit
  if (memberPath === '/reached-free-project-limit' && method === 'GET') {
    const members = await getMembersAtFreeProjectLimit(pool, orgId)
    return Response.json(members, { headers: corsHeaders })
  }

  // GET /members/mfa/enforcement
  if (memberPath === '/mfa/enforcement' && method === 'GET') {
    const mfa = await getMfaEnforcement(pool, orgId)
    return Response.json(mfa, { headers: corsHeaders })
  }

  // PATCH /members/mfa/enforcement
  if (memberPath === '/mfa/enforcement' && method === 'PATCH') {
    const actorRole = await getMemberHighestRoleId(pool, orgId, profileId)
    if (actorRole < ADMIN_ROLE_ID) {
      return Response.json({ message: 'Forbidden' }, { status: 403, headers: corsHeaders })
    }
    const body = await req.json()
    const mfa = await updateMfaEnforcement(
      pool,
      orgId,
      body.enforced,
      profileId,
      gotrueId,
      auditCtx
    )
    return Response.json(mfa, { headers: corsHeaders })
  }

  // GET /members/invitations
  if (memberPath === '/invitations' && method === 'GET') {
    const invitations = await listInvitations(pool, orgId)
    return Response.json(invitations, { headers: corsHeaders })
  }

  // POST /members/invitations
  if (memberPath === '/invitations' && method === 'POST') {
    const actorRole = await getMemberHighestRoleId(pool, orgId, profileId)
    if (actorRole < ADMIN_ROLE_ID) {
      return Response.json({ message: 'Forbidden' }, { status: 403, headers: corsHeaders })
    }
    const body: CreateInvitationBody = await req.json()
    if (!body.email || !body.role_id) {
      return Response.json(
        { message: 'email and role_id are required' },
        { status: 400, headers: corsHeaders }
      )
    }
    const result = await createInvitation(pool, orgId, body, profileId, gotrueId, auditCtx)
    if (result.error) {
      return Response.json(
        { message: result.error },
        { status: result.status ?? 400, headers: corsHeaders }
      )
    }
    return Response.json(result.invitation, { status: 201, headers: corsHeaders })
  }

  // Invitation by token: GET /members/invitations/{token}
  const tokenGetMatch = memberPath.match(/^\/invitations\/([0-9a-f-]{36})$/)
  if (tokenGetMatch && method === 'GET') {
    const token = tokenGetMatch[1]
    const info = await getInvitationByToken(pool, token, gotrueId, email)
    return Response.json(info, { headers: corsHeaders })
  }

  // Accept invitation: POST /members/invitations/{token}
  const tokenPostMatch = memberPath.match(/^\/invitations\/([0-9a-f-]{36})$/)
  if (tokenPostMatch && method === 'POST') {
    const token = tokenPostMatch[1]
    const result = await acceptInvitation(pool, token, profileId, gotrueId, auditCtx)
    if (!result.success) {
      return Response.json(
        { message: result.error },
        { status: result.status ?? 400, headers: corsHeaders }
      )
    }
    return Response.json({ message: 'Invitation accepted' }, { headers: corsHeaders })
  }

  // Delete invitation: DELETE /members/invitations/{id}
  const invDeleteMatch = memberPath.match(/^\/invitations\/(\d+)$/)
  if (invDeleteMatch && method === 'DELETE') {
    const actorRole = await getMemberHighestRoleId(pool, orgId, profileId)
    if (actorRole < ADMIN_ROLE_ID) {
      return Response.json({ message: 'Forbidden' }, { status: 403, headers: corsHeaders })
    }
    const invitationId = parseInt(invDeleteMatch[1], 10)
    const deleted = await deleteInvitation(pool, orgId, invitationId, profileId, gotrueId, auditCtx)
    if (!deleted) {
      return Response.json(
        { message: 'Invitation not found' },
        { status: 404, headers: corsHeaders }
      )
    }
    return Response.json({ message: 'Invitation deleted' }, { headers: corsHeaders })
  }

  // Member role operations: /{gotrue_id}/roles/{role_id}
  const memberRoleMatch = memberPath.match(/^\/([0-9a-f-]{36})\/roles\/(\d+)$/)
  if (memberRoleMatch) {
    const targetGotrueId = memberRoleMatch[1]
    const roleId = parseInt(memberRoleMatch[2], 10)

    if (method === 'PUT') {
      const actorRole = await getMemberHighestRoleId(pool, orgId, profileId)
      if (actorRole < ADMIN_ROLE_ID) {
        return Response.json({ message: 'Forbidden' }, { status: 403, headers: corsHeaders })
      }
      const body: UpdateMemberRoleBody = await req.json()
      const result = await updateMemberRole(
        pool,
        orgId,
        targetGotrueId,
        roleId,
        body.role_scoped_projects ?? [],
        profileId,
        gotrueId,
        auditCtx
      )
      if (!result.success) {
        return Response.json(
          { message: result.error },
          { status: result.status ?? 400, headers: corsHeaders }
        )
      }
      return Response.json({ message: 'Role updated' }, { headers: corsHeaders })
    }

    if (method === 'DELETE') {
      const actorRole = await getMemberHighestRoleId(pool, orgId, profileId)
      if (actorRole < ADMIN_ROLE_ID) {
        return Response.json({ message: 'Forbidden' }, { status: 403, headers: corsHeaders })
      }
      const result = await unassignMemberRole(
        pool,
        orgId,
        targetGotrueId,
        roleId,
        profileId,
        gotrueId,
        auditCtx
      )
      if (!result.success) {
        return Response.json(
          { message: result.error },
          { status: result.status ?? 400, headers: corsHeaders }
        )
      }
      return Response.json({ message: 'Role unassigned' }, { headers: corsHeaders })
    }
  }

  // DELETE /members/{gotrue_id}
  const memberDeleteMatch = memberPath.match(/^\/([0-9a-f-]{36})$/)
  if (memberDeleteMatch && method === 'DELETE') {
    const actorRole = await getMemberHighestRoleId(pool, orgId, profileId)
    if (actorRole < ADMIN_ROLE_ID) {
      return Response.json({ message: 'Forbidden' }, { status: 403, headers: corsHeaders })
    }
    const targetGotrueId = memberDeleteMatch[1]
    const result = await deleteMember(pool, orgId, targetGotrueId, profileId, gotrueId, auditCtx)
    if (!result.success) {
      return Response.json(
        { message: result.error },
        { status: result.status ?? 400, headers: corsHeaders }
      )
    }
    return Response.json({ message: 'Member removed' }, { headers: corsHeaders })
  }

  // PATCH /members/{gotrue_id} (Version 2 - assign role)
  const memberPatchMatch = memberPath.match(/^\/([0-9a-f-]{36})$/)
  if (memberPatchMatch && method === 'PATCH') {
    const actorRole = await getMemberHighestRoleId(pool, orgId, profileId)
    if (actorRole < ADMIN_ROLE_ID) {
      return Response.json({ message: 'Forbidden' }, { status: 403, headers: corsHeaders })
    }
    const targetGotrueId = memberPatchMatch[1]
    const body: AssignMemberRoleBodyV2 = await req.json()
    if (!body.role_id) {
      return Response.json(
        { message: 'role_id is required' },
        { status: 400, headers: corsHeaders }
      )
    }
    const result = await assignMemberRole(
      pool,
      orgId,
      targetGotrueId,
      body.role_id,
      body.role_scoped_projects,
      profileId,
      gotrueId,
      auditCtx
    )
    if (!result.success) {
      return Response.json(
        { message: result.error },
        { status: result.status ?? 400, headers: corsHeaders }
      )
    }
    return Response.json({ message: 'Role assigned' }, { headers: corsHeaders })
  }

  return Response.json({ message: 'Not Found' }, { status: 404, headers: corsHeaders })
}
