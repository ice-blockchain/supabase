const STRIPE_API_KEY = Deno.env.get("STRIPE_API_KEY");

let stripe: StripeClient | null = null;

interface StripeClient {
  customers: {
    create: (params: Record<string, unknown>) => Promise<{ id: string }>;
    retrieve: (id: string) => Promise<Record<string, unknown>>;
  };
  subscriptions: {
    create: (params: Record<string, unknown>) => Promise<Record<string, unknown>>;
    retrieve: (id: string) => Promise<Record<string, unknown>>;
    update: (id: string, params: Record<string, unknown>) => Promise<Record<string, unknown>>;
  };
  setupIntents: {
    create: (params: Record<string, unknown>) => Promise<{ id: string; client_secret: string }>;
  };
  paymentMethods: {
    detach: (id: string) => Promise<Record<string, unknown>>;
  };
  invoices: {
    list: (params: Record<string, unknown>) => Promise<{ data: Record<string, unknown>[] }>;
    retrieveUpcoming: (params: Record<string, unknown>) => Promise<Record<string, unknown>>;
  };
}

async function getStripe(): Promise<StripeClient | null> {
  if (!STRIPE_API_KEY) return null;
  if (stripe) return stripe;

  const { default: Stripe } = await import(
    "https://esm.sh/stripe@14?target=denonext"
  );
  stripe = new Stripe(STRIPE_API_KEY, {
    apiVersion: "2024-11-20",
  }) as unknown as StripeClient;
  return stripe;
}

export function isStripeEnabled(): boolean {
  return !!STRIPE_API_KEY;
}

export async function createStripeCustomer(
  email: string,
  name?: string,
): Promise<string | null> {
  const client = await getStripe();
  if (!client) return null;
  const customer = await client.customers.create({
    email,
    name: name ?? undefined,
  });
  return customer.id;
}

export async function createSetupIntent(
  customerId: string,
): Promise<{ id: string; client_secret: string } | null> {
  const client = await getStripe();
  if (!client) return null;
  return await client.setupIntents.create({
    customer: customerId,
    payment_method_types: ["card"],
  });
}

export async function detachPaymentMethod(
  paymentMethodId: string,
): Promise<boolean> {
  const client = await getStripe();
  if (!client) return false;
  await client.paymentMethods.detach(paymentMethodId);
  return true;
}

export async function listStripeInvoices(
  customerId: string,
  limit = 10,
): Promise<Record<string, unknown>[] | null> {
  const client = await getStripe();
  if (!client) return null;
  const result = await client.invoices.list({
    customer: customerId,
    limit,
  });
  return result.data;
}

export async function getUpcomingInvoice(
  customerId: string,
): Promise<Record<string, unknown> | null> {
  const client = await getStripe();
  if (!client) return null;
  try {
    return await client.invoices.retrieveUpcoming({ customer: customerId });
  } catch {
    return null;
  }
}
