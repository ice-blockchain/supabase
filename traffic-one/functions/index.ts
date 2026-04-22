import { createClient } from "npm:@supabase/supabase-js@2";
import { pool } from "./db.ts";
import { getOrCreateProfile } from "./services/profile.service.ts";
import { handleProfile } from "./routes/profile.ts";
import { handleAccessTokens } from "./routes/access-tokens.ts";
import { handleScopedAccessTokens } from "./routes/scoped-access-tokens.ts";
import { handleNotifications } from "./routes/notifications.ts";
import { handlePermissions } from "./routes/permissions.ts";
import { handleAudit } from "./routes/audit.ts";
import { handleSignup, handleResetPassword } from "./routes/auth.ts";
import { handleOrganizations } from "./routes/organizations.ts";
import { handleProjects, handleProjectHealth } from "./routes/projects.ts";
import { handleStripe, handleConfirmSubscription } from "./routes/billing.ts";

export const corsHeaders = {
  "Access-Control-Allow-Origin": "*",
  "Access-Control-Allow-Headers": "authorization, x-client-info, apikey, content-type",
};

const supabaseUrl = Deno.env.get("SUPABASE_URL")!;
const supabaseAnonKey = Deno.env.get("SUPABASE_ANON_KEY")!;

const supabase = createClient(supabaseUrl, supabaseAnonKey, {
  auth: { autoRefreshToken: false, persistSession: false, detectSessionInUrl: false },
});

Deno.serve(async (req: Request) => {
  if (req.method === "OPTIONS") {
    return new Response("ok", { headers: corsHeaders });
  }

  const url = new URL(req.url);
  const path = url.pathname.replace(/^\/traffic-one/, "") || "/";
  const method = req.method;

  // Unauthenticated routes (public, like GoTrue itself)
  if (path === "/signup" && method === "POST") {
    return handleSignup(req, supabase);
  }
  if (path === "/reset-password" && method === "POST") {
    return handleResetPassword(req, supabase);
  }

  const authHeader = req.headers.get("Authorization");
  if (!authHeader) {
    return Response.json({ msg: "Missing authorization" }, {
      status: 401,
      headers: corsHeaders,
    });
  }

  const token = authHeader.replace("Bearer ", "");

  let gotrueId: string;
  let email: string;

  try {
    const { data: { user }, error } = await supabase.auth.getUser(token);
    if (error || !user) {
      return Response.json({ msg: "Invalid JWT" }, { status: 401, headers: corsHeaders });
    }
    gotrueId = user.id;
    email = user.email ?? "";
  } catch {
    return Response.json({ msg: "Invalid JWT" }, { status: 401, headers: corsHeaders });
  }

  try {
    const profile = await getOrCreateProfile(pool, gotrueId, email);
    const profileId = profile.id;

    if (path === "/" || path === "/update") {
      return handleProfile(req, path, method, pool, gotrueId, email);
    }

    if (path.startsWith("/access-tokens")) {
      return handleAccessTokens(req, path, method, pool, gotrueId, email, profileId);
    }

    if (path.startsWith("/scoped-access-tokens")) {
      return handleScopedAccessTokens(req, path, method, pool, gotrueId, email, profileId);
    }

    if (path.startsWith("/notifications")) {
      return handleNotifications(req, path, method, pool, gotrueId, email, profileId);
    }

    if (path === "/permissions") {
      return handlePermissions(req, path, method, pool, profileId);
    }

    if (path === "/organizations/confirm-subscription" && method === "POST") {
      return handleConfirmSubscription(req, method);
    }

    if (path.startsWith("/organizations")) {
      const orgPath = path.replace(/^\/organizations/, "") || "/";
      return handleOrganizations(req, orgPath, method, pool, profileId, gotrueId, email);
    }

    if (path.startsWith("/stripe")) {
      const stripePath = path.replace(/^\/stripe/, "") || "/";
      return handleStripe(req, stripePath, method, pool);
    }

    if (path === "/projects-resource-warnings") {
      return Response.json([], { headers: corsHeaders });
    }

    if (path.startsWith("/telemetry/feature-flags")) {
      return Response.json({}, { headers: corsHeaders });
    }

    if (path.startsWith("/projects")) {
      const projectPath = path.replace(/^\/projects/, "") || "/";
      return handleProjects(req, projectPath, method, pool, profileId, gotrueId, email);
    }

    if (path.startsWith("/v1-projects")) {
      const v1Path = path.replace(/^\/v1-projects/, "") || "/";
      return handleProjectHealth(req, v1Path, method, pool, profileId);
    }

    if (path === "/profile/audit-log") {
      return handleAudit(req, "/audit", method, pool, gotrueId, email, profileId);
    }

    if (path === "/audit" || path === "/audit-login") {
      return handleAudit(req, path, method, pool, gotrueId, email, profileId);
    }

    return Response.json({ message: "Not Found" }, {
      status: 404,
      headers: corsHeaders,
    });
  } catch (err) {
    console.error("traffic-one error:", err);
    return Response.json(
      { message: "Internal Server Error" },
      { status: 500, headers: corsHeaders },
    );
  }
});
