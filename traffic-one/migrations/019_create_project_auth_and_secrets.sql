-- Bundle M: third-party auth integrations, SSL enforcement, Vault-backed secrets.
--
-- This migration depends on Bundle I (migration 018) which introduces
-- `traffic.project_config` with its full schema (`postgrest`, `storage`,
-- `realtime`, `pgbouncer`, `secrets_rotation`). Previous versions of this
-- file defensively re-created `project_config` with a minimal schema if
-- 018 had not run yet, which masked a migrator bug: running 019 first
-- would create a stripped-down table that 018 then silently left alone
-- (its CREATE TABLE IF NOT EXISTS is a no-op).
--
-- M10: We now rely on strict numeric migration ordering and FAIL LOUDLY
-- instead. This ALTER statement raises a "relation does not exist" error
-- if 018 has not run yet, which is exactly the signal the operator needs.
--
-- `ssl_enforcement` stores the minimal configuration shape
-- `{ "database": "enforced" | "not_enforced" }`. The route handler wraps
-- it into `{ currentConfig, appliedSuccessfully }` on read.

-- ── project_config.ssl_enforcement (introduced by Bundle I, 018) ────────────

ALTER TABLE traffic.project_config
  ADD COLUMN IF NOT EXISTS ssl_enforcement JSONB NOT NULL DEFAULT '{}'::jsonb;

-- ── third-party auth integrations ────────────────────────────────────────────
--
-- `type='oidc'` covers both "OIDC issuer URL" and "JWKS URL" integrations
-- (Studio treats them interchangeably at the storage layer — one of
-- oidc_issuer_url / jwks_url is set). `type='custom_jwks'` stores a
-- user-supplied JWKS JSON blob. `resolved_jwks` is reserved for a future
-- background refresh of remote JWKS.

CREATE TABLE IF NOT EXISTS traffic.project_third_party_auth (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  project_ref TEXT NOT NULL,
  type TEXT NOT NULL CHECK (type IN ('oidc', 'custom_jwks')),
  oidc_issuer_url TEXT,
  jwks_url TEXT,
  custom_jwks JSONB,
  resolved_jwks JSONB,
  inserted_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE INDEX IF NOT EXISTS idx_project_third_party_auth_project_ref
  ON traffic.project_third_party_auth (project_ref);

GRANT SELECT, INSERT, UPDATE, DELETE ON traffic.project_third_party_auth TO traffic_api;

-- ── project_secrets (Vault-backed) ───────────────────────────────────────────
--
-- Maps (project_ref, name) → vault.secrets.id. Plaintext never lives here;
-- it only lives in vault.decrypted_secrets and is surfaced exclusively via
-- the service-level decryptSecretInternal helper. List / fetch paths through
-- the HTTP routes only return names + timestamps.

CREATE TABLE IF NOT EXISTS traffic.project_secrets (
  id SERIAL PRIMARY KEY,
  project_ref TEXT NOT NULL,
  name TEXT NOT NULL,
  secret_id UUID NOT NULL,
  inserted_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  UNIQUE(project_ref, name)
);

CREATE INDEX IF NOT EXISTS idx_project_secrets_project_ref
  ON traffic.project_secrets (project_ref);

GRANT SELECT, INSERT, UPDATE, DELETE ON traffic.project_secrets TO traffic_api;
GRANT USAGE ON SEQUENCE traffic.project_secrets_id_seq TO traffic_api;
