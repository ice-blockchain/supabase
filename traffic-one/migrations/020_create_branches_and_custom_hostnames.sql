-- Self-hosted branches + custom hostnames.
--
-- Branches are pure DB-state rows: self-hosted has no git integration layer,
-- so push / merge / reset / restore are implemented as status transitions
-- on this table. The state machine enforced by the service layer is:
--
--   created  ──push──▶  pushing  ──(finalize)──▶  pushed  ──merge──▶  merged
--                                                   ▲                    │
--                                                   └──────reset─────────┘
--
-- Soft-deletes (deleted_at) can be reversed via POST /branches/{id}/restore;
-- the partial unique index ignores soft-deleted rows so a deleted branch
-- name can be reused by a fresh branch.
--
-- Custom hostnames: operators don't control DNS from the dashboard in
-- self-hosted, so activate/reverify return 501. This table is purely a
-- mirror of whatever the user typed into the "custom domain" form so the
-- Studio UI can round-trip the configured hostname across reloads.

CREATE TABLE IF NOT EXISTS traffic.branches (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  project_ref TEXT NOT NULL,
  branch_name TEXT NOT NULL,
  parent_project_ref TEXT,
  is_default BOOLEAN NOT NULL DEFAULT false,
  git_branch TEXT,
  status TEXT NOT NULL DEFAULT 'created'
    CHECK (status IN ('created', 'pushing', 'pushed', 'merged', 'revoked')),
  pr_number INTEGER,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  merged_at TIMESTAMPTZ,
  deleted_at TIMESTAMPTZ
);

CREATE INDEX IF NOT EXISTS idx_branches_project_ref
  ON traffic.branches (project_ref);

CREATE INDEX IF NOT EXISTS idx_branches_project_ref_active
  ON traffic.branches (project_ref)
  WHERE deleted_at IS NULL;

-- Branch names are unique within a project, ignoring soft-deleted rows.
CREATE UNIQUE INDEX IF NOT EXISTS uq_branches_project_ref_name_active
  ON traffic.branches (project_ref, branch_name)
  WHERE deleted_at IS NULL;

GRANT SELECT, INSERT, UPDATE, DELETE ON traffic.branches TO traffic_api;

CREATE TABLE IF NOT EXISTS traffic.custom_hostnames (
  id SERIAL PRIMARY KEY,
  project_ref TEXT NOT NULL UNIQUE,
  custom_hostname TEXT,
  status TEXT NOT NULL DEFAULT 'not_configured'
    CHECK (status IN ('not_configured', 'pending', 'active', 'failed')),
  verification_errors JSONB NOT NULL DEFAULT '[]',
  ownership_verified BOOLEAN NOT NULL DEFAULT false,
  ssl_verified BOOLEAN NOT NULL DEFAULT false,
  inserted_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE INDEX IF NOT EXISTS idx_custom_hostnames_project_ref
  ON traffic.custom_hostnames (project_ref);

GRANT SELECT, INSERT, UPDATE, DELETE ON traffic.custom_hostnames TO traffic_api;
GRANT USAGE ON SEQUENCE traffic.custom_hostnames_id_seq TO traffic_api;
