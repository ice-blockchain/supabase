import type { Pool } from 'https://deno.land/x/postgres@v0.19.3/mod.ts'

export interface StudioPermission {
  actions: string[]
  resources: string[]
  condition: null
  organization_slug: string
  restrictive: boolean
  project_refs: string[]
}

// Role IDs come from traffic.roles (see migration 010):
//   2 = Read-only, 3 = Developer, 4 = Administrator, 5 = Owner.
// Owner implies all admin rights; Admin implies all developer rights;
// Developer implies all read-only rights. That's why we key off the highest
// role the user has in each org.
const ROLE_READ_ONLY = 2
const ROLE_DEVELOPER = 3
const ROLE_ADMIN = 4

// Builds the set of permission entries emitted for a single org membership.
// Earlier versions emitted `actions: ["%"], resources: ["%"]` for every
// member, which `useCheckPermissions` interprets as super-admin. That meant
// every UI gate collapsed regardless of role. The table below maps each role
// to a minimum allow-list plus any restrictive denies required to mirror the
// upstream supabase.com semantics (Read-only cannot write anything, Developer
// cannot manage members / billing / the org itself).
function permissionsForRole(slug: string, roleId: number): StudioPermission[] {
  const base = {
    condition: null,
    organization_slug: slug,
    project_refs: [] as string[],
  } as const

  // Owner (5) and Admin (4) stay wildcard — they can manage members, billing,
  // and org settings just like upstream.
  if (roleId >= ROLE_ADMIN) {
    return [
      {
        ...base,
        actions: ['%'],
        resources: ['%'],
        restrictive: false,
      },
    ]
  }

  // Developer (3) keeps wildcard allow but is restricted from admin-only
  // resources (org settings, member management, billing writes). The
  // restrictive entries short-circuit the allow when a matching check lands.
  if (roleId === ROLE_DEVELOPER) {
    return [
      {
        ...base,
        actions: ['%'],
        resources: ['%'],
        restrictive: false,
      },
      {
        ...base,
        actions: ['create', 'update', 'delete'],
        resources: ['organizations', 'organization_members', 'invitations'],
        restrictive: true,
      },
      {
        ...base,
        actions: ['billing_write'],
        resources: ['%'],
        restrictive: true,
      },
    ]
  }

  // Read-only (2) may read anything but never create/update/delete.
  if (roleId === ROLE_READ_ONLY) {
    return [
      {
        ...base,
        actions: ['read', '%_read'],
        resources: ['%'],
        restrictive: false,
      },
    ]
  }

  // Unknown role_id: return an empty allow-list so the user gets no UI gates.
  // We still emit a single entry so the org slug shows up in `/permissions`;
  // without it, Studio may treat the user as "not a member" of that org.
  return [
    {
      ...base,
      actions: [],
      resources: [],
      restrictive: false,
    },
  ]
}

/**
 * Returns the effective permissions for a user in the format Studio expects.
 *
 * Emits one or more entries per organization the caller belongs to, scaled to
 * the caller's highest role in that org. Pre-H5 this function returned a
 * single wildcard entry per org regardless of role, which effectively made
 * every authenticated member a super-admin in Studio's UI gates.
 */
export async function getPermissions(pool: Pool, profileId: number): Promise<StudioPermission[]> {
  const connection = await pool.connect()
  try {
    // Pull the highest role_id per org in a single query (rather than N+1
    // `getMemberHighestRoleId` calls) so `/permissions` stays fast even for
    // users in many orgs.
    const result = await connection.queryObject<{ slug: string; max_role: number | null }>`
      SELECT o.slug, MAX(omr.role_id) AS max_role
      FROM traffic.organizations o
      JOIN traffic.organization_members m ON m.organization_id = o.id
      LEFT JOIN traffic.organization_member_roles omr
        ON omr.organization_id = o.id AND omr.profile_id = m.profile_id
      WHERE m.profile_id = ${profileId}
      GROUP BY o.id, o.slug, o.created_at
      ORDER BY o.created_at ASC
    `

    if (result.rows.length === 0) {
      // Legacy fallback: the caller is authenticated but has no org yet.
      // Emit a single wildcard entry scoped to the magic "default" slug so
      // Studio renders something while onboarding.
      return [
        {
          actions: ['%'],
          resources: ['%'],
          condition: null,
          organization_slug: 'default',
          restrictive: false,
          project_refs: [],
        },
      ]
    }

    return result.rows.flatMap((row) =>
      permissionsForRole(row.slug, row.max_role ?? ROLE_READ_ONLY)
    )
  } finally {
    connection.release()
  }
}
