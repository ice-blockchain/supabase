import { assert, assertEquals } from "jsr:@std/assert@1";
import "jsr:@std/dotenv/load";
import { getPermissions } from "../../functions/services/permission.service.ts";
import { Pool } from "https://deno.land/x/postgres@v0.17.0/mod.ts";

const pool = new Pool(Deno.env.get("TRAFFIC_DB_URL")!, 1, true);

Deno.test("getPermissions returns default permissions for any user", async () => {
  const permissions = await getPermissions(pool, 1);

  assert(Array.isArray(permissions));
  assert(permissions.length > 0);
  assert(permissions.includes("organizations_read"));
  assert(permissions.includes("projects_read"));
  assert(permissions.includes("organization_admin_read"));
  assert(permissions.includes("members_read"));
});

Deno.test("getPermissions includes all expected permission types", async () => {
  const permissions = await getPermissions(pool, 1);

  const expectedPermissions = [
    "organizations_read",
    "organizations_create",
    "projects_read",
    "snippets_read",
    "organization_admin_read",
    "organization_admin_write",
    "members_read",
    "members_write",
    "organization_projects_read",
    "organization_projects_create",
    "project_admin_read",
    "project_admin_write",
    "action_runs_read",
    "action_runs_write",
    "advisors_read",
  ];

  assertEquals(permissions.length, expectedPermissions.length);
  for (const p of expectedPermissions) {
    assert(permissions.includes(p as typeof permissions[number]), `Missing permission: ${p}`);
  }
});
