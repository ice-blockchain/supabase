-- Pricing overrides: per-org, per-metric discount/custom pricing
CREATE TABLE IF NOT EXISTS traffic.pricing_overrides (
  id                    SERIAL PRIMARY KEY,
  organization_id       INTEGER NOT NULL REFERENCES traffic.organizations(id) ON DELETE CASCADE,
  metric                VARCHAR(64),
  discount_percent      NUMERIC(5,2) DEFAULT 0,
  custom_free_units     NUMERIC,
  custom_per_unit_price NUMERIC,
  notes                 TEXT,
  created_at            TIMESTAMPTZ DEFAULT now(),
  updated_at            TIMESTAMPTZ DEFAULT now(),
  UNIQUE(organization_id, metric)
);

GRANT SELECT, INSERT, UPDATE, DELETE ON traffic.pricing_overrides TO traffic_api;
GRANT USAGE, SELECT ON SEQUENCE traffic.pricing_overrides_id_seq TO traffic_api;

-- Usage service needs to query database size and storage objects
GRANT EXECUTE ON FUNCTION pg_database_size(name) TO traffic_api;
GRANT SELECT ON storage.objects TO traffic_api;
