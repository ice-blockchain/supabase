// ─────────────────────────────────────────────────────────────────────────────
//
// Project-backend resolver (Phase 1 of the "shared Studio, separate project
// backends" plan). A single Studio dashboard needs to drive either the shared
// Docker stack (local / self-hosted single-tenant mode) or N per-project
// backends provisioned by an external orchestrator (api mode). Every
// project-scoped handler in `traffic-one` asks this module "what endpoint
// should I hit for {ref}, and with which service_role key?" before making
// an outbound call.
//
// Contract:
//   1. Row lookup: `SELECT endpoint, anon_key, db_host, *_secret_id FROM
//      traffic.projects WHERE ref = {ref}`. If the row does not exist the
//      caller is expected to have already short-circuited with `getProjectByRef`
//      (membership check). We still throw `ProjectBackendNotProvisionedError`
//      rather than silently falling back to env so that a typo'd ref in an
//      authenticated call surfaces as a clean 501 / 404 instead of quietly
//      dispatching to the shared stack.
//
//   2. Secret decryption: `service_key`, `db_pass`, and `connection_string`
//      are stored as Vault UUID references. We read
//      `vault.decrypted_secrets.decrypted_secret` per-UUID (no bulk select —
//      each one can independently be NULL for a partially-provisioned row).
//
//   3. Env-var fallback: when any column / secret is missing in *shared-stack
//      mode*, we substitute the matching `Deno.env` value (`SUPABASE_URL`,
//      `SUPABASE_ANON_KEY`, `SUPABASE_SERVICE_ROLE_KEY` /
//      `SUPABASE_SERVICE_KEY`, `POSTGRES_*`, `PG_META_URL`, `LOGFLARE_URL`,
//      `LOGFLARE_PRIVATE_ACCESS_TOKEN`). This preserves today's single-stack
//      behavior in local mode — every ref resolves to the same Docker services
//      without any dispatcher changes being observable from the outside.
//
//      **C2 (2026-04): `anon_key` and `service_key` fallback is SHARED-STACK
//      ONLY.** When `isPerProjectBackend(row.endpoint)` is true the resolver
//      refuses to fall back to the platform-global `SUPABASE_ANON_KEY` /
//      `SUPABASE_SERVICE_ROLE_KEY` because signing outbound calls to a
//      different tenant's endpoint with the shared service_role key is a
//      cross-tenant credential leak. Per-project projects MUST ship their
//      own `anon_key` column + Vault-backed `service_key_secret_id`; when
//      either is absent the resolver throws
//      `ProjectBackendNotProvisionedError` with the exact missing key in
//      `missing[]`, which the dispatcher surfaces as a 501 so callers see
//      the provisioning gap instead of silently talking to the wrong host.
//
//   4. 501 escape hatch: if neither the DB row nor env produce a non-empty
//      `endpoint` + `serviceKey` (the minimum viable pair for any outbound
//      call), throw `ProjectBackendNotProvisionedError`. Callers should catch
//      it and respond `501 { code: 'project_backend_not_provisioned' }`,
//      matching the `provisioner_unconfigured` pattern already used for
//      ApiProvisioner misconfiguration.
//
//   5. Derived URLs: `pgMetaUrl`, `logflareUrl`, and `functionsApiUrl` are
//      composed as `{endpoint}/pg-meta/v1`, `{endpoint}/analytics/v1`, and
//      `{endpoint}/functions/v1` respectively when the row points at a
//      per-project backend (endpoint differs from the shared `SUPABASE_URL`).
//      In the shared-stack case we prefer the env values so local Docker keeps
//      using `http://meta:8080` / `http://analytics:4000` — the compose-local
//      hostnames that the current handlers talk to today.
//
// Tests mock the pool via the `queryObject` contract and drive env vars to
// exercise both code paths without needing a real Postgres running.
//
// ─────────────────────────────────────────────────────────────────────────────

export interface ProjectBackend {
  /** Project ref — the short 20-char hex identifier this backend serves. */
  ref: string
  /** Base URL of the per-project backend (or the shared Docker stack). */
  endpoint: string
  /** Public anon key used for unauthenticated-ish proxying (graphql anon path). */
  anonKey: string
  /** Service-role key; carried as both `Authorization: Bearer` and `apikey`. */
  serviceKey: string
  /** Base URL of the pg-meta service that owns this project's DB metadata. */
  pgMetaUrl: string
  /** Base URL of the logflare analytics endpoint for this project. */
  logflareUrl: string
  /** Private access token for Logflare SQL endpoint queries. */
  logflareToken: string
  /** Superuser-capable DB host for JIT DDL and db-password rotation. */
  dbHost: string
  /**
   * Externally resolvable DB host returned to API clients (the JIT
   * `connection_string` field, future cloud Studio download links, etc.).
   * Defaults to `dbHost` so single-stack Docker installs are unchanged;
   * override via `SUPABASE_PUBLIC_DB_HOST` in any environment that needs
   * external clients to reach the project DB through a different name
   * (e.g. `127.0.0.1` for local dev tunnels, or the public DNS name in
   * cloud deployments).
   */
  externalDbHost: string
  /** DB port (default 5432). */
  dbPort: number
  /** DB user (default 'postgres'). */
  dbUser: string
  /** DB password (decrypted from Vault when available). */
  dbPass: string
  /** DB name (default 'postgres'). */
  dbName: string
  /** Full superuser DSN — for one-shot `new Pool(...)` in jit / db-password. */
  connectionString: string
  /** Base URL for outbound `/_deploy` edge-function writes in api mode. */
  functionsApiUrl: string
}

// Thrown when neither the `traffic.projects` row nor env vars produce a
// non-empty (endpoint, serviceKey). Callers should translate into a 501
// with code `project_backend_not_provisioned`.
export class ProjectBackendNotProvisionedError extends Error {
  override name = 'ProjectBackendNotProvisionedError'
  code = 'project_backend_not_provisioned'
  missing: string[]

  constructor(ref: string, missing: string[]) {
    super(
      `Project ${ref} backend is not fully provisioned (missing: ${missing.join(', ')}). ` +
        'Set PROJECT_PROVISIONER=local for Docker development mode, ' +
        'or ensure the external orchestrator has populated endpoint/service_key.',
    )
    this.missing = missing
  }
}

// ── Row shape ────────────────────────────────────────────────

interface ProjectRow {
  ref: string
  endpoint: string | null
  anon_key: string | null
  db_host: string | null
  service_key_secret_id: string | null
  db_pass_secret_id: string | null
  connection_string_secret_id: string | null
}

// Minimal Pool / connection surface used by the resolver. Splitting the
// interface out of `https://deno.land/x/postgres` makes the resolver trivially
// mockable in unit tests — callers pass a fake that records the SQL it sees.
export interface BackendPoolConnection {
  queryObject<T>(strings: TemplateStringsArray, ...values: unknown[]): Promise<{ rows: T[] }>
  release(): void
}

export interface BackendPool {
  connect(): Promise<BackendPoolConnection>
}

// ── Env accessors ────────────────────────────────────────────

function env(name: string, fallback = ''): string {
  return Deno.env.get(name) ?? fallback
}

function envNumber(name: string, fallback: number): number {
  const raw = Deno.env.get(name)
  if (raw === undefined || raw === null || raw === '') return fallback
  const n = Number(raw)
  return Number.isFinite(n) ? n : fallback
}

function sharedEndpoint(): string {
  return env('SUPABASE_URL')
}

function sharedServiceKey(): string {
  return env('SUPABASE_SERVICE_ROLE_KEY', env('SUPABASE_SECRET_KEY', env('SUPABASE_SERVICE_KEY')))
}

// Parse `SUPABASE_DB_URL` into connection components so we can fall back to
// it when the canonical `POSTGRES_*` env vars are not set on a particular
// container. The supabase/docker-compose.yml functions service only exposes
// `SUPABASE_DB_URL` (constructed from POSTGRES_* at substitution-time), not
// the individual parts — so in the shared-stack case we need to parse it
// back out for JIT DDL and db-password rotation to find a usable superuser
// connection.
interface ParsedDbUrl {
  user: string
  password: string
  host: string
  port: number
  database: string
}

function parseDbUrl(raw: string): ParsedDbUrl | null {
  if (!raw) return null
  try {
    const u = new URL(raw)
    if (!u.protocol.startsWith('postgres')) return null
    return {
      user: decodeURIComponent(u.username || ''),
      password: decodeURIComponent(u.password || ''),
      host: u.hostname,
      port: u.port ? Number(u.port) : 5432,
      database: u.pathname.replace(/^\//, '') || 'postgres',
    }
  } catch {
    return null
  }
}

function sharedDbUrl(): ParsedDbUrl | null {
  return parseDbUrl(env('SUPABASE_DB_URL'))
}

// Per-project orchestrators expose pg-meta/analytics/functions under
// conventional sub-paths on the project endpoint. Local mode keeps using
// the compose-internal `http://meta:8080` / `http://analytics:4000` hosts
// because that's what Kong and Vector reach today — switching to the
// `{endpoint}/...` form against `http://kong:8000` would force Kong to
// proxy sub-paths that aren't configured in `kong.yml`.
function isPerProjectBackend(rowEndpoint: string | null): boolean {
  if (!rowEndpoint) return false
  const shared = sharedEndpoint()
  if (!shared) return true
  // Trim a trailing slash before comparing so `http://kong:8000/` and
  // `http://kong:8000` are treated as the same shared host.
  const normalize = (s: string): string => s.replace(/\/$/, '')
  return normalize(rowEndpoint) !== normalize(shared)
}

// ── Secret decryption ────────────────────────────────────────

async function decryptSecret(
  connection: BackendPoolConnection,
  secretId: string | null,
): Promise<string> {
  if (!secretId) return ''
  const result = await connection.queryObject<{ decrypted_secret: string }>`
    SELECT decrypted_secret FROM vault.decrypted_secrets
    WHERE id = ${secretId}::uuid
  `
  return result.rows[0]?.decrypted_secret ?? ''
}

// ── Resolver ─────────────────────────────────────────────────

export async function getProjectBackend(ref: string, pool: BackendPool): Promise<ProjectBackend> {
  const connection = await pool.connect()
  try {
    const rowResult = await connection.queryObject<ProjectRow>`
      SELECT
        ref, endpoint, anon_key, db_host,
        service_key_secret_id, db_pass_secret_id, connection_string_secret_id
      FROM traffic.projects
      WHERE ref = ${ref}
    `

    if (rowResult.rows.length === 0) {
      throw new ProjectBackendNotProvisionedError(ref, ['project_row'])
    }

    const row = rowResult.rows[0]

    const serviceKeyFromVault = await decryptSecret(connection, row.service_key_secret_id)
    const dbPassFromVault = await decryptSecret(connection, row.db_pass_secret_id)
    const connectionStringFromVault = await decryptSecret(
      connection,
      row.connection_string_secret_id,
    )

    const endpoint = row.endpoint ?? sharedEndpoint()
    const perProject = isPerProjectBackend(row.endpoint)
    // C2: per-project mode MUST NOT fall back to the shared `SUPABASE_*`
    // env values. Doing so would silently sign outbound calls to a
    // different tenant's endpoint with the platform-global `service_role`
    // key — a cross-tenant credential leak. When the project row points
    // at a per-project endpoint we require the row to carry its own
    // `anon_key` column and a Vault-backed `service_key_secret_id`; if
    // either is missing we surface the partial provisioning state as a
    // `project_backend_not_provisioned` 501 with the exact missing keys
    // so operators can see which Vault row / column was never populated.
    // In shared-stack mode (where `perProject === false`) the env
    // fallbacks remain in play — that's the local-Docker single-tenant
    // path, which is the only place the shared keys are valid.
    const anonKey = perProject ? (row.anon_key ?? '') : (row.anon_key ?? env('SUPABASE_ANON_KEY'))
    const serviceKey = perProject ? serviceKeyFromVault : serviceKeyFromVault || sharedServiceKey()
    const sharedDb = sharedDbUrl()
    const dbHost = row.db_host ?? env('POSTGRES_HOST', sharedDb?.host ?? 'db')
    // External clients (JIT `connection_string`, cloud Studio downloads)
    // need a hostname they can actually resolve. In-container callers
    // continue to use `dbHost` (= `db` in the shared Docker stack); this
    // value only diverges when an operator deliberately sets
    // `SUPABASE_PUBLIC_DB_HOST` (e.g. `127.0.0.1` for local SSH tunnels,
    // or a public DNS name in cloud deployments). Falls back to `dbHost`
    // so production single-stack installs are unchanged.
    const externalDbHost = env('SUPABASE_PUBLIC_DB_HOST', dbHost)
    const dbPort = envNumber('POSTGRES_PORT', sharedDb?.port ?? 5432)
    const dbUser = env('POSTGRES_USER', sharedDb?.user || 'postgres')
    const dbPass = dbPassFromVault || env('POSTGRES_PASSWORD', sharedDb?.password ?? '')
    const dbName = env('POSTGRES_DB', sharedDb?.database ?? 'postgres')

    // Vault-stored connection string wins ONLY when it actually carries a
    // password. Some tenants were provisioned with placeholder conn_string
    // secrets whose password component is blank (e.g. during a DB-reset
    // recovery or partial provisioning). Attempting to open a pool against
    // such a string trips postgres-deno's "Attempting SASL auth with unset
    // password" at connection time. In that case we fall through to the
    // per-component build below, which uses the real password resolved from
    // the vault / POSTGRES_PASSWORD / SUPABASE_DB_URL chain.
    const parsedVaultConn = connectionStringFromVault ? parseDbUrl(connectionStringFromVault) : null
    const vaultConnUsable = Boolean(parsedVaultConn?.password)
    const connectionString = (vaultConnUsable ? connectionStringFromVault : '') ||
      (dbHost && dbPass ? `postgresql://${dbUser}:${dbPass}@${dbHost}:${dbPort}/${dbName}` : '')

    const pgMetaUrl = perProject
      ? endpoint.replace(/\/$/, '') + '/pg-meta/v1'
      : env('PG_META_URL', 'http://meta:8080').replace(/\/$/, '')
    const logflareUrl = perProject
      ? endpoint.replace(/\/$/, '') + '/analytics/v1'
      : env('LOGFLARE_URL', 'http://analytics:4000').replace(/\/$/, '')
    // M9 (Phase 6 limitation, documented in ARCHITECTURE.md §"Env-var
    // fallbacks"): the Logflare access token is read from the
    // platform-global `LOGFLARE_PRIVATE_ACCESS_TOKEN` env var rather than
    // a per-project Vault secret. Adding a `logflare_access_token_secret_id`
    // column to `traffic.projects` is the planned long-term fix but
    // requires a schema migration + ApiProvisioner contract change, so
    // we've deferred it. Until then, a cross-tenant Logflare token is
    // acceptable because:
    //   (a) the token only authorizes read access against the SQL endpoint,
    //   (b) per-project mode already routes to a distinct `logflareUrl`,
    //   (c) open-source deploys run a single Logflare instance anyway.
    // If you deploy per-project Logflare instances, set
    // `LOGFLARE_PRIVATE_ACCESS_TOKEN` to the token that each downstream
    // instance accepts (typically configured identically at provision time).
    const logflareToken = env('LOGFLARE_PRIVATE_ACCESS_TOKEN')
    const functionsApiUrl = endpoint.replace(/\/$/, '') + '/functions/v1'

    // Minimum viable contract: a non-empty endpoint and service_key is
    // enough for every outbound admin call. Everything else is best-effort.
    const missing: string[] = []
    if (!endpoint) missing.push('endpoint')
    if (!serviceKey) missing.push('service_key')
    if (missing.length > 0) {
      throw new ProjectBackendNotProvisionedError(ref, missing)
    }

    return {
      ref: row.ref,
      endpoint,
      anonKey,
      serviceKey,
      pgMetaUrl,
      logflareUrl,
      logflareToken,
      dbHost,
      externalDbHost,
      dbPort,
      dbUser,
      dbPass,
      dbName,
      connectionString,
      functionsApiUrl,
    }
  } finally {
    connection.release()
  }
}

// ── Outbound helper ──────────────────────────────────────────

export type FetchLike = typeof fetch

export interface FetchProjectJsonInit extends RequestInit {
  // `path` is joined onto `backend.endpoint` verbatim — callers must start it
  // with `/`. We don't auto-prefix `/auth/v1` / `/rest/v1` because the caller
  // knows which subsystem it's talking to.
  path?: never
}

// Builds an authorized fetch against a project backend. Mirrors the header
// set that the stock supabase-js admin client sends: both `Authorization`
// (the JWT) and `apikey` (the raw service key). PostgREST and pg-meta want
// `apikey`; GoTrue admin wants `Authorization`; both tolerate the other
// being present.
//
// Content-Type is auto-set to JSON when a body is present and the caller
// didn't already specify one, matching what Studio's fetchers do. Callers
// sending FormData or raw octet-streams should pass their own Content-Type.
export function fetchProjectJson(
  backend: ProjectBackend,
  path: string,
  init: RequestInit = {},
  fetchImpl: FetchLike = fetch,
): Promise<Response> {
  if (!path.startsWith('/')) {
    return Promise.reject(
      new Error(`fetchProjectJson: path must start with '/': got ${JSON.stringify(path)}`),
    )
  }
  const url = backend.endpoint.replace(/\/$/, '') + path
  return fetchProjectUrl(backend, url, init, fetchImpl)
}

// Sibling of `fetchProjectJson` that targets an absolute URL rather than a
// path relative to `backend.endpoint`. Used for surfaces whose base URL is
// carried on the backend as a full URL (`functionsApiUrl`, `pgMetaUrl`,
// `logflareUrl`) and therefore may live on a different host than
// `backend.endpoint` in api-mode deployments.
export function fetchProjectUrl(
  backend: ProjectBackend,
  url: string,
  init: RequestInit = {},
  fetchImpl: FetchLike = fetch,
): Promise<Response> {
  const headers = new Headers(init.headers ?? {})
  if (!headers.has('Authorization')) {
    headers.set('Authorization', `Bearer ${backend.serviceKey}`)
  }
  if (!headers.has('apikey')) {
    headers.set('apikey', backend.serviceKey)
  }
  if (!headers.has('Content-Type') && init.body !== undefined && init.body !== null) {
    headers.set('Content-Type', 'application/json')
  }
  return fetchImpl(url, { ...init, headers })
}

// True when the resolved backend points at the shared Docker stack (local
// single-tenant mode). Per-project backends instead point at whatever URL
// `ApiProvisioner.provision()` returned. The edge-function route uses this
// to decide whether to write to the local filesystem mount or to proxy the
// deploy over HTTP to the project's own functions runtime.
//
// L1: must stay in sync with `isPerProjectBackend`. In particular:
//   - row.endpoint null/empty  →  shared (regardless of SUPABASE_URL)
//     `getProjectBackend` falls back to `sharedEndpoint()` here, so a blank
//     SUPABASE_URL leaves `backend.endpoint === ''`. The old impl tripped
//     on the empty-shared guard and returned false, which forced edge
//     deploys down the HTTP-proxy path even though there IS no
//     per-project backend to proxy to — a confusing misfire during local
//     dev when operators forgot to set SUPABASE_URL. Treat an empty
//     endpoint as "shared" defensively.
//   - row.endpoint set, shared unset  →  per-project (only place with a
//     usable URL is the row, so it must be treated as a dedicated stack).
//   - row.endpoint set, shared set   →  shared iff they match.
export function isSharedStack(backend: ProjectBackend): boolean {
  const normalize = (s: string): string => s.replace(/\/$/, '')
  const shared = sharedEndpoint()
  const endpoint = backend.endpoint ?? ''
  // L1 defensive return: both blank means the project row had no endpoint
  // AND the operator never set SUPABASE_URL. `getProjectBackend` already
  // treated this as the shared-stack fallback path, so isSharedStack must
  // agree — otherwise edge-function deploy picks the wrong branch and
  // tries to POST to an empty URL.
  if (!endpoint && !shared) return true
  if (!shared) return false
  return normalize(endpoint) === normalize(shared)
}
