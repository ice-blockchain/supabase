-- Create the traffic schema and restricted API role
-- The traffic_api role is used by all platform API edge functions

CREATE SCHEMA IF NOT EXISTS traffic;

DO $$
BEGIN
  IF NOT EXISTS (SELECT FROM pg_roles WHERE rolname = 'traffic_api') THEN
    EXECUTE format('CREATE ROLE traffic_api LOGIN PASSWORD %L', current_setting('app.traffic_api_pass', true));
  END IF;
END
$$;

GRANT USAGE ON SCHEMA traffic TO traffic_api;
