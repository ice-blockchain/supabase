import type { Pool } from "https://deno.land/x/postgres@v0.17.0/mod.ts";
import type { AuditLog, AuditLogsResponse } from "../types/api.ts";

const corsHeaders = {
  "Access-Control-Allow-Origin": "*",
  "Access-Control-Allow-Headers": "authorization, x-client-info, apikey, content-type",
};

interface AuditLogRow {
  id: string;
  profile_id: number;
  action_name: string;
  action_metadata: Array<{ method?: string; route?: string; status?: number }>;
  actor_id: string;
  actor_type: string;
  actor_metadata: Array<{ email?: string; ip?: string; tokenType?: string }>;
  target_description: string;
  target_metadata: Record<string, unknown>;
  occurred_at: string;
}

function rowToAuditLog(row: AuditLogRow): AuditLog {
  return {
    action: {
      name: row.action_name,
      metadata: row.action_metadata ?? [],
    },
    actor: {
      id: row.actor_id,
      type: row.actor_type,
      metadata: row.actor_metadata ?? [],
    },
    target: {
      description: row.target_description ?? "",
      metadata: row.target_metadata ?? {},
    },
    occurred_at: row.occurred_at,
  };
}

const DEFAULT_RETENTION_PERIOD = 7;

export async function handleAudit(
  req: Request,
  path: string,
  method: string,
  pool: Pool,
  gotrueId: string,
  email: string,
  profileId: number,
): Promise<Response> {
  if (method === "GET" && path === "/audit") {
    const url = new URL(req.url);
    const startTs = url.searchParams.get("iso_timestamp_start");
    const endTs = url.searchParams.get("iso_timestamp_end");

    if (!startTs || !endTs) {
      return Response.json(
        { message: "iso_timestamp_start and iso_timestamp_end are required" },
        { status: 400, headers: corsHeaders },
      );
    }

    const connection = await pool.connect();
    try {
      const result = await connection.queryObject<AuditLogRow>`
        SELECT * FROM traffic.audit_logs
        WHERE profile_id = ${profileId}
          AND occurred_at >= ${startTs}::timestamptz
          AND occurred_at <= ${endTs}::timestamptz
        ORDER BY occurred_at DESC
      `;
      const response: AuditLogsResponse = {
        result: result.rows.map(rowToAuditLog),
        retention_period: DEFAULT_RETENTION_PERIOD,
      };
      return Response.json(response, { headers: corsHeaders });
    } finally {
      connection.release();
    }
  }

  if (method === "POST" && path === "/audit-login") {
    const ip = req.headers.get("x-forwarded-for") ?? req.headers.get("x-real-ip") ?? "unknown";

    const connection = await pool.connect();
    try {
      await connection.queryObject`
        INSERT INTO traffic.audit_logs (
          id, profile_id, action_name, action_metadata,
          actor_id, actor_type, actor_metadata,
          target_description, target_metadata, occurred_at
        ) VALUES (
          gen_random_uuid(), ${profileId}, 'account.login',
          ${JSON.stringify([{ method: "POST", route: "/audit-login", status: 200 }])}::jsonb,
          ${gotrueId}, 'user',
          ${JSON.stringify([{ email, ip }])}::jsonb,
          'account login', '{}'::jsonb, now()
        )
      `;
      return Response.json({ message: "Login event recorded" }, { status: 201, headers: corsHeaders });
    } finally {
      connection.release();
    }
  }

  return Response.json({ message: "Method not allowed" }, {
    status: 405,
    headers: corsHeaders,
  });
}
