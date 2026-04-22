import type { Pool } from "https://deno.land/x/postgres@v0.17.0/mod.ts";
import { getOrCreateProfile, updateProfile } from "../services/profile.service.ts";

const corsHeaders = {
  "Access-Control-Allow-Origin": "*",
  "Access-Control-Allow-Headers": "authorization, x-client-info, apikey, content-type",
};

export async function handleProfile(
  req: Request,
  path: string,
  method: string,
  pool: Pool,
  gotrueId: string,
  email: string,
): Promise<Response> {
  if (method === "GET" && (path === "/" || path === "")) {
    const profile = await getOrCreateProfile(pool, gotrueId, email);
    return Response.json(profile, { headers: corsHeaders });
  }

  if (method === "PUT" && (path === "/" || path === "/update")) {
    const body = await req.json().catch(() => ({}));
    const ip = req.headers.get("x-forwarded-for") ?? req.headers.get("x-real-ip") ?? "unknown";
    const profile = await updateProfile(pool, gotrueId, body, {
      email,
      ip,
      method,
      route: "/profile" + path,
    });
    return Response.json(profile, { headers: corsHeaders });
  }

  return Response.json({ message: "Method not allowed" }, {
    status: 405,
    headers: corsHeaders,
  });
}
