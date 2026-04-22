-- Migration 009: Organization Settings (MFA enforcement, SSO providers, audit log org reference)

-- 1. New columns on organizations
ALTER TABLE traffic.organizations
  ADD COLUMN IF NOT EXISTS mfa_enforced BOOLEAN NOT NULL DEFAULT false;
ALTER TABLE traffic.organizations
  ADD COLUMN IF NOT EXISTS additional_billing_emails TEXT[] NOT NULL DEFAULT '{}';

-- 2. Organization reference on audit_logs (nullable for backward compat)
ALTER TABLE traffic.audit_logs
  ADD COLUMN IF NOT EXISTS organization_id INTEGER REFERENCES traffic.organizations(id) ON DELETE SET NULL;

-- 3. Query-optimized composite indexes for audit_logs
--
-- Org audit query:     WHERE organization_id = ? AND occurred_at BETWEEN ? AND ? ORDER BY occurred_at DESC
-- Profile audit query: WHERE profile_id = ?      AND occurred_at BETWEEN ? AND ? ORDER BY occurred_at DESC
--
-- These composite indexes cover the equality filter, range scan, and sort in a single B-tree.
-- They replace the less efficient single-column indexes from migration 005.
CREATE INDEX IF NOT EXISTS idx_audit_logs_org_occurred
  ON traffic.audit_logs (organization_id, occurred_at DESC);

CREATE INDEX IF NOT EXISTS idx_audit_logs_profile_occurred
  ON traffic.audit_logs (profile_id, occurred_at DESC);

-- Drop the old single-column indexes that are now subsumed:
DROP INDEX IF EXISTS traffic.idx_audit_logs_profile_id;
DROP INDEX IF EXISTS traffic.idx_audit_logs_occurred_at;

-- 4. SSO providers table (one provider per org, enforced by UNIQUE)
CREATE TABLE IF NOT EXISTS traffic.sso_providers (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  organization_id INTEGER NOT NULL UNIQUE REFERENCES traffic.organizations(id) ON DELETE CASCADE,
  enabled BOOLEAN NOT NULL DEFAULT false,
  metadata_xml_file TEXT,
  metadata_xml_url TEXT,
  domains TEXT[] NOT NULL DEFAULT '{}',
  email_mapping TEXT[] NOT NULL DEFAULT '{}',
  first_name_mapping TEXT[] NOT NULL DEFAULT '{}',
  last_name_mapping TEXT[] NOT NULL DEFAULT '{}',
  user_name_mapping TEXT[] NOT NULL DEFAULT '{}',
  join_org_on_signup_enabled BOOLEAN NOT NULL DEFAULT false,
  join_org_on_signup_role TEXT DEFAULT 'Developer',
  created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT now()
);

GRANT SELECT, INSERT, UPDATE, DELETE ON traffic.sso_providers TO traffic_api;
