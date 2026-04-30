import type { Pool } from 'https://deno.land/x/postgres@v0.19.3/mod.ts'
import { assert, assertEquals, assertExists } from 'jsr:@std/assert@1'

import 'jsr:@std/dotenv/load'

import { createRetryingPool } from '../_helpers/pool.ts'

const pool = createRetryingPool(Deno.env.get('TRAFFIC_DB_URL')!)

type Tx = ReturnType<Awaited<ReturnType<Pool['connect']>>['createTransaction']>

async function createTestProfile(tx: Tx, suffix: string): Promise<number> {
  const result = await tx.queryObject<{ id: number }>`
    INSERT INTO traffic.profiles (gotrue_id, username, primary_email)
    VALUES (
      ${'00000000-0000-0000-0000-0000000c' + suffix},
      ${'contentuser' + suffix},
      ${suffix + '@content.test'}
    )
    RETURNING id
  `
  return result.rows[0].id
}

async function insertItem(
  tx: Tx,
  params: {
    project_ref: string
    owner_id: number
    folder_id?: string | null
    name: string
    type?: 'sql' | 'report' | 'log_sql'
    visibility?: 'user' | 'project'
    content?: Record<string, unknown>
    favorite?: boolean
  },
): Promise<string> {
  const result = await tx.queryObject<{ id: string }>`
    INSERT INTO traffic.content_items (
      project_ref, owner_id, folder_id, name, type, visibility, content, favorite
    ) VALUES (
      ${params.project_ref}, ${params.owner_id}, ${params.folder_id ?? null},
      ${params.name}, ${params.type ?? 'sql'}, ${params.visibility ?? 'user'},
      ${JSON.stringify(params.content ?? {})}::jsonb, ${params.favorite ?? false}
    )
    RETURNING id
  `
  return result.rows[0].id
}

async function insertFolder(
  tx: Tx,
  params: {
    project_ref: string
    owner_id: number
    parent_id?: string | null
    name: string
  },
): Promise<string> {
  const result = await tx.queryObject<{ id: string }>`
    INSERT INTO traffic.content_folders (project_ref, owner_id, parent_id, name)
    VALUES (
      ${params.project_ref}, ${params.owner_id},
      ${params.parent_id ?? null}, ${params.name}
    )
    RETURNING id
  `
  return result.rows[0].id
}

// ── Defaults & constraints ─────────────────────────────────

Deno.test('content_items: default values and CHECK constraints', async () => {
  await pool.withConnection(async (connection) => {
    const tx = connection.createTransaction('test_content_defaults')
    await tx.begin()
    const ownerId = await createTestProfile(tx, '01')

    const result = await tx.queryObject<{
      id: string
      type: string
      visibility: string
      favorite: boolean
      description: string
      content: Record<string, unknown>
    }>`
      INSERT INTO traffic.content_items (project_ref, owner_id, type)
      VALUES ('ref_defaults', ${ownerId}, 'sql')
      RETURNING id, type, visibility, favorite, description, content
    `
    assertEquals(result.rows.length, 1)
    assertExists(result.rows[0].id)
    assertEquals(result.rows[0].visibility, 'user')
    assertEquals(result.rows[0].favorite, false)
    assertEquals(result.rows[0].description, '')
    assertEquals(result.rows[0].content as Record<string, unknown>, {})

    let badType = false
    try {
      await tx.queryObject`
        INSERT INTO traffic.content_items (project_ref, owner_id, type)
        VALUES ('ref_defaults', ${ownerId}, 'not_a_type')
      `
    } catch {
      badType = true
    }
    assert(badType, 'invalid type should violate CHECK constraint')

    await tx.rollback()
  })
})

Deno.test('content_items: invalid visibility rejected', async () => {
  await pool.withConnection(async (connection) => {
    const tx = connection.createTransaction('test_content_vis_constraint')
    await tx.begin()
    const ownerId = await createTestProfile(tx, '02')

    let threw = false
    try {
      await tx.queryObject`
        INSERT INTO traffic.content_items (project_ref, owner_id, type, visibility)
        VALUES ('ref_vis', ${ownerId}, 'sql', 'public')
      `
    } catch {
      threw = true
    }
    assert(threw, 'invalid visibility should violate CHECK constraint')

    await tx.rollback()
  })
})

// ── Visibility rules (read enforcement) ────────────────────

Deno.test(
  "visibility rules: 'user' items are invisible to other users, 'project' items are visible",
  async () => {
    await pool.withConnection(async (connection) => {
      const tx = connection.createTransaction('test_content_visibility')
      await tx.begin()
      const ownerId = await createTestProfile(tx, '03')
      const otherId = await createTestProfile(tx, '04')

      const privateId = await insertItem(tx, {
        project_ref: 'ref_vis_01',
        owner_id: ownerId,
        name: 'private',
        visibility: 'user',
      })
      const sharedId = await insertItem(tx, {
        project_ref: 'ref_vis_01',
        owner_id: ownerId,
        name: 'shared',
        visibility: 'project',
      })

      // Owner sees both rows under the listing predicate.
      const ownerRows = await tx.queryObject<{ id: string }>`
      SELECT id FROM traffic.content_items
      WHERE project_ref = 'ref_vis_01'
        AND (owner_id = ${ownerId} OR visibility = 'project')
    `
      const ownerIds = new Set(ownerRows.rows.map((r) => r.id))
      assert(ownerIds.has(privateId))
      assert(ownerIds.has(sharedId))

      // Other user only sees the 'project'-visibility row.
      const otherRows = await tx.queryObject<{ id: string }>`
      SELECT id FROM traffic.content_items
      WHERE project_ref = 'ref_vis_01'
        AND (owner_id = ${otherId} OR visibility = 'project')
    `
      const otherIds = new Set(otherRows.rows.map((r) => r.id))
      assert(
        !otherIds.has(privateId),
        "other user must NOT see 'user' visibility item",
      )
      assert(
        otherIds.has(sharedId),
        "other user must see 'project' visibility item",
      )

      await tx.rollback()
    })
  },
)

// ── Ownership enforcement on writes ────────────────────────

Deno.test("ownership: UPDATE gated by owner_id does not touch another user's row", async () => {
  await pool.withConnection(async (connection) => {
    const tx = connection.createTransaction('test_content_ownership_update')
    await tx.begin()
    const ownerId = await createTestProfile(tx, '05')
    const intruderId = await createTestProfile(tx, '06')

    const id = await insertItem(tx, {
      project_ref: 'ref_own_01',
      owner_id: ownerId,
      name: 'orig',
      visibility: 'project',
      content: { sql: 'select 1' },
    })

    const attempt = await tx.queryObject`
      UPDATE traffic.content_items
      SET name = 'hijacked'
      WHERE id = ${id}::uuid AND owner_id = ${intruderId}
      RETURNING id
    `
    assertEquals(attempt.rows.length, 0)

    const after = await tx.queryObject<{ name: string }>`
      SELECT name FROM traffic.content_items WHERE id = ${id}::uuid
    `
    assertEquals(after.rows[0].name, 'orig')

    await tx.rollback()
  })
})

Deno.test("ownership: DELETE gated by owner_id does not remove another user's rows", async () => {
  await pool.withConnection(async (connection) => {
    const tx = connection.createTransaction('test_content_ownership_delete')
    await tx.begin()
    const ownerId = await createTestProfile(tx, '07')
    const intruderId = await createTestProfile(tx, '08')

    const ownedId = await insertItem(tx, {
      project_ref: 'ref_own_02',
      owner_id: ownerId,
      name: 'owned',
    })
    const otherOwnedId = await insertItem(tx, {
      project_ref: 'ref_own_02',
      owner_id: intruderId,
      name: 'other',
    })

    const result = await tx.queryObject<{ id: string }>`
      DELETE FROM traffic.content_items
      WHERE project_ref = 'ref_own_02'
        AND owner_id = ${ownerId}
        AND id = ANY(ARRAY[${ownedId}::uuid, ${otherOwnedId}::uuid])
      RETURNING id
    `
    assertEquals(result.rows.length, 1)
    assertEquals(result.rows[0].id, ownedId)

    const remaining = await tx.queryObject<{ id: string }>`
      SELECT id FROM traffic.content_items WHERE project_ref = 'ref_own_02'
    `
    assertEquals(remaining.rows.length, 1)
    assertEquals(remaining.rows[0].id, otherOwnedId)

    await tx.rollback()
  })
})

// ── Cascade & detach semantics ─────────────────────────────

Deno.test('cascade: deleting a parent folder cascades to child folders', async () => {
  await pool.withConnection(async (connection) => {
    const tx = connection.createTransaction('test_content_cascade_folders')
    await tx.begin()
    const ownerId = await createTestProfile(tx, '09')

    const parentId = await insertFolder(tx, {
      project_ref: 'ref_cascade_01',
      owner_id: ownerId,
      name: 'parent',
    })
    const child1 = await insertFolder(tx, {
      project_ref: 'ref_cascade_01',
      owner_id: ownerId,
      parent_id: parentId,
      name: 'child1',
    })
    const grandchild = await insertFolder(tx, {
      project_ref: 'ref_cascade_01',
      owner_id: ownerId,
      parent_id: child1,
      name: 'grandchild',
    })

    await tx.queryObject`
      DELETE FROM traffic.content_folders
      WHERE id = ${parentId}::uuid
    `

    const remaining = await tx.queryObject<{ id: string }>`
      SELECT id FROM traffic.content_folders
      WHERE project_ref = 'ref_cascade_01'
    `
    const ids = remaining.rows.map((r) => r.id)
    assert(!ids.includes(parentId))
    assert(!ids.includes(child1))
    assert(!ids.includes(grandchild))

    await tx.rollback()
  })
})

Deno.test(
  'detach: deleting a folder sets folder_id to NULL on its items (ON DELETE SET NULL)',
  async () => {
    await pool.withConnection(async (connection) => {
      const tx = connection.createTransaction('test_content_detach_items')
      await tx.begin()
      const ownerId = await createTestProfile(tx, '10')

      const folderId = await insertFolder(tx, {
        project_ref: 'ref_detach_01',
        owner_id: ownerId,
        name: 'folder',
      })
      const itemId = await insertItem(tx, {
        project_ref: 'ref_detach_01',
        owner_id: ownerId,
        folder_id: folderId,
        name: 'inside folder',
      })

      await tx
        .queryObject`DELETE FROM traffic.content_folders WHERE id = ${folderId}::uuid`

      const item = await tx.queryObject<{ folder_id: string | null }>`
      SELECT folder_id FROM traffic.content_items WHERE id = ${itemId}::uuid
    `
      assertEquals(item.rows.length, 1)
      assertEquals(item.rows[0].folder_id, null)

      await tx.rollback()
    })
  },
)

// ── Count aggregates (service shape) ───────────────────────

Deno.test('count: favorites / private / shared aggregations are correct', async () => {
  await pool.withConnection(async (connection) => {
    const tx = connection.createTransaction('test_content_count')
    await tx.begin()
    const ownerId = await createTestProfile(tx, '11')
    const otherId = await createTestProfile(tx, '12')

    await insertItem(tx, {
      project_ref: 'ref_count_01',
      owner_id: ownerId,
      name: 'p1',
      visibility: 'user',
      favorite: true,
    })
    await insertItem(tx, {
      project_ref: 'ref_count_01',
      owner_id: ownerId,
      name: 'p2',
      visibility: 'user',
      favorite: false,
    })
    await insertItem(tx, {
      project_ref: 'ref_count_01',
      owner_id: ownerId,
      name: 's1',
      visibility: 'project',
      favorite: true,
    })
    // Another user's shared item (visible because visibility = 'project')
    await insertItem(tx, {
      project_ref: 'ref_count_01',
      owner_id: otherId,
      name: 's2_other',
      visibility: 'project',
      favorite: false,
    })
    // Another user's private item (invisible to ownerId)
    await insertItem(tx, {
      project_ref: 'ref_count_01',
      owner_id: otherId,
      name: 'other_private',
      visibility: 'user',
    })

    const result = await tx.queryObject<{
      count: number
      favorites: number
      private_count: number
      shared: number
    }>`
      SELECT
        COUNT(*)::int AS count,
        COUNT(*) FILTER (WHERE favorite = true)::int AS favorites,
        COUNT(*) FILTER (WHERE visibility = 'user' AND owner_id = ${ownerId})::int AS private_count,
        COUNT(*) FILTER (WHERE visibility = 'project')::int AS shared
      FROM traffic.content_items
      WHERE project_ref = 'ref_count_01'
        AND (owner_id = ${ownerId} OR visibility = 'project')
    `
    const row = result.rows[0]
    assertEquals(row.count, 4)
    assertEquals(row.favorites, 2)
    assertEquals(row.private_count, 2)
    assertEquals(row.shared, 2)

    await tx.rollback()
  })
})

// ── Profile cascade ────────────────────────────────────────

Deno.test('profile cascade: deleting a profile removes their content and folders', async () => {
  await pool.withConnection(async (connection) => {
    const tx = connection.createTransaction('test_profile_cascade')
    await tx.begin()
    const ownerId = await createTestProfile(tx, '13')

    const folderId = await insertFolder(tx, {
      project_ref: 'ref_profile_cascade_01',
      owner_id: ownerId,
      name: 'f',
    })
    const itemId = await insertItem(tx, {
      project_ref: 'ref_profile_cascade_01',
      owner_id: ownerId,
      folder_id: folderId,
      name: 'i',
    })

    await tx.queryObject`DELETE FROM traffic.profiles WHERE id = ${ownerId}`

    const folders = await tx.queryObject`
      SELECT id FROM traffic.content_folders WHERE id = ${folderId}::uuid
    `
    assertEquals(folders.rows.length, 0)
    const items = await tx.queryObject`
      SELECT id FROM traffic.content_items WHERE id = ${itemId}::uuid
    `
    assertEquals(items.rows.length, 0)

    await tx.rollback()
  })
})
