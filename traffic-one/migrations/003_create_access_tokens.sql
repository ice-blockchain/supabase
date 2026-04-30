CREATE TABLE IF NOT EXISTS traffic.access_tokens (
  id SERIAL PRIMARY KEY,
  profile_id INTEGER NOT NULL REFERENCES traffic.profiles(id) ON DELETE CASCADE,
  name TEXT NOT NULL,
  token_hash TEXT NOT NULL,
  token_alias TEXT NOT NULL,
  scope TEXT DEFAULT 'V0',
  expires_at TIMESTAMPTZ,
  last_used_at TIMESTAMPTZ,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE INDEX IF NOT EXISTS idx_access_tokens_profile_id ON traffic.access_tokens (profile_id);

CREATE TABLE IF NOT EXISTS traffic.scoped_access_tokens (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  profile_id INTEGER NOT NULL REFERENCES traffic.profiles(id) ON DELETE CASCADE,
  name TEXT NOT NULL,
  token_hash TEXT NOT NULL,
  token_alias TEXT NOT NULL,
  permissions TEXT[] NOT NULL DEFAULT '{}',
  organization_slugs TEXT[] DEFAULT '{}',
  project_refs TEXT[] DEFAULT '{}',
  expires_at TIMESTAMPTZ,
  last_used_at TIMESTAMPTZ,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE INDEX IF NOT EXISTS idx_scoped_access_tokens_profile_id ON traffic.scoped_access_tokens (profile_id);

GRANT SELECT, INSERT, DELETE ON traffic.access_tokens TO traffic_api;
GRANT USAGE ON SEQUENCE traffic.access_tokens_id_seq TO traffic_api;
GRANT SELECT, INSERT, DELETE ON traffic.scoped_access_tokens TO traffic_api;
