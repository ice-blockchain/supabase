import type { Pool } from "https://deno.land/x/postgres@v0.17.0/mod.ts";
import { corsHeaders } from "../index.ts";
import type { CreateOrganizationBody } from "../types/api.ts";
import {
  listOrganizations,
  getOrganizationBySlug,
  createOrganization,
  updateOrganization,
  deleteOrganization,
} from "../services/organization.service.ts";
import { handleBilling } from "./billing.ts";
import { handleMembers } from "./members.ts";
import {
  getOrgAuditLogs,
  getSSOProvider,
  createSSOProvider,
  updateSSOProvider,
  deleteSSOProvider,
} from "../services/org-settings.service.ts";
import { getOrgUsage, getOrgDailyUsage } from "../services/usage.service.ts";
import { listOrgProjects } from "../services/project.service.ts";

export async function handleOrganizations(
  req: Request,
  path: string,
  method: string,
  pool: Pool,
  profileId: number,
  gotrueId: string,
  email: string,
): Promise<Response> {
  const ip = req.headers.get("x-forwarded-for") ?? req.headers.get("x-real-ip") ?? "unknown";
  const auditContext = { email, ip, method, route: "/organizations" + path };

  // GET /organizations — list all user's orgs
  if (path === "/" && method === "GET") {
    const orgs = await listOrganizations(pool, profileId);
    return Response.json(orgs, { headers: corsHeaders });
  }

  // POST /organizations — create org
  if (path === "/" && method === "POST") {
    const body: CreateOrganizationBody = await req.json();
    if (!body.name) {
      return Response.json(
        { message: "name is required" },
        { status: 400, headers: corsHeaders },
      );
    }
    const org = await createOrganization(pool, profileId, body, gotrueId, auditContext);
    return Response.json(org, { status: 201, headers: corsHeaders });
  }

  // Extract slug from path: /{slug} or /{slug}/sub-resource
  const slugMatch = path.match(/^\/([^/]+)(\/.*)?$/);
  if (!slugMatch) {
    return Response.json({ message: "Not Found" }, { status: 404, headers: corsHeaders });
  }

  const slug = slugMatch[1];
  const subPath = slugMatch[2] || "";

  // GET /organizations/{slug}/projects — list org projects from DB
  if (method === "GET" && subPath === "/projects") {
    const org = await getOrganizationBySlug(pool, slug, profileId);
    if (!org) {
      return Response.json({ message: "Organization not found" }, { status: 404, headers: corsHeaders });
    }
    const url = new URL(req.url);
    const limit = parseInt(url.searchParams.get("limit") || "100", 10);
    const offset = parseInt(url.searchParams.get("offset") || "0", 10);
    const result = await listOrgProjects(pool, org.id, limit, offset);
    return Response.json(result, { headers: corsHeaders });
  }

  // Delegate billing/payments/customer/tax sub-paths to billing handler
  if (subPath.startsWith("/billing") || subPath.startsWith("/customer") ||
      subPath.startsWith("/tax-ids") || subPath.startsWith("/payments")) {
    const org = await getOrganizationBySlug(pool, slug, profileId);
    if (!org) {
      return Response.json({ message: "Organization not found" }, { status: 404, headers: corsHeaders });
    }
    return handleBilling(req, subPath, method, pool, org.id, profileId, gotrueId, email);
  }

  // Usage endpoints (real metrics from Postgres + Logflare)
  if (method === "GET" && (subPath === "/usage" || subPath === "/usage/daily")) {
    const org = await getOrganizationBySlug(pool, slug, profileId);
    if (!org) {
      return Response.json({ message: "Organization not found" }, { status: 404, headers: corsHeaders });
    }

    const url = new URL(req.url);
    const usageOpts = {
      projectRef: url.searchParams.get("project_ref") ?? undefined,
      start: url.searchParams.get("start") ?? undefined,
      end: url.searchParams.get("end") ?? undefined,
    };

    try {
      if (subPath === "/usage") {
        const result = await getOrgUsage(pool, org.id, org.plan.id, usageOpts);
        return Response.json(result, { headers: corsHeaders });
      } else {
        const result = await getOrgDailyUsage(pool, org.id, usageOpts);
        return Response.json(result, { headers: corsHeaders });
      }
    } catch (err) {
      console.error("Usage endpoint error:", err);
      return Response.json({ message: "Failed to get usage stats" }, { status: 500, headers: corsHeaders });
    }
  }

  // ── Org Audit Logs ────────────────────────────────────
  if (method === "GET" && subPath === "/audit") {
    const org = await getOrganizationBySlug(pool, slug, profileId);
    if (!org) {
      return Response.json({ message: "Organization not found" }, { status: 404, headers: corsHeaders });
    }
    const url = new URL(req.url);
    const startTs = url.searchParams.get("iso_timestamp_start");
    const endTs = url.searchParams.get("iso_timestamp_end");
    if (!startTs || !endTs) {
      return Response.json(
        { message: "iso_timestamp_start and iso_timestamp_end are required" },
        { status: 400, headers: corsHeaders },
      );
    }
    const logs = await getOrgAuditLogs(pool, org.id, startTs, endTs);
    return Response.json(logs, { headers: corsHeaders });
  }

  // ── Members, Invitations, Roles ─────────────────────────
  if (subPath.startsWith("/members") || subPath === "/roles") {
    const org = await getOrganizationBySlug(pool, slug, profileId);
    if (!org) {
      return Response.json({ message: "Organization not found" }, { status: 404, headers: corsHeaders });
    }
    return handleMembers(req, subPath, method, pool, org.id, profileId, gotrueId, email);
  }

  // ── SSO Provider CRUD ───────────────────────────────────
  if (subPath === "/sso") {
    const org = await getOrganizationBySlug(pool, slug, profileId);
    if (!org) {
      return Response.json({ message: "Organization not found" }, { status: 404, headers: corsHeaders });
    }
    if (method === "GET") {
      const provider = await getSSOProvider(pool, org.id);
      if (!provider) {
        return Response.json(
          { message: "No SSO provider configured for this organization" },
          { status: 404, headers: corsHeaders },
        );
      }
      return Response.json(provider, { headers: corsHeaders });
    }
    if (method === "POST") {
      const body = await req.json();
      const provider = await createSSOProvider(pool, org.id, body, profileId, gotrueId, auditContext);
      return Response.json(provider, { status: 201, headers: corsHeaders });
    }
    if (method === "PUT") {
      const body = await req.json();
      const provider = await updateSSOProvider(pool, org.id, body, profileId, gotrueId, auditContext);
      if (!provider) {
        return Response.json(
          { message: "No SSO provider configured for this organization" },
          { status: 404, headers: corsHeaders },
        );
      }
      return Response.json(provider, { headers: corsHeaders });
    }
    if (method === "DELETE") {
      const deleted = await deleteSSOProvider(pool, org.id, profileId, gotrueId, auditContext);
      if (!deleted) {
        return Response.json(
          { message: "No SSO provider configured for this organization" },
          { status: 404, headers: corsHeaders },
        );
      }
      return Response.json({ message: "SSO provider deleted" }, { headers: corsHeaders });
    }
  }

  // Sub-resource stubs for self-hosted (no marketplace)
  const subResourceStubs: Record<string, unknown> = {
    "/entitlements": { entitlements: [] },
    "/oauth/apps": [],
    "/apps": [],
    "/apps/installations": [],
  };

  if (method === "GET" && subPath && subPath !== "/") {
    const org = await getOrganizationBySlug(pool, slug, profileId);
    if (!org) {
      return Response.json({ message: "Organization not found" }, { status: 404, headers: corsHeaders });
    }
    const stubData = subResourceStubs[subPath];
    return Response.json(stubData !== undefined ? stubData : {}, { headers: corsHeaders });
  }

  if (method === "POST" && subPath && subPath !== "/") {
    const org = await getOrganizationBySlug(pool, slug, profileId);
    if (!org) {
      return Response.json({ message: "Organization not found" }, { status: 404, headers: corsHeaders });
    }
    if (subPath === "/available-versions") {
      return Response.json({ available_versions: [] }, { headers: corsHeaders });
    }
    return Response.json({}, { headers: corsHeaders });
  }

  // GET /organizations/{slug} — get org detail
  if (method === "GET") {
    const org = await getOrganizationBySlug(pool, slug, profileId);
    if (!org) {
      return Response.json({ message: "Organization not found" }, { status: 404, headers: corsHeaders });
    }
    return Response.json(org, { headers: corsHeaders });
  }

  // PATCH /organizations/{slug} — update org
  if (method === "PATCH" && !subPath) {
    const body = await req.json();
    const result = await updateOrganization(
      pool, slug, profileId,
      { name: body.name, billing_email: body.billing_email, opt_in_tags: body.opt_in_tags, additional_billing_emails: body.additional_billing_emails },
      gotrueId, auditContext,
    );
    if (!result) {
      return Response.json({ message: "Organization not found" }, { status: 404, headers: corsHeaders });
    }
    return Response.json(result, { headers: corsHeaders });
  }

  // DELETE /organizations/{slug} — delete org
  if (method === "DELETE" && !subPath) {
    const deleted = await deleteOrganization(pool, slug, profileId, gotrueId, auditContext);
    if (!deleted) {
      return Response.json({ message: "Organization not found or not owner" }, { status: 404, headers: corsHeaders });
    }
    return Response.json({ message: "Organization deleted" }, { headers: corsHeaders });
  }

  return Response.json({ message: "Method not allowed" }, { status: 405, headers: corsHeaders });
}
