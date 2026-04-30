CREATE TABLE IF NOT EXISTS traffic.organizations (
  id SERIAL PRIMARY KEY,
  name TEXT NOT NULL,
  slug TEXT NOT NULL UNIQUE,
  billing_email TEXT,
  opt_in_tags TEXT[] NOT NULL DEFAULT '{}',
  plan_id TEXT NOT NULL DEFAULT 'free',
  plan_name TEXT NOT NULL DEFAULT 'Free',
  created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE TABLE IF NOT EXISTS traffic.organization_members (
  id SERIAL PRIMARY KEY,
  organization_id INTEGER NOT NULL REFERENCES traffic.organizations(id) ON DELETE CASCADE,
  profile_id INTEGER NOT NULL REFERENCES traffic.profiles(id) ON DELETE CASCADE,
  role TEXT NOT NULL DEFAULT 'owner',
  created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  UNIQUE(organization_id, profile_id)
);

CREATE INDEX IF NOT EXISTS idx_organizations_slug ON traffic.organizations (slug);
CREATE INDEX IF NOT EXISTS idx_organization_members_profile_id ON traffic.organization_members (profile_id);
CREATE INDEX IF NOT EXISTS idx_organization_members_organization_id ON traffic.organization_members (organization_id);

GRANT SELECT, INSERT, UPDATE, DELETE ON traffic.organizations TO traffic_api;
GRANT USAGE ON SEQUENCE traffic.organizations_id_seq TO traffic_api;
GRANT SELECT, INSERT, UPDATE, DELETE ON traffic.organization_members TO traffic_api;
GRANT USAGE ON SEQUENCE traffic.organization_members_id_seq TO traffic_api;
