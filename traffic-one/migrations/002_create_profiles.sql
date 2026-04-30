CREATE TABLE IF NOT EXISTS traffic.profiles (
  id SERIAL PRIMARY KEY,
  gotrue_id UUID NOT NULL UNIQUE,
  username TEXT NOT NULL DEFAULT '',
  primary_email TEXT NOT NULL DEFAULT '',
  first_name TEXT,
  last_name TEXT,
  mobile TEXT,
  is_alpha_user BOOLEAN NOT NULL DEFAULT false,
  is_sso_user BOOLEAN NOT NULL DEFAULT false,
  free_project_limit INTEGER DEFAULT 2,
  disabled_features TEXT[] NOT NULL DEFAULT '{}',
  created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE INDEX IF NOT EXISTS idx_profiles_gotrue_id ON traffic.profiles (gotrue_id);

GRANT SELECT, INSERT, UPDATE, DELETE ON traffic.profiles TO traffic_api;
GRANT USAGE ON SEQUENCE traffic.profiles_id_seq TO traffic_api;
