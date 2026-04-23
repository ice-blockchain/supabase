CREATE TABLE IF NOT EXISTS traffic.feedback (
  id SERIAL PRIMARY KEY,
  profile_id INTEGER REFERENCES traffic.profiles(id) ON DELETE SET NULL,
  category TEXT NOT NULL CHECK (category IN ('general', 'upgrade_survey', 'downgrade_survey', 'support_ticket')),
  message TEXT NOT NULL,
  project_ref TEXT,
  organization_slug TEXT,
  tags TEXT[] NOT NULL DEFAULT '{}',
  metadata JSONB NOT NULL DEFAULT '{}',
  custom_fields JSONB NOT NULL DEFAULT '{}',
  created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE INDEX IF NOT EXISTS idx_feedback_profile_id ON traffic.feedback (profile_id);
CREATE INDEX IF NOT EXISTS idx_feedback_category ON traffic.feedback (category);

GRANT SELECT, INSERT, UPDATE, DELETE ON traffic.feedback TO traffic_api;
GRANT USAGE ON SEQUENCE traffic.feedback_id_seq TO traffic_api;
