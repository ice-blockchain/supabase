-- Bundle Q migration: JIT (just-in-time) database access policies + per-user grants.
--
-- `jit_policies` stores a per-project policy JSONB (enabled flag, max session
-- duration, approval flow, default scope). The route handler returns defaults
-- when no row exists, so this table only needs to persist explicit overrides.
--
-- `jit_grants` tracks issued short-lived Postgres roles. The `status` column
-- captures provisional states:
--   `active`   — the real Postgres role was created successfully.
--   `pending`  — the controlling connection lacks CREATEROLE (tests / restricted
--                envs); the grant row is persisted so Studio shows it and the
--                caller receives the credentials, but the PG role is absent.
--   `revoked`  — explicit DELETE by an operator.
--   `expired`  — `cleanupExpiredGrants` flipped the row past `expires_at`.
--
-- Plaintext passwords are never stored in this table; we keep the Vault
-- `password_secret_id` and surface the plaintext only in the create response.

CREATE TABLE IF NOT EXISTS traffic.jit_policies (
  id SERIAL PRIMARY KEY,
  project_ref TEXT NOT NULL UNIQUE,
  policy JSONB NOT NULL DEFAULT '{}'::jsonb,
  updated_at TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE INDEX IF NOT EXISTS idx_jit_policies_project_ref
  ON traffic.jit_policies (project_ref);

GRANT SELECT, INSERT, UPDATE, DELETE ON traffic.jit_policies TO traffic_api;
GRANT USAGE ON SEQUENCE traffic.jit_policies_id_seq TO traffic_api;

CREATE TABLE IF NOT EXISTS traffic.jit_grants (
  id SERIAL PRIMARY KEY,
  project_ref TEXT NOT NULL,
  profile_id INTEGER REFERENCES traffic.profiles(id) ON DELETE SET NULL,
  username TEXT NOT NULL,
  password_secret_id UUID,
  scope TEXT,
  status TEXT NOT NULL
    CHECK (status IN ('active', 'pending', 'revoked', 'expired'))
    DEFAULT 'active',
  granted_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  expires_at TIMESTAMPTZ NOT NULL,
  revoked_at TIMESTAMPTZ
);

CREATE INDEX IF NOT EXISTS idx_jit_grants_project_ref
  ON traffic.jit_grants (project_ref);

CREATE INDEX IF NOT EXISTS idx_jit_grants_project_ref_status
  ON traffic.jit_grants (project_ref, status);

CREATE INDEX IF NOT EXISTS idx_jit_grants_expires_at
  ON traffic.jit_grants (expires_at);

GRANT SELECT, INSERT, UPDATE, DELETE ON traffic.jit_grants TO traffic_api;
GRANT USAGE ON SEQUENCE traffic.jit_grants_id_seq TO traffic_api;
