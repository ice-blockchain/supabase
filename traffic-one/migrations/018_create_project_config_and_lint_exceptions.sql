-- Per-project runtime configuration surfaces (PostgREST, Storage, Realtime,
-- pgBouncer) layered on top of env-derived defaults. Each column holds a
-- partial JSONB override that is shallow-merged with the code-side defaults
-- on read. `secrets_rotation` tracks the latest JWT-secret rotation request
-- so that GET /config/secrets/update-status can advance state deterministically.
--
-- Bundle M (Auth v1) will add an `ssl_enforcement` column in a later
-- migration. Do NOT add it here.

CREATE TABLE IF NOT EXISTS traffic.project_config (
  id SERIAL PRIMARY KEY,
  project_ref TEXT NOT NULL UNIQUE,
  postgrest JSONB NOT NULL DEFAULT '{}'::jsonb,
  storage JSONB NOT NULL DEFAULT '{}'::jsonb,
  realtime JSONB NOT NULL DEFAULT '{}'::jsonb,
  pgbouncer JSONB NOT NULL DEFAULT '{}'::jsonb,
  secrets_rotation JSONB NOT NULL DEFAULT '{}'::jsonb,
  updated_at TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE INDEX IF NOT EXISTS idx_project_config_project_ref
  ON traffic.project_config (project_ref);

GRANT SELECT, INSERT, UPDATE, DELETE ON traffic.project_config TO traffic_api;
GRANT USAGE ON SEQUENCE traffic.project_config_id_seq TO traffic_api;

-- Lint advisor exceptions — per-project, per-lint "ignore this" flag.
CREATE TABLE IF NOT EXISTS traffic.lint_exceptions (
  id SERIAL PRIMARY KEY,
  project_ref TEXT NOT NULL,
  lint_name TEXT NOT NULL,
  disabled BOOLEAN NOT NULL DEFAULT true,
  metadata JSONB NOT NULL DEFAULT '{}'::jsonb,
  inserted_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  UNIQUE (project_ref, lint_name)
);

CREATE INDEX IF NOT EXISTS idx_lint_exceptions_project_ref
  ON traffic.lint_exceptions (project_ref);

GRANT SELECT, INSERT, UPDATE, DELETE ON traffic.lint_exceptions TO traffic_api;
GRANT USAGE ON SEQUENCE traffic.lint_exceptions_id_seq TO traffic_api;

-- Project sensitivity column. Defaults to MEDIUM for existing rows.
ALTER TABLE traffic.projects
  ADD COLUMN IF NOT EXISTS sensitivity TEXT
    CHECK (sensitivity IN ('LOW', 'MEDIUM', 'HIGH', 'CRITICAL'))
    DEFAULT 'MEDIUM';
