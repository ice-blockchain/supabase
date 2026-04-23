CREATE TABLE IF NOT EXISTS traffic.log_drains (
  id SERIAL PRIMARY KEY,
  project_ref TEXT NOT NULL,
  token UUID NOT NULL UNIQUE DEFAULT gen_random_uuid(),
  name TEXT NOT NULL,
  description TEXT NOT NULL DEFAULT '',
  type TEXT NOT NULL,
  config JSONB NOT NULL DEFAULT '{}',
  filters JSONB NOT NULL DEFAULT '[]',
  active BOOLEAN NOT NULL DEFAULT true,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  deleted_at TIMESTAMPTZ
);

CREATE INDEX IF NOT EXISTS idx_log_drains_project_ref
  ON traffic.log_drains (project_ref);

CREATE INDEX IF NOT EXISTS idx_log_drains_project_ref_active
  ON traffic.log_drains (project_ref)
  WHERE deleted_at IS NULL;

-- Name uniqueness is enforced per project, ignoring soft-deleted rows.
CREATE UNIQUE INDEX IF NOT EXISTS uq_log_drains_project_ref_name_active
  ON traffic.log_drains (project_ref, name)
  WHERE deleted_at IS NULL;

GRANT SELECT, INSERT, UPDATE, DELETE ON traffic.log_drains TO traffic_api;
GRANT USAGE ON SEQUENCE traffic.log_drains_id_seq TO traffic_api;
