import type { Pool } from 'https://deno.land/x/postgres@v0.17.0/mod.ts'

import { corsHeaders } from '../index.ts'
import {
  applyProjectAddon,
  countInvoices,
  createUpgradeRequest,
  deletePaymentMethod,
  deleteTaxId,
  getCustomer,
  getInvoice,
  getPlans,
  getProjectAddons,
  getSubscription,
  listInvoices,
  listPaymentMethods,
  listTaxIds,
  previewSubscriptionChange,
  redeemCredits,
  removeProjectAddon,
  setDefaultPaymentMethod,
  topUpCredits,
  updateSubscription,
  upsertCustomer,
  upsertTaxId,
} from '../services/billing.service.ts'
import { getProjectByRef } from '../services/project.service.ts'
import { createSetupIntent, isStripeEnabled } from '../services/stripe.service.ts'

export async function handleBilling(
  req: Request,
  subPath: string,
  method: string,
  pool: Pool,
  orgId: number,
  _profileId: number,
  _gotrueId: string,
  _email: string
): Promise<Response> {
  // ── Subscription ─────────────────────────────────────

  if (subPath === '/billing/subscription' && method === 'GET') {
    const sub = await getSubscription(pool, orgId)
    return Response.json(sub, { headers: corsHeaders })
  }

  if (subPath === '/billing/subscription' && method === 'PUT') {
    const body = await req.json()
    const planId = body.plan_id ?? body.tier?.replace('tier_', '') ?? 'free'
    const planName = body.plan_name ?? planId.charAt(0).toUpperCase() + planId.slice(1)
    const tier = body.tier ?? `tier_${planId}`
    const sub = await updateSubscription(pool, orgId, planId, planName, tier)
    return Response.json(sub, { headers: corsHeaders })
  }

  if (subPath === '/billing/subscription/preview' && method === 'POST') {
    const body = await req.json()
    const preview = await previewSubscriptionChange(pool, orgId, body.target_plan ?? 'free')
    return Response.json(preview, { headers: corsHeaders })
  }

  if (subPath === '/billing/subscription/confirm' && method === 'POST') {
    const sub = await getSubscription(pool, orgId)
    return Response.json(sub, { headers: corsHeaders })
  }

  // ── Plans ────────────────────────────────────────────

  if (subPath === '/billing/plans' && method === 'GET') {
    const plans = getPlans()
    return Response.json({ plans }, { headers: corsHeaders })
  }

  // ── Invoices ─────────────────────────────────────────

  if (subPath === '/billing/invoices' && method === 'HEAD') {
    const count = await countInvoices(pool, orgId)
    return new Response(null, {
      headers: { ...corsHeaders, 'X-Total-Count': String(count) },
    })
  }

  if (subPath === '/billing/invoices' && method === 'GET') {
    const url = new URL(req.url)
    const offset = parseInt(url.searchParams.get('offset') ?? '0', 10)
    const limit = parseInt(url.searchParams.get('limit') ?? '10', 10)
    const invoices = await listInvoices(pool, orgId, offset, limit)
    return Response.json(invoices, { headers: corsHeaders })
  }

  if (subPath === '/billing/invoices/upcoming' && method === 'GET') {
    return Response.json(
      {
        amount_due: 0,
        subtotal: 0,
        lines: [],
      },
      { headers: corsHeaders }
    )
  }

  const invoiceMatch = subPath.match(/^\/billing\/invoices\/([^/]+)(\/.*)?$/)
  if (invoiceMatch && method === 'GET') {
    const invoiceId = invoiceMatch[1]
    const invoiceSub = invoiceMatch[2] || ''

    if (invoiceSub === '/receipt') {
      const invoice = await getInvoice(pool, orgId, invoiceId)
      if (!invoice) {
        return Response.json(
          { message: 'Invoice not found' },
          { status: 404, headers: corsHeaders }
        )
      }
      return Response.json({ url: invoice.invoice_pdf ?? '' }, { headers: corsHeaders })
    }

    if (invoiceSub === '/payment-link') {
      return Response.json({ url: '' }, { headers: corsHeaders })
    }

    const invoice = await getInvoice(pool, orgId, invoiceId)
    if (!invoice) {
      return Response.json({ message: 'Invoice not found' }, { status: 404, headers: corsHeaders })
    }
    return Response.json(invoice, { headers: corsHeaders })
  }

  // ── Customer ─────────────────────────────────────────

  if (subPath === '/customer' && method === 'GET') {
    const customer = await getCustomer(pool, orgId)
    return Response.json(customer, { headers: corsHeaders })
  }

  if (subPath === '/customer' && method === 'PUT') {
    const body = await req.json()
    const customer = await upsertCustomer(pool, orgId, body)
    return Response.json(customer, { headers: corsHeaders })
  }

  // ── Payment Methods ──────────────────────────────────

  if (subPath === '/payments' && method === 'GET') {
    const methods = await listPaymentMethods(pool, orgId)
    return Response.json(methods, { headers: corsHeaders })
  }

  if (subPath === '/payments/setup-intent' && method === 'POST') {
    if (!isStripeEnabled()) {
      return Response.json(
        { id: 'seti_local', client_secret: 'local_mode' },
        { headers: corsHeaders }
      )
    }
    const body = await req.json()
    const intent = await createSetupIntent(body.customer_id ?? '')
    return Response.json(intent ?? { id: '', client_secret: '' }, { headers: corsHeaders })
  }

  if (subPath === '/payments' && method === 'DELETE') {
    const body = await req.json()
    const deleted = await deletePaymentMethod(pool, orgId, body.id ?? body.payment_method_id)
    return Response.json({ success: deleted }, { headers: corsHeaders })
  }

  if (subPath === '/payments/default' && method === 'PUT') {
    const body = await req.json()
    const success = await setDefaultPaymentMethod(pool, orgId, body.id ?? body.payment_method_id)
    return Response.json({ success }, { headers: corsHeaders })
  }

  // ── Tax IDs ──────────────────────────────────────────
  //
  // GET / PUT both return the OpenAPI `TaxIdResponse` envelope:
  // `{ tax_id: { country, type, value } | null }` so Studio's
  // `useOrganizationTaxIdQuery` can read `.tax_id` and fall back to null.

  if (subPath === '/tax-ids' && method === 'GET') {
    const taxId = await listTaxIds(pool, orgId)
    return Response.json(taxId, { headers: corsHeaders })
  }

  if (subPath === '/tax-ids' && method === 'PUT') {
    const body = await req.json()
    const taxId = await upsertTaxId(pool, orgId, body.type, body.value, body.country ?? null)
    return Response.json(taxId, { headers: corsHeaders })
  }

  if (subPath === '/tax-ids' && method === 'DELETE') {
    const body = await req.json()
    const deleted = await deleteTaxId(pool, orgId, body.id)
    return Response.json({ success: deleted }, { headers: corsHeaders })
  }

  // ── Credits ──────────────────────────────────────────

  if (subPath === '/billing/credits/top-up' && method === 'POST') {
    const body = await req.json()
    const result = await topUpCredits(pool, orgId, body.amount ?? 0)
    return Response.json(result, { headers: corsHeaders })
  }

  if (subPath === '/billing/credits/redeem' && method === 'POST') {
    const body = await req.json()
    const result = await redeemCredits(pool, orgId, body.amount ?? 0, body.code ?? '')
    return Response.json(result, { headers: corsHeaders })
  }

  // ── Upgrade Request ──────────────────────────────────

  if (subPath === '/billing/upgrade-request' && method === 'POST') {
    const body = await req.json()
    const result = await createUpgradeRequest(pool, orgId, body.plan ?? '', body.note)
    return Response.json(result, { status: 201, headers: corsHeaders })
  }

  return Response.json({ message: 'Not Found' }, { status: 404, headers: corsHeaders })
}

// ── Stripe top-level routes ────────────────────────────

// `handleStripe` is mounted at `/api/platform/stripe`; it doesn't need a
// database pool because every path delegates to Stripe or returns a stub.
// The old signature passed `pool` but never used it, masking a real wiring
// bug (M8). Callers should pass `createSetupIntent`-compatible bodies
// (`{ customer_id: string }`) so we can proxy them through when Stripe is
// configured (H3).
export async function handleStripe(
  req: Request,
  subPath: string,
  method: string
): Promise<Response> {
  if (subPath === '/invoices/overdue' && method === 'GET') {
    return Response.json([], { headers: corsHeaders })
  }

  if (subPath === '/setup-intent' && method === 'POST') {
    if (!isStripeEnabled()) {
      return Response.json(
        { id: 'seti_local', client_secret: 'local_mode' },
        { headers: corsHeaders }
      )
    }
    // H3: previously returned `{ id: '', client_secret: '' }` — Studio cannot
    // attach a payment method with an empty client secret. Reuse the shared
    // `createSetupIntent` helper so enabled Stripe deploys work the same way
    // `/platform/organizations/{slug}/payments/setup-intent` already does.
    let customerId = ''
    try {
      const body = (await req.json()) as { customer_id?: string }
      customerId = body?.customer_id ?? ''
    } catch {
      // empty body → createSetupIntent will error out below if Stripe requires one.
    }
    const intent = await createSetupIntent(customerId)
    return Response.json(intent ?? { id: '', client_secret: '' }, { headers: corsHeaders })
  }

  return Response.json({ message: 'Not Found' }, { status: 404, headers: corsHeaders })
}

// ── Project billing routes ─────────────────────────────

// Every `/api/platform/projects/{ref}/billing/*` request must first prove the
// caller is a member of the project's org. Without this gate any authenticated
// user with a valid JWT could read and mutate addons/subscription data on an
// arbitrary project. The 404 (instead of 403) matches the rest of the codebase
// so we don't leak project existence to non-members.
export async function handleProjectBilling(
  req: Request,
  subPath: string,
  method: string,
  pool: Pool,
  ref: string,
  profileId: number
): Promise<Response> {
  const project = await getProjectByRef(pool, ref, profileId)
  if (!project) {
    return Response.json({ message: 'Project not found' }, { status: 404, headers: corsHeaders })
  }

  if (subPath === '/billing/addons' && method === 'GET') {
    const addons = await getProjectAddons(pool, ref)
    return Response.json(addons, { headers: corsHeaders })
  }

  if (subPath === '/billing/addons' && method === 'POST') {
    const body = await req.json()
    const addons = await applyProjectAddon(
      pool,
      ref,
      body.addon_type ?? body.type,
      body.addon_variant ?? body.variant
    )
    return Response.json(addons, { headers: corsHeaders })
  }

  const addonDeleteMatch = subPath.match(/^\/billing\/addons\/(.+)$/)
  if (addonDeleteMatch && method === 'DELETE') {
    const variant = addonDeleteMatch[1]
    const removed = await removeProjectAddon(pool, ref, variant)
    return Response.json({ success: removed }, { headers: corsHeaders })
  }

  if (subPath === '/billing/subscription' && method === 'GET') {
    return Response.json(
      {
        billing_cycle_anchor: 0,
        current_period_end: 0,
        current_period_start: 0,
        plan: { id: 'free', name: 'Free' },
        addons: [],
        usage_fees: [],
        nano_enabled: true,
      },
      { headers: corsHeaders }
    )
  }

  return Response.json({ message: 'Not Found' }, { status: 404, headers: corsHeaders })
}

// ── Confirm subscription on org creation ───────────────

export async function handleConfirmSubscription(_req: Request, _method: string): Promise<Response> {
  return Response.json({ message: 'Subscription confirmed' }, { headers: corsHeaders })
}
