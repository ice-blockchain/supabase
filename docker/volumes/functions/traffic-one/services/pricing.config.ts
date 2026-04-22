import type { UsageMetric, PricingStrategy, MetricPricing, PricingOverride } from "../types/api.ts";

interface PlanPricing {
  pricing_strategy: PricingStrategy;
  free_units: number;
  per_unit_price: number;
  package_size?: number;
  package_price?: number;
  available_in_plan: boolean;
  capped: boolean;
  unit_price_desc: string;
}

type PlanId = "free" | "pro" | "team" | "enterprise";

const BYTES_PER_GB = 1073741824;

function gb(n: number): number {
  return n * BYTES_PER_GB;
}

function mb(n: number): number {
  return n * 1048576;
}

const FREE_PRICING: Record<UsageMetric, PlanPricing> = {
  EGRESS:                     { pricing_strategy: "UNIT", free_units: gb(5), per_unit_price: 0.09 / BYTES_PER_GB, available_in_plan: true, capped: true, unit_price_desc: "$0.09 per GB" },
  CACHED_EGRESS:              { pricing_strategy: "NONE", free_units: 0, per_unit_price: 0, available_in_plan: true, capped: true, unit_price_desc: "" },
  DATABASE_SIZE:              { pricing_strategy: "UNIT", free_units: mb(500), per_unit_price: 0.125 / BYTES_PER_GB, available_in_plan: true, capped: true, unit_price_desc: "$0.125 per GB" },
  STORAGE_SIZE:               { pricing_strategy: "UNIT", free_units: gb(1), per_unit_price: 0.021 / BYTES_PER_GB, available_in_plan: true, capped: true, unit_price_desc: "$0.021 per GB" },
  MONTHLY_ACTIVE_USERS:       { pricing_strategy: "UNIT", free_units: 50000, per_unit_price: 0.00325, available_in_plan: true, capped: true, unit_price_desc: "$0.00325 per MAU" },
  MONTHLY_ACTIVE_SSO_USERS:   { pricing_strategy: "UNIT", free_units: 0, per_unit_price: 0.015, available_in_plan: false, capped: true, unit_price_desc: "$0.015 per MAU" },
  MONTHLY_ACTIVE_THIRD_PARTY_USERS: { pricing_strategy: "UNIT", free_units: 50000, per_unit_price: 0.00325, available_in_plan: true, capped: true, unit_price_desc: "$0.00325 per MAU" },
  FUNCTION_INVOCATIONS:       { pricing_strategy: "PACKAGE", free_units: 500000, per_unit_price: 0.000002, package_size: 1000000, package_price: 2, available_in_plan: true, capped: true, unit_price_desc: "$2 per million" },
  FUNCTION_CPU_MILLISECONDS:  { pricing_strategy: "NONE", free_units: 0, per_unit_price: 0, available_in_plan: true, capped: true, unit_price_desc: "" },
  STORAGE_IMAGES_TRANSFORMED: { pricing_strategy: "PACKAGE", free_units: 0, per_unit_price: 0.005, package_size: 1000, package_price: 5, available_in_plan: false, capped: true, unit_price_desc: "$5 per 1000" },
  REALTIME_MESSAGE_COUNT:     { pricing_strategy: "PACKAGE", free_units: 2000000, per_unit_price: 0.0000025, package_size: 1000000, package_price: 2.5, available_in_plan: true, capped: true, unit_price_desc: "$2.50 per million" },
  REALTIME_PEAK_CONNECTIONS:  { pricing_strategy: "PACKAGE", free_units: 200, per_unit_price: 0.01, package_size: 1000, package_price: 10, available_in_plan: true, capped: true, unit_price_desc: "$10 per 1000" },
  AUTH_MFA_PHONE:             { pricing_strategy: "UNIT", free_units: 0, per_unit_price: 0, available_in_plan: false, capped: true, unit_price_desc: "" },
  AUTH_MFA_WEB_AUTHN:         { pricing_strategy: "UNIT", free_units: 0, per_unit_price: 0, available_in_plan: false, capped: true, unit_price_desc: "" },
  LOG_DRAIN_EVENTS:           { pricing_strategy: "NONE", free_units: 0, per_unit_price: 0, available_in_plan: false, capped: true, unit_price_desc: "" },

  // Compute hours -- not available on free
  COMPUTE_HOURS_BRANCH:                 { pricing_strategy: "UNIT", free_units: 0, per_unit_price: 0.01344, available_in_plan: false, capped: false, unit_price_desc: "$0.01344 per hour" },
  COMPUTE_HOURS_XS:                     { pricing_strategy: "UNIT", free_units: 0, per_unit_price: 0.01344, available_in_plan: false, capped: false, unit_price_desc: "$0.01344 per hour" },
  COMPUTE_HOURS_SM:                     { pricing_strategy: "UNIT", free_units: 0, per_unit_price: 0.0206,  available_in_plan: false, capped: false, unit_price_desc: "$0.0206 per hour" },
  COMPUTE_HOURS_MD:                     { pricing_strategy: "UNIT", free_units: 0, per_unit_price: 0.0822,  available_in_plan: false, capped: false, unit_price_desc: "$0.0822 per hour" },
  COMPUTE_HOURS_L:                      { pricing_strategy: "UNIT", free_units: 0, per_unit_price: 0.1517,  available_in_plan: false, capped: false, unit_price_desc: "$0.1517 per hour" },
  COMPUTE_HOURS_XL:                     { pricing_strategy: "UNIT", free_units: 0, per_unit_price: 0.2877,  available_in_plan: false, capped: false, unit_price_desc: "$0.2877 per hour" },
  COMPUTE_HOURS_2XL:                    { pricing_strategy: "UNIT", free_units: 0, per_unit_price: 0.562,   available_in_plan: false, capped: false, unit_price_desc: "$0.562 per hour" },
  COMPUTE_HOURS_4XL:                    { pricing_strategy: "UNIT", free_units: 0, per_unit_price: 1.1098,  available_in_plan: false, capped: false, unit_price_desc: "$1.1098 per hour" },
  COMPUTE_HOURS_8XL:                    { pricing_strategy: "UNIT", free_units: 0, per_unit_price: 2.2055,  available_in_plan: false, capped: false, unit_price_desc: "$2.2055 per hour" },
  COMPUTE_HOURS_12XL:                   { pricing_strategy: "UNIT", free_units: 0, per_unit_price: 3.2877,  available_in_plan: false, capped: false, unit_price_desc: "$3.2877 per hour" },
  COMPUTE_HOURS_16XL:                   { pricing_strategy: "UNIT", free_units: 0, per_unit_price: 4.3836,  available_in_plan: false, capped: false, unit_price_desc: "$4.3836 per hour" },
  COMPUTE_HOURS_24XL:                   { pricing_strategy: "UNIT", free_units: 0, per_unit_price: 0, available_in_plan: false, capped: false, unit_price_desc: "Contact sales" },
  COMPUTE_HOURS_24XL_OPTIMIZED_CPU:     { pricing_strategy: "UNIT", free_units: 0, per_unit_price: 0, available_in_plan: false, capped: false, unit_price_desc: "Contact sales" },
  COMPUTE_HOURS_24XL_OPTIMIZED_MEMORY:  { pricing_strategy: "UNIT", free_units: 0, per_unit_price: 0, available_in_plan: false, capped: false, unit_price_desc: "Contact sales" },
  COMPUTE_HOURS_24XL_HIGH_MEMORY:       { pricing_strategy: "UNIT", free_units: 0, per_unit_price: 0, available_in_plan: false, capped: false, unit_price_desc: "Contact sales" },
  COMPUTE_HOURS_48XL:                   { pricing_strategy: "UNIT", free_units: 0, per_unit_price: 0, available_in_plan: false, capped: false, unit_price_desc: "Contact sales" },
  COMPUTE_HOURS_48XL_OPTIMIZED_CPU:     { pricing_strategy: "UNIT", free_units: 0, per_unit_price: 0, available_in_plan: false, capped: false, unit_price_desc: "Contact sales" },
  COMPUTE_HOURS_48XL_OPTIMIZED_MEMORY:  { pricing_strategy: "UNIT", free_units: 0, per_unit_price: 0, available_in_plan: false, capped: false, unit_price_desc: "Contact sales" },
  COMPUTE_HOURS_48XL_HIGH_MEMORY:       { pricing_strategy: "UNIT", free_units: 0, per_unit_price: 0, available_in_plan: false, capped: false, unit_price_desc: "Contact sales" },
  ACTIVE_COMPUTE_HOURS:                 { pricing_strategy: "UNIT", free_units: 0, per_unit_price: 0, available_in_plan: false, capped: false, unit_price_desc: "" },

  // Disk
  DISK_SIZE_GB_HOURS_GP3:  { pricing_strategy: "UNIT", free_units: 0, per_unit_price: 0.000171, available_in_plan: false, capped: false, unit_price_desc: "$0.125 per GB-month" },
  DISK_SIZE_GB_HOURS_IO2:  { pricing_strategy: "UNIT", free_units: 0, per_unit_price: 0.000171, available_in_plan: false, capped: false, unit_price_desc: "$0.125 per GB-month" },
  DISK_THROUGHPUT_GP3:     { pricing_strategy: "UNIT", free_units: 0, per_unit_price: 0, available_in_plan: false, capped: false, unit_price_desc: "" },
  DISK_IOPS_GP3:           { pricing_strategy: "UNIT", free_units: 0, per_unit_price: 0, available_in_plan: false, capped: false, unit_price_desc: "" },
  DISK_IOPS_IO2:           { pricing_strategy: "UNIT", free_units: 0, per_unit_price: 0, available_in_plan: false, capped: false, unit_price_desc: "" },

  // Add-ons
  CUSTOM_DOMAIN: { pricing_strategy: "UNIT", free_units: 0, per_unit_price: 10, available_in_plan: false, capped: false, unit_price_desc: "$10 per month" },
  PITR_7:        { pricing_strategy: "UNIT", free_units: 0, per_unit_price: 100, available_in_plan: false, capped: false, unit_price_desc: "$100 per month" },
  PITR_14:       { pricing_strategy: "UNIT", free_units: 0, per_unit_price: 150, available_in_plan: false, capped: false, unit_price_desc: "$150 per month" },
  PITR_28:       { pricing_strategy: "UNIT", free_units: 0, per_unit_price: 200, available_in_plan: false, capped: false, unit_price_desc: "$200 per month" },
  IPV4:          { pricing_strategy: "UNIT", free_units: 0, per_unit_price: 4, available_in_plan: false, capped: false, unit_price_desc: "$4 per month" },
  LOG_DRAIN:     { pricing_strategy: "UNIT", free_units: 0, per_unit_price: 0, available_in_plan: false, capped: false, unit_price_desc: "" },

  // Logs
  LOG_INGESTION: { pricing_strategy: "NONE", free_units: 0, per_unit_price: 0, available_in_plan: false, capped: false, unit_price_desc: "" },
  LOG_QUERYING:  { pricing_strategy: "NONE", free_units: 0, per_unit_price: 0, available_in_plan: false, capped: false, unit_price_desc: "" },
  LOG_STORAGE:   { pricing_strategy: "NONE", free_units: 0, per_unit_price: 0, available_in_plan: false, capped: false, unit_price_desc: "" },
};

const PRO_OVERRIDES: Partial<Record<UsageMetric, Partial<PlanPricing>>> = {
  EGRESS:                     { free_units: gb(250), capped: false },
  DATABASE_SIZE:              { free_units: gb(8), capped: false },
  STORAGE_SIZE:               { free_units: gb(100), capped: false },
  MONTHLY_ACTIVE_USERS:       { free_units: 100000, capped: false },
  MONTHLY_ACTIVE_SSO_USERS:   { free_units: 50, available_in_plan: true, capped: false },
  MONTHLY_ACTIVE_THIRD_PARTY_USERS: { free_units: 100000, capped: false },
  FUNCTION_INVOCATIONS:       { free_units: 2000000, capped: false },
  FUNCTION_CPU_MILLISECONDS:  { available_in_plan: true, capped: false },
  STORAGE_IMAGES_TRANSFORMED: { free_units: 100, available_in_plan: true, capped: false },
  REALTIME_MESSAGE_COUNT:     { free_units: 5000000, capped: false },
  REALTIME_PEAK_CONNECTIONS:  { free_units: 500, capped: false },
  AUTH_MFA_PHONE:             { available_in_plan: true, capped: false },
  AUTH_MFA_WEB_AUTHN:         { available_in_plan: true, capped: false },
  LOG_DRAIN_EVENTS:           { available_in_plan: true, capped: false },
  COMPUTE_HOURS_BRANCH:       { available_in_plan: true },
  COMPUTE_HOURS_XS:           { available_in_plan: true },
  COMPUTE_HOURS_SM:           { available_in_plan: true },
  COMPUTE_HOURS_MD:           { available_in_plan: true },
  COMPUTE_HOURS_L:            { available_in_plan: true },
  COMPUTE_HOURS_XL:           { available_in_plan: true },
  COMPUTE_HOURS_2XL:          { available_in_plan: true },
  COMPUTE_HOURS_4XL:          { available_in_plan: true },
  COMPUTE_HOURS_8XL:          { available_in_plan: true },
  COMPUTE_HOURS_12XL:         { available_in_plan: true },
  COMPUTE_HOURS_16XL:         { available_in_plan: true },
  DISK_SIZE_GB_HOURS_GP3:     { available_in_plan: true },
  DISK_SIZE_GB_HOURS_IO2:     { available_in_plan: true },
  CUSTOM_DOMAIN:              { available_in_plan: true },
  IPV4:                       { available_in_plan: true },
};

function buildPlanPricing(overrides: Partial<Record<UsageMetric, Partial<PlanPricing>>>): Record<UsageMetric, PlanPricing> {
  const result = {} as Record<UsageMetric, PlanPricing>;
  for (const [metric, base] of Object.entries(FREE_PRICING)) {
    const override = overrides[metric as UsageMetric];
    result[metric as UsageMetric] = override ? { ...base, ...override } : { ...base };
  }
  return result;
}

const PLAN_PRICING: Record<string, Record<UsageMetric, PlanPricing>> = {
  free: FREE_PRICING,
  pro: buildPlanPricing(PRO_OVERRIDES),
  team: buildPlanPricing(PRO_OVERRIDES),
  enterprise: buildPlanPricing(PRO_OVERRIDES),
};

export function getDefaultPricing(planId: string, metric: UsageMetric): MetricPricing {
  const plan = PLAN_PRICING[planId] ?? PLAN_PRICING["free"];
  const p = plan[metric];
  return {
    pricing_strategy: p.pricing_strategy,
    free_units: p.free_units,
    per_unit_price: p.per_unit_price,
    package_size: p.package_size,
    package_price: p.package_price,
    available_in_plan: p.available_in_plan,
    capped: p.capped,
    unit_price_desc: p.unit_price_desc,
  };
}

export function getEffectivePricing(
  planId: string,
  metric: UsageMetric,
  overrides: PricingOverride[],
): MetricPricing {
  const defaults = getDefaultPricing(planId, metric);

  const metricOverride = overrides.find((o) => o.metric === metric);
  const globalOverride = overrides.find((o) => o.metric === null);
  const override = metricOverride ?? globalOverride;

  if (!override) return defaults;

  const freeUnits = override.custom_free_units ?? defaults.free_units;
  let perUnitPrice = override.custom_per_unit_price ?? defaults.per_unit_price;

  if (override.discount_percent > 0) {
    perUnitPrice *= 1 - override.discount_percent / 100;
  }

  return {
    ...defaults,
    free_units: freeUnits,
    per_unit_price: perUnitPrice,
  };
}

export function calculateCost(
  usage: number,
  pricing: MetricPricing,
): number {
  if (pricing.pricing_strategy === "NONE") return 0;

  const overage = Math.max(0, usage - pricing.free_units);
  if (overage === 0) return 0;

  if (pricing.pricing_strategy === "PACKAGE" && pricing.package_size && pricing.package_price) {
    const packages = Math.ceil(overage / pricing.package_size);
    return packages * pricing.package_price;
  }

  return overage * pricing.per_unit_price;
}

export const ALL_METRICS: UsageMetric[] = Object.keys(FREE_PRICING) as UsageMetric[];
