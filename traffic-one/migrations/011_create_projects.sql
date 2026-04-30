CREATE TABLE IF NOT EXISTS traffic.projects (
  id SERIAL PRIMARY KEY,
  ref TEXT NOT NULL UNIQUE,
  name TEXT NOT NULL,
  organization_id INTEGER NOT NULL REFERENCES traffic.organizations(id) ON DELETE CASCADE,
  region TEXT NOT NULL DEFAULT 'local',
  cloud_provider TEXT NOT NULL DEFAULT 'FLY',
  status TEXT NOT NULL DEFAULT 'COMING_UP',
  endpoint TEXT,
  anon_key TEXT,
  db_host TEXT,
  service_key_secret_id UUID,
  db_pass_secret_id UUID,
  connection_string_secret_id UUID,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE INDEX IF NOT EXISTS idx_projects_organization_id ON traffic.projects (organization_id);

GRANT SELECT, INSERT, UPDATE, DELETE ON traffic.projects TO traffic_api;
GRANT USAGE ON SEQUENCE traffic.projects_id_seq TO traffic_api;

CREATE EXTENSION IF NOT EXISTS supabase_vault WITH SCHEMA vault;

GRANT USAGE ON SCHEMA vault TO traffic_api;
GRANT EXECUTE ON ALL FUNCTIONS IN SCHEMA vault TO traffic_api;
GRANT SELECT ON vault.decrypted_secrets TO traffic_api;
-- DELETE FROM vault.secrets WHERE id = ... needs SELECT to evaluate the
-- WHERE clause row-by-row; without it Postgres fails "permission denied
-- for table secrets" at plan time regardless of the DELETE grant.
GRANT SELECT, DELETE ON vault.secrets TO traffic_api;

GRANT USAGE ON SCHEMA storage TO traffic_api;
GRANT SELECT ON storage.objects TO traffic_api;
GRANT SELECT ON storage.buckets TO traffic_api;
