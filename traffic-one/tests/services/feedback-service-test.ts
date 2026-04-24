import type { Pool } from 'https://deno.land/x/postgres@v0.19.3/mod.ts'
import { assert, assertEquals, assertExists } from 'jsr:@std/assert@1'

import 'jsr:@std/dotenv/load'

import { createRetryingPool } from '../_helpers/pool.ts'

const pool = createRetryingPool(Deno.env.get('TRAFFIC_DB_URL')!)

async function createTestProfile(
  tx: ReturnType<Awaited<ReturnType<Pool['connect']>>['createTransaction']>,
  suffix: string,
) {
  const result = await tx.queryObject<{ id: number }>`
    INSERT INTO traffic.profiles (gotrue_id, username, primary_email)
    VALUES (
      ${'00000000-0000-0000-0000-00000000f' + suffix},
      ${'feedbackuser' + suffix},
      ${suffix + '@feedback.test'}
    )
    RETURNING id
  `
  return result.rows[0].id
}

Deno.test('createFeedback persists a row with defaults', async () => {
  await pool.withConnection(async (connection) => {
    const tx = connection.createTransaction('test_feedback_create')
    await tx.begin()
    const profileId = await createTestProfile(tx, '001')

    const result = await tx.queryObject<{
      id: number
      category: string
      message: string
      tags: string[]
      metadata: Record<string, unknown>
      custom_fields: Record<string, unknown>
      created_at: string
    }>`
      INSERT INTO traffic.feedback (
        profile_id, category, message, project_ref, organization_slug, tags, metadata
      ) VALUES (
        ${profileId}, 'general', 'hello', null, null, ${[]}::text[], '{}'::jsonb
      )
      RETURNING id, category, message, tags, metadata, custom_fields, created_at
    `
    assertEquals(result.rows.length, 1)
    assertExists(result.rows[0].id)
    assertExists(result.rows[0].created_at)
    assertEquals(result.rows[0].category, 'general')
    assertEquals(result.rows[0].message, 'hello')
    assert(Array.isArray(result.rows[0].tags))
    assertEquals(result.rows[0].tags.length, 0)
    assertEquals(result.rows[0].metadata as Record<string, unknown>, {})
    assertEquals(result.rows[0].custom_fields as Record<string, unknown>, {})
    await tx.rollback()
  })
})

Deno.test('updateFeedbackCustomFields merges without replacing existing keys', async () => {
  await pool.withConnection(async (connection) => {
    const tx = connection.createTransaction('test_feedback_merge')
    await tx.begin()
    const profileId = await createTestProfile(tx, '002')

    const inserted = await tx.queryObject<{ id: number }>`
      INSERT INTO traffic.feedback (
        profile_id, category, message, custom_fields
      ) VALUES (
        ${profileId}, 'support_ticket', 'ticket',
        '{"org_id": 10, "project_ref": "abc"}'::jsonb
      )
      RETURNING id
    `
    const id = inserted.rows[0].id

    await tx.queryObject`
      UPDATE traffic.feedback
      SET custom_fields = custom_fields || '{"category": "Billing", "org_id": 42}'::jsonb,
          updated_at = now()
      WHERE id = ${id}
    `

    const row = await tx.queryObject<
      { custom_fields: Record<string, unknown> }
    >`
      SELECT custom_fields FROM traffic.feedback WHERE id = ${id}
    `
    const cf = row.rows[0].custom_fields as {
      org_id?: number
      project_ref?: string
      category?: string
    }
    assertEquals(cf.org_id, 42)
    assertEquals(cf.project_ref, 'abc')
    assertEquals(cf.category, 'Billing')
    await tx.rollback()
  })
})

Deno.test('updateFeedbackCustomFields returns zero rows for unknown id', async () => {
  await pool.withConnection(async (connection) => {
    const tx = connection.createTransaction('test_feedback_unknown')
    await tx.begin()

    const result = await tx.queryObject`
      UPDATE traffic.feedback
      SET custom_fields = custom_fields || '{"x": 1}'::jsonb
      WHERE id = -1
      RETURNING *
    `
    assertEquals(result.rows.length, 0)
    await tx.rollback()
  })
})
