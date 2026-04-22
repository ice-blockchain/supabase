import type { Pool } from "https://deno.land/x/postgres@v0.17.0/mod.ts";
import type {
  GetSubscriptionResponse,
  InvoiceResponse,
  CustomerResponse,
  PaymentMethodResponse,
  TaxIdResponse,
  ProjectAddonsResponse,
  SelectedAddon,
} from "../types/billing.ts";

// ── Row types ────────────────────────────────────────────

interface SubscriptionRow {
  id: string;
  organization_id: number;
  status: string | null;
  tier: string;
  plan_id: string;
  plan_name: string;
  billing_cycle_anchor: number;
  usage_billing_enabled: boolean;
  nano_enabled: boolean;
  current_period_start: string | null;
  current_period_end: string | null;
  stripe_subscription_id: string | null;
  stripe_customer_id: string | null;
}

interface CustomerRow {
  id: number;
  organization_id: number;
  stripe_customer_id: string | null;
  billing_name: string | null;
  city: string | null;
  country: string | null;
  line1: string | null;
  line2: string | null;
  postal_code: string | null;
  state: string | null;
}

interface PaymentMethodRow {
  id: string;
  type: string;
  card_brand: string | null;
  card_last4: string | null;
  card_exp_month: number | null;
  card_exp_year: number | null;
  is_default: boolean;
  stripe_payment_method_id: string | null;
}

interface InvoiceRow {
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

interface TaxIdRow {
  id: number;
  type: string;
  value: string;
  created_at: string;
}

interface CreditRow {
  balance: number;
}

interface ProjectAddonRow {
  id: number;
  project_ref: string;
  addon_type: string;
  addon_variant: string;
}

// ── Row mappers ──────────────────────────────────────────

function subscriptionToResponse(row: SubscriptionRow): GetSubscriptionResponse {
  const periodStart = row.current_period_start
    ? Math.floor(new Date(row.current_period_start).getTime() / 1000)
    : 0;
  const periodEnd = row.current_period_end
    ? Math.floor(new Date(row.current_period_end).getTime() / 1000)
    : 0;

  return {
    addons: [],
    billing_cycle_anchor: Number(row.billing_cycle_anchor) || 0,
    billing_via_partner: false,
    current_period_end: periodEnd,
    current_period_start: periodStart,
    customer_balance: 0,
    next_invoice_at: periodEnd,
    payment_method_type: "none",
    plan: {
      id: row.plan_id as GetSubscriptionResponse["plan"]["id"],
      name: row.plan_name,
    },
    project_addons: [],
    scheduled_plan_change: null,
    usage_billing_enabled: row.usage_billing_enabled ?? false,
  };
}

function invoiceRowToResponse(row: InvoiceRow): InvoiceResponse {
  return {
    id: row.id,
    number: row.number,
    status: row.status,
    amount_due: Number(row.amount_due),
    subtotal: Number(row.subtotal),
    period_start: row.period_start,
    period_end: row.period_end,
    invoice_pdf: row.invoice_pdf,
    stripe_invoice_id: row.stripe_invoice_id,
    subscription_id: row.subscription_id,
    created_at: row.created_at,
  };
}

function customerRowToResponse(row: CustomerRow): CustomerResponse {
  return {
    billing_name: row.billing_name,
    city: row.city,
    country: row.country,
    line1: row.line1,
    line2: row.line2,
    postal_code: row.postal_code,
    state: row.state,
  };
}

function paymentMethodRowToResponse(row: PaymentMethodRow): PaymentMethodResponse {
  return {
    id: row.id,
    type: row.type,
    card_brand: row.card_brand,
    card_last4: row.card_last4,
    card_exp_month: row.card_exp_month,
    card_exp_year: row.card_exp_year,
    is_default: row.is_default,
  };
}

function taxIdRowToResponse(row: TaxIdRow): TaxIdResponse {
  return {
    id: row.id,
    type: row.type,
    value: row.value,
    created_at: row.created_at,
  };
}

// ── Subscription ─────────────────────────────────────────

export async function getSubscription(
  pool: Pool,
  orgId: number,
): Promise<GetSubscriptionResponse> {
  const connection = await pool.connect();
  try {
    const result = await connection.queryObject<SubscriptionRow>`
      SELECT * FROM traffic.subscriptions WHERE organization_id = ${orgId}
    `;
    if (result.rows.length === 0) {
      return subscriptionToResponse({
        id: "",
        organization_id: orgId,
        status: "active",
        tier: "tier_free",
        plan_id: "free",
        plan_name: "Free",
        billing_cycle_anchor: 0,
        usage_billing_enabled: false,
        nano_enabled: true,
        current_period_start: null,
        current_period_end: null,
        stripe_subscription_id: null,
        stripe_customer_id: null,
      });
    }
    return subscriptionToResponse(result.rows[0]);
  } finally {
    connection.release();
  }
}

export async function updateSubscription(
  pool: Pool,
  orgId: number,
  planId: string,
  planName: string,
  tier: string,
): Promise<GetSubscriptionResponse> {
  const connection = await pool.connect();
  try {
    const tx = connection.createTransaction("update_subscription");
    await tx.begin();

    const existing = await tx.queryObject<{ id: string }>`
      SELECT id FROM traffic.subscriptions WHERE organization_id = ${orgId}
    `;

    let result;
    if (existing.rows.length === 0) {
      result = await tx.queryObject<SubscriptionRow>`
        INSERT INTO traffic.subscriptions (organization_id, status, plan_id, plan_name, tier)
        VALUES (${orgId}, 'active', ${planId}, ${planName}, ${tier})
        RETURNING *
      `;
    } else {
      result = await tx.queryObject<SubscriptionRow>`
        UPDATE traffic.subscriptions
        SET plan_id = ${planId}, plan_name = ${planName}, tier = ${tier}
        WHERE organization_id = ${orgId}
        RETURNING *
      `;
    }

    await tx.commit();
    return subscriptionToResponse(result.rows[0]);
  } finally {
    connection.release();
  }
}

export async function previewSubscriptionChange(
  pool: Pool,
  orgId: number,
  _targetPlan: string,
): Promise<{ amount_due: number; billing_preview: Record<string, unknown> }> {
  const connection = await pool.connect();
  try {
    const sub = await connection.queryObject<SubscriptionRow>`
      SELECT * FROM traffic.subscriptions WHERE organization_id = ${orgId}
    `;
    const _current = sub.rows[0] ?? null;
    return { amount_due: 0, billing_preview: {} };
  } finally {
    connection.release();
  }
}

// ── Plans ────────────────────────────────────────────────

export function getPlans(): Record<string, unknown>[] {
  return [
    { id: "free", name: "Free", price: 0, description: "Perfect for hobby projects", features: [] },
    { id: "pro", name: "Pro", price: 2500, description: "For production applications", features: [] },
    { id: "team", name: "Team", price: 59900, description: "For scaling teams", features: [] },
    { id: "enterprise", name: "Enterprise", price: 0, description: "Custom pricing", features: [] },
  ];
}

// ── Invoices ─────────────────────────────────────────────

export async function listInvoices(
  pool: Pool,
  orgId: number,
  offset = 0,
  limit = 10,
): Promise<InvoiceResponse[]> {
  const connection = await pool.connect();
  try {
    const result = await connection.queryObject<InvoiceRow>`
      SELECT * FROM traffic.invoices
      WHERE organization_id = ${orgId}
      ORDER BY created_at DESC
      OFFSET ${offset} LIMIT ${limit}
    `;
    return result.rows.map(invoiceRowToResponse);
  } finally {
    connection.release();
  }
}

export async function countInvoices(
  pool: Pool,
  orgId: number,
): Promise<number> {
  const connection = await pool.connect();
  try {
    const result = await connection.queryObject<{ count: number }>`
      SELECT COUNT(*)::int AS count FROM traffic.invoices WHERE organization_id = ${orgId}
    `;
    return result.rows[0].count;
  } finally {
    connection.release();
  }
}

export async function getInvoice(
  pool: Pool,
  orgId: number,
  invoiceId: string,
): Promise<InvoiceResponse | null> {
  const connection = await pool.connect();
  try {
    const result = await connection.queryObject<InvoiceRow>`
      SELECT * FROM traffic.invoices
      WHERE id = ${invoiceId} AND organization_id = ${orgId}
    `;
    if (result.rows.length === 0) return null;
    return invoiceRowToResponse(result.rows[0]);
  } finally {
    connection.release();
  }
}

export async function countOverdueInvoices(
  pool: Pool,
): Promise<number> {
  const connection = await pool.connect();
  try {
    const result = await connection.queryObject<{ count: number }>`
      SELECT COUNT(*)::int AS count FROM traffic.invoices
      WHERE status IN ('open', 'past_due', 'uncollectible')
    `;
    return result.rows[0].count;
  } finally {
    connection.release();
  }
}

// ── Customer ─────────────────────────────────────────────

export async function getCustomer(
  pool: Pool,
  orgId: number,
): Promise<CustomerResponse> {
  const connection = await pool.connect();
  try {
    const result = await connection.queryObject<CustomerRow>`
      SELECT * FROM traffic.customers WHERE organization_id = ${orgId}
    `;
    if (result.rows.length === 0) {
      return { billing_name: null, city: null, country: null, line1: null, line2: null, postal_code: null, state: null };
    }
    return customerRowToResponse(result.rows[0]);
  } finally {
    connection.release();
  }
}

export async function upsertCustomer(
  pool: Pool,
  orgId: number,
  data: Partial<CustomerResponse>,
): Promise<CustomerResponse> {
  const connection = await pool.connect();
  try {
    const result = await connection.queryObject<CustomerRow>`
      INSERT INTO traffic.customers (organization_id, billing_name, city, country, line1, line2, postal_code, state)
      VALUES (
        ${orgId},
        ${data.billing_name ?? null},
        ${data.city ?? null},
        ${data.country ?? null},
        ${data.line1 ?? null},
        ${data.line2 ?? null},
        ${data.postal_code ?? null},
        ${data.state ?? null}
      )
      ON CONFLICT (organization_id) DO UPDATE SET
        billing_name = COALESCE(EXCLUDED.billing_name, traffic.customers.billing_name),
        city = COALESCE(EXCLUDED.city, traffic.customers.city),
        country = COALESCE(EXCLUDED.country, traffic.customers.country),
        line1 = COALESCE(EXCLUDED.line1, traffic.customers.line1),
        line2 = COALESCE(EXCLUDED.line2, traffic.customers.line2),
        postal_code = COALESCE(EXCLUDED.postal_code, traffic.customers.postal_code),
        state = COALESCE(EXCLUDED.state, traffic.customers.state),
        updated_at = now()
      RETURNING *
    `;
    return customerRowToResponse(result.rows[0]);
  } finally {
    connection.release();
  }
}

// ── Payment Methods ──────────────────────────────────────

export async function listPaymentMethods(
  pool: Pool,
  orgId: number,
): Promise<PaymentMethodResponse[]> {
  const connection = await pool.connect();
  try {
    const result = await connection.queryObject<PaymentMethodRow>`
      SELECT * FROM traffic.payment_methods
      WHERE organization_id = ${orgId}
      ORDER BY created_at DESC
    `;
    return result.rows.map(paymentMethodRowToResponse);
  } finally {
    connection.release();
  }
}

export async function deletePaymentMethod(
  pool: Pool,
  orgId: number,
  paymentMethodId: string,
): Promise<boolean> {
  const connection = await pool.connect();
  try {
    const result = await connection.queryObject`
      DELETE FROM traffic.payment_methods
      WHERE id = ${paymentMethodId} AND organization_id = ${orgId}
    `;
    return (result.rowCount ?? 0) > 0;
  } finally {
    connection.release();
  }
}

export async function setDefaultPaymentMethod(
  pool: Pool,
  orgId: number,
  paymentMethodId: string,
): Promise<boolean> {
  const connection = await pool.connect();
  try {
    const tx = connection.createTransaction("set_default_pm");
    await tx.begin();

    await tx.queryObject`
      UPDATE traffic.payment_methods SET is_default = false
      WHERE organization_id = ${orgId}
    `;
    const result = await tx.queryObject`
      UPDATE traffic.payment_methods SET is_default = true
      WHERE id = ${paymentMethodId} AND organization_id = ${orgId}
    `;

    await tx.commit();
    return (result.rowCount ?? 0) > 0;
  } finally {
    connection.release();
  }
}

// ── Tax IDs ──────────────────────────────────────────────

export async function listTaxIds(
  pool: Pool,
  orgId: number,
): Promise<TaxIdResponse[]> {
  const connection = await pool.connect();
  try {
    const result = await connection.queryObject<TaxIdRow>`
      SELECT * FROM traffic.tax_ids
      WHERE organization_id = ${orgId}
      ORDER BY created_at DESC
    `;
    return result.rows.map(taxIdRowToResponse);
  } finally {
    connection.release();
  }
}

export async function upsertTaxId(
  pool: Pool,
  orgId: number,
  type: string,
  value: string,
): Promise<TaxIdResponse> {
  const connection = await pool.connect();
  try {
    const result = await connection.queryObject<TaxIdRow>`
      INSERT INTO traffic.tax_ids (organization_id, type, value)
      VALUES (${orgId}, ${type}, ${value})
      RETURNING *
    `;
    return taxIdRowToResponse(result.rows[0]);
  } finally {
    connection.release();
  }
}

export async function deleteTaxId(
  pool: Pool,
  orgId: number,
  taxIdId: number,
): Promise<boolean> {
  const connection = await pool.connect();
  try {
    const result = await connection.queryObject`
      DELETE FROM traffic.tax_ids WHERE id = ${taxIdId} AND organization_id = ${orgId}
    `;
    return (result.rowCount ?? 0) > 0;
  } finally {
    connection.release();
  }
}

// ── Credits ──────────────────────────────────────────────

export async function getCreditBalance(
  pool: Pool,
  orgId: number,
): Promise<number> {
  const connection = await pool.connect();
  try {
    const result = await connection.queryObject<CreditRow>`
      SELECT balance FROM traffic.credits WHERE organization_id = ${orgId}
    `;
    return result.rows.length > 0 ? Number(result.rows[0].balance) : 0;
  } finally {
    connection.release();
  }
}

export async function redeemCredits(
  pool: Pool,
  orgId: number,
  amount: number,
  description: string,
): Promise<{ balance: number }> {
  const connection = await pool.connect();
  try {
    const tx = connection.createTransaction("redeem_credits");
    await tx.begin();

    await tx.queryObject`
      INSERT INTO traffic.credits (organization_id, balance)
      VALUES (${orgId}, ${amount})
      ON CONFLICT (organization_id) DO UPDATE SET
        balance = traffic.credits.balance + ${amount},
        updated_at = now()
    `;

    await tx.queryObject`
      INSERT INTO traffic.credit_transactions (organization_id, amount, type, description)
      VALUES (${orgId}, ${amount}, 'redeem', ${description})
    `;

    const result = await tx.queryObject<CreditRow>`
      SELECT balance FROM traffic.credits WHERE organization_id = ${orgId}
    `;

    await tx.commit();
    return { balance: Number(result.rows[0].balance) };
  } finally {
    connection.release();
  }
}

export async function topUpCredits(
  pool: Pool,
  orgId: number,
  amount: number,
): Promise<{ balance: number }> {
  const connection = await pool.connect();
  try {
    const tx = connection.createTransaction("topup_credits");
    await tx.begin();

    await tx.queryObject`
      INSERT INTO traffic.credits (organization_id, balance)
      VALUES (${orgId}, ${amount})
      ON CONFLICT (organization_id) DO UPDATE SET
        balance = traffic.credits.balance + ${amount},
        updated_at = now()
    `;

    await tx.queryObject`
      INSERT INTO traffic.credit_transactions (organization_id, amount, type, description)
      VALUES (${orgId}, ${amount}, 'top_up', ${"Top-up of " + amount})
    `;

    const result = await tx.queryObject<CreditRow>`
      SELECT balance FROM traffic.credits WHERE organization_id = ${orgId}
    `;

    await tx.commit();
    return { balance: Number(result.rows[0].balance) };
  } finally {
    connection.release();
  }
}

// ── Upgrade Requests ─────────────────────────────────────

export async function createUpgradeRequest(
  pool: Pool,
  orgId: number,
  requestedPlan: string,
  note?: string,
): Promise<{ id: number; status: string }> {
  const connection = await pool.connect();
  try {
    const result = await connection.queryObject<{ id: number; status: string }>`
      INSERT INTO traffic.upgrade_requests (organization_id, requested_plan, note)
      VALUES (${orgId}, ${requestedPlan}, ${note ?? null})
      RETURNING id, status
    `;
    return result.rows[0];
  } finally {
    connection.release();
  }
}

// ── Project Addons ───────────────────────────────────────

export async function getProjectAddons(
  pool: Pool,
  ref: string,
): Promise<ProjectAddonsResponse> {
  const connection = await pool.connect();
  try {
    const result = await connection.queryObject<ProjectAddonRow>`
      SELECT * FROM traffic.project_addons WHERE project_ref = ${ref}
    `;
    const selectedAddons: SelectedAddon[] = result.rows.map((row) => ({
      type: row.addon_type,
      variant: {
        identifier: row.addon_variant,
        name: row.addon_variant,
        price: 0,
        price_description: "",
        price_interval: "monthly" as const,
        price_type: "fixed" as const,
      },
    }));
    return {
      available_addons: [],
      ref,
      selected_addons: selectedAddons,
    };
  } finally {
    connection.release();
  }
}

export async function applyProjectAddon(
  pool: Pool,
  ref: string,
  addonType: string,
  addonVariant: string,
): Promise<ProjectAddonsResponse> {
  const connection = await pool.connect();
  try {
    await connection.queryObject`
      INSERT INTO traffic.project_addons (project_ref, addon_type, addon_variant)
      VALUES (${ref}, ${addonType}, ${addonVariant})
      ON CONFLICT (project_ref, addon_type) DO UPDATE SET
        addon_variant = ${addonVariant},
        updated_at = now()
    `;
  } finally {
    connection.release();
  }
  return getProjectAddons(pool, ref);
}

export async function removeProjectAddon(
  pool: Pool,
  ref: string,
  addonVariant: string,
): Promise<boolean> {
  const connection = await pool.connect();
  try {
    const result = await connection.queryObject`
      DELETE FROM traffic.project_addons
      WHERE project_ref = ${ref} AND addon_variant = ${addonVariant}
    `;
    return (result.rowCount ?? 0) > 0;
  } finally {
    connection.release();
  }
}
