import type { Pool } from "https://deno.land/x/postgres@v0.17.0/mod.ts";
import {
  listNotifications,
  bulkUpdateNotificationStatus,
  updateNotificationStatus,
} from "../services/notification.service.ts";

const corsHeaders = {
  "Access-Control-Allow-Origin": "*",
  "Access-Control-Allow-Headers": "authorization, x-client-info, apikey, content-type",
};

export async function handleNotifications(
  req: Request,
  path: string,
  method: string,
  pool: Pool,
  gotrueId: string,
  email: string,
  profileId: number,
): Promise<Response> {
  const ip = req.headers.get("x-forwarded-for") ?? req.headers.get("x-real-ip") ?? "unknown";
  const auditContext = { email, ip, method, route: "/profile" + path };

  if (method === "GET" && path === "/notifications") {
    const notifications = await listNotifications(pool, profileId);
    return Response.json(notifications, { headers: corsHeaders });
  }

  if (method === "PATCH" && path === "/notifications") {
    const body = await req.json().catch(() => ({}));
    if (!body.ids || !body.status) {
      return Response.json(
        { message: "ids and status are required" },
        { status: 400, headers: corsHeaders },
      );
    }
    const updated = await bulkUpdateNotificationStatus(
      pool, profileId, body.ids, body.status, gotrueId, auditContext,
    );
    return Response.json(updated, { headers: corsHeaders });
  }

  const singleMatch = path.match(/^\/notifications\/([a-f0-9-]+)$/i);
  if (method === "PATCH" && singleMatch) {
    const notifId = singleMatch[1];
    const body = await req.json().catch(() => ({}));
    if (!body.status) {
      return Response.json({ message: "status is required" }, { status: 400, headers: corsHeaders });
    }
    const updated = await updateNotificationStatus(
      pool, profileId, notifId, body.status, gotrueId, auditContext,
    );
    if (!updated) {
      return Response.json({ message: "Notification not found" }, { status: 404, headers: corsHeaders });
    }
    return Response.json(updated, { headers: corsHeaders });
  }

  return Response.json({ message: "Method not allowed" }, {
    status: 405,
    headers: corsHeaders,
  });
}
