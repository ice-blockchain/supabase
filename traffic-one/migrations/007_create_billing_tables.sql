-- Billing tables for org-based billing
-- Adapted from supabase-community/nextjs-subscription-payments schema

CREATE TYPE traffic.subscription_status AS ENUM (
  'trialing', 'active', 'canceled', 'incomplete',
  'incomplete_expired', 'past_due', 'unpaid', 'paused'
);

CREATE TYPE traffic.pricing_type AS ENUM ('one_time', 'recurring');
CREATE TYPE traffic.pricing_plan_interval AS ENUM ('day', 'week', 'month', 'year');

CREATE TABLE IF NOT EXISTS traffic.products (
  id TEXT PRIMARY KEY,
  active BOOLEAN,
  name TEXT,
  description TEXT,
  image TEXT,
  metadata JSONB
);

CREATE TABLE IF NOT EXISTS traffic.prices (
  id TEXT PRIMARY KEY,
  product_id TEXT REFERENCES traffic.products,
  active BOOLEAN,
  description TEXT,
  unit_amount BIGINT,
  currency TEXT CHECK (char_length(currency) = 3),
  type traffic.pricing_type,
  interval traffic.pricing_plan_interval,
  interval_count INTEGER,
  trial_period_days INTEGER,
  metadata JSONB
);

CREATE TABLE IF NOT EXISTS traffic.subscriptions (
  id TEXT PRIMARY KEY DEFAULT gen_random_uuid()::text,
  organization_id INTEGER NOT NULL REFERENCES traffic.organizations(id) ON DELETE CASCADE,
  status traffic.subscription_status,
  metadata JSONB,
  price_id TEXT REFERENCES traffic.prices,
  quantity INTEGER,
  cancel_at_period_end BOOLEAN,
  created TIMESTAMPTZ DEFAULT now(),
  current_period_start TIMESTAMPTZ DEFAULT now(),
  current_period_end TIMESTAMPTZ DEFAULT now(),
  ended_at TIMESTAMPTZ,
  cancel_at TIMESTAMPTZ,
  canceled_at TIMESTAMPTZ,
  trial_start TIMESTAMPTZ,
  trial_end TIMESTAMPTZ,
  tier TEXT NOT NULL DEFAULT 'tier_free',
  plan_id TEXT NOT NULL DEFAULT 'free',
  plan_name TEXT NOT NULL DEFAULT 'Free',
  billing_cycle_anchor BIGINT DEFAULT 0,
  usage_billing_enabled BOOLEAN DEFAULT false,
  nano_enabled BOOLEAN DEFAULT true,
  stripe_subscription_id TEXT,
  stripe_customer_id TEXT,
  UNIQUE(organization_id)
);

CREATE TABLE IF NOT EXISTS traffic.customers (
  id SERIAL PRIMARY KEY,
  organization_id INTEGER NOT NULL REFERENCES traffic.organizations(id) ON DELETE CASCADE UNIQUE,
  stripe_customer_id TEXT,
  billing_name TEXT,
  city TEXT,
  country TEXT,
  line1 TEXT,
  line2 TEXT,
  postal_code TEXT,
  state TEXT,
  created_at TIMESTAMPTZ DEFAULT now(),
  updated_at TIMESTAMPTZ DEFAULT now()
);

CREATE TABLE IF NOT EXISTS traffic.payment_methods (
  id TEXT PRIMARY KEY DEFAULT gen_random_uuid()::text,
  organization_id INTEGER NOT NULL REFERENCES traffic.organizations(id) ON DELETE CASCADE,
  type TEXT DEFAULT 'card',
  card_brand TEXT,
  card_last4 TEXT,
  card_exp_month INTEGER,
  card_exp_year INTEGER,
  is_default BOOLEAN DEFAULT false,
  stripe_payment_method_id TEXT,
  created_at TIMESTAMPTZ DEFAULT now()
);

CREATE TABLE IF NOT EXISTS traffic.invoices (
  id TEXT PRIMARY KEY DEFAULT gen_random_uuid()::text,
  organization_id INTEGER NOT NULL REFERENCES traffic.organizations(id) ON DELETE CASCADE,
  number TEXT,
  status TEXT DEFAULT 'draft',
  amount_due BIGINT DEFAULT 0,
  subtotal BIGINT DEFAULT 0,
  period_start TIMESTAMPTZ,
  period_end TIMESTAMPTZ,
  invoice_pdf TEXT,
  stripe_invoice_id TEXT,
  subscription_id TEXT,
  created_at TIMESTAMPTZ DEFAULT now()
);

CREATE TABLE IF NOT EXISTS traffic.tax_ids (
  id SERIAL PRIMARY KEY,
  organization_id INTEGER NOT NULL REFERENCES traffic.organizations(id) ON DELETE CASCADE,
  type TEXT NOT NULL,
  value TEXT NOT NULL,
  created_at TIMESTAMPTZ DEFAULT now()
);

CREATE TABLE IF NOT EXISTS traffic.credits (
  id SERIAL PRIMARY KEY,
  organization_id INTEGER NOT NULL REFERENCES traffic.organizations(id) ON DELETE CASCADE UNIQUE,
  balance BIGINT DEFAULT 0,
  updated_at TIMESTAMPTZ DEFAULT now()
);

CREATE TABLE IF NOT EXISTS traffic.credit_transactions (
  id SERIAL PRIMARY KEY,
  organization_id INTEGER NOT NULL REFERENCES traffic.organizations(id) ON DELETE CASCADE,
  amount BIGINT NOT NULL,
  type TEXT NOT NULL,
  description TEXT,
  created_at TIMESTAMPTZ DEFAULT now()
);

CREATE TABLE IF NOT EXISTS traffic.project_addons (
  id SERIAL PRIMARY KEY,
  project_ref TEXT NOT NULL,
  addon_type TEXT NOT NULL,
  addon_variant TEXT NOT NULL,
  created_at TIMESTAMPTZ DEFAULT now(),
  updated_at TIMESTAMPTZ DEFAULT now(),
  UNIQUE(project_ref, addon_type)
);

CREATE TABLE IF NOT EXISTS traffic.upgrade_requests (
  id SERIAL PRIMARY KEY,
  organization_id INTEGER NOT NULL REFERENCES traffic.organizations(id) ON DELETE CASCADE,
  requested_plan TEXT NOT NULL,
  note TEXT,
  status TEXT DEFAULT 'pending',
  created_at TIMESTAMPTZ DEFAULT now()
);

-- Indexes based on API access patterns

CREATE INDEX idx_products_active ON traffic.products (active);

CREATE INDEX idx_prices_product_id ON traffic.prices (product_id);
CREATE INDEX idx_prices_active ON traffic.prices (active);

CREATE INDEX idx_customers_stripe_customer_id ON traffic.customers (stripe_customer_id)
  WHERE stripe_customer_id IS NOT NULL;

CREATE INDEX idx_payment_methods_org_id ON traffic.payment_methods (organization_id);
CREATE INDEX idx_payment_methods_org_default ON traffic.payment_methods (organization_id, is_default)
  WHERE is_default = true;

CREATE INDEX idx_invoices_org_created ON traffic.invoices (organization_id, created_at DESC);
CREATE INDEX idx_invoices_status ON traffic.invoices (status)
  WHERE status IN ('open', 'past_due', 'uncollectible');
CREATE INDEX idx_invoices_stripe_id ON traffic.invoices (stripe_invoice_id)
  WHERE stripe_invoice_id IS NOT NULL;

CREATE INDEX idx_tax_ids_org_id ON traffic.tax_ids (organization_id);

CREATE INDEX idx_credit_transactions_org_created ON traffic.credit_transactions (organization_id, created_at DESC);

CREATE INDEX idx_project_addons_ref ON traffic.project_addons (project_ref);

CREATE INDEX idx_upgrade_requests_org_id ON traffic.upgrade_requests (organization_id);

-- Grant permissions to traffic_api role
GRANT SELECT, INSERT, UPDATE, DELETE ON traffic.products TO traffic_api;
GRANT SELECT, INSERT, UPDATE, DELETE ON traffic.prices TO traffic_api;
GRANT SELECT, INSERT, UPDATE, DELETE ON traffic.subscriptions TO traffic_api;
GRANT SELECT, INSERT, UPDATE, DELETE ON traffic.customers TO traffic_api;
GRANT SELECT, INSERT, UPDATE, DELETE ON traffic.payment_methods TO traffic_api;
GRANT SELECT, INSERT, UPDATE, DELETE ON traffic.invoices TO traffic_api;
GRANT SELECT, INSERT, UPDATE, DELETE ON traffic.tax_ids TO traffic_api;
GRANT SELECT, INSERT, UPDATE, DELETE ON traffic.credits TO traffic_api;
GRANT SELECT, INSERT, UPDATE, DELETE ON traffic.credit_transactions TO traffic_api;
GRANT SELECT, INSERT, UPDATE, DELETE ON traffic.project_addons TO traffic_api;
GRANT SELECT, INSERT, UPDATE, DELETE ON traffic.upgrade_requests TO traffic_api;

GRANT USAGE ON SEQUENCE traffic.customers_id_seq TO traffic_api;
GRANT USAGE ON SEQUENCE traffic.tax_ids_id_seq TO traffic_api;
GRANT USAGE ON SEQUENCE traffic.credits_id_seq TO traffic_api;
GRANT USAGE ON SEQUENCE traffic.credit_transactions_id_seq TO traffic_api;
GRANT USAGE ON SEQUENCE traffic.project_addons_id_seq TO traffic_api;
GRANT USAGE ON SEQUENCE traffic.upgrade_requests_id_seq TO traffic_api;
