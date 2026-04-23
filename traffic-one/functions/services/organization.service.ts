import type { Pool } from 'https://deno.land/x/postgres@v0.17.0/mod.ts'

import type {
  CreateOrganizationBody,
  OrganizationResponse,
  OrganizationSlugResponse,
  UpdateOrganizationResponse,
} from '../types/api.ts'

interface OrgRow {
  id: number
  name: string
  slug: string
  billing_email: string | null
  opt_in_tags: string[]
  mfa_enforced: boolean
  additional_billing_emails: string[]
  plan_id: string
  plan_name: string
  created_at: string
  updated_at: string
}

interface OrgWithRoleRow extends OrgRow {
  role: string
}

export function generateSlugBase(name: string): string {
  return name
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-+|-+$/g, '')
    .slice(0, 48)
}

function randomSuffix(): string {
  const bytes = new Uint8Array(3)
  crypto.getRandomValues(bytes)
  return Array.from(bytes)
    .map((b) => b.toString(16).padStart(2, '0'))
    .join('')
}

function rowToListResponse(row: OrgWithRoleRow): OrganizationResponse {
  return {
    id: row.id,
    name: row.name,
    slug: row.slug,
    billing_email: row.billing_email,
    billing_partner: null,
    is_owner: row.role === 'owner',
    opt_in_tags: row.opt_in_tags ?? [],
    plan: { id: row.plan_id, name: row.plan_name },
    restriction_data: null,
    restriction_status: null,
    stripe_customer_id: null,
    subscription_id: null,
    usage_billing_enabled: false,
    organization_missing_address: false,
    organization_missing_tax_id: false,
    organization_requires_mfa: row.mfa_enforced ?? false,
  }
}

function rowToSlugResponse(row: OrgRow): OrganizationSlugResponse {
  return {
    id: row.id,
    name: row.name,
    slug: row.slug,
    billing_email: row.billing_email,
    billing_partner: null,
    opt_in_tags: row.opt_in_tags ?? [],
    plan: { id: row.plan_id, name: row.plan_name },
    restriction_data: null,
    restriction_status: null,
    usage_billing_enabled: false,
    has_oriole_project: false,
  }
}

function rowToUpdateResponse(row: OrgRow): UpdateOrganizationResponse {
  return {
    id: row.id,
    name: row.name,
    slug: row.slug,
    billing_email: row.billing_email,
    opt_in_tags: row.opt_in_tags ?? [],
    stripe_customer_id: null,
  }
}

export async function listOrganizations(
  pool: Pool,
  profileId: number
): Promise<OrganizationResponse[]> {
  const connection = await pool.connect()
  try {
    const result = await connection.queryObject<OrgWithRoleRow>`
      SELECT o.*, m.role
      FROM traffic.organizations o
      JOIN traffic.organization_members m ON m.organization_id = o.id
      WHERE m.profile_id = ${profileId}
      ORDER BY o.created_at ASC
    `
    return result.rows.map(rowToListResponse)
  } finally {
    connection.release()
  }
}

export async function getOrganizationBySlug(
  pool: Pool,
  slug: string,
  profileId: number
): Promise<OrganizationSlugResponse | null> {
  const connection = await pool.connect()
  try {
    const result = await connection.queryObject<OrgRow>`
      SELECT o.*
      FROM traffic.organizations o
      JOIN traffic.organization_members m ON m.organization_id = o.id
      WHERE o.slug = ${slug} AND m.profile_id = ${profileId}
    `
    if (result.rows.length === 0) return null
    return rowToSlugResponse(result.rows[0])
  } finally {
    connection.release()
  }
}

export async function createOrganization(
  pool: Pool,
  profileId: number,
  body: CreateOrganizationBody,
  gotrueId: string,
  auditContext?: { email: string; ip: string; method: string; route: string }
): Promise<OrganizationResponse> {
  const connection = await pool.connect()
  try {
    const tx = connection.createTransaction('create_organization')
    await tx.begin()

    let slug = generateSlugBase(body.name)
    if (!slug) slug = 'org'

    const existing = await tx.queryObject<{ count: number }>`
      SELECT COUNT(*)::int AS count FROM traffic.organizations WHERE slug = ${slug}
    `
    if (existing.rows[0].count > 0) {
      slug = slug.slice(0, 42) + '-' + randomSuffix()
    }

    const orgResult = await tx.queryObject<OrgRow>`
      INSERT INTO traffic.organizations (name, slug, billing_email)
      VALUES (${body.name}, ${slug}, NULL)
      RETURNING *
    `
    const org = orgResult.rows[0]

    await tx.queryObject`
      INSERT INTO traffic.organization_members (organization_id, profile_id, role)
      VALUES (${org.id}, ${profileId}, 'owner')
    `

    await tx.queryObject`
      INSERT INTO traffic.organization_member_roles (organization_id, profile_id, role_id)
      VALUES (${org.id}, ${profileId}, 5)
      ON CONFLICT (organization_id, profile_id, role_id) DO NOTHING
    `

    if (auditContext) {
      await tx.queryObject`
        INSERT INTO traffic.audit_logs (
          id, profile_id, organization_id, action_name, action_metadata,
          actor_id, actor_type, actor_metadata,
          target_description, target_metadata, occurred_at
        ) VALUES (
          gen_random_uuid(), ${profileId}, ${org.id}, 'organizations.insert',
          ${JSON.stringify([{ method: auditContext.method, route: auditContext.route, status: 201 }])}::jsonb,
          ${gotrueId}, 'user',
          ${JSON.stringify([{ email: auditContext.email, ip: auditContext.ip }])}::jsonb,
          ${'organizations #' + org.id}, '{}'::jsonb, now()
        )
      `
    }

    await tx.commit()

    return {
      id: org.id,
      name: org.name,
      slug: org.slug,
      billing_email: org.billing_email,
      billing_partner: null,
      is_owner: true,
      opt_in_tags: org.opt_in_tags ?? [],
      plan: { id: org.plan_id, name: org.plan_name },
      restriction_data: null,
      restriction_status: null,
      stripe_customer_id: null,
      subscription_id: null,
      usage_billing_enabled: false,
      organization_missing_address: false,
      organization_missing_tax_id: false,
      organization_requires_mfa: org.mfa_enforced ?? false,
    }
  } finally {
    connection.release()
  }
}

export async function updateOrganization(
  pool: Pool,
  slug: string,
  profileId: number,
  updates: {
    name?: string
    billing_email?: string
    opt_in_tags?: string[]
    additional_billing_emails?: string[]
  },
  gotrueId: string,
  auditContext?: { email: string; ip: string; method: string; route: string }
): Promise<UpdateOrganizationResponse | null> {
  const connection = await pool.connect()
  try {
    const tx = connection.createTransaction('update_organization')
    await tx.begin()

    const membership = await tx.queryObject<{ organization_id: number }>`
      SELECT m.organization_id
      FROM traffic.organization_members m
      JOIN traffic.organizations o ON o.id = m.organization_id
      WHERE o.slug = ${slug} AND m.profile_id = ${profileId}
    `
    if (membership.rows.length === 0) {
      await tx.rollback()
      return null
    }
    const orgId = membership.rows[0].organization_id

    const setClauses: string[] = []
    const values: unknown[] = []
    let paramIdx = 1

    if (updates.name !== undefined) {
      setClauses.push(`name = $${paramIdx++}`)
      values.push(updates.name)
    }
    if (updates.billing_email !== undefined) {
      setClauses.push(`billing_email = $${paramIdx++}`)
      values.push(updates.billing_email)
    }
    if (updates.opt_in_tags !== undefined) {
      setClauses.push(`opt_in_tags = $${paramIdx++}`)
      values.push(updates.opt_in_tags)
    }
    if (updates.additional_billing_emails !== undefined) {
      setClauses.push(`additional_billing_emails = $${paramIdx++}`)
      values.push(updates.additional_billing_emails)
    }

    setClauses.push(`updated_at = now()`)

    if (setClauses.length === 1) {
      await tx.rollback()
      const existing = await connection.queryObject<OrgRow>`
        SELECT * FROM traffic.organizations WHERE id = ${orgId}
      `
      return rowToUpdateResponse(existing.rows[0])
    }

    const setClause = setClauses.join(', ')
    values.push(orgId)
    const query = `UPDATE traffic.organizations SET ${setClause} WHERE id = $${paramIdx} RETURNING *`

    const result = await tx.queryObject<OrgRow>({ text: query, args: values })

    if (auditContext && result.rows.length > 0) {
      await tx.queryObject`
        INSERT INTO traffic.audit_logs (
          id, profile_id, organization_id, action_name, action_metadata,
          actor_id, actor_type, actor_metadata,
          target_description, target_metadata, occurred_at
        ) VALUES (
          gen_random_uuid(), ${profileId}, ${result.rows[0].id}, 'organizations.update',
          ${JSON.stringify([{ method: auditContext.method, route: auditContext.route, status: 200 }])}::jsonb,
          ${gotrueId}, 'user',
          ${JSON.stringify([{ email: auditContext.email, ip: auditContext.ip }])}::jsonb,
          ${'organizations #' + result.rows[0].id}, '{}'::jsonb, now()
        )
      `
    }

    await tx.commit()
    return rowToUpdateResponse(result.rows[0])
  } finally {
    connection.release()
  }
}

export async function deleteOrganization(
  pool: Pool,
  slug: string,
  profileId: number,
  gotrueId: string,
  auditContext?: { email: string; ip: string; method: string; route: string }
): Promise<boolean> {
  const connection = await pool.connect()
  try {
    const tx = connection.createTransaction('delete_organization')
    await tx.begin()

    const membership = await tx.queryObject<{ organization_id: number }>`
      SELECT m.organization_id
      FROM traffic.organization_members m
      JOIN traffic.organizations o ON o.id = m.organization_id
      WHERE o.slug = ${slug} AND m.profile_id = ${profileId} AND m.role = 'owner'
    `
    if (membership.rows.length === 0) {
      await tx.rollback()
      return false
    }
    const orgId = membership.rows[0].organization_id

    if (auditContext) {
      await tx.queryObject`
        INSERT INTO traffic.audit_logs (
          id, profile_id, organization_id, action_name, action_metadata,
          actor_id, actor_type, actor_metadata,
          target_description, target_metadata, occurred_at
        ) VALUES (
          gen_random_uuid(), ${profileId}, ${orgId}, 'organizations.delete',
          ${JSON.stringify([{ method: auditContext.method, route: auditContext.route, status: 200 }])}::jsonb,
          ${gotrueId}, 'user',
          ${JSON.stringify([{ email: auditContext.email, ip: auditContext.ip }])}::jsonb,
          ${'organizations #' + orgId}, '{}'::jsonb, now()
        )
      `
    }

    await tx.queryObject`DELETE FROM traffic.organizations WHERE id = ${orgId}`

    await tx.commit()
    return true
  } finally {
    connection.release()
  }
}

export async function getOrganizationMemberSlugs(pool: Pool, profileId: number): Promise<string[]> {
  const connection = await pool.connect()
  try {
    const result = await connection.queryObject<{ slug: string }>`
      SELECT o.slug
      FROM traffic.organizations o
      JOIN traffic.organization_members m ON m.organization_id = o.id
      WHERE m.profile_id = ${profileId}
      ORDER BY o.created_at ASC
    `
    return result.rows.map((r) => r.slug)
  } finally {
    connection.release()
  }
}
