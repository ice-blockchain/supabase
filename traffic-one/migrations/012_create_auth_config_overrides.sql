-- Per-project auth config overrides layered on top of GoTrue's env-derived defaults.
-- GoTrue itself is configured via environment variables and requires a container
-- restart to change. Studio writes to this table so the UI's "save" reflects
-- immediately on subsequent reads, even though the live GoTrue process is
-- unchanged. Operators must still restart GoTrue with updated env vars for
-- the overrides to take effect at the auth layer.

CREATE TABLE IF NOT EXISTS traffic.auth_config_overrides (
  id SERIAL PRIMARY KEY,
  project_ref TEXT NOT NULL,
  config_key TEXT NOT NULL,
  config_value JSONB NOT NULL,
  updated_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  UNIQUE(project_ref, config_key)
);

CREATE INDEX IF NOT EXISTS idx_auth_config_overrides_project_ref
  ON traffic.auth_config_overrides (project_ref);

GRANT SELECT, INSERT, UPDATE, DELETE ON traffic.auth_config_overrides TO traffic_api;
GRANT USAGE ON SEQUENCE traffic.auth_config_overrides_id_seq TO traffic_api;
