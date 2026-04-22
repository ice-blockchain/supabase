CREATE TABLE IF NOT EXISTS traffic.audit_logs (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  profile_id INTEGER NOT NULL REFERENCES traffic.profiles(id) ON DELETE CASCADE,
  action_name TEXT NOT NULL,
  action_metadata JSONB DEFAULT '[]',
  actor_id TEXT NOT NULL,
  actor_type TEXT NOT NULL DEFAULT 'user',
  actor_metadata JSONB DEFAULT '[]',
  target_description TEXT DEFAULT '',
  target_metadata JSONB DEFAULT '{}',
  occurred_at TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE INDEX IF NOT EXISTS idx_audit_logs_profile_id ON traffic.audit_logs (profile_id);
CREATE INDEX IF NOT EXISTS idx_audit_logs_occurred_at ON traffic.audit_logs (occurred_at);

-- Append-only: allow INSERT and SELECT but deny UPDATE and DELETE
GRANT SELECT, INSERT ON traffic.audit_logs TO traffic_api;

-- Set default privileges for future tables in the traffic schema
ALTER DEFAULT PRIVILEGES IN SCHEMA traffic GRANT SELECT, INSERT, UPDATE, DELETE ON TABLES TO traffic_api;
ALTER DEFAULT PRIVILEGES IN SCHEMA traffic GRANT USAGE ON SEQUENCES TO traffic_api;
