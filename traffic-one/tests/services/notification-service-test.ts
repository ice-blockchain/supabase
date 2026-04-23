import { Pool } from 'https://deno.land/x/postgres@v0.17.0/mod.ts'
import { assertEquals } from 'jsr:@std/assert@1'

import 'jsr:@std/dotenv/load'

import { getSummary, markAllArchived } from '../../functions/services/notification.service.ts'

const pool = new Pool(Deno.env.get('TRAFFIC_DB_URL')!, 1, true)

async function createTestProfile(
  tx: ReturnType<Awaited<ReturnType<Pool['connect']>>['createTransaction']>,
  suffix: string
) {
  const result = await tx.queryObject<{ id: number }>`
    INSERT INTO traffic.profiles (gotrue_id, username, primary_email)
    VALUES (${'00000000-0000-0000-0000-00000000b' + suffix}, ${'notifuser' + suffix}, ${suffix + '@test.com'})
    RETURNING id
  `
  return result.rows[0].id
}

Deno.test('list notifications returns empty for new profile', async () => {
  const connection = await pool.connect()
  const tx = connection.createTransaction('test_empty_notifications')
  try {
    await tx.begin()
    const profileId = await createTestProfile(tx, '001')

    const result = await tx.queryObject`
      SELECT * FROM traffic.notifications WHERE profile_id = ${profileId}
    `
    assertEquals(result.rows.length, 0)
    await tx.rollback()
  } finally {
    connection.release()
  }
})

Deno.test('insert and retrieve notification', async () => {
  const connection = await pool.connect()
  const tx = connection.createTransaction('test_insert_notification')
  try {
    await tx.begin()
    const profileId = await createTestProfile(tx, '002')

    await tx.queryObject`
      INSERT INTO traffic.notifications (profile_id, name, data, meta, priority, status)
      VALUES (${profileId}, 'Test Notification', '{"key":"value"}'::jsonb, '{}'::jsonb, 'Warning', 'new')
    `

    const result = await tx.queryObject<{ name: string; priority: string; status: string }>`
      SELECT name, priority, status FROM traffic.notifications WHERE profile_id = ${profileId}
    `
    assertEquals(result.rows.length, 1)
    assertEquals(result.rows[0].name, 'Test Notification')
    assertEquals(result.rows[0].priority, 'Warning')
    assertEquals(result.rows[0].status, 'new')
    await tx.rollback()
  } finally {
    connection.release()
  }
})

Deno.test('update notification status', async () => {
  const connection = await pool.connect()
  const tx = connection.createTransaction('test_update_notification_status')
  try {
    await tx.begin()
    const profileId = await createTestProfile(tx, '003')

    const inserted = await tx.queryObject<{ id: string }>`
      INSERT INTO traffic.notifications (profile_id, name, priority, status)
      VALUES (${profileId}, 'Status Test', 'Info', 'new')
      RETURNING id
    `
    const notifId = inserted.rows[0].id

    await tx.queryObject`
      UPDATE traffic.notifications SET status = 'seen' WHERE id = ${notifId}::uuid
    `

    const result = await tx.queryObject<{ status: string }>`
      SELECT status FROM traffic.notifications WHERE id = ${notifId}::uuid
    `
    assertEquals(result.rows[0].status, 'seen')
    await tx.rollback()
  } finally {
    connection.release()
  }
})

Deno.test('bulk update notification status', async () => {
  const connection = await pool.connect()
  const tx = connection.createTransaction('test_bulk_update')
  try {
    await tx.begin()
    const profileId = await createTestProfile(tx, '004')

    const n1 = await tx.queryObject<{ id: string }>`
      INSERT INTO traffic.notifications (profile_id, name, priority, status)
      VALUES (${profileId}, 'Notif 1', 'Info', 'new') RETURNING id
    `
    const n2 = await tx.queryObject<{ id: string }>`
      INSERT INTO traffic.notifications (profile_id, name, priority, status)
      VALUES (${profileId}, 'Notif 2', 'Warning', 'new') RETURNING id
    `

    const ids = [n1.rows[0].id, n2.rows[0].id]
    await tx.queryObject`
      UPDATE traffic.notifications SET status = 'archived' WHERE id = ANY(${ids}::uuid[])
    `

    const result = await tx.queryObject<{ status: string }>`
      SELECT status FROM traffic.notifications WHERE profile_id = ${profileId}
    `
    assertEquals(result.rows.length, 2)
    result.rows.forEach((r) => assertEquals(r.status, 'archived'))
    await tx.rollback()
  } finally {
    connection.release()
  }
})

// ── Service-level tests for the Bundle B additions ──────────
//
// These tests need to invoke the real service functions, which open their
// own pool connections. Because a single rolled-back transaction is invisible
// to those service-side connections (MVCC), we commit setup data with fresh
// gotrue_ids and make a best-effort cleanup pass after the assertions run.

async function cleanupProfile(profileId: number) {
  // Cascades to traffic.notifications and traffic.audit_logs via FK ON DELETE
  // CASCADE. Swallow errors so a failed cleanup doesn't mask the test result.
  try {
    const cleanConn = await pool.connect()
    try {
      await cleanConn.queryObject`DELETE FROM traffic.profiles WHERE id = ${profileId}`
    } finally {
      cleanConn.release()
    }
  } catch {
    /* best-effort */
  }
}

Deno.test('getSummary returns aggregated unread/read counts for profile', async () => {
  let profileId: number | null = null
  try {
    const setup = await pool.connect()
    try {
      const profile = await setup.queryObject<{ id: number }>`
        INSERT INTO traffic.profiles (gotrue_id, username, primary_email)
        VALUES (
          ${crypto.randomUUID()},
          ${'notifsummary-' + Date.now()},
          ${'notifsummary-' + Date.now() + '@test.com'}
        )
        RETURNING id
      `
      profileId = profile.rows[0].id
      await setup.queryObject`
        INSERT INTO traffic.notifications (profile_id, name, priority, status)
        VALUES
          (${profileId}, 'n-new-1', 'Info', 'new'),
          (${profileId}, 'n-new-2', 'Info', 'new'),
          (${profileId}, 'n-seen-1', 'Info', 'seen'),
          (${profileId}, 'n-arch-1', 'Info', 'archived')
      `
    } finally {
      setup.release()
    }

    // getSummary counts archived as "read" to prevent the bell from resetting
    // to 0/0 after the user archives notifications. (Regression test for H1.)
    const summary = await getSummary(pool, profileId)
    assertEquals(summary.unread_count, 2)
    assertEquals(summary.read_count, 2)
  } finally {
    if (profileId !== null) await cleanupProfile(profileId)
  }
})

Deno.test("markAllArchived flips only the target profile's non-archived rows", async () => {
  let profileId1: number | null = null
  let profileId2: number | null = null
  let gotrueId1 = ''
  try {
    const setup = await pool.connect()
    try {
      gotrueId1 = crypto.randomUUID()
      const gotrueId2 = crypto.randomUUID()
      const ts = Date.now()
      const p1 = await setup.queryObject<{ id: number }>`
        INSERT INTO traffic.profiles (gotrue_id, username, primary_email)
        VALUES (${gotrueId1}, ${'archive-src-' + ts}, ${'archive-src-' + ts + '@test.com'})
        RETURNING id
      `
      profileId1 = p1.rows[0].id
      const p2 = await setup.queryObject<{ id: number }>`
        INSERT INTO traffic.profiles (gotrue_id, username, primary_email)
        VALUES (${gotrueId2}, ${'archive-other-' + ts}, ${'archive-other-' + ts + '@test.com'})
        RETURNING id
      `
      profileId2 = p2.rows[0].id

      await setup.queryObject`
        INSERT INTO traffic.notifications (profile_id, name, priority, status)
        VALUES
          (${profileId1}, 'p1-new', 'Info', 'new'),
          (${profileId1}, 'p1-seen', 'Info', 'seen'),
          (${profileId1}, 'p1-arch', 'Info', 'archived'),
          (${profileId2}, 'p2-new', 'Info', 'new'),
          (${profileId2}, 'p2-seen', 'Info', 'seen')
      `
    } finally {
      setup.release()
    }

    // Pass auditContext=undefined so the service doesn't write an audit row
    // (traffic_api has no DELETE on audit_logs, keeping cleanup clean).
    const archived = await markAllArchived(pool, profileId1, gotrueId1, undefined)
    assertEquals(archived, 2, 'should archive only the two non-archived rows for profile1')

    const verify = await pool.connect()
    try {
      const p1Rows = await verify.queryObject<{ status: string }>`
        SELECT status FROM traffic.notifications WHERE profile_id = ${profileId1}
      `
      assertEquals(p1Rows.rows.length, 3)
      p1Rows.rows.forEach((r) => assertEquals(r.status, 'archived'))

      const p2Rows = await verify.queryObject<{ status: string; name: string }>`
        SELECT status, name FROM traffic.notifications
        WHERE profile_id = ${profileId2}
        ORDER BY name
      `
      assertEquals(p2Rows.rows.length, 2)
      assertEquals(p2Rows.rows[0].status, 'new')
      assertEquals(p2Rows.rows[1].status, 'seen')
    } finally {
      verify.release()
    }
  } finally {
    if (profileId1 !== null) await cleanupProfile(profileId1)
    if (profileId2 !== null) await cleanupProfile(profileId2)
  }
})
