import type { Pool } from "https://deno.land/x/postgres@v0.17.0/mod.ts";
import type {
  MemberResponse,
  InvitationItem,
  InvitationResponse,
  InvitationByTokenResponse,
  CreateInvitationBody,
  RoleItem,
  OrganizationRoleResponse,
  MfaEnforcementResponse,
  MemberWithFreeProjectLimit,
} from "../types/api.ts";

interface AuditContext {
  email: string;
  ip: string;
  method: string;
  route: string;
}

// ── Row types ────────────────────────────────────────────

interface MemberRow {
  gotrue_id: string;
  is_sso_user: boolean | null;
  primary_email: string | null;
  username: string;
  role_ids: number[];
}

interface InvitationRow {
  id: number;
  invited_at: string;
  invited_email: string;
  role_id: number;
}

interface RoleRow {
  id: number;
  name: string;
  description: string | null;
  base_role_id: number;
}

interface FreeProjectLimitRow {
  free_project_limit: number;
  primary_email: string;
  username: string;
}

// ── Authorization helper ─────────────────────────────────

export async function getMemberHighestRoleId(
  pool: Pool,
  orgId: number,
  profileId: number,
): Promise<number> {
  const connection = await pool.connect();
  try {
    const result = await connection.queryObject<{ max_role: number | null }>`
      SELECT MAX(role_id) as max_role
      FROM traffic.organization_member_roles
      WHERE organization_id = ${orgId} AND profile_id = ${profileId}
    `;
    return result.rows[0]?.max_role ?? 0;
  } finally {
    connection.release();
  }
}

// ── List members ─────────────────────────────────────────

export async function listMembers(
  pool: Pool,
  orgId: number,
): Promise<MemberResponse[]> {
  const connection = await pool.connect();
  try {
    const result = await connection.queryObject<MemberRow>`
      SELECT
        p.gotrue_id,
        p.is_sso_user,
        p.primary_email,
        p.username,
        COALESCE(
          array_agg(omr.role_id ORDER BY omr.role_id) FILTER (WHERE omr.role_id IS NOT NULL),
          '{}'
        ) AS role_ids
      FROM traffic.organization_members om
      JOIN traffic.profiles p ON p.id = om.profile_id
      LEFT JOIN traffic.organization_member_roles omr
        ON omr.organization_id = om.organization_id AND omr.profile_id = om.profile_id
      WHERE om.organization_id = ${orgId}
      GROUP BY p.gotrue_id, p.is_sso_user, p.primary_email, p.username
    `;
    return result.rows.map((r) => ({
      gotrue_id: r.gotrue_id,
      is_sso_user: r.is_sso_user,
      metadata: {},
      mfa_enabled: false,
      primary_email: r.primary_email,
      role_ids: r.role_ids ?? [],
      username: r.username,
    }));
  } finally {
    connection.release();
  }
}

// ── Delete member ────────────────────────────────────────

export async function deleteMember(
  pool: Pool,
  orgId: number,
  targetGotrueId: string,
  actorProfileId: number,
  gotrueId: string,
  auditCtx: AuditContext,
): Promise<{ success: boolean; error?: string; status?: number }> {
  const connection = await pool.connect();
  try {
    const tx = connection.createTransaction("delete_member");
    await tx.begin();

    const target = await tx.queryObject<{ profile_id: number }>`
      SELECT om.profile_id
      FROM traffic.organization_members om
      JOIN traffic.profiles p ON p.id = om.profile_id
      WHERE om.organization_id = ${orgId} AND p.gotrue_id = ${targetGotrueId}::uuid
    `;
    if (target.rows.length === 0) {
      await tx.rollback();
      return { success: false, error: "Member not found", status: 404 };
    }
    const targetProfileId = target.rows[0].profile_id;

    const ownerCheck = await tx.queryObject<{ cnt: number }>`
      SELECT COUNT(*)::int AS cnt
      FROM traffic.organization_member_roles
      WHERE organization_id = ${orgId} AND role_id = 5
    `;
    const targetHasOwner = await tx.queryObject<{ cnt: number }>`
      SELECT COUNT(*)::int AS cnt
      FROM traffic.organization_member_roles
      WHERE organization_id = ${orgId} AND profile_id = ${targetProfileId} AND role_id = 5
    `;
    if (targetHasOwner.rows[0].cnt > 0 && ownerCheck.rows[0].cnt <= 1) {
      await tx.rollback();
      return { success: false, error: "Cannot remove the last owner", status: 400 };
    }

    await tx.queryObject`
      DELETE FROM traffic.organization_member_roles
      WHERE organization_id = ${orgId} AND profile_id = ${targetProfileId}
    `;
    await tx.queryObject`
      DELETE FROM traffic.organization_members
      WHERE organization_id = ${orgId} AND profile_id = ${targetProfileId}
    `;

    await tx.queryObject`
      INSERT INTO traffic.audit_logs (
        id, profile_id, organization_id, action_name, action_metadata,
        actor_id, actor_type, actor_metadata,
        target_description, target_metadata, occurred_at
      ) VALUES (
        gen_random_uuid(), ${actorProfileId}, ${orgId}, 'organization_members.delete',
        ${JSON.stringify([{ method: auditCtx.method, route: auditCtx.route, status: 200 }])}::jsonb,
        ${gotrueId}, 'user',
        ${JSON.stringify([{ email: auditCtx.email, ip: auditCtx.ip }])}::jsonb,
        ${"member " + targetGotrueId}, '{}'::jsonb, now()
      )
    `;

    await tx.commit();
    return { success: true };
  } finally {
    connection.release();
  }
}

// ── Assign role (PATCH member V2) ────────────────────────

export async function assignMemberRole(
  pool: Pool,
  orgId: number,
  targetGotrueId: string,
  roleId: number,
  projects: string[] | undefined,
  actorProfileId: number,
  gotrueId: string,
  auditCtx: AuditContext,
): Promise<{ success: boolean; error?: string; status?: number }> {
  const connection = await pool.connect();
  try {
    const tx = connection.createTransaction("assign_member_role");
    await tx.begin();

    const target = await tx.queryObject<{ profile_id: number }>`
      SELECT om.profile_id
      FROM traffic.organization_members om
      JOIN traffic.profiles p ON p.id = om.profile_id
      WHERE om.organization_id = ${orgId} AND p.gotrue_id = ${targetGotrueId}::uuid
    `;
    if (target.rows.length === 0) {
      await tx.rollback();
      return { success: false, error: "Member not found", status: 404 };
    }
    const targetProfileId = target.rows[0].profile_id;

    await tx.queryObject`
      INSERT INTO traffic.organization_member_roles (organization_id, profile_id, role_id, project_refs)
      VALUES (${orgId}, ${targetProfileId}, ${roleId}, ${projects ?? []})
      ON CONFLICT (organization_id, profile_id, role_id)
      DO UPDATE SET project_refs = ${projects ?? []}
    `;

    await tx.queryObject`
      INSERT INTO traffic.audit_logs (
        id, profile_id, organization_id, action_name, action_metadata,
        actor_id, actor_type, actor_metadata,
        target_description, target_metadata, occurred_at
      ) VALUES (
        gen_random_uuid(), ${actorProfileId}, ${orgId}, 'organization_member_roles.insert',
        ${JSON.stringify([{ method: auditCtx.method, route: auditCtx.route, status: 200 }])}::jsonb,
        ${gotrueId}, 'user',
        ${JSON.stringify([{ email: auditCtx.email, ip: auditCtx.ip }])}::jsonb,
        ${"member " + targetGotrueId + " role " + roleId}, '{}'::jsonb, now()
      )
    `;

    await tx.commit();
    return { success: true };
  } finally {
    connection.release();
  }
}

// ── Update member role (PUT) ─────────────────────────────

export async function updateMemberRole(
  pool: Pool,
  orgId: number,
  targetGotrueId: string,
  roleId: number,
  projectRefs: string[],
  actorProfileId: number,
  gotrueId: string,
  auditCtx: AuditContext,
): Promise<{ success: boolean; error?: string; status?: number }> {
  const connection = await pool.connect();
  try {
    const tx = connection.createTransaction("update_member_role");
    await tx.begin();

    const target = await tx.queryObject<{ profile_id: number }>`
      SELECT om.profile_id
      FROM traffic.organization_members om
      JOIN traffic.profiles p ON p.id = om.profile_id
      WHERE om.organization_id = ${orgId} AND p.gotrue_id = ${targetGotrueId}::uuid
    `;
    if (target.rows.length === 0) {
      await tx.rollback();
      return { success: false, error: "Member not found", status: 404 };
    }

    const updated = await tx.queryObject`
      UPDATE traffic.organization_member_roles
      SET project_refs = ${projectRefs}
      WHERE organization_id = ${orgId}
        AND profile_id = ${target.rows[0].profile_id}
        AND role_id = ${roleId}
    `;
    if (updated.rowCount === 0) {
      await tx.rollback();
      return { success: false, error: "Role assignment not found", status: 404 };
    }

    await tx.queryObject`
      INSERT INTO traffic.audit_logs (
        id, profile_id, organization_id, action_name, action_metadata,
        actor_id, actor_type, actor_metadata,
        target_description, target_metadata, occurred_at
      ) VALUES (
        gen_random_uuid(), ${actorProfileId}, ${orgId}, 'organization_member_roles.update',
        ${JSON.stringify([{ method: auditCtx.method, route: auditCtx.route, status: 200 }])}::jsonb,
        ${gotrueId}, 'user',
        ${JSON.stringify([{ email: auditCtx.email, ip: auditCtx.ip }])}::jsonb,
        ${"member " + targetGotrueId + " role " + roleId}, '{}'::jsonb, now()
      )
    `;

    await tx.commit();
    return { success: true };
  } finally {
    connection.release();
  }
}

// ── Unassign role (DELETE) ───────────────────────────────

export async function unassignMemberRole(
  pool: Pool,
  orgId: number,
  targetGotrueId: string,
  roleId: number,
  actorProfileId: number,
  gotrueId: string,
  auditCtx: AuditContext,
): Promise<{ success: boolean; error?: string; status?: number }> {
  const connection = await pool.connect();
  try {
    const tx = connection.createTransaction("unassign_member_role");
    await tx.begin();

    const target = await tx.queryObject<{ profile_id: number }>`
      SELECT om.profile_id
      FROM traffic.organization_members om
      JOIN traffic.profiles p ON p.id = om.profile_id
      WHERE om.organization_id = ${orgId} AND p.gotrue_id = ${targetGotrueId}::uuid
    `;
    if (target.rows.length === 0) {
      await tx.rollback();
      return { success: false, error: "Member not found", status: 404 };
    }
    const targetProfileId = target.rows[0].profile_id;

    if (roleId === 5) {
      const ownerCount = await tx.queryObject<{ cnt: number }>`
        SELECT COUNT(*)::int AS cnt
        FROM traffic.organization_member_roles
        WHERE organization_id = ${orgId} AND role_id = 5
      `;
      if (ownerCount.rows[0].cnt <= 1) {
        await tx.rollback();
        return { success: false, error: "Cannot remove the last owner role", status: 400 };
      }
    }

    const deleted = await tx.queryObject`
      DELETE FROM traffic.organization_member_roles
      WHERE organization_id = ${orgId}
        AND profile_id = ${targetProfileId}
        AND role_id = ${roleId}
    `;
    if (deleted.rowCount === 0) {
      await tx.rollback();
      return { success: false, error: "Role assignment not found", status: 404 };
    }

    await tx.queryObject`
      INSERT INTO traffic.audit_logs (
        id, profile_id, organization_id, action_name, action_metadata,
        actor_id, actor_type, actor_metadata,
        target_description, target_metadata, occurred_at
      ) VALUES (
        gen_random_uuid(), ${actorProfileId}, ${orgId}, 'organization_member_roles.delete',
        ${JSON.stringify([{ method: auditCtx.method, route: auditCtx.route, status: 200 }])}::jsonb,
        ${gotrueId}, 'user',
        ${JSON.stringify([{ email: auditCtx.email, ip: auditCtx.ip }])}::jsonb,
        ${"member " + targetGotrueId + " role " + roleId}, '{}'::jsonb, now()
      )
    `;

    await tx.commit();
    return { success: true };
  } finally {
    connection.release();
  }
}

// ── List invitations ─────────────────────────────────────

export async function listInvitations(
  pool: Pool,
  orgId: number,
): Promise<InvitationResponse> {
  const connection = await pool.connect();
  try {
    const result = await connection.queryObject<InvitationRow>`
      SELECT id, invited_at, invited_email, role_id
      FROM traffic.invitations
      WHERE organization_id = ${orgId}
      ORDER BY invited_at DESC
    `;
    return { invitations: result.rows };
  } finally {
    connection.release();
  }
}

// ── Create invitation ────────────────────────────────────

export async function createInvitation(
  pool: Pool,
  orgId: number,
  body: CreateInvitationBody,
  actorProfileId: number,
  gotrueId: string,
  auditCtx: AuditContext,
): Promise<{ invitation?: InvitationItem; error?: string; status?: number }> {
  const connection = await pool.connect();
  try {
    const tx = connection.createTransaction("create_invitation");
    await tx.begin();

    const existing = await tx.queryObject<{ cnt: number }>`
      SELECT COUNT(*)::int AS cnt
      FROM traffic.invitations
      WHERE organization_id = ${orgId} AND invited_email = ${body.email}
    `;
    if (existing.rows[0].cnt > 0) {
      await tx.rollback();
      return { error: "An invitation already exists for this email", status: 409 };
    }

    const existingMember = await tx.queryObject<{ cnt: number }>`
      SELECT COUNT(*)::int AS cnt
      FROM traffic.organization_members om
      JOIN traffic.profiles p ON p.id = om.profile_id
      WHERE om.organization_id = ${orgId} AND p.primary_email = ${body.email}
    `;
    if (existingMember.rows[0].cnt > 0) {
      await tx.rollback();
      return { error: "User is already a member of this organization", status: 409 };
    }

    const result = await tx.queryObject<InvitationRow>`
      INSERT INTO traffic.invitations (organization_id, invited_email, role_id, role_scoped_projects)
      VALUES (${orgId}, ${body.email}, ${body.role_id}, ${body.role_scoped_projects ?? []})
      RETURNING id, invited_at, invited_email, role_id
    `;

    await tx.queryObject`
      INSERT INTO traffic.audit_logs (
        id, profile_id, organization_id, action_name, action_metadata,
        actor_id, actor_type, actor_metadata,
        target_description, target_metadata, occurred_at
      ) VALUES (
        gen_random_uuid(), ${actorProfileId}, ${orgId}, 'invitations.insert',
        ${JSON.stringify([{ method: auditCtx.method, route: auditCtx.route, status: 201 }])}::jsonb,
        ${gotrueId}, 'user',
        ${JSON.stringify([{ email: auditCtx.email, ip: auditCtx.ip }])}::jsonb,
        ${"invitation for " + body.email}, '{}'::jsonb, now()
      )
    `;

    await tx.commit();
    return { invitation: result.rows[0] };
  } finally {
    connection.release();
  }
}

// ── Delete invitation ────────────────────────────────────

export async function deleteInvitation(
  pool: Pool,
  orgId: number,
  invitationId: number,
  actorProfileId: number,
  gotrueId: string,
  auditCtx: AuditContext,
): Promise<boolean> {
  const connection = await pool.connect();
  try {
    const tx = connection.createTransaction("delete_invitation");
    await tx.begin();

    const deleted = await tx.queryObject`
      DELETE FROM traffic.invitations
      WHERE id = ${invitationId} AND organization_id = ${orgId}
    `;
    if (deleted.rowCount === 0) {
      await tx.rollback();
      return false;
    }

    await tx.queryObject`
      INSERT INTO traffic.audit_logs (
        id, profile_id, organization_id, action_name, action_metadata,
        actor_id, actor_type, actor_metadata,
        target_description, target_metadata, occurred_at
      ) VALUES (
        gen_random_uuid(), ${actorProfileId}, ${orgId}, 'invitations.delete',
        ${JSON.stringify([{ method: auditCtx.method, route: auditCtx.route, status: 200 }])}::jsonb,
        ${gotrueId}, 'user',
        ${JSON.stringify([{ email: auditCtx.email, ip: auditCtx.ip }])}::jsonb,
        ${"invitation #" + invitationId}, '{}'::jsonb, now()
      )
    `;

    await tx.commit();
    return true;
  } finally {
    connection.release();
  }
}

// ── Get invitation by token ──────────────────────────────

export async function getInvitationByToken(
  pool: Pool,
  token: string,
  gotrueId: string,
  email: string,
): Promise<InvitationByTokenResponse> {
  const connection = await pool.connect();
  try {
    const result = await connection.queryObject<{
      id: number;
      invited_email: string;
      expires_at: string;
      org_name: string;
    }>`
      SELECT i.id, i.invited_email, i.expires_at, o.name AS org_name
      FROM traffic.invitations i
      JOIN traffic.organizations o ON o.id = i.organization_id
      WHERE i.token = ${token}::uuid
    `;

    if (result.rows.length === 0) {
      return {
        authorized_user: false,
        email_match: false,
        expired_token: false,
        organization_name: "",
        sso_mismatch: false,
        token_does_not_exist: true,
      };
    }

    const row = result.rows[0];
    const expired = new Date(row.expires_at) < new Date();
    const emailMatch = row.invited_email.toLowerCase() === email.toLowerCase();

    return {
      authorized_user: true,
      email_match: emailMatch,
      expired_token: expired,
      invite_id: row.id,
      organization_name: row.org_name,
      sso_mismatch: false,
      token_does_not_exist: false,
    };
  } finally {
    connection.release();
  }
}

// ── Accept invitation ────────────────────────────────────

export async function acceptInvitation(
  pool: Pool,
  token: string,
  profileId: number,
  gotrueId: string,
  auditCtx: AuditContext,
): Promise<{ success: boolean; error?: string; status?: number }> {
  const connection = await pool.connect();
  try {
    const tx = connection.createTransaction("accept_invitation");
    await tx.begin();

    const inv = await tx.queryObject<{
      id: number;
      organization_id: number;
      role_id: number;
      invited_email: string;
      expires_at: string;
      role_scoped_projects: string[];
    }>`
      SELECT id, organization_id, role_id, invited_email, expires_at, role_scoped_projects
      FROM traffic.invitations
      WHERE token = ${token}::uuid
    `;

    if (inv.rows.length === 0) {
      await tx.rollback();
      return { success: false, error: "Invitation not found", status: 404 };
    }

    const invitation = inv.rows[0];
    if (new Date(invitation.expires_at) < new Date()) {
      await tx.rollback();
      return { success: false, error: "Invitation has expired", status: 410 };
    }

    const existingMember = await tx.queryObject<{ cnt: number }>`
      SELECT COUNT(*)::int AS cnt
      FROM traffic.organization_members
      WHERE organization_id = ${invitation.organization_id} AND profile_id = ${profileId}
    `;
    if (existingMember.rows[0].cnt > 0) {
      await tx.queryObject`
        DELETE FROM traffic.invitations WHERE id = ${invitation.id}
      `;
      await tx.commit();
      return { success: true };
    }

    await tx.queryObject`
      INSERT INTO traffic.organization_members (organization_id, profile_id, role)
      VALUES (${invitation.organization_id}, ${profileId}, 'member')
    `;

    await tx.queryObject`
      INSERT INTO traffic.organization_member_roles (organization_id, profile_id, role_id, project_refs)
      VALUES (${invitation.organization_id}, ${profileId}, ${invitation.role_id}, ${invitation.role_scoped_projects})
    `;

    await tx.queryObject`
      DELETE FROM traffic.invitations WHERE id = ${invitation.id}
    `;

    await tx.queryObject`
      INSERT INTO traffic.audit_logs (
        id, profile_id, organization_id, action_name, action_metadata,
        actor_id, actor_type, actor_metadata,
        target_description, target_metadata, occurred_at
      ) VALUES (
        gen_random_uuid(), ${profileId}, ${invitation.organization_id}, 'invitations.accept',
        ${JSON.stringify([{ method: auditCtx.method, route: auditCtx.route, status: 200 }])}::jsonb,
        ${gotrueId}, 'user',
        ${JSON.stringify([{ email: auditCtx.email, ip: auditCtx.ip }])}::jsonb,
        ${"invitation #" + invitation.id}, '{}'::jsonb, now()
      )
    `;

    await tx.commit();
    return { success: true };
  } finally {
    connection.release();
  }
}

// ── List roles ───────────────────────────────────────────

export async function listRoles(
  pool: Pool,
  _orgId: number,
): Promise<OrganizationRoleResponse> {
  const connection = await pool.connect();
  try {
    const result = await connection.queryObject<RoleRow>`
      SELECT id, name, description, base_role_id
      FROM traffic.roles
      ORDER BY id ASC
    `;
    const roles: RoleItem[] = result.rows.map((r) => ({
      base_role_id: r.base_role_id,
      description: r.description,
      id: r.id,
      name: r.name,
      projects: [],
    }));
    return {
      org_scoped_roles: roles,
      project_scoped_roles: [],
    };
  } finally {
    connection.release();
  }
}

// ── MFA enforcement ──────────────────────────────────────

export async function getMfaEnforcement(
  pool: Pool,
  orgId: number,
): Promise<MfaEnforcementResponse> {
  const connection = await pool.connect();
  try {
    const result = await connection.queryObject<{ mfa_enforced: boolean }>`
      SELECT mfa_enforced FROM traffic.organizations WHERE id = ${orgId}
    `;
    return { enforced: result.rows[0]?.mfa_enforced ?? false };
  } finally {
    connection.release();
  }
}

export async function updateMfaEnforcement(
  pool: Pool,
  orgId: number,
  enforced: boolean,
  profileId: number,
  gotrueId: string,
  auditCtx: AuditContext,
): Promise<MfaEnforcementResponse> {
  const connection = await pool.connect();
  try {
    const tx = connection.createTransaction("update_mfa_enforcement");
    await tx.begin();

    await tx.queryObject`
      UPDATE traffic.organizations
      SET mfa_enforced = ${enforced}, updated_at = now()
      WHERE id = ${orgId}
    `;

    await tx.queryObject`
      INSERT INTO traffic.audit_logs (
        id, profile_id, organization_id, action_name, action_metadata,
        actor_id, actor_type, actor_metadata,
        target_description, target_metadata, occurred_at
      ) VALUES (
        gen_random_uuid(), ${profileId}, ${orgId}, 'organizations.mfa_update',
        ${JSON.stringify([{ method: auditCtx.method, route: auditCtx.route, status: 200 }])}::jsonb,
        ${gotrueId}, 'user',
        ${JSON.stringify([{ email: auditCtx.email, ip: auditCtx.ip }])}::jsonb,
        ${"organizations #" + orgId}, ${JSON.stringify({ enforced })}::jsonb, now()
      )
    `;

    await tx.commit();
    return { enforced };
  } finally {
    connection.release();
  }
}

// ── Free project limit check ─────────────────────────────

export async function getMembersAtFreeProjectLimit(
  pool: Pool,
  orgId: number,
): Promise<MemberWithFreeProjectLimit[]> {
  const connection = await pool.connect();
  try {
    const result = await connection.queryObject<FreeProjectLimitRow>`
      SELECT p.free_project_limit, p.primary_email, p.username
      FROM traffic.organization_members om
      JOIN traffic.profiles p ON p.id = om.profile_id
      LEFT JOIN (
        SELECT pr.organization_id, om2.profile_id, COUNT(*)::int AS project_count
        FROM traffic.projects pr
        JOIN traffic.organization_members om2
          ON om2.organization_id = pr.organization_id
        GROUP BY pr.organization_id, om2.profile_id
      ) pc ON pc.organization_id = om.organization_id AND pc.profile_id = om.profile_id
      WHERE om.organization_id = ${orgId}
        AND p.free_project_limit IS NOT NULL
        AND p.free_project_limit > 0
        AND COALESCE(pc.project_count, 0) >= p.free_project_limit
    `;
    return result.rows;
  } finally {
    connection.release();
  }
}
