import type { Pool } from "https://deno.land/x/postgres@v0.17.0/mod.ts";
import { corsHeaders } from "../index.ts";
import { handleProjectBilling } from "./billing.ts";
import {
  createProject,
  getProjectByRef,
  listProjectsPaginated,
  updateProject,
  deleteProject,
  getProjectStatus,
  setProjectStatus,
  transferProject,
  transferProjectPreview,
} from "../services/project.service.ts";

export async function handleProjects(
  req: Request,
  path: string,
  method: string,
  pool: Pool,
  profileId: number,
  gotrueId: string,
  email: string,
): Promise<Response> {
  const ip = req.headers.get("x-forwarded-for") ?? req.headers.get("x-real-ip") ?? "unknown";
  const auditContext = { email, ip, method, route: "/projects" + path };

  // POST /projects — create project
  if (method === "POST" && path === "/") {
    const body = await req.json();
    if (!body.name || !body.organization_slug) {
      return Response.json(
        { message: "name and organization_slug are required" },
        { status: 400, headers: corsHeaders },
      );
    }
    const project = await createProject(pool, profileId, gotrueId, body, auditContext);
    if (!project) {
      return Response.json(
        { message: "Organization not found or not a member" },
        { status: 404, headers: corsHeaders },
      );
    }
    return Response.json(project, { status: 201, headers: corsHeaders });
  }

  // Delegate billing sub-paths before other matching
  const billingMatch = path.match(/^\/([^/]+)(\/billing.*)$/);
  if (billingMatch && pool) {
    return handleProjectBilling(req, billingMatch[2], method, pool, billingMatch[1]);
  }

  // GET /projects — paginated list
  if (method === "GET" && path === "/") {
    const url = new URL(req.url);
    const limit = parseInt(url.searchParams.get("limit") || "100", 10);
    const offset = parseInt(url.searchParams.get("offset") || "0", 10);
    const result = await listProjectsPaginated(pool, profileId, limit, offset);
    return Response.json(result, { headers: corsHeaders });
  }

  // GET /projects/{ref} — project detail (must be exact match, not sub-resource)
  const refOnlyMatch = path.match(/^\/([^/]+)$/);
  if (method === "GET" && refOnlyMatch) {
    const ref = refOnlyMatch[1];
    const project = await getProjectByRef(pool, ref, profileId);
    if (!project) {
      return Response.json({ message: "Project not found" }, { status: 404, headers: corsHeaders });
    }
    return Response.json(project, { headers: corsHeaders });
  }

  // PATCH /projects/{ref} — update project
  if (method === "PATCH" && refOnlyMatch) {
    const ref = refOnlyMatch[1];
    const body = await req.json();
    const result = await updateProject(pool, ref, profileId, { name: body.name }, gotrueId, auditContext);
    if (!result) {
      return Response.json({ message: "Project not found" }, { status: 404, headers: corsHeaders });
    }
    return Response.json(result, { headers: corsHeaders });
  }

  // DELETE /projects/{ref} — delete project
  if (method === "DELETE" && refOnlyMatch) {
    const ref = refOnlyMatch[1];
    const result = await deleteProject(pool, ref, profileId, gotrueId, auditContext);
    if (!result) {
      return Response.json({ message: "Project not found" }, { status: 404, headers: corsHeaders });
    }
    return Response.json(result, { headers: corsHeaders });
  }

  // Sub-resource routes: /{ref}/subpath
  const subMatch = path.match(/^\/([^/]+)(\/.+)$/);
  if (subMatch) {
    const ref = subMatch[1];
    const subPath = subMatch[2];

    // POST /{ref}/pause
    if (method === "POST" && subPath === "/pause") {
      const result = await setProjectStatus(pool, ref, profileId, "INACTIVE", gotrueId, auditContext);
      if (!result) {
        return Response.json({ message: "Project not found" }, { status: 404, headers: corsHeaders });
      }
      return Response.json(result, { headers: corsHeaders });
    }

    // POST /{ref}/restore
    if (method === "POST" && subPath === "/restore") {
      const result = await setProjectStatus(pool, ref, profileId, "ACTIVE_HEALTHY", gotrueId, auditContext);
      if (!result) {
        return Response.json({ message: "Project not found" }, { status: 404, headers: corsHeaders });
      }
      return Response.json(result, { headers: corsHeaders });
    }

    // POST /{ref}/restart — no-op
    if (method === "POST" && subPath === "/restart") {
      return Response.json({ message: "ok" }, { headers: corsHeaders });
    }

    // POST /{ref}/restart-services — no-op
    if (method === "POST" && subPath === "/restart-services") {
      return Response.json({ message: "ok" }, { headers: corsHeaders });
    }

    // POST /{ref}/transfer/preview
    if (method === "POST" && subPath === "/transfer/preview") {
      const body = await req.json();
      const result = await transferProjectPreview(pool, ref, profileId, body.target_organization_slug);
      return Response.json(result, { headers: corsHeaders });
    }

    // POST /{ref}/transfer
    if (method === "POST" && subPath === "/transfer") {
      const body = await req.json();
      const result = await transferProject(pool, ref, profileId, body.target_organization_slug, gotrueId, auditContext);
      if (!result) {
        return Response.json({ message: "Transfer failed" }, { status: 400, headers: corsHeaders });
      }
      return Response.json(result, { headers: corsHeaders });
    }

    // PUT /{ref}/content — upsert content item (SQL snippets, reports)
    if ((method === "PUT" || method === "POST") && subPath === "/content") {
      try {
        const body = await req.json();
        const id = body.id || crypto.randomUUID();
        const now = new Date().toISOString();
        return Response.json(
          {
            id,
            project_id: 0,
            owner_id: profileId,
            name: body.name || "New Query",
            description: body.description || "",
            type: body.type || "sql",
            visibility: body.visibility || "user",
            content: body.content || {},
            favorite: body.favorite || false,
            inserted_at: now,
            updated_at: now,
          },
          { headers: corsHeaders },
        );
      } catch {
        return Response.json({ message: "Invalid body" }, { status: 400, headers: corsHeaders });
      }
    }

    // DELETE /{ref}/content — delete content items
    if (method === "DELETE" && subPath === "/content") {
      return Response.json({}, { headers: corsHeaders });
    }

    // GET-only sub-resources
    if (method === "GET") {
      // GET /{ref}/status
      if (subPath === "/status") {
        const status = await getProjectStatus(pool, ref, profileId);
        if (!status) {
          return Response.json({ message: "Project not found" }, { status: 404, headers: corsHeaders });
        }
        return Response.json(status, { headers: corsHeaders });
      }

      // GET /{ref}/pause/status
      if (subPath === "/pause/status") {
        const status = await getProjectStatus(pool, ref, profileId);
        if (!status) {
          return Response.json({ message: "Project not found" }, { status: 404, headers: corsHeaders });
        }
        return Response.json(status, { headers: corsHeaders });
      }

      // GET /{ref}/service-versions — hardcoded
      if (subPath === "/service-versions") {
        return Response.json({}, { headers: corsHeaders });
      }

      // Static sub-resource stubs (preserving existing functionality)
      const subResourceStubs: Record<string, unknown> = {
        "/databases": [
          {
            cloud_provider: "AWS",
            identifier: ref,
            infra_compute_size: "nano",
            region: "local",
            status: "ACTIVE_HEALTHY",
            inserted_at: "2024-01-01T00:00:00Z",
            read_replicas: [],
          },
        ],
        "/databases-statuses": [],
        "/load-balancers": [],
        "/members": [],
        "/run-lints": [],
        "/branches": [],
        "/analytics/log-drains": [],
        "/config/realtime": {},
        "/config/pgbouncer": {},
        "/config/storage": {
          fileSizeLimit: 52428800,
          isFreeTier: true,
          features: {
            imageTransformation: { enabled: false },
            vectorBuckets: { enabled: false },
            icebergCatalog: { enabled: false },
            list_v2: { enabled: true },
          },
        },
        "/config/network-bans": { banned_ipv4_addresses: [], banned_ipv6_addresses: [] },
        "/notifications/advisor/exceptions": [],
        "/content": { data: [] },
        "/content/folders": { data: { folders: [], contents: [] }, cursor: null },
        "/secrets": [],
        "/integrations": [],
      };

      // Dynamic: /config/supavisor — return pooler configuration from env vars
      if (subPath === "/config/supavisor") {
        const tenantId = Deno.env.get("POOLER_TENANT_ID") || ref;
        const poolSize = parseInt(Deno.env.get("POOLER_DEFAULT_POOL_SIZE") || "20", 10);
        const maxClientConn = parseInt(Deno.env.get("POOLER_MAX_CLIENT_CONN") || "100", 10);
        const txPort = parseInt(Deno.env.get("POOLER_PROXY_PORT_TRANSACTION") || "6543", 10);
        const dbName = Deno.env.get("POSTGRES_DB") || "postgres";

        const supavisorConfig = [
          {
            connection_string: `postgres://postgres.[${tenantId}]@supabase-pooler:${txPort}/${dbName}`,
            connectionString: `postgres://postgres.[${tenantId}]@supabase-pooler:${txPort}/${dbName}`,
            database_type: "PRIMARY",
            db_host: "supabase-pooler",
            db_name: dbName,
            db_port: txPort,
            db_user: `postgres.${tenantId}`,
            default_pool_size: poolSize,
            identifier: ref,
            is_using_scram_auth: false,
            max_client_conn: maxClientConn,
            pool_mode: "transaction",
          },
        ];
        return Response.json(supavisorConfig, { headers: corsHeaders });
      }

      const stubData = subResourceStubs[subPath];
      if (stubData !== undefined) {
        return Response.json(stubData, { headers: corsHeaders });
      }
    }
  }

  return Response.json({}, { headers: corsHeaders });
}

// Handler for /v1/projects/{ref}/* (routed separately via Kong)
export async function handleProjectHealth(
  _req: Request,
  path: string,
  method: string,
  pool: Pool,
  profileId: number,
): Promise<Response> {
  // GET /{ref}/health
  const healthMatch = path.match(/^\/([^/]+)\/health$/);
  if (method === "GET" && healthMatch) {
    const ref = healthMatch[1];
    const status = await getProjectStatus(pool, ref, profileId);
    if (!status) {
      return Response.json({ message: "Project not found" }, { status: 404, headers: corsHeaders });
    }

    const healthy = status.status === "ACTIVE_HEALTHY";
    const svcStatus = healthy ? "ACTIVE_HEALTHY" : "UNHEALTHY";

    return Response.json(
      [
        { name: "auth", status: svcStatus },
        { name: "rest", status: svcStatus },
        { name: "realtime", status: svcStatus },
        { name: "storage", status: svcStatus },
        { name: "db", status: svcStatus },
      ],
      { headers: corsHeaders },
    );
  }

  // GET /{ref}/branches — list project branches (stub)
  const branchesMatch = path.match(/^\/([^/]+)\/branches\/?$/);
  if (method === "GET" && branchesMatch) {
    return Response.json([], { headers: corsHeaders });
  }

  // GET /{ref}/api-keys — list API keys
  const apiKeysMatch = path.match(/^\/([^/]+)\/api-keys\/?$/);
  if (method === "GET" && apiKeysMatch) {
    const anonKey = Deno.env.get("SUPABASE_ANON_KEY") || "";
    const serviceKey = Deno.env.get("SUPABASE_SERVICE_KEY") || "";
    return Response.json([
      { name: "anon", api_key: anonKey, tags: "anon,public" },
      { name: "service_role", api_key: serviceKey, tags: "service_role" },
    ], { headers: corsHeaders });
  }

  // GET /{ref}/functions — list edge functions from disk
  const functionsListMatch = path.match(/^\/([^/]+)\/functions\/?$/);
  if (method === "GET" && functionsListMatch) {
    return listEdgeFunctions();
  }

  // GET /{ref}/functions/{slug} — single function detail
  const functionDetailMatch = path.match(/^\/([^/]+)\/functions\/([^/]+)\/?$/);
  if (method === "GET" && functionDetailMatch) {
    const slug = functionDetailMatch[2];
    return getEdgeFunctionBySlug(slug);
  }

  // GET /{ref}/functions/{slug}/body — function source code
  const functionBodyMatch = path.match(/^\/([^/]+)\/functions\/([^/]+)\/body$/);
  if (method === "GET" && functionBodyMatch) {
    const slug = functionBodyMatch[2];
    return getEdgeFunctionBody(slug);
  }

  return Response.json({ message: "Not found" }, { status: 404, headers: corsHeaders });
}

// ── Edge Functions filesystem helpers ──────────────────────

const FUNCTIONS_DIR = "/home/deno/functions";

interface FunctionEntry {
  id: string;
  slug: string;
  name: string;
  version: number;
  status: "ACTIVE" | "REMOVED" | "THROTTLED";
  entrypoint_path: string;
  created_at: number;
  updated_at: number;
  verify_jwt: boolean;
}

async function listEdgeFunctions(): Promise<Response> {
  try {
    const functions: FunctionEntry[] = [];

    for await (const entry of Deno.readDir(FUNCTIONS_DIR)) {
      if (!entry.isDirectory || entry.name === "main" || entry.name === "traffic-one") continue;

      const func = await parseFunctionDir(entry.name);
      if (func) functions.push(func);
    }

    return Response.json(functions, { headers: corsHeaders });
  } catch (err) {
    console.error("listEdgeFunctions error:", err);
    return Response.json([], { headers: corsHeaders });
  }
}

async function getEdgeFunctionBySlug(slug: string): Promise<Response> {
  if (slug === "main" || slug === "traffic-one") {
    return Response.json({ message: "Function not found" }, { status: 404, headers: corsHeaders });
  }

  try {
    const func = await parseFunctionDir(slug);
    if (!func) {
      return Response.json({ message: "Function not found" }, { status: 404, headers: corsHeaders });
    }
    return Response.json(func, { headers: corsHeaders });
  } catch {
    return Response.json({ message: "Function not found" }, { status: 404, headers: corsHeaders });
  }
}

async function getEdgeFunctionBody(slug: string): Promise<Response> {
  if (slug === "main" || slug === "traffic-one") {
    return Response.json({ message: "Function not found" }, { status: 404, headers: corsHeaders });
  }

  const dirPath = `${FUNCTIONS_DIR}/${slug}`;
  try {
    const files: Array<{ name: string; content: string }> = [];

    for await (const entry of Deno.readDir(dirPath)) {
      if (!entry.isFile) continue;
      const content = await Deno.readTextFile(`${dirPath}/${entry.name}`);
      files.push({ name: entry.name, content });
    }

    return Response.json(files, { headers: corsHeaders });
  } catch {
    return Response.json({ message: "Function not found" }, { status: 404, headers: corsHeaders });
  }
}

async function parseFunctionDir(slug: string): Promise<FunctionEntry | null> {
  const dirPath = `${FUNCTIONS_DIR}/${slug}`;

  try {
    const stat = await Deno.stat(dirPath);
    if (!stat.isDirectory) return null;

    let entrypointName = "index.ts";
    for await (const entry of Deno.readDir(dirPath)) {
      if (entry.isFile && entry.name.startsWith("index")) {
        entrypointName = entry.name;
        break;
      }
    }

    const entrypointStat = await Deno.stat(`${dirPath}/${entrypointName}`).catch(() => null);
    const createdAt = entrypointStat?.birthtime?.getTime() ?? stat.mtime?.getTime() ?? Date.now();
    const updatedAt = entrypointStat?.mtime?.getTime() ?? stat.mtime?.getTime() ?? Date.now();

    return {
      id: crypto.randomUUID(),
      slug,
      name: slug,
      version: 1,
      status: "ACTIVE",
      entrypoint_path: entrypointName,
      created_at: createdAt,
      updated_at: updatedAt,
      verify_jwt: false,
    };
  } catch {
    return null;
  }
}
