import { Pool } from 'https://deno.land/x/postgres@v0.19.3/mod.ts'

import type { ProjectBackend } from './project-backend.service.ts'

// ── Types ────────────────────────────────────────────────────

export type JitStatus = 'active' | 'pending' | 'revoked' | 'expired'
export type JitScope = 'read-only' | 'read-write'

export interface JitPolicy {
  enabled: boolean
  max_session_duration_minutes: number
  approval_required: boolean
  default_scope: JitScope
}

export const DEFAULT_POLICY: JitPolicy = {
  enabled: true,
  max_session_duration_minutes: 60,
  approval_required: false,
  default_scope: 'read-only',
}

export interface JitGrantSummary {
  user_id: number | null
  username: string
  role: string
  expires_at: string
  scope: string
  granted_at: string
}

export interface AuditContext {
  email: string
  ip: string
  method: string
  route: string
  organizationId: number
}

export interface IssueGrantInput {
  user_id?: number | null
  duration_minutes?: number
  scope?: JitScope
  tables?: string[]
}

export interface IssueGrantResult {
  username: string
  password: string
  expires_at: string
  connection_string: string
  status: JitStatus
}

// ── Internal helpers ─────────────────────────────────────────

function randomHex(bytes: number): string {
  const arr = new Uint8Array(bytes)
  crypto.getRandomValues(arr)
  return Array.from(arr)
    .map((b) => b.toString(16).padStart(2, '0'))
    .join('')
}

function sanitizeRefForRole(ref: string): string {
  return ref
    .replace(/[^a-zA-Z0-9]/g, '')
    .slice(0, 16)
    .toLowerCase()
}

function generateUsername(projectRef: string): string {
  return `jit_${sanitizeRefForRole(projectRef)}_${randomHex(8)}`
}

function generatePassword(): string {
  return randomHex(32)
}

function buildConnectionString(
  backend: ProjectBackend,
  username: string,
  password: string,
): string {
  // Use the externally resolvable host so the DSN we hand back via
  // `IssueGrantResult.connection_string` is usable from outside the
  // Docker network (psql, integration tests, future cloud Studio).
  // In-container DDL pools (`withProjectPool`, `createPostgresRole`)
  // continue to use `backend.connectionString` / `backend.dbHost`.
  const host = backend.externalDbHost
  const port = backend.dbPort
  const dbName = backend.dbName
  const encoded = encodeURIComponent(password)
  return `postgresql://${username}:${encoded}@${host}:${port}/${dbName}`
}

// One-shot pool helper — every project-DB DDL call opens its own
// `new Pool(backend.connectionString, 1, true)` and closes it in `finally`
// so we never leak a connection to a tenant database, even on error. The
// `lazy=true` flag keeps instantiation cheap when we short-circuit.
async function withProjectPool<T>(
  connectionString: string,
  fn: (pool: Pool) => Promise<T>,
): Promise<T> {
  const projectPool = new Pool(connectionString, 1, true)
  try {
    return await fn(projectPool)
  } finally {
    try {
      await projectPool.end()
    } catch (err) {
      console.warn('JIT project pool close failed:', err)
    }
  }
}

const SAFE_IDENT_RE = /^[a-zA-Z0-9_]+$/
const SAFE_QUALIFIED_IDENT_RE = /^[a-zA-Z0-9_]+(\.[a-zA-Z0-9_]+)?$/

function mergePolicy(
  current: Partial<JitPolicy> | null | undefined,
  patch: Partial<JitPolicy>,
): JitPolicy {
  return { ...DEFAULT_POLICY, ...(current ?? {}), ...patch }
}

// ── Policy ───────────────────────────────────────────────────

export async function getPolicy(pool: Pool, projectRef: string): Promise<JitPolicy> {
  const connection = await pool.connect()
  try {
    const result = await connection.queryObject<{ policy: Partial<JitPolicy> | null }>`
      SELECT policy FROM traffic.jit_policies WHERE project_ref = ${projectRef}
    `
    if (result.rows.length === 0) return { ...DEFAULT_POLICY }
    return mergePolicy(result.rows[0].policy, {})
  } finally {
    connection.release()
  }
}

export async function upsertPolicy(
  pool: Pool,
  projectRef: string,
  patch: Partial<JitPolicy>,
  profileId: number,
  gotrueId: string,
  auditContext: AuditContext,
): Promise<JitPolicy> {
  const connection = await pool.connect()
  try {
    const tx = connection.createTransaction('upsert_jit_policy')
    await tx.begin()

    const existing = await tx.queryObject<{ policy: Partial<JitPolicy> | null }>`
      SELECT policy FROM traffic.jit_policies WHERE project_ref = ${projectRef}
    `
    const merged = mergePolicy(existing.rows[0]?.policy ?? null, patch)

    const result = await tx.queryObject<{ policy: Partial<JitPolicy> | null }>`
      INSERT INTO traffic.jit_policies (project_ref, policy, updated_at)
      VALUES (${projectRef}, ${JSON.stringify(merged)}::jsonb, now())
      ON CONFLICT (project_ref) DO UPDATE
        SET policy = ${JSON.stringify(merged)}::jsonb,
            updated_at = now()
      RETURNING policy
    `

    await tx.queryObject`
      INSERT INTO traffic.audit_logs (
        id, profile_id, organization_id, action_name, action_metadata,
        actor_id, actor_type, actor_metadata,
        target_description, target_metadata, occurred_at
      ) VALUES (
        gen_random_uuid(), ${profileId}, ${auditContext.organizationId}, 'project.jit_policy_updated',
        ${
      JSON.stringify([{ method: auditContext.method, route: auditContext.route, status: 200 }])
    }::jsonb,
        ${gotrueId}, 'user',
        ${JSON.stringify([{ email: auditContext.email, ip: auditContext.ip }])}::jsonb,
        ${'jit_policies (ref: ' + projectRef + ')'},
        ${JSON.stringify({ project_ref: projectRef, patch })}::jsonb,
        now()
      )
    `

    await tx.commit()
    return mergePolicy(result.rows[0]?.policy ?? null, {})
  } finally {
    connection.release()
  }
}

// ── Grants ───────────────────────────────────────────────────

export async function listGrants(pool: Pool, projectRef: string): Promise<JitGrantSummary[]> {
  const connection = await pool.connect()
  try {
    const result = await connection.queryObject<{
      profile_id: number | null
      username: string
      scope: string | null
      granted_at: string
      expires_at: string
      status: JitStatus
    }>`
      SELECT profile_id, username, scope, granted_at, expires_at, status
      FROM traffic.jit_grants
      WHERE project_ref = ${projectRef}
        AND status IN ('active', 'pending')
        AND expires_at > now()
      ORDER BY granted_at DESC
    `
    return result.rows.map((r) => ({
      user_id: r.profile_id,
      username: r.username,
      role: r.username,
      scope: r.scope ?? 'read-only',
      granted_at: r.granted_at,
      expires_at: r.expires_at,
    }))
  } finally {
    connection.release()
  }
}

export async function issueGrant(
  pool: Pool,
  projectRef: string,
  backend: ProjectBackend,
  input: IssueGrantInput,
  callerProfileId: number,
  gotrueId: string,
  auditContext: AuditContext,
): Promise<IssueGrantResult> {
  const policy = await getPolicy(pool, projectRef)

  const requestedDuration = input.duration_minutes ?? policy.max_session_duration_minutes
  const durationMinutes = Math.max(
    1,
    Math.min(requestedDuration, policy.max_session_duration_minutes),
  )

  const scope: JitScope = input.scope === 'read-write' ? 'read-write' : policy.default_scope
  const username = generateUsername(projectRef)
  const password = generatePassword()
  const expiresAt = new Date(Date.now() + durationMinutes * 60_000).toISOString()
  const targetProfileId = input.user_id ?? callerProfileId

  // Attempt real Postgres role creation BEFORE entering the grant-row
  // transaction — CREATE ROLE runs in its own implicit transaction at the
  // server side and we don't want to entangle its failure mode (e.g. the
  // connection role lacks CREATEROLE) with the accounting insert.
  //
  // Role DDL targets the *project* database via a one-shot pool. Without a
  // provisioned connection string (local mode, unprovisioned tenant) we fall
  // straight through to the `pending` path so Studio still gets a grant row
  // it can display + revoke later.
  let status: JitStatus = 'active'
  if (backend.connectionString) {
    try {
      await withProjectPool(
        backend.connectionString,
        (projectPool) => createPostgresRole(projectPool, username, password, scope, input.tables),
      )
    } catch (err) {
      console.warn('JIT role creation failed, persisting as pending:', err)
      status = 'pending'
    }
  } else {
    status = 'pending'
  }

  const connection = await pool.connect()
  try {
    const tx = connection.createTransaction('issue_jit_grant')
    await tx.begin()

    const secret = await tx.queryObject<{ secret_id: string }>`
      SELECT vault.create_secret(
        ${password},
        ${'jit_' + projectRef + '_' + username + '_password'}
      ) AS secret_id
    `

    const inserted = await tx.queryObject<{ id: number }>`
      INSERT INTO traffic.jit_grants (
        project_ref, profile_id, username, password_secret_id,
        scope, status, expires_at
      ) VALUES (
        ${projectRef}, ${targetProfileId}, ${username},
        ${secret.rows[0].secret_id}::uuid,
        ${scope}, ${status}, ${expiresAt}::timestamptz
      )
      RETURNING id
    `

    await tx.queryObject`
      INSERT INTO traffic.audit_logs (
        id, profile_id, organization_id, action_name, action_metadata,
        actor_id, actor_type, actor_metadata,
        target_description, target_metadata, occurred_at
      ) VALUES (
        gen_random_uuid(), ${callerProfileId}, ${auditContext.organizationId}, 'project.jit_grant_issued',
        ${
      JSON.stringify([{ method: auditContext.method, route: auditContext.route, status: 201 }])
    }::jsonb,
        ${gotrueId}, 'user',
        ${JSON.stringify([{ email: auditContext.email, ip: auditContext.ip }])}::jsonb,
        ${'jit_grants #' + inserted.rows[0].id + ' (ref: ' + projectRef + ')'},
        ${
      JSON.stringify({
        project_ref: projectRef,
        username,
        scope,
        status,
        target_profile_id: targetProfileId,
        expires_at: expiresAt,
      })
    }::jsonb,
        now()
      )
    `

    await tx.commit()

    return {
      username,
      password,
      expires_at: expiresAt,
      connection_string: buildConnectionString(backend, username, password),
      status,
    }
  } finally {
    connection.release()
  }
}

export async function revokeGrant(
  pool: Pool,
  projectRef: string,
  backend: ProjectBackend,
  userId: number,
  callerProfileId: number,
  gotrueId: string,
  auditContext: AuditContext,
): Promise<{ revoked: boolean; count: number }> {
  const toDrop: string[] = []
  let count = 0

  const connection = await pool.connect()
  try {
    const tx = connection.createTransaction('revoke_jit_grant')
    await tx.begin()

    const rows = await tx.queryObject<{
      id: number
      username: string
      password_secret_id: string | null
    }>`
      SELECT id, username, password_secret_id
      FROM traffic.jit_grants
      WHERE project_ref = ${projectRef}
        AND profile_id = ${userId}
        AND status IN ('active', 'pending')
    `

    if (rows.rows.length === 0) {
      await tx.commit()
      return { revoked: false, count: 0 }
    }

    for (const row of rows.rows) {
      if (row.password_secret_id) {
        await tx.queryObject`
          DELETE FROM vault.secrets WHERE id = ${row.password_secret_id}::uuid
        `
      }
      await tx.queryObject`
        UPDATE traffic.jit_grants
        SET status = 'revoked', revoked_at = now()
        WHERE id = ${row.id}
      `
      toDrop.push(row.username)
      count += 1
    }

    await tx.queryObject`
      INSERT INTO traffic.audit_logs (
        id, profile_id, organization_id, action_name, action_metadata,
        actor_id, actor_type, actor_metadata,
        target_description, target_metadata, occurred_at
      ) VALUES (
        gen_random_uuid(), ${callerProfileId}, ${auditContext.organizationId}, 'project.jit_grant_revoked',
        ${
      JSON.stringify([{ method: auditContext.method, route: auditContext.route, status: 200 }])
    }::jsonb,
        ${gotrueId}, 'user',
        ${JSON.stringify([{ email: auditContext.email, ip: auditContext.ip }])}::jsonb,
        ${'jit_grants (ref: ' + projectRef + ')'},
        ${
      JSON.stringify({
        project_ref: projectRef,
        target_user_id: userId,
        revoked_count: count,
        usernames: toDrop,
      })
    }::jsonb,
        now()
      )
    `

    await tx.commit()
  } finally {
    connection.release()
  }

  // Best-effort DROP ROLE outside the transaction against the project DB.
  // The grant row is already flipped to 'revoked', so a failure here just
  // means the PG role stays around until cleanupExpiredGrants (or a manual
  // sweep) drops it.
  if (backend.connectionString) {
    await withProjectPool(backend.connectionString, async (projectPool) => {
      for (const username of toDrop) {
        try {
          await dropPostgresRole(projectPool, username)
        } catch (err) {
          console.warn('JIT role drop failed:', err)
        }
      }
    })
  }

  return { revoked: true, count }
}

/**
 * Sweep expired grants across all projects. The sweep runs against the
 * traffic pool (for accounting), then groups expired rows by `project_ref`
 * and opens one project pool per distinct ref to drop the stale roles.
 *
 * Callers pass a `resolveBackend(ref)` closure — typically bound to
 * `getProjectBackend(ref, pool)` — so this service stays pure and the
 * backend resolver lives in `project-backend.service.ts`.
 */
export async function cleanupExpiredGrants(
  pool: Pool,
  resolveBackend: (projectRef: string) => Promise<ProjectBackend | null>,
): Promise<number> {
  const expired: Array<{ project_ref: string; username: string }> = []

  const connection = await pool.connect()
  try {
    const result = await connection.queryObject<{
      id: number
      project_ref: string
      username: string
    }>`
      UPDATE traffic.jit_grants
      SET status = 'expired'
      WHERE status IN ('active', 'pending')
        AND expires_at <= now()
      RETURNING id, project_ref, username
    `
    for (const row of result.rows) {
      expired.push({ project_ref: row.project_ref, username: row.username })
    }
  } finally {
    connection.release()
  }

  const byRef = new Map<string, string[]>()
  for (const entry of expired) {
    const list = byRef.get(entry.project_ref) ?? []
    list.push(entry.username)
    byRef.set(entry.project_ref, list)
  }

  for (const [ref, usernames] of byRef.entries()) {
    let backend: ProjectBackend | null
    try {
      backend = await resolveBackend(ref)
    } catch (err) {
      console.warn(`JIT cleanup: could not resolve backend for ${ref}:`, err)
      continue
    }
    if (!backend || !backend.connectionString) continue

    await withProjectPool(backend.connectionString, async (projectPool) => {
      for (const username of usernames) {
        try {
          await dropPostgresRole(projectPool, username)
        } catch (err) {
          console.warn('JIT expired role drop failed:', err)
        }
      }
    })
  }

  return expired.length
}

// ── Postgres role plumbing ───────────────────────────────────

async function createPostgresRole(
  pool: Pool,
  username: string,
  password: string,
  scope: JitScope,
  tables: string[] | undefined,
): Promise<void> {
  if (!SAFE_IDENT_RE.test(username)) {
    throw new Error('invalid username: ' + username)
  }
  // M2: `password` MUST be generated server-side by `generatePassword()` and
  // never interpolated from user input. The single-quote escape below is only
  // a defense-in-depth: Postgres will swallow it if `standard_conforming_strings`
  // is off, and passwords containing backslashes interact oddly with locales.
  // Keep this code path strictly internal. If you ever add a caller that
  // accepts an external password, switch to `ALTER ROLE ... PASSWORD` with a
  // parameterised driver call instead of string interpolation.
  const escapedPassword = password.replace(/'/g, "''")
  const grantVerb = scope === 'read-write' ? 'SELECT, INSERT, UPDATE, DELETE' : 'SELECT'

  const connection = await pool.connect()
  let roleCreated = false
  try {
    // M1: Postgres logs every `CREATE ROLE … PASSWORD 'xxx'` statement when
    // `log_statement` is set to `ddl` or `all` (common in production). That
    // leaks every JIT password to operators with log access. Suppressing the
    // statement log for just this session (`SET LOCAL log_statement = 'none'`
    // inside an explicit transaction so it doesn't bleed into the pool) keeps
    // slow/error logs intact while dropping the DDL statement bodies.
    await connection.queryObject(`BEGIN`)
    await connection.queryObject(`SET LOCAL log_statement = 'none'`)
    try {
      // Two-step create so if `log_min_error_statement` ever captures the
      // error body we still avoid shipping the plaintext password. CREATE
      // ROLE with no PASSWORD clause isn't logged any differently, but the
      // subsequent ALTER ROLE runs under `log_statement = 'none'` anyway.
      await connection.queryObject(`CREATE ROLE ${username} LOGIN NOINHERIT`)
      roleCreated = true
      await connection.queryObject(`ALTER ROLE ${username} PASSWORD '${escapedPassword}'`)
      await connection.queryObject(`COMMIT`)
    } catch (err) {
      await connection.queryObject(`ROLLBACK`)
      throw err
    }

    await connection.queryObject(`GRANT USAGE ON SCHEMA public TO ${username}`)

    const scopedTables = (tables ?? []).filter((t) => SAFE_QUALIFIED_IDENT_RE.test(t))
    if (scopedTables.length > 0) {
      for (const raw of scopedTables) {
        await connection.queryObject(`GRANT ${grantVerb} ON ${raw} TO ${username}`)
      }
    } else {
      await connection.queryObject(
        `GRANT ${grantVerb} ON ALL TABLES IN SCHEMA public TO ${username}`,
      )
    }
  } catch (err) {
    if (roleCreated) {
      try {
        await connection.queryObject(`DROP ROLE IF EXISTS ${username}`)
      } catch (dropErr) {
        console.warn('JIT cleanup of partially created role failed:', dropErr)
      }
    }
    throw err
  } finally {
    connection.release()
  }
}

async function dropPostgresRole(pool: Pool, username: string): Promise<void> {
  if (!SAFE_IDENT_RE.test(username)) return

  const connection = await pool.connect()
  try {
    try {
      await connection.queryObject(
        `REVOKE ALL PRIVILEGES ON ALL TABLES IN SCHEMA public FROM ${username}`,
      )
    } catch {
      // Ignore; role may not hold those privileges.
    }
    try {
      await connection.queryObject(`REVOKE USAGE ON SCHEMA public FROM ${username}`)
    } catch {
      // Ignore; role may not hold that privilege.
    }
    await connection.queryObject(`DROP ROLE IF EXISTS ${username}`)
  } finally {
    connection.release()
  }
}
