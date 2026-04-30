CREATE TABLE IF NOT EXISTS traffic.schema_migrations (
  id SERIAL PRIMARY KEY,
  project_ref TEXT NOT NULL,
  version TEXT NOT NULL,
  name TEXT NOT NULL DEFAULT '',
  statements TEXT[] NOT NULL DEFAULT '{}',
  inserted_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  UNIQUE(project_ref, version)
);

CREATE INDEX IF NOT EXISTS idx_schema_migrations_project_ref
  ON traffic.schema_migrations (project_ref);

CREATE INDEX IF NOT EXISTS idx_schema_migrations_project_ref_version
  ON traffic.schema_migrations (project_ref, version DESC);

GRANT SELECT, INSERT, UPDATE, DELETE ON traffic.schema_migrations TO traffic_api;
GRANT USAGE ON SEQUENCE traffic.schema_migrations_id_seq TO traffic_api;
