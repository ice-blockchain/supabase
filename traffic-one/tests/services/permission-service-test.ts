import { assert, assertEquals } from 'jsr:@std/assert@1'

import 'jsr:@std/dotenv/load'

import { createRetryingPool } from '../_helpers/pool.ts'
import { getPermissions } from '../../functions/services/permission.service.ts'

const pool = createRetryingPool(Deno.env.get('TRAFFIC_DB_URL')!)

async function seedProfileAndOrg(roleId: number, suffix: string) {
  return await pool.withConnection(async (setup) => {
    const profile = await setup.queryObject<{ id: number }>`
      INSERT INTO traffic.profiles (gotrue_id, username, primary_email)
      VALUES (
        ${crypto.randomUUID()},
        ${'perm-' + suffix},
        ${'perm-' + suffix + '@test.com'}
      )
      RETURNING id
    `
    const profileId = profile.rows[0].id

    const org = await setup.queryObject<{ id: number; slug: string }>`
      INSERT INTO traffic.organizations (slug, name, billing_email, owner_profile_id)
      VALUES (
        ${'perm-org-' + suffix},
        ${'Perm Org ' + suffix},
        ${'perm-' + suffix + '@test.com'},
        ${profileId}
      )
      RETURNING id, slug
    `
    const orgId = org.rows[0].id
    const slug = org.rows[0].slug

    await setup.queryObject`
      INSERT INTO traffic.organization_members (organization_id, profile_id, role)
      VALUES (${orgId}, ${profileId}, 'member')
    `
    await setup.queryObject`
      INSERT INTO traffic.organization_member_roles (organization_id, profile_id, role_id)
      VALUES (${orgId}, ${profileId}, ${roleId})
    `

    return { profileId, orgId, slug }
  })
}

async function cleanup(profileId: number | null, orgId: number | null) {
  try {
    await pool.withConnection(async (conn) => {
      if (orgId !== null) {
        await conn
          .queryObject`DELETE FROM traffic.organizations WHERE id = ${orgId}`
      }
      if (profileId !== null) {
        await conn
          .queryObject`DELETE FROM traffic.profiles WHERE id = ${profileId}`
      }
    })
  } catch {
    /* best-effort */
  }
}

// The matcher mirrors `toRegexpString` in apps/studio/hooks/misc/useCheckPermissions.ts
// so we can assert what Studio would decide for a given action+resource pair.
function toRegexpString(actionOrResource: string) {
  return `^${actionOrResource.replace('.', '\\.').replace('%', '.*')}$`
}

function can(
  permissions: ReturnType<typeof emitted>,
  action: string,
  resource: string,
): boolean {
  const matching = permissions.filter(
    (p) =>
      p.actions.some((a) => action.match(toRegexpString(a))) &&
      p.resources.some((r) => resource.match(toRegexpString(r))),
  )
  if (matching.length === 0) return false
  if (matching.some((p) => p.restrictive)) return false
  return matching.some((p) => !p.restrictive)
}

type StudioPermission = {
  actions: string[]
  resources: string[]
  restrictive: boolean
  organization_slug: string
  project_refs: string[]
  condition: null
}

function emitted(
  permissions: StudioPermission[],
  slug: string,
): StudioPermission[] {
  return permissions.filter((p) => p.organization_slug === slug)
}

Deno.test('H5: Owner (role 5) receives wildcard permissions', async () => {
  let profileId: number | null = null
  let orgId: number | null = null
  try {
    const seed = await seedProfileAndOrg(5, 'owner-' + Date.now())
    profileId = seed.profileId
    orgId = seed.orgId

    const permissions = await getPermissions(pool, seed.profileId)
    const forOrg = emitted(permissions as StudioPermission[], seed.slug)

    assert(forOrg.length === 1, 'owner should emit one wildcard entry')
    assertEquals(forOrg[0].actions, ['%'])
    assertEquals(forOrg[0].resources, ['%'])
    assertEquals(forOrg[0].restrictive, false)

    assert(can(forOrg, 'update', 'organizations'))
    assert(can(forOrg, 'delete', 'organization_members'))
    assert(can(forOrg, 'billing_write', 'stripe.addons'))
  } finally {
    await cleanup(profileId, orgId)
  }
})

Deno.test('H5: Administrator (role 4) receives wildcard permissions', async () => {
  let profileId: number | null = null
  let orgId: number | null = null
  try {
    const seed = await seedProfileAndOrg(4, 'admin-' + Date.now())
    profileId = seed.profileId
    orgId = seed.orgId

    const forOrg = emitted(
      (await getPermissions(pool, seed.profileId)) as StudioPermission[],
      seed.slug,
    )
    assert(can(forOrg, 'create', 'organization_members'))
    assert(can(forOrg, 'billing_write', 'stripe.tax_ids'))
  } finally {
    await cleanup(profileId, orgId)
  }
})

Deno.test('H5: Developer (role 3) cannot manage members or billing', async () => {
  let profileId: number | null = null
  let orgId: number | null = null
  try {
    const seed = await seedProfileAndOrg(3, 'dev-' + Date.now())
    profileId = seed.profileId
    orgId = seed.orgId

    const forOrg = emitted(
      (await getPermissions(pool, seed.profileId)) as StudioPermission[],
      seed.slug,
    )

    assert(
      forOrg.some((p) => !p.restrictive && p.actions.includes('%')),
      'developer should keep a wildcard allow entry',
    )
    assert(
      forOrg.some((p) => p.restrictive),
      'developer should emit restrictive entries',
    )

    // Allowed actions
    assert(can(forOrg, 'read', 'projects'))
    assert(can(forOrg, 'update', 'projects'))
    assert(can(forOrg, 'create', 'projects'))
    assert(can(forOrg, 'delete', 'functions'))

    // Denied admin/owner actions
    assert(
      !can(forOrg, 'update', 'organizations'),
      'developer may not update org settings',
    )
    assert(
      !can(forOrg, 'delete', 'organizations'),
      'developer may not delete the org',
    )
    assert(
      !can(forOrg, 'create', 'organization_members'),
      'developer may not invite members',
    )
    assert(
      !can(forOrg, 'update', 'organization_members'),
      'developer may not change member roles',
    )
    assert(
      !can(forOrg, 'delete', 'organization_members'),
      'developer may not remove members',
    )
    assert(
      !can(forOrg, 'billing_write', 'stripe.subscription'),
      'developer may not edit billing',
    )
  } finally {
    await cleanup(profileId, orgId)
  }
})

Deno.test('H5: Read-only (role 2) is limited to read actions', async () => {
  let profileId: number | null = null
  let orgId: number | null = null
  try {
    const seed = await seedProfileAndOrg(2, 'readonly-' + Date.now())
    profileId = seed.profileId
    orgId = seed.orgId

    const forOrg = emitted(
      (await getPermissions(pool, seed.profileId)) as StudioPermission[],
      seed.slug,
    )

    assertEquals(
      forOrg.length,
      1,
      'read-only should emit a single allow entry',
    )
    assertEquals(forOrg[0].restrictive, false)
    assert(
      !forOrg[0].actions.includes('%'),
      'read-only must NOT receive wildcard actions',
    )

    // Reads are allowed across the board
    assert(can(forOrg, 'read', 'projects'))
    assert(can(forOrg, 'billing_read', 'stripe.subscription'))
    assert(can(forOrg, 'analytics_read', 'projects.analytics'))
    assert(can(forOrg, 'infra_read', 'projects.infra'))

    // Writes are denied across the board
    assert(!can(forOrg, 'create', 'projects'))
    assert(!can(forOrg, 'update', 'projects'))
    assert(!can(forOrg, 'delete', 'projects'))
    assert(!can(forOrg, 'billing_write', 'stripe.subscription'))
    assert(!can(forOrg, 'infra_execute', 'projects.infra'))
  } finally {
    await cleanup(profileId, orgId)
  }
})

Deno.test('H5: profile with no orgs still receives the default slug entry', async () => {
  let profileId: number | null = null
  try {
    await pool.withConnection(async (setup) => {
      const profile = await setup.queryObject<{ id: number }>`
        INSERT INTO traffic.profiles (gotrue_id, username, primary_email)
        VALUES (
          ${crypto.randomUUID()},
          ${'perm-noorg-' + Date.now()},
          ${'perm-noorg-' + Date.now() + '@test.com'}
        )
        RETURNING id
      `
      profileId = profile.rows[0].id
    })

    const permissions = (await getPermissions(pool, profileId!)) as StudioPermission[]
    assertEquals(permissions.length, 1)
    assertEquals(permissions[0].organization_slug, 'default')
    assertEquals(permissions[0].actions, ['%'])
  } finally {
    await cleanup(profileId, null)
  }
})
