import type { Pool } from "https://deno.land/x/postgres@v0.17.0/mod.ts";
import type {
  UsageMetric,
  PricingOverride,
  UsageEntry,
  DailyUsageEntry,
  EgressBreakdown,
  OrgUsageResponse,
  OrgDailyUsageResponse,
} from "../types/api.ts";
import { queryLogflare } from "./logflare.client.ts";
import {
  getEffectivePricing,
  calculateCost,
  ALL_METRICS,
} from "./pricing.config.ts";

interface UsageOpts {
  projectRef?: string;
  start?: string;
  end?: string;
}

async function loadOverrides(pool: Pool, orgId: number): Promise<PricingOverride[]> {
  const conn = await pool.connect();
  try {
    const result = await conn.queryObject<PricingOverride>`
      SELECT id, organization_id, metric, discount_percent, custom_free_units, custom_per_unit_price, notes
      FROM traffic.pricing_overrides
      WHERE organization_id = ${orgId}
    `;
    return result.rows;
  } catch {
    return [];
  } finally {
    conn.release();
  }
}

async function queryDatabaseSize(pool: Pool): Promise<number> {
  const conn = await pool.connect();
  try {
    const result = await conn.queryObject<{ size: bigint | number }>`
      SELECT pg_database_size(current_database()) AS size
    `;
    return Number(result.rows[0]?.size ?? 0);
  } catch (err) {
    console.error("Failed to query database size:", err);
    return 0;
  } finally {
    conn.release();
  }
}

async function queryStorageSize(pool: Pool): Promise<number> {
  const conn = await pool.connect();
  try {
    const result = await conn.queryObject<{ size: bigint | number }>`
      SELECT COALESCE(SUM((metadata->>'size')::bigint), 0) AS size FROM storage.objects
    `;
    return Number(result.rows[0]?.size ?? 0);
  } catch (err) {
    console.error("Failed to query storage size:", err);
    return 0;
  } finally {
    conn.release();
  }
}

function dateRange(opts: UsageOpts): { isoStart: string; isoEnd: string } {
  const now = new Date();
  const startOfMonth = new Date(now.getFullYear(), now.getMonth(), 1);
  return {
    isoStart: opts.start ?? startOfMonth.toISOString(),
    isoEnd: opts.end ?? now.toISOString(),
  };
}

async function safeLogflare(sql: string, isoStart: string, isoEnd: string, projectRef: string): Promise<Record<string, unknown>[]> {
  try {
    return await queryLogflare(sql, isoStart, isoEnd, projectRef);
  } catch (err) {
    console.error("Logflare query error:", err);
    return [];
  }
}

function toNum(val: unknown): number {
  if (typeof val === "number") return val;
  if (typeof val === "string") return Number(val) || 0;
  if (typeof val === "bigint") return Number(val);
  return 0;
}

export async function getOrgUsage(
  pool: Pool,
  orgId: number,
  planId: string,
  opts: UsageOpts = {},
): Promise<OrgUsageResponse> {
  const projectRef = opts.projectRef ?? "default";
  const { isoStart, isoEnd } = dateRange(opts);

  const [overrides, dbSize, storageSize, logflareResults] = await Promise.all([
    loadOverrides(pool, orgId),
    queryDatabaseSize(pool),
    queryStorageSize(pool),
    Promise.all([
      safeLogflare("SELECT COUNT(DISTINCT id) AS cnt FROM function_edge_logs", isoStart, isoEnd, projectRef),
      safeLogflare(
        `SELECT SUM(CAST(COALESCE(r.content_length, '0') AS int64)) AS total_bytes
         FROM edge_logs t
         CROSS JOIN UNNEST(metadata) AS m
         CROSS JOIN UNNEST(m.response) AS response
         CROSS JOIN UNNEST(response.headers) AS r`,
        isoStart, isoEnd, projectRef,
      ),
      safeLogflare(
        `SELECT COUNT(DISTINCT JSON_VALUE(event_message, '$.actor_id')) AS cnt FROM auth_logs`,
        isoStart, isoEnd, projectRef,
      ),
      safeLogflare("SELECT COUNT(*) AS cnt FROM realtime_logs", isoStart, isoEnd, projectRef),
      safeLogflare(
        `SELECT COUNT(*) AS cnt FROM edge_logs t
         CROSS JOIN UNNEST(metadata) AS m
         CROSS JOIN UNNEST(m.request) AS request
         WHERE request.path LIKE '/storage/v1/render/%'`,
        isoStart, isoEnd, projectRef,
      ),
    ]),
  ]);

  const [funcRows, egressRows, mauRows, realtimeRows, imgRows] = logflareResults;
  const funcInvocations = toNum(funcRows[0]?.cnt);
  const egress = toNum(egressRows[0]?.total_bytes);
  const mau = toNum(mauRows[0]?.cnt);
  const realtimeMessages = toNum(realtimeRows[0]?.cnt);
  const imagesTransformed = toNum(imgRows[0]?.cnt);

  const metricValues: Partial<Record<UsageMetric, number>> = {
    DATABASE_SIZE: dbSize,
    STORAGE_SIZE: storageSize,
    FUNCTION_INVOCATIONS: funcInvocations,
    EGRESS: egress,
    MONTHLY_ACTIVE_USERS: mau,
    MONTHLY_ACTIVE_THIRD_PARTY_USERS: mau,
    REALTIME_MESSAGE_COUNT: realtimeMessages,
    STORAGE_IMAGES_TRANSFORMED: imagesTransformed,
  };

  const projectName = Deno.env.get("DEFAULT_PROJECT_NAME") || "Default Project";
  const usages: UsageEntry[] = ALL_METRICS.map((metric) => {
    const usage = metricValues[metric] ?? 0;
    const pricing = getEffectivePricing(planId, metric, overrides);
    const cost = calculateCost(usage, pricing);

    return {
      metric,
      usage,
      usage_original: usage,
      cost,
      available_in_plan: pricing.available_in_plan,
      capped: pricing.capped,
      unlimited: false,
      pricing_strategy: pricing.pricing_strategy,
      pricing_free_units: pricing.free_units,
      pricing_per_unit_price: pricing.per_unit_price,
      pricing_package_price: pricing.package_price,
      pricing_package_size: pricing.package_size,
      project_allocations: usage > 0 ? [{ ref: projectRef, name: projectName, usage }] : [],
      unit_price_desc: pricing.unit_price_desc,
    };
  });

  return { usage_billing_enabled: true, usages };
}

export async function getOrgDailyUsage(
  pool: Pool,
  orgId: number,
  opts: UsageOpts = {},
): Promise<OrgDailyUsageResponse> {
  const projectRef = opts.projectRef ?? "default";
  const { isoStart, isoEnd } = dateRange(opts);

  const dailyMetrics: UsageMetric[] = [
    "DATABASE_SIZE", "STORAGE_SIZE", "EGRESS", "FUNCTION_INVOCATIONS",
    "MONTHLY_ACTIVE_USERS", "REALTIME_MESSAGE_COUNT", "REALTIME_PEAK_CONNECTIONS",
    "STORAGE_IMAGES_TRANSFORMED",
  ];

  const [dbSize, storageSize, egressDaily, funcDaily, mauDaily, rtMsgDaily, rtPeakDaily, imgDaily] = await Promise.all([
    queryDatabaseSize(pool),
    queryStorageSize(pool),
    safeLogflare(
      `SELECT
        CAST(timestamp_trunc(t.timestamp, day) AS datetime) AS day,
        SUM(CAST(COALESCE(r.content_length, '0') AS int64)) AS total_bytes,
        SUM(CASE WHEN request.path LIKE '/rest/%' OR request.path LIKE '/v1/%' THEN CAST(COALESCE(r.content_length, '0') AS int64) ELSE 0 END) AS egress_rest,
        SUM(CASE WHEN request.path LIKE '/auth/%' THEN CAST(COALESCE(r.content_length, '0') AS int64) ELSE 0 END) AS egress_auth,
        SUM(CASE WHEN request.path LIKE '/storage/%' THEN CAST(COALESCE(r.content_length, '0') AS int64) ELSE 0 END) AS egress_storage,
        SUM(CASE WHEN request.path LIKE '/realtime/%' THEN CAST(COALESCE(r.content_length, '0') AS int64) ELSE 0 END) AS egress_realtime,
        SUM(CASE WHEN request.path LIKE '/functions/%' THEN CAST(COALESCE(r.content_length, '0') AS int64) ELSE 0 END) AS egress_function,
        0 AS egress_supavisor,
        0 AS egress_graphql,
        0 AS egress_logdrain
      FROM edge_logs t
        CROSS JOIN UNNEST(metadata) AS m
        CROSS JOIN UNNEST(m.request) AS request
        CROSS JOIN UNNEST(m.response) AS response
        CROSS JOIN UNNEST(response.headers) AS r
      GROUP BY day ORDER BY day`,
      isoStart, isoEnd, projectRef,
    ),
    safeLogflare(
      `SELECT CAST(timestamp_trunc(t.timestamp, day) AS datetime) AS day, COUNT(DISTINCT id) AS cnt
       FROM function_edge_logs t GROUP BY day ORDER BY day`,
      isoStart, isoEnd, projectRef,
    ),
    safeLogflare(
      `SELECT CAST(timestamp_trunc(t.timestamp, day) AS datetime) AS day,
              COUNT(DISTINCT JSON_VALUE(event_message, '$.actor_id')) AS cnt
       FROM auth_logs t GROUP BY day ORDER BY day`,
      isoStart, isoEnd, projectRef,
    ),
    safeLogflare(
      `SELECT CAST(timestamp_trunc(t.timestamp, day) AS datetime) AS day, COUNT(*) AS cnt
       FROM realtime_logs t GROUP BY day ORDER BY day`,
      isoStart, isoEnd, projectRef,
    ),
    safeLogflare(
      `SELECT CAST(timestamp_trunc(t.timestamp, day) AS datetime) AS day, COUNT(*) AS cnt
       FROM realtime_logs t GROUP BY day ORDER BY day`,
      isoStart, isoEnd, projectRef,
    ),
    safeLogflare(
      `SELECT CAST(timestamp_trunc(t.timestamp, day) AS datetime) AS day, COUNT(*) AS cnt
       FROM edge_logs t
       CROSS JOIN UNNEST(metadata) AS m
       CROSS JOIN UNNEST(m.request) AS request
       WHERE request.path LIKE '/storage/v1/render/%'
       GROUP BY day ORDER BY day`,
      isoStart, isoEnd, projectRef,
    ),
  ]);

  const usages: DailyUsageEntry[] = [];

  const daysBetween = getDaysBetween(isoStart, isoEnd);

  for (const day of daysBetween) {
    const dayStr = day.toISOString().slice(0, 10);

    usages.push({ date: dayStr, metric: "DATABASE_SIZE", usage: dbSize, usage_original: dbSize, breakdown: null });
    usages.push({ date: dayStr, metric: "STORAGE_SIZE", usage: storageSize, usage_original: storageSize, breakdown: null });

    const egressDay = findDayRow(egressDaily, day);
    const egressTotal = toNum(egressDay?.total_bytes);
    const breakdown: EgressBreakdown = {
      egress_rest: toNum(egressDay?.egress_rest),
      egress_storage: toNum(egressDay?.egress_storage),
      egress_realtime: toNum(egressDay?.egress_realtime),
      egress_function: toNum(egressDay?.egress_function),
      egress_supavisor: toNum(egressDay?.egress_supavisor),
      egress_graphql: toNum(egressDay?.egress_graphql),
      egress_logdrain: toNum(egressDay?.egress_logdrain),
    };
    usages.push({ date: dayStr, metric: "EGRESS", usage: egressTotal, usage_original: egressTotal, breakdown });

    const funcDay = findDayRow(funcDaily, day);
    const funcVal = toNum(funcDay?.cnt);
    usages.push({ date: dayStr, metric: "FUNCTION_INVOCATIONS", usage: funcVal, usage_original: funcVal, breakdown: null });

    const mauDay = findDayRow(mauDaily, day);
    const mauVal = toNum(mauDay?.cnt);
    usages.push({ date: dayStr, metric: "MONTHLY_ACTIVE_USERS", usage: mauVal, usage_original: mauVal, breakdown: null });

    const rtMsgDay = findDayRow(rtMsgDaily, day);
    const rtMsgVal = toNum(rtMsgDay?.cnt);
    usages.push({ date: dayStr, metric: "REALTIME_MESSAGE_COUNT", usage: rtMsgVal, usage_original: rtMsgVal, breakdown: null });

    const rtPeakDay = findDayRow(rtPeakDaily, day);
    const rtPeakVal = toNum(rtPeakDay?.cnt);
    usages.push({ date: dayStr, metric: "REALTIME_PEAK_CONNECTIONS", usage: rtPeakVal, usage_original: rtPeakVal, breakdown: null });

    const imgDay = findDayRow(imgDaily, day);
    const imgVal = toNum(imgDay?.cnt);
    usages.push({ date: dayStr, metric: "STORAGE_IMAGES_TRANSFORMED", usage: imgVal, usage_original: imgVal, breakdown: null });
  }

  return { usages };
}

function getDaysBetween(isoStart: string, isoEnd: string): Date[] {
  const start = new Date(isoStart);
  const end = new Date(isoEnd);
  start.setUTCHours(0, 0, 0, 0);
  end.setUTCHours(0, 0, 0, 0);

  const days: Date[] = [];
  const current = new Date(start);
  while (current <= end) {
    days.push(new Date(current));
    current.setUTCDate(current.getUTCDate() + 1);
  }
  return days;
}

function findDayRow(rows: Record<string, unknown>[], targetDay: Date): Record<string, unknown> | undefined {
  const targetStr = targetDay.toISOString().slice(0, 10);
  return rows.find((r) => {
    const dayVal = String(r.day ?? "");
    return dayVal.startsWith(targetStr);
  });
}
