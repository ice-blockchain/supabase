-- Content persistence for Studio SQL snippets, reports, and log queries.
-- Items live under a project_ref (soft-link to traffic.projects.ref), are owned
-- by a profile, and can be grouped into per-owner folders. Visibility controls
-- read access: 'user' is private to owner, 'project' is readable by any member
-- of the project's organization. Writes are always owner-only.

CREATE TABLE IF NOT EXISTS traffic.content_folders (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  project_ref TEXT NOT NULL,
  owner_id INTEGER NOT NULL REFERENCES traffic.profiles(id) ON DELETE CASCADE,
  parent_id UUID REFERENCES traffic.content_folders(id) ON DELETE CASCADE,
  name TEXT NOT NULL,
  inserted_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE INDEX IF NOT EXISTS idx_content_folders_project_ref
  ON traffic.content_folders (project_ref);
CREATE INDEX IF NOT EXISTS idx_content_folders_project_ref_owner
  ON traffic.content_folders (project_ref, owner_id);
CREATE INDEX IF NOT EXISTS idx_content_folders_parent_id
  ON traffic.content_folders (parent_id);

CREATE TABLE IF NOT EXISTS traffic.content_items (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  project_ref TEXT NOT NULL,
  owner_id INTEGER NOT NULL REFERENCES traffic.profiles(id) ON DELETE CASCADE,
  folder_id UUID REFERENCES traffic.content_folders(id) ON DELETE SET NULL,
  name TEXT NOT NULL DEFAULT '',
  description TEXT NOT NULL DEFAULT '',
  type TEXT NOT NULL CHECK (type IN ('sql', 'report', 'log_sql')),
  visibility TEXT NOT NULL DEFAULT 'user' CHECK (visibility IN ('user', 'project')),
  content JSONB NOT NULL DEFAULT '{}'::jsonb,
  favorite BOOLEAN NOT NULL DEFAULT false,
  inserted_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE INDEX IF NOT EXISTS idx_content_items_project_ref
  ON traffic.content_items (project_ref);
CREATE INDEX IF NOT EXISTS idx_content_items_project_ref_owner
  ON traffic.content_items (project_ref, owner_id);
CREATE INDEX IF NOT EXISTS idx_content_items_project_ref_folder
  ON traffic.content_items (project_ref, folder_id);
CREATE INDEX IF NOT EXISTS idx_content_items_project_ref_type
  ON traffic.content_items (project_ref, type);

GRANT SELECT, INSERT, UPDATE, DELETE ON traffic.content_folders TO traffic_api;
GRANT SELECT, INSERT, UPDATE, DELETE ON traffic.content_items TO traffic_api;
