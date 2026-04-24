import { Pool } from 'https://deno.land/x/postgres@v0.19.3/mod.ts'
import { assert, assertEquals, assertExists } from 'jsr:@std/assert@1'
import { createClient } from 'npm:@supabase/supabase-js@2'

import 'jsr:@std/dotenv/load'

const supabaseUrl = Deno.env.get('SUPABASE_URL')!
const supabaseKey = Deno.env.get('SUPABASE_ANON_KEY')!
const supabase = createClient(supabaseUrl, supabaseKey, {
  auth: {
    autoRefreshToken: false,
    persistSession: false,
    detectSessionInUrl: false,
  },
})

const NOTIFICATIONS_URL = `${supabaseUrl}/api/platform/notifications`
const PROFILE_URL = `${supabaseUrl}/api/platform/profile`

const pool = new Pool(Deno.env.get('TRAFFIC_DB_URL')!, 1, true)

// ── Helpers ──────────────────────────────────────────────

async function getTestSession() {
  const {
    data: { session },
    error,
  } = await supabase.auth.signInWithPassword({
    email: 'test@example.com',
    password: 'test-password',
  })
  if (error || !session) {
    throw new Error(
      `Failed to sign in test user: ${error?.message ?? 'no session'}`,
    )
  }
  return session
}

function authHeaders(token: string): Record<string, string> {
  return {
    Authorization: `Bearer ${token}`,
    'Content-Type': 'application/json',
  }
}

async function getTestProfileId(token: string): Promise<number> {
  const res = await fetch(PROFILE_URL, { headers: authHeaders(token) })
  assertEquals(res.status, 200, 'profile fetch should succeed')
  const profile = await res.json()
  return profile.id as number
}

async function seedNotification(
  profileId: number,
  name: string,
  status: 'new' | 'seen' | 'archived',
): Promise<string> {
  const connection = await pool.connect()
  try {
    const result = await connection.queryObject<{ id: string }>`
      INSERT INTO traffic.notifications (profile_id, name, priority, status)
      VALUES (${profileId}, ${name}, 'Info', ${status})
      RETURNING id
    `
    return result.rows[0].id
  } finally {
    connection.release()
  }
}

// Resets the test user's notifications to a known state. We can't DELETE
// (traffic_api has no DELETE on traffic.notifications), but UPDATE is
// allowed, so we archive everything via the API. Other tests that expect
// unread counts call this first.
async function resetToArchived(token: string) {
  const res = await fetch(`${NOTIFICATIONS_URL}/archive-all`, {
    method: 'PATCH',
    headers: { ...authHeaders(token), Version: '2' },
  })
  await res.body?.cancel()
}

// ── Auth ─────────────────────────────────────────────────

Deno.test('GET /api/platform/notifications returns 401 without auth', async () => {
  const res = await fetch(NOTIFICATIONS_URL)
  assertEquals(res.status, 401)
  await res.body?.cancel()
})

// ── List (exercise the removed Kong stub) ────────────────

Deno.test(
  "GET /api/platform/notifications returns the user's real notifications (not Kong's empty stub)",
  async () => {
    const session = await getTestSession()
    const profileId = await getTestProfileId(session.access_token)
    await resetToArchived(session.access_token)

    const seededName = `integ-list-${Date.now()}`
    const seededId = await seedNotification(profileId, seededName, 'new')

    const res = await fetch(NOTIFICATIONS_URL, {
      headers: authHeaders(session.access_token),
    })
    assertEquals(res.status, 200)
    const body = await res.json()
    assert(Array.isArray(body), 'notifications list must be an array')

    const found = (body as Array<{ id: string; name: string; status: string }>)
      .find(
        (n) => n.id === seededId,
      )
    assertExists(
      found,
      'seeded notification should be returned by the real handler',
    )
    assertEquals(found!.name, seededName)
    assertEquals(found!.status, 'new')
  },
)

// ── Summary ──────────────────────────────────────────────

Deno.test(
  'GET /api/platform/notifications/summary returns { unread_count, read_count }',
  async () => {
    const session = await getTestSession()
    const profileId = await getTestProfileId(session.access_token)
    await resetToArchived(session.access_token)

    const ts = Date.now()
    await seedNotification(profileId, `integ-summary-new-${ts}-a`, 'new')
    await seedNotification(profileId, `integ-summary-new-${ts}-b`, 'new')
    await seedNotification(profileId, `integ-summary-seen-${ts}-a`, 'seen')
    await seedNotification(profileId, `integ-summary-arch-${ts}-a`, 'archived')

    const res = await fetch(`${NOTIFICATIONS_URL}/summary`, {
      headers: authHeaders(session.access_token),
    })
    assertEquals(res.status, 200)
    const body = await res.json()
    assert(
      !Array.isArray(body),
      'summary must be an object, not an array (Kong-stub shape)',
    )
    assertEquals(typeof body.unread_count, 'number')
    assertEquals(typeof body.read_count, 'number')
    assertEquals(body.unread_count, 2)
    // `read_count` must aggregate seen + archived so the bell does not drop to
    // 0/0 once notifications are archived. (Regression test for H1.)
    assertEquals(body.read_count, 2)
  },
)

// ── PATCH array body (Studio Version-2) ──────────────────

Deno.test(
  'PATCH /api/platform/notifications with array body persists per-row statuses',
  async () => {
    const session = await getTestSession()
    const profileId = await getTestProfileId(session.access_token)
    await resetToArchived(session.access_token)

    const ts = Date.now()
    const id1 = await seedNotification(profileId, `integ-patch-${ts}-1`, 'new')
    const id2 = await seedNotification(profileId, `integ-patch-${ts}-2`, 'new')

    const res = await fetch(NOTIFICATIONS_URL, {
      method: 'PATCH',
      headers: { ...authHeaders(session.access_token), Version: '2' },
      body: JSON.stringify([
        { id: id1, status: 'seen' },
        { id: id2, status: 'archived' },
      ]),
    })
    assertEquals(res.status, 200)
    const updated = await res.json()
    assert(
      Array.isArray(updated),
      'PATCH response must be an array of updated rows',
    )
    assertEquals(updated.length, 2)

    const list = await fetch(NOTIFICATIONS_URL, {
      headers: authHeaders(session.access_token),
    })
    const notifications = (await list.json()) as Array<
      { id: string; status: string }
    >
    const seen = notifications.find((n) => n.id === id1)
    const archived = notifications.find((n) => n.id === id2)
    assertExists(seen)
    assertExists(archived)
    assertEquals(seen!.status, 'seen')
    assertEquals(archived!.status, 'archived')
  },
)

// ── PATCH /archive-all (Studio Version-2) ────────────────

Deno.test(
  'PATCH /api/platform/notifications/archive-all flips every non-archived row',
  async () => {
    const session = await getTestSession()
    const profileId = await getTestProfileId(session.access_token)
    await resetToArchived(session.access_token)

    const ts = Date.now()
    await seedNotification(profileId, `integ-arch-${ts}-1`, 'new')
    await seedNotification(profileId, `integ-arch-${ts}-2`, 'new')
    await seedNotification(profileId, `integ-arch-${ts}-3`, 'seen')

    const pre = await fetch(`${NOTIFICATIONS_URL}/summary`, {
      headers: authHeaders(session.access_token),
    }).then((r) => r.json())
    assertEquals(pre.unread_count, 2)
    assertEquals(pre.read_count, 1)

    const res = await fetch(`${NOTIFICATIONS_URL}/archive-all`, {
      method: 'PATCH',
      headers: { ...authHeaders(session.access_token), Version: '2' },
    })
    assertEquals(res.status, 200)
    await res.body?.cancel()

    // After archive-all the three seeded rows are all archived, so the
    // summary must now report unread=0 but read_count=3 (seen + archived).
    // This prevents the UX regression where the bell went to 0/0 post-archive.
    const post = await fetch(`${NOTIFICATIONS_URL}/summary`, {
      headers: authHeaders(session.access_token),
    }).then((r) => r.json())
    assertEquals(post.unread_count, 0)
    assertEquals(post.read_count, 3)
  },
)

// ── Method-not-allowed (create is not supported) ─────────

Deno.test('POST /api/platform/notifications returns 405', async () => {
  const session = await getTestSession()
  const res = await fetch(NOTIFICATIONS_URL, {
    method: 'POST',
    headers: authHeaders(session.access_token),
    body: JSON.stringify({ name: 'should-not-create', priority: 'Info' }),
  })
  assertEquals(res.status, 405)
  await res.body?.cancel()
})

// ── H7: Kong no longer has the static `platform-notifications-stub` service.
//
// Wave 1 shipped a Kong-level stub that returned `[]` for any notifications
// request. Wave 3 replaced it with the traffic-one edge function. This test
// locks the regression by asserting both that the stub identifier is absent
// from kong.yml and that `GET /api/platform/notifications` returns a live
// array populated by the real handler (seeded above in the "real handler"
// test). If either breaks, Studio's bell silently goes blank.

Deno.test('H7: kong.yml no longer defines the platform-notifications-stub', async () => {
  const kongPath = new URL(
    '../../docker/volumes/api/kong.yml',
    import.meta.url,
  )
  let kong: string
  try {
    kong = await Deno.readTextFile(kongPath)
  } catch {
    // When the test suite runs from a container the repo root may not be
    // mounted; in that case we skip rather than fail.
    return
  }
  assert(
    !kong.includes('platform-notifications-stub'),
    'kong.yml must not re-introduce the static notifications stub service',
  )
  // Sanity-check the replacement is wired up.
  assert(
    kong.includes('platform-notifications'),
    'kong.yml must still expose /api/platform/notifications via the edge function',
  )
})
