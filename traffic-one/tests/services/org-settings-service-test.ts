import type { Pool } from 'https://deno.land/x/postgres@v0.19.3/mod.ts'
import { assert, assertEquals } from 'jsr:@std/assert@1'

import 'jsr:@std/dotenv/load'

import { createRetryingPool } from '../_helpers/pool.ts'

const pool = createRetryingPool(Deno.env.get('TRAFFIC_DB_URL')!)

async function createTestProfile(
  tx: ReturnType<Awaited<ReturnType<Pool['connect']>>['createTransaction']>,
  suffix: string,
) {
  const result = await tx.queryObject<{ id: number; gotrue_id: string }>`
    INSERT INTO traffic.profiles (gotrue_id, username, primary_email)
    VALUES (${'00000000-0000-0000-0000-000000set' + suffix}, ${'setuser' + suffix}, ${
    suffix + '@settings.com'
  })
    RETURNING id, gotrue_id
  `
  return result.rows[0]
}

async function createTestOrg(
  tx: ReturnType<Awaited<ReturnType<Pool['connect']>>['createTransaction']>,
  slug: string,
  profileId: number,
) {
  const org = await tx.queryObject<{ id: number }>`
    INSERT INTO traffic.organizations (name, slug) VALUES (${'Org ' + slug}, ${slug})
    RETURNING id
  `
  await tx.queryObject`
    INSERT INTO traffic.organization_members (organization_id, profile_id, role)
    VALUES (${org.rows[0].id}, ${profileId}, 'owner')
  `
  return org.rows[0].id
}

// ── MFA column default ──────────────────────────────────

Deno.test('mfa_enforced defaults to false', async () => {
  await pool.withConnection(async (connection) => {
    const tx = connection.createTransaction('test_mfa_default')
    await tx.begin()

    const org = await tx.queryObject<{ mfa_enforced: boolean }>`
      INSERT INTO traffic.organizations (name, slug) VALUES ('MFA Default Org', 'mfa-default-org')
      RETURNING mfa_enforced
    `
    assertEquals(org.rows[0].mfa_enforced, false)

    await tx.rollback()
  })
})

// ── MFA update ──────────────────────────────────────────

Deno.test('mfa_enforced can be toggled to true and back', async () => {
  await pool.withConnection(async (connection) => {
    const tx = connection.createTransaction('test_mfa_toggle')
    await tx.begin()

    const org = await tx.queryObject<{ id: number }>`
      INSERT INTO traffic.organizations (name, slug) VALUES ('MFA Toggle Org', 'mfa-toggle-org')
      RETURNING id
    `
    const orgId = org.rows[0].id

    await tx.queryObject`
      UPDATE traffic.organizations SET mfa_enforced = true WHERE id = ${orgId}
    `
    const after = await tx.queryObject<{ mfa_enforced: boolean }>`
      SELECT mfa_enforced FROM traffic.organizations WHERE id = ${orgId}
    `
    assertEquals(after.rows[0].mfa_enforced, true)

    await tx.queryObject`
      UPDATE traffic.organizations SET mfa_enforced = false WHERE id = ${orgId}
    `
    const reverted = await tx.queryObject<{ mfa_enforced: boolean }>`
      SELECT mfa_enforced FROM traffic.organizations WHERE id = ${orgId}
    `
    assertEquals(reverted.rows[0].mfa_enforced, false)

    await tx.rollback()
  })
})

// ── additional_billing_emails default ───────────────────

Deno.test('additional_billing_emails defaults to empty array', async () => {
  await pool.withConnection(async (connection) => {
    const tx = connection.createTransaction('test_billing_emails_default')
    await tx.begin()

    const org = await tx.queryObject<{ additional_billing_emails: string[] }>`
      INSERT INTO traffic.organizations (name, slug) VALUES ('Billing Emails Org', 'billing-emails-org')
      RETURNING additional_billing_emails
    `
    assertEquals(org.rows[0].additional_billing_emails, [])

    await tx.rollback()
  })
})

// ── SSO provider CRUD ───────────────────────────────────

Deno.test('SSO provider insert and select by organization_id', async () => {
  await pool.withConnection(async (connection) => {
    const tx = connection.createTransaction('test_sso_insert')
    await tx.begin()
    const profile = await createTestProfile(tx, 's01')
    const orgId = await createTestOrg(tx, 'sso-insert-org', profile.id)

    const sso = await tx.queryObject<
      { id: string; enabled: boolean; domains: string[] }
    >`
      INSERT INTO traffic.sso_providers (organization_id, enabled, domains)
      VALUES (${orgId}, true, ARRAY['example.com']::text[])
      RETURNING id, enabled, domains
    `
    assertEquals(sso.rows.length, 1)
    assertEquals(sso.rows[0].enabled, true)

    const fetched = await tx.queryObject<{ id: string }>`
      SELECT id FROM traffic.sso_providers WHERE organization_id = ${orgId}
    `
    assertEquals(fetched.rows.length, 1)
    assertEquals(fetched.rows[0].id, sso.rows[0].id)

    await tx.rollback()
  })
})

// ── SSO provider uniqueness ─────────────────────────────

Deno.test('SSO provider unique constraint prevents duplicate per org', async () => {
  await pool.withConnection(async (connection) => {
    const tx = connection.createTransaction('test_sso_unique')
    await tx.begin()
    const profile = await createTestProfile(tx, 's02')
    const orgId = await createTestOrg(tx, 'sso-unique-org', profile.id)

    await tx.queryObject`
      INSERT INTO traffic.sso_providers (organization_id, enabled)
      VALUES (${orgId}, false)
    `

    let threw = false
    try {
      await tx.queryObject`
        INSERT INTO traffic.sso_providers (organization_id, enabled)
        VALUES (${orgId}, true)
      `
    } catch {
      threw = true
    }
    assert(
      threw,
      'Duplicate SSO provider for same org should throw a constraint error',
    )

    await tx.rollback()
  })
})

// ── SSO provider update ─────────────────────────────────

Deno.test('SSO provider update changes fields', async () => {
  await pool.withConnection(async (connection) => {
    const tx = connection.createTransaction('test_sso_update')
    await tx.begin()
    const profile = await createTestProfile(tx, 's03')
    const orgId = await createTestOrg(tx, 'sso-update-org', profile.id)

    await tx.queryObject`
      INSERT INTO traffic.sso_providers (organization_id, enabled, metadata_xml_url)
      VALUES (${orgId}, false, 'https://old.example.com/metadata')
    `

    const updated = await tx.queryObject<
      { enabled: boolean; metadata_xml_url: string }
    >`
      UPDATE traffic.sso_providers
      SET enabled = true, metadata_xml_url = 'https://new.example.com/metadata', updated_at = now()
      WHERE organization_id = ${orgId}
      RETURNING enabled, metadata_xml_url
    `
    assertEquals(updated.rows[0].enabled, true)
    assertEquals(
      updated.rows[0].metadata_xml_url,
      'https://new.example.com/metadata',
    )

    await tx.rollback()
  })
})

// ── SSO provider delete cascades with org ───────────────

Deno.test('deleting organization cascades to sso_providers', async () => {
  await pool.withConnection(async (connection) => {
    const tx = connection.createTransaction('test_sso_cascade')
    await tx.begin()
    const profile = await createTestProfile(tx, 's04')
    const orgId = await createTestOrg(tx, 'sso-cascade-org', profile.id)

    await tx.queryObject`
      INSERT INTO traffic.sso_providers (organization_id, enabled)
      VALUES (${orgId}, true)
    `

    await tx.queryObject`DELETE FROM traffic.organizations WHERE id = ${orgId}`

    const remaining = await tx.queryObject`
      SELECT * FROM traffic.sso_providers WHERE organization_id = ${orgId}
    `
    assertEquals(
      remaining.rows.length,
      0,
      'SSO provider should be cascade-deleted with org',
    )

    await tx.rollback()
  })
})

// ── Audit logs: organization_id filtering ───────────────

Deno.test('audit_logs with organization_id can be filtered by org', async () => {
  await pool.withConnection(async (connection) => {
    const tx = connection.createTransaction('test_audit_org_filter')
    await tx.begin()
    const profile = await createTestProfile(tx, 's05')
    const orgA = await createTestOrg(tx, 'audit-org-a', profile.id)
    const orgB = await createTestOrg(tx, 'audit-org-b', profile.id)

    await tx.queryObject`
      INSERT INTO traffic.audit_logs (
        id, profile_id, organization_id, action_name, action_metadata,
        actor_id, actor_type, actor_metadata,
        target_description, target_metadata, occurred_at
      ) VALUES (
        gen_random_uuid(), ${profile.id}, ${orgA}, 'test.action_a',
        '[]'::jsonb, ${profile.gotrue_id}, 'user', '[]'::jsonb,
        'test target a', '{}'::jsonb, now()
      )
    `
    await tx.queryObject`
      INSERT INTO traffic.audit_logs (
        id, profile_id, organization_id, action_name, action_metadata,
        actor_id, actor_type, actor_metadata,
        target_description, target_metadata, occurred_at
      ) VALUES (
        gen_random_uuid(), ${profile.id}, ${orgB}, 'test.action_b',
        '[]'::jsonb, ${profile.gotrue_id}, 'user', '[]'::jsonb,
        'test target b', '{}'::jsonb, now()
      )
    `

    const logsA = await tx.queryObject<{ action_name: string }>`
      SELECT action_name FROM traffic.audit_logs WHERE organization_id = ${orgA}
    `
    assertEquals(logsA.rows.length, 1)
    assertEquals(logsA.rows[0].action_name, 'test.action_a')

    const logsB = await tx.queryObject<{ action_name: string }>`
      SELECT action_name FROM traffic.audit_logs WHERE organization_id = ${orgB}
    `
    assertEquals(logsB.rows.length, 1)
    assertEquals(logsB.rows[0].action_name, 'test.action_b')

    await tx.rollback()
  })
})

// ── Audit logs: organization_id is nullable ─────────────

Deno.test('audit_logs organization_id is nullable (backward compat)', async () => {
  await pool.withConnection(async (connection) => {
    const tx = connection.createTransaction('test_audit_nullable_org')
    await tx.begin()
    const profile = await createTestProfile(tx, 's06')

    const result = await tx.queryObject<{ organization_id: number | null }>`
      INSERT INTO traffic.audit_logs (
        id, profile_id, action_name, action_metadata,
        actor_id, actor_type, actor_metadata,
        target_description, target_metadata, occurred_at
      ) VALUES (
        gen_random_uuid(), ${profile.id}, 'test.no_org',
        '[]'::jsonb, ${profile.gotrue_id}, 'user', '[]'::jsonb,
        'test target', '{}'::jsonb, now()
      )
      RETURNING organization_id
    `
    assertEquals(result.rows[0].organization_id, null)

    await tx.rollback()
  })
})

// ── opt_in_tags update ──────────────────────────────────

Deno.test('opt_in_tags can be updated on organizations', async () => {
  await pool.withConnection(async (connection) => {
    const tx = connection.createTransaction('test_opt_in_tags')
    await tx.begin()

    const org = await tx.queryObject<{ id: number; opt_in_tags: string[] }>`
      INSERT INTO traffic.organizations (name, slug) VALUES ('OptIn Org', 'optin-org')
      RETURNING id, opt_in_tags
    `
    assertEquals(org.rows[0].opt_in_tags, [])

    const updated = await tx.queryObject<{ opt_in_tags: string[] }>`
      UPDATE traffic.organizations
      SET opt_in_tags = '{"AI_SQL_GENERATOR_OPT_IN"}'
      WHERE id = ${org.rows[0].id}
      RETURNING opt_in_tags
    `
    assertEquals(updated.rows[0].opt_in_tags, ['AI_SQL_GENERATOR_OPT_IN'])

    await tx.rollback()
  })
})
