export interface SubscriptionPlan {
  id: "free" | "pro" | "team" | "enterprise" | "platform";
  name: string;
}

export interface SubscriptionAddon {
  name: string;
  price: number;
  supabase_prod_id: string;
}

export interface ProjectAddonVariant {
  identifier: string;
  meta?: unknown;
  name: string;
  price: number;
  price_description: string;
  price_interval: "monthly" | "hourly";
  price_type: "fixed" | "usage";
}

export interface ProjectAddonEntry {
  type: string;
  variant: ProjectAddonVariant;
}

export interface ProjectAddonGroup {
  addons: ProjectAddonEntry[];
  name: string;
  ref: string;
}

export interface ScheduledPlanChange {
  at: string;
  target_plan: string;
  usage_billing_enabled: boolean;
}

export interface GetSubscriptionResponse {
  addons: SubscriptionAddon[];
  billing_cycle_anchor: number;
  billing_partner?: string | null;
  billing_via_partner: boolean;
  current_period_end: number;
  current_period_start: number;
  customer_balance?: number;
  next_invoice_at: number;
  payment_method_type: string;
  plan: SubscriptionPlan;
  project_addons: ProjectAddonGroup[];
  scheduled_plan_change: ScheduledPlanChange | null;
  usage_billing_enabled: boolean;
}

export interface AvailableAddonVariant {
  identifier: string;
  meta?: unknown;
  name: string;
  price: number;
  price_description: string;
  price_interval: "monthly" | "hourly";
  price_type: "fixed" | "usage";
}

export interface AvailableAddon {
  name: string;
  type: string;
  variants: AvailableAddonVariant[];
}

export interface SelectedAddon {
  type: string;
  variant: AvailableAddonVariant;
}

export interface ProjectAddonsResponse {
  available_addons: AvailableAddon[];
  ref: string;
  selected_addons: SelectedAddon[];
}

export interface InvoiceResponse {
  id: string;
  number: string | null;
  status: string;
  amount_due: number;
  subtotal: number;
  period_start: string | null;
  period_end: string | null;
  invoice_pdf: string | null;
  stripe_invoice_id: string | null;
  subscription_id: string | null;
  created_at: string;
}

export interface CustomerResponse {
  billing_name: string | null;
  city: string | null;
  country: string | null;
  line1: string | null;
  line2: string | null;
  postal_code: string | null;
  state: string | null;
}

export interface PaymentMethodResponse {
  id: string;
  type: string;
  card_brand: string | null;
  card_last4: string | null;
  card_exp_month: number | null;
  card_exp_year: number | null;
  is_default: boolean;
}

export interface TaxIdResponse {
  id: number;
  type: string;
  value: string;
  created_at: string;
}

export interface CreditBalance {
  balance: number;
}

export interface UpgradeRequestResponse {
  id: number;
  requested_plan: string;
  note: string | null;
  status: string;
  created_at: string;
}

export interface PlanOption {
  id: string;
  name: string;
  price: number;
  description: string;
  features: string[];
}
