-- Migration 010: Roles catalog, member-role junction, and invitations
-- Supports multi-role assignment, invitation workflow, and project-scoped roles

-- 1. Roles catalog (seeded with 4 fixed roles matching Studio's FIXED_ROLE_ORDER)
CREATE TABLE IF NOT EXISTS traffic.roles (
  id INTEGER PRIMARY KEY,
  name TEXT NOT NULL UNIQUE,
  description TEXT,
  base_role_id INTEGER NOT NULL,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now()
);

INSERT INTO traffic.roles (id, name, description, base_role_id) VALUES
  (2, 'Read only', 'Can view all resources but cannot make changes', 2),
  (3, 'Developer', 'Can manage projects and services', 3),
  (4, 'Administrator', 'Can manage members and organization settings', 4),
  (5, 'Owner', 'Full control over the organization', 5)
ON CONFLICT (id) DO NOTHING;

-- 2. Organization-member-role junction table (replaces flat role TEXT column)
CREATE TABLE IF NOT EXISTS traffic.organization_member_roles (
  id SERIAL PRIMARY KEY,
  organization_id INTEGER NOT NULL REFERENCES traffic.organizations(id) ON DELETE CASCADE,
  profile_id INTEGER NOT NULL REFERENCES traffic.profiles(id) ON DELETE CASCADE,
  role_id INTEGER NOT NULL REFERENCES traffic.roles(id) ON DELETE CASCADE,
  project_refs TEXT[] NOT NULL DEFAULT '{}',
  created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  UNIQUE(organization_id, profile_id, role_id)
);

CREATE INDEX IF NOT EXISTS idx_org_member_roles_org_profile
  ON traffic.organization_member_roles (organization_id, profile_id);

-- 3. Invitations table (token-based, 24h expiry)
CREATE TABLE IF NOT EXISTS traffic.invitations (
  id SERIAL PRIMARY KEY,
  organization_id INTEGER NOT NULL REFERENCES traffic.organizations(id) ON DELETE CASCADE,
  invited_email TEXT NOT NULL,
  role_id INTEGER NOT NULL REFERENCES traffic.roles(id) ON DELETE CASCADE,
  token UUID NOT NULL UNIQUE DEFAULT gen_random_uuid(),
  role_scoped_projects TEXT[] NOT NULL DEFAULT '{}',
  invited_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  expires_at TIMESTAMPTZ NOT NULL DEFAULT (now() + interval '24 hours')
);

CREATE INDEX IF NOT EXISTS idx_invitations_org_id
  ON traffic.invitations (organization_id);
CREATE INDEX IF NOT EXISTS idx_invitations_token
  ON traffic.invitations (token);

-- 4. Data migration: create junction rows for existing organization_members
INSERT INTO traffic.organization_member_roles (organization_id, profile_id, role_id)
SELECT om.organization_id, om.profile_id,
  CASE om.role
    WHEN 'owner' THEN 5
    WHEN 'admin' THEN 4
    WHEN 'developer' THEN 3
    WHEN 'read_only' THEN 2
    ELSE 3
  END
FROM traffic.organization_members om
WHERE NOT EXISTS (
  SELECT 1 FROM traffic.organization_member_roles omr
  WHERE omr.organization_id = om.organization_id AND omr.profile_id = om.profile_id
);

-- 5. Permissions for traffic_api role
GRANT SELECT ON traffic.roles TO traffic_api;
GRANT SELECT, INSERT, UPDATE, DELETE ON traffic.organization_member_roles TO traffic_api;
GRANT USAGE ON SEQUENCE traffic.organization_member_roles_id_seq TO traffic_api;
GRANT SELECT, INSERT, UPDATE, DELETE ON traffic.invitations TO traffic_api;
GRANT USAGE ON SEQUENCE traffic.invitations_id_seq TO traffic_api;
