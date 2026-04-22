CREATE TABLE IF NOT EXISTS traffic.notifications (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  profile_id INTEGER NOT NULL REFERENCES traffic.profiles(id) ON DELETE CASCADE,
  name TEXT NOT NULL,
  data JSONB DEFAULT '{}',
  meta JSONB DEFAULT '{}',
  priority TEXT NOT NULL DEFAULT 'Info' CHECK (priority IN ('Critical', 'Warning', 'Info')),
  status TEXT NOT NULL DEFAULT 'new' CHECK (status IN ('new', 'seen', 'archived')),
  inserted_at TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE INDEX IF NOT EXISTS idx_notifications_profile_id ON traffic.notifications (profile_id);

GRANT SELECT, INSERT, UPDATE ON traffic.notifications TO traffic_api;
