import type { Pool } from "https://deno.land/x/postgres@v0.17.0/mod.ts";
import type {
  CreateProjectBody,
  CreateProjectResponse,
  ProjectDetailResponse,
  ListProjectsPaginatedResponse,
  OrganizationProjectsResponse,
  RemoveProjectResponse,
} from "../types/api.ts";
import type { ProjectProvisioner } from "./provisioners/local.provisioner.ts";
import { LocalProvisioner } from "./provisioners/local.provisioner.ts";
import { ApiProvisioner } from "./provisioners/api.provisioner.ts";

interface ProjectRow {
  id: number;
  ref: string;
  name: string;
  organization_id: number;
  region: string;
  cloud_provider: string;
  status: string;
  endpoint: string | null;
  anon_key: string | null;
  db_host: string | null;
  service_key_secret_id: string | null;
  db_pass_secret_id: string | null;
  connection_string_secret_id: string | null;
  created_at: string;
  updated_at: string;
}

interface ProjectWithSlugRow extends ProjectRow {
  organization_slug: string;
}

interface AuditContext {
  email: string;
  ip: string;
  method: string;
  route: string;
}

function generateRef(): string {
  const bytes = new Uint8Array(10);
  crypto.getRandomValues(bytes);
  return Array.from(bytes).map((b) => b.toString(16).padStart(2, "0")).join("");
}

function getProvisioner(): ProjectProvisioner {
  const mode = Deno.env.get("PROJECT_PROVISIONER") || "local";
  if (mode === "api") {
    return new ApiProvisioner();
  }
  return new LocalProvisioner();
}

function isLocalMode(): boolean {
  return (Deno.env.get("PROJECT_PROVISIONER") || "local") === "local";
}

// ── Create ────────────────────────────────────────────────

export async function createProject(
  pool: Pool,
  profileId: number,
  gotrueId: string,
  body: CreateProjectBody,
  auditContext: AuditContext,
): Promise<CreateProjectResponse | null> {
  const connection = await pool.connect();
  try {
    const tx = connection.createTransaction("create_project");
    await tx.begin();

    // Verify org membership
    const orgResult = await tx.queryObject<{ id: number; slug: string }>`
      SELECT o.id, o.slug
      FROM traffic.organizations o
      JOIN traffic.organization_members m ON m.organization_id = o.id
      WHERE o.slug = ${body.organization_slug} AND m.profile_id = ${profileId}
    `;
    if (orgResult.rows.length === 0) {
      await tx.rollback();
      return null;
    }
    const org = orgResult.rows[0];

    const ref = generateRef();
    const provisioner = getProvisioner();
    const credentials = await provisioner.provision(ref, {
      region: body.db_region,
      plan: body.plan,
      db_pass: body.db_pass,
    });

    const status = isLocalMode() ? "ACTIVE_HEALTHY" : "COMING_UP";
    const connString = `postgresql://postgres:${credentials.db_pass}@${credentials.db_host}:5432/postgres`;

    // Store sensitive credentials in Vault
    const serviceKeySecret = await tx.queryObject<{ id: string }>`
      SELECT vault.create_secret(${credentials.service_key}, ${"project_" + ref + "_service_key"}, 'Service role key') AS id
    `;
    const dbPassSecret = await tx.queryObject<{ id: string }>`
      SELECT vault.create_secret(${credentials.db_pass}, ${"project_" + ref + "_db_pass"}, 'Database password') AS id
    `;
    const connStringSecret = await tx.queryObject<{ id: string }>`
      SELECT vault.create_secret(${connString}, ${"project_" + ref + "_conn_string"}, 'Connection string') AS id
    `;

    const projectResult = await tx.queryObject<ProjectRow>`
      INSERT INTO traffic.projects (
        ref, name, organization_id, region, cloud_provider, status,
        endpoint, anon_key, db_host,
        service_key_secret_id, db_pass_secret_id, connection_string_secret_id
      ) VALUES (
        ${ref}, ${body.name}, ${org.id},
        ${body.db_region || "local"}, ${body.cloud_provider || "FLY"}, ${status},
        ${credentials.endpoint}, ${credentials.anon_key}, ${credentials.db_host},
        ${serviceKeySecret.rows[0].id}::uuid,
        ${dbPassSecret.rows[0].id}::uuid,
        ${connStringSecret.rows[0].id}::uuid
      )
      RETURNING *
    `;
    const project = projectResult.rows[0];

    // Audit log
    await tx.queryObject`
      INSERT INTO traffic.audit_logs (
        id, profile_id, organization_id, action_name, action_metadata,
        actor_id, actor_type, actor_metadata,
        target_description, target_metadata, occurred_at
      ) VALUES (
        gen_random_uuid(), ${profileId}, ${org.id}, 'projects.insert',
        ${JSON.stringify([{ method: auditContext.method, route: auditContext.route, status: 201 }])}::jsonb,
        ${gotrueId}, 'user',
        ${JSON.stringify([{ email: auditContext.email, ip: auditContext.ip }])}::jsonb,
        ${"projects #" + project.id + " (ref: " + ref + ")"}, '{}'::jsonb, now()
      )
    `;

    await tx.commit();

    return {
      id: project.id,
      ref: project.ref,
      name: project.name,
      status: project.status,
      endpoint: credentials.endpoint,
      anon_key: credentials.anon_key,
      service_key: credentials.service_key,
      organization_id: org.id,
      organization_slug: org.slug,
      region: project.region,
      cloud_provider: project.cloud_provider,
      is_branch_enabled: false,
      is_physical_backups_enabled: false,
      preview_branch_refs: [],
      subscription_id: null,
      inserted_at: project.created_at,
    };
  } finally {
    connection.release();
  }
}

// ── Get by ref ────────────────────────────────────────────

export async function getProjectByRef(
  pool: Pool,
  ref: string,
  profileId: number,
): Promise<ProjectDetailResponse | null> {
  const connection = await pool.connect();
  try {
    const result = await connection.queryObject<ProjectRow>`
      SELECT p.*
      FROM traffic.projects p
      JOIN traffic.organization_members m ON m.organization_id = p.organization_id
      WHERE p.ref = ${ref} AND m.profile_id = ${profileId}
    `;
    if (result.rows.length === 0) return null;
    const project = result.rows[0];

    let connectionString: string | null = null;
    if (project.connection_string_secret_id) {
      const secretResult = await connection.queryObject<{ decrypted_secret: string }>`
        SELECT decrypted_secret FROM vault.decrypted_secrets
        WHERE id = ${project.connection_string_secret_id}::uuid
      `;
      if (secretResult.rows.length > 0) {
        connectionString = secretResult.rows[0].decrypted_secret;
      }
    }

    return {
      id: project.id,
      ref: project.ref,
      name: project.name,
      status: project.status,
      cloud_provider: project.cloud_provider,
      region: project.region,
      organization_id: project.organization_id,
      db_host: project.db_host || "",
      connectionString,
      restUrl: (project.endpoint || "") + "/rest/v1/",
      high_availability: false,
      is_branch_enabled: false,
      is_physical_backups_enabled: false,
      subscription_id: "default",
      inserted_at: project.created_at,
      updated_at: project.updated_at,
    };
  } finally {
    connection.release();
  }
}

// ── List all user's projects (paginated) ──────────────────

export async function listProjectsPaginated(
  pool: Pool,
  profileId: number,
  limit = 100,
  offset = 0,
): Promise<ListProjectsPaginatedResponse> {
  const connection = await pool.connect();
  try {
    const countResult = await connection.queryObject<{ count: number }>`
      SELECT COUNT(*)::int AS count
      FROM traffic.projects p
      JOIN traffic.organization_members m ON m.organization_id = p.organization_id
      WHERE m.profile_id = ${profileId}
    `;
    const count = countResult.rows[0].count;

    const result = await connection.queryObject<ProjectWithSlugRow>`
      SELECT p.*, o.slug AS organization_slug
      FROM traffic.projects p
      JOIN traffic.organizations o ON o.id = p.organization_id
      JOIN traffic.organization_members m ON m.organization_id = p.organization_id
      WHERE m.profile_id = ${profileId}
      ORDER BY p.created_at ASC
      LIMIT ${limit} OFFSET ${offset}
    `;

    return {
      pagination: { count, limit, offset },
      projects: result.rows.map((row) => ({
        id: row.id,
        ref: row.ref,
        name: row.name,
        status: row.status,
        region: row.region,
        cloud_provider: row.cloud_provider,
        organization_id: row.organization_id,
        organization_slug: row.organization_slug,
        is_branch_enabled: false,
        is_physical_backups_enabled: false,
        preview_branch_refs: [],
        subscription_id: null,
        inserted_at: row.created_at,
      })),
    };
  } finally {
    connection.release();
  }
}

// ── List org projects ─────────────────────────────────────

export async function listOrgProjects(
  pool: Pool,
  orgId: number,
  limit = 100,
  offset = 0,
): Promise<OrganizationProjectsResponse> {
  const connection = await pool.connect();
  try {
    const countResult = await connection.queryObject<{ count: number }>`
      SELECT COUNT(*)::int AS count FROM traffic.projects WHERE organization_id = ${orgId}
    `;
    const count = countResult.rows[0].count;

    const result = await connection.queryObject<ProjectRow>`
      SELECT * FROM traffic.projects
      WHERE organization_id = ${orgId}
      ORDER BY created_at ASC
      LIMIT ${limit} OFFSET ${offset}
    `;

    return {
      pagination: { count, limit, offset },
      projects: result.rows.map((row) => ({
        ref: row.ref,
        name: row.name,
        status: row.status,
        region: row.region,
        cloud_provider: row.cloud_provider,
        inserted_at: row.created_at,
        is_branch: false,
        databases: [
          {
            identifier: row.ref,
            infra_compute_size: "nano",
            region: row.region,
            status: row.status,
            type: "PRIMARY",
            cloud_provider: row.cloud_provider,
          },
        ],
      })),
    };
  } finally {
    connection.release();
  }
}

// ── Update ────────────────────────────────────────────────

export async function updateProject(
  pool: Pool,
  ref: string,
  profileId: number,
  updates: { name?: string },
  gotrueId: string,
  auditContext: AuditContext,
): Promise<RemoveProjectResponse | null> {
  const connection = await pool.connect();
  try {
    const tx = connection.createTransaction("update_project");
    await tx.begin();

    const membership = await tx.queryObject<{ organization_id: number }>`
      SELECT p.organization_id
      FROM traffic.projects p
      JOIN traffic.organization_members m ON m.organization_id = p.organization_id
      WHERE p.ref = ${ref} AND m.profile_id = ${profileId}
    `;
    if (membership.rows.length === 0) {
      await tx.rollback();
      return null;
    }

    const result = await tx.queryObject<ProjectRow>`
      UPDATE traffic.projects
      SET name = COALESCE(${updates.name ?? null}, name), updated_at = now()
      WHERE ref = ${ref}
      RETURNING *
    `;
    if (result.rows.length === 0) {
      await tx.rollback();
      return null;
    }
    const project = result.rows[0];

    await tx.queryObject`
      INSERT INTO traffic.audit_logs (
        id, profile_id, organization_id, action_name, action_metadata,
        actor_id, actor_type, actor_metadata,
        target_description, target_metadata, occurred_at
      ) VALUES (
        gen_random_uuid(), ${profileId}, ${project.organization_id}, 'projects.update',
        ${JSON.stringify([{ method: auditContext.method, route: auditContext.route, status: 200 }])}::jsonb,
        ${gotrueId}, 'user',
        ${JSON.stringify([{ email: auditContext.email, ip: auditContext.ip }])}::jsonb,
        ${"projects #" + project.id + " (ref: " + ref + ")"}, '{}'::jsonb, now()
      )
    `;

    await tx.commit();
    return { id: project.id, ref: project.ref, name: project.name, status: project.status };
  } finally {
    connection.release();
  }
}

// ── Delete ────────────────────────────────────────────────

export async function deleteProject(
  pool: Pool,
  ref: string,
  profileId: number,
  gotrueId: string,
  auditContext: AuditContext,
): Promise<RemoveProjectResponse | null> {
  const connection = await pool.connect();
  try {
    const tx = connection.createTransaction("delete_project");
    await tx.begin();

    const projectResult = await tx.queryObject<ProjectRow>`
      SELECT p.*
      FROM traffic.projects p
      JOIN traffic.organization_members m ON m.organization_id = p.organization_id
      WHERE p.ref = ${ref} AND m.profile_id = ${profileId}
    `;
    if (projectResult.rows.length === 0) {
      await tx.rollback();
      return null;
    }
    const project = projectResult.rows[0];

    // Clean up Vault secrets
    if (project.service_key_secret_id) {
      await tx.queryObject`DELETE FROM vault.secrets WHERE id = ${project.service_key_secret_id}::uuid`;
    }
    if (project.db_pass_secret_id) {
      await tx.queryObject`DELETE FROM vault.secrets WHERE id = ${project.db_pass_secret_id}::uuid`;
    }
    if (project.connection_string_secret_id) {
      await tx.queryObject`DELETE FROM vault.secrets WHERE id = ${project.connection_string_secret_id}::uuid`;
    }

    await tx.queryObject`
      INSERT INTO traffic.audit_logs (
        id, profile_id, organization_id, action_name, action_metadata,
        actor_id, actor_type, actor_metadata,
        target_description, target_metadata, occurred_at
      ) VALUES (
        gen_random_uuid(), ${profileId}, ${project.organization_id}, 'projects.delete',
        ${JSON.stringify([{ method: auditContext.method, route: auditContext.route, status: 200 }])}::jsonb,
        ${gotrueId}, 'user',
        ${JSON.stringify([{ email: auditContext.email, ip: auditContext.ip }])}::jsonb,
        ${"projects #" + project.id + " (ref: " + ref + ")"}, '{}'::jsonb, now()
      )
    `;

    await tx.queryObject`DELETE FROM traffic.projects WHERE id = ${project.id}`;

    try {
      const provisioner = getProvisioner();
      await provisioner.deprovision(ref);
    } catch (err) {
      console.error("Provisioner deprovision warning:", err);
    }

    await tx.commit();
    return { id: project.id, ref: project.ref, name: project.name, status: project.status };
  } finally {
    connection.release();
  }
}

// ── Status ────────────────────────────────────────────────

export async function getProjectStatus(
  pool: Pool,
  ref: string,
  profileId: number,
): Promise<{ status: string } | null> {
  const connection = await pool.connect();
  try {
    const result = await connection.queryObject<{ status: string }>`
      SELECT p.status
      FROM traffic.projects p
      JOIN traffic.organization_members m ON m.organization_id = p.organization_id
      WHERE p.ref = ${ref} AND m.profile_id = ${profileId}
    `;
    if (result.rows.length === 0) return null;
    return { status: result.rows[0].status };
  } finally {
    connection.release();
  }
}

// ── Set status (pause/restore) ────────────────────────────

export async function setProjectStatus(
  pool: Pool,
  ref: string,
  profileId: number,
  newStatus: string,
  gotrueId: string,
  auditContext: AuditContext,
): Promise<RemoveProjectResponse | null> {
  const connection = await pool.connect();
  try {
    const tx = connection.createTransaction("set_project_status");
    await tx.begin();

    const projectResult = await tx.queryObject<ProjectRow>`
      SELECT p.*
      FROM traffic.projects p
      JOIN traffic.organization_members m ON m.organization_id = p.organization_id
      WHERE p.ref = ${ref} AND m.profile_id = ${profileId}
    `;
    if (projectResult.rows.length === 0) {
      await tx.rollback();
      return null;
    }

    const result = await tx.queryObject<ProjectRow>`
      UPDATE traffic.projects SET status = ${newStatus}, updated_at = now()
      WHERE ref = ${ref}
      RETURNING *
    `;
    const project = result.rows[0];

    const actionName = newStatus === "INACTIVE" ? "projects.pause" : "projects.restore";
    await tx.queryObject`
      INSERT INTO traffic.audit_logs (
        id, profile_id, organization_id, action_name, action_metadata,
        actor_id, actor_type, actor_metadata,
        target_description, target_metadata, occurred_at
      ) VALUES (
        gen_random_uuid(), ${profileId}, ${project.organization_id}, ${actionName},
        ${JSON.stringify([{ method: auditContext.method, route: auditContext.route, status: 200 }])}::jsonb,
        ${gotrueId}, 'user',
        ${JSON.stringify([{ email: auditContext.email, ip: auditContext.ip }])}::jsonb,
        ${"projects #" + project.id + " (ref: " + ref + ")"}, '{}'::jsonb, now()
      )
    `;

    await tx.commit();
    return { id: project.id, ref: project.ref, name: project.name, status: project.status };
  } finally {
    connection.release();
  }
}

// ── Transfer ──────────────────────────────────────────────

export async function transferProjectPreview(
  pool: Pool,
  ref: string,
  profileId: number,
  targetOrgSlug: string,
): Promise<{ valid: boolean; message?: string }> {
  const connection = await pool.connect();
  try {
    // Check source project membership
    const projectResult = await connection.queryObject<{ organization_id: number }>`
      SELECT p.organization_id
      FROM traffic.projects p
      JOIN traffic.organization_members m ON m.organization_id = p.organization_id
      WHERE p.ref = ${ref} AND m.profile_id = ${profileId}
    `;
    if (projectResult.rows.length === 0) {
      return { valid: false, message: "Project not found or not a member" };
    }

    // Check target org membership
    const targetOrg = await connection.queryObject<{ id: number }>`
      SELECT o.id
      FROM traffic.organizations o
      JOIN traffic.organization_members m ON m.organization_id = o.id
      WHERE o.slug = ${targetOrgSlug} AND m.profile_id = ${profileId}
    `;
    if (targetOrg.rows.length === 0) {
      return { valid: false, message: "Target organization not found or not a member" };
    }

    return { valid: true };
  } finally {
    connection.release();
  }
}

export async function transferProject(
  pool: Pool,
  ref: string,
  profileId: number,
  targetOrgSlug: string,
  gotrueId: string,
  auditContext: AuditContext,
): Promise<RemoveProjectResponse | null> {
  const connection = await pool.connect();
  try {
    const tx = connection.createTransaction("transfer_project");
    await tx.begin();

    const projectResult = await tx.queryObject<ProjectRow>`
      SELECT p.*
      FROM traffic.projects p
      JOIN traffic.organization_members m ON m.organization_id = p.organization_id
      WHERE p.ref = ${ref} AND m.profile_id = ${profileId}
    `;
    if (projectResult.rows.length === 0) {
      await tx.rollback();
      return null;
    }

    const targetOrg = await tx.queryObject<{ id: number }>`
      SELECT o.id
      FROM traffic.organizations o
      JOIN traffic.organization_members m ON m.organization_id = o.id
      WHERE o.slug = ${targetOrgSlug} AND m.profile_id = ${profileId}
    `;
    if (targetOrg.rows.length === 0) {
      await tx.rollback();
      return null;
    }

    const result = await tx.queryObject<ProjectRow>`
      UPDATE traffic.projects
      SET organization_id = ${targetOrg.rows[0].id}, updated_at = now()
      WHERE ref = ${ref}
      RETURNING *
    `;
    const project = result.rows[0];

    await tx.queryObject`
      INSERT INTO traffic.audit_logs (
        id, profile_id, organization_id, action_name, action_metadata,
        actor_id, actor_type, actor_metadata,
        target_description, target_metadata, occurred_at
      ) VALUES (
        gen_random_uuid(), ${profileId}, ${targetOrg.rows[0].id}, 'projects.transfer',
        ${JSON.stringify([{ method: auditContext.method, route: auditContext.route, status: 200 }])}::jsonb,
        ${gotrueId}, 'user',
        ${JSON.stringify([{ email: auditContext.email, ip: auditContext.ip }])}::jsonb,
        ${"projects #" + project.id + " (ref: " + ref + ")"}, '{}'::jsonb, now()
      )
    `;

    await tx.commit();
    return { id: project.id, ref: project.ref, name: project.name, status: project.status };
  } finally {
    connection.release();
  }
}
