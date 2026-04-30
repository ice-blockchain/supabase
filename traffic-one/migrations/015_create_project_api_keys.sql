-- Per-project API keys (publishable + secret) and JWT signing keys.
--
-- API keys are stored as SHA-256 hex digests of the plaintext. The plaintext
-- is surfaced exactly once, in the CREATE response, and never again — Studio's
-- "show key once" modal is the only place a consumer can read it. Subsequent
-- reads return only the `key_alias` (first 8 chars + "..." + last 4) for
-- display. `deleted_at` is the soft-delete marker; list views filter it out.
--
-- JWT signing keys represent the project's rotation-aware key material. The
-- `status` column enforces the 4-state machine used by Studio's
-- `useProjectSigningKeysQuery`. Exactly one key per project can be `in_use`;
-- the service layer enforces that invariant inside a transaction on create
-- and update.

CREATE TABLE IF NOT EXISTS traffic.project_api_keys (
  id SERIAL PRIMARY KEY,
  project_ref TEXT NOT NULL,
  name TEXT NOT NULL,
  description TEXT NOT NULL DEFAULT '',
  key_hash TEXT NOT NULL,
  key_alias TEXT NOT NULL,
  type TEXT NOT NULL CHECK (type IN ('publishable', 'secret')),
  tags TEXT[] NOT NULL DEFAULT '{}',
  created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  deleted_at TIMESTAMPTZ,
  UNIQUE(project_ref, key_hash)
);

CREATE INDEX IF NOT EXISTS idx_project_api_keys_project_ref
  ON traffic.project_api_keys (project_ref);

CREATE INDEX IF NOT EXISTS idx_project_api_keys_project_ref_active
  ON traffic.project_api_keys (project_ref)
  WHERE deleted_at IS NULL;

GRANT SELECT, INSERT, UPDATE, DELETE ON traffic.project_api_keys TO traffic_api;
GRANT USAGE ON SEQUENCE traffic.project_api_keys_id_seq TO traffic_api;

CREATE TABLE IF NOT EXISTS traffic.project_jwt_signing_keys (
  id SERIAL PRIMARY KEY,
  project_ref TEXT NOT NULL,
  algorithm TEXT NOT NULL,
  status TEXT NOT NULL CHECK (status IN ('in_use', 'standby', 'previously_used', 'revoked')),
  public_jwk JSONB NOT NULL DEFAULT '{}'::jsonb,
  private_jwk_secret_id UUID,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE INDEX IF NOT EXISTS idx_project_jwt_signing_keys_project_ref
  ON traffic.project_jwt_signing_keys (project_ref);

CREATE INDEX IF NOT EXISTS idx_project_jwt_signing_keys_project_ref_status
  ON traffic.project_jwt_signing_keys (project_ref, status);

-- M7: Enforce "exactly one in_use signing key per project" at the schema
-- level. The service layer (`project-api-keys.service.ts`) also demotes the
-- active key before promoting a replacement, but a race between the UPDATE
-- and the INSERT could leave two `in_use` rows. This partial unique index
-- makes that impossible — the INSERT would fail with a unique-violation and
-- the transaction would roll back instead of silently corrupting the
-- invariant that Studio relies on.
CREATE UNIQUE INDEX IF NOT EXISTS idx_project_jwt_signing_keys_one_in_use_per_project
  ON traffic.project_jwt_signing_keys (project_ref)
  WHERE status = 'in_use';

GRANT SELECT, INSERT, UPDATE, DELETE ON traffic.project_jwt_signing_keys TO traffic_api;
GRANT USAGE ON SEQUENCE traffic.project_jwt_signing_keys_id_seq TO traffic_api;
