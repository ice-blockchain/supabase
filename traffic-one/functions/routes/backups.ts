import type { Pool } from "https://deno.land/x/postgres@v0.17.0/mod.ts";
import { corsHeaders } from "../index.ts";
import { getProjectByRef } from "../services/project.service.ts";

const BACKUPS_UNSUPPORTED_MESSAGE =
  "Database backups are not available in self-hosted deployments";

function notSupportedResponse(message = BACKUPS_UNSUPPORTED_MESSAGE): Response {
  return Response.json(
    { code: "self_hosted_unsupported", message },
    { status: 501, headers: corsHeaders },
  );
}

function notFoundResponse(message = "Not Found"): Response {
  return Response.json({ message }, { status: 404, headers: corsHeaders });
}

function methodNotAllowedResponse(): Response {
  return Response.json(
    { message: "Method not allowed" },
    { status: 405, headers: corsHeaders },
  );
}

// ── Handler ────────────────────────────────────────────────

export async function handleBackups(
  req: Request,
  path: string,
  method: string,
  pool: Pool,
  profileId: number,
  _gotrueId: string,
  _email: string,
): Promise<Response> {
  // Extract ref from path: /{ref} or /{ref}/sub-path
  const refMatch = path.match(/^\/([^/]+)(\/.*)?$/);
  if (!refMatch) {
    return notFoundResponse();
  }

  const ref = refMatch[1];
  const subPath = refMatch[2] || "";

  const project = await getProjectByRef(pool, ref, profileId);
  if (!project) {
    return notFoundResponse("Project not found");
  }

  const region = project.region || "local";

  // ── Backups ─────────────────────────────────────────────
  if (subPath === "/backups" || subPath === "") {
    if (method === "GET") {
      return Response.json(
        {
          backups: [],
          physicalBackupData: {},
          pitr_enabled: false,
          region,
          walg_enabled: false,
          tierKey: "FREE",
        },
        { headers: corsHeaders },
      );
    }
    return methodNotAllowedResponse();
  }

  if (subPath === "/backups/downloadable-backups") {
    if (method === "GET") {
      return Response.json(
        { backups: [], status: "ok" },
        { headers: corsHeaders },
      );
    }
    return methodNotAllowedResponse();
  }

  if (subPath === "/backups/download") {
    if (method === "POST") return notSupportedResponse();
    return methodNotAllowedResponse();
  }

  if (subPath === "/backups/restore") {
    if (method === "POST") return notSupportedResponse();
    return methodNotAllowedResponse();
  }

  if (subPath === "/backups/restore-physical") {
    if (method === "POST") return notSupportedResponse();
    return methodNotAllowedResponse();
  }

  if (subPath === "/backups/enable-physical-backups") {
    if (method === "POST") return notSupportedResponse();
    return methodNotAllowedResponse();
  }

  if (subPath === "/backups/pitr") {
    if (method === "POST") return notSupportedResponse();
    return methodNotAllowedResponse();
  }

  // ── Clone ───────────────────────────────────────────────
  if (subPath === "/clone") {
    if (method === "GET") {
      return Response.json(
        {
          backups: [],
          physicalBackupData: {},
          pitr_enabled: false,
          region,
          target_compute_size: "nano",
          target_volume_size_gb: 8,
          walg_enabled: false,
        },
        { headers: corsHeaders },
      );
    }
    if (method === "POST") return notSupportedResponse();
    return methodNotAllowedResponse();
  }

  if (subPath === "/clone/status") {
    if (method === "GET") {
      return Response.json(
        { id: project.id, ref: project.ref, clones: [] },
        { headers: corsHeaders },
      );
    }
    return methodNotAllowedResponse();
  }

  // ── Hooks (Database Webhooks) ───────────────────────────
  if (subPath === "/hook-enable") {
    if (method === "POST") {
      return Response.json({ enabled: true }, { headers: corsHeaders });
    }
    return methodNotAllowedResponse();
  }

  return notFoundResponse();
}
