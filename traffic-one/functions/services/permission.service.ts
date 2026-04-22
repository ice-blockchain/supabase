import type { Pool } from "https://deno.land/x/postgres@v0.17.0/mod.ts";

export interface StudioPermission {
  actions: string[];
  resources: string[];
  condition: null;
  organization_slug: string;
  restrictive: boolean;
  project_refs: string[];
}

/**
 * Returns the effective permissions for a user in the format Studio expects.
 * Queries organization_members to return one wildcard permission entry per org
 * the user belongs to. Falls back to a "default" entry if the user has no orgs
 * (backwards-compatible with the pre-organizations flow).
 */
export async function getPermissions(
  pool: Pool,
  profileId: number,
): Promise<StudioPermission[]> {
  const connection = await pool.connect();
  try {
    const result = await connection.queryObject<{ slug: string }>`
      SELECT o.slug
      FROM traffic.organizations o
      JOIN traffic.organization_members m ON m.organization_id = o.id
      WHERE m.profile_id = ${profileId}
      ORDER BY o.created_at ASC
    `;

    const slugs = result.rows.map((r) => r.slug);

    if (slugs.length === 0) {
      return [
        {
          actions: ["%"],
          resources: ["%"],
          condition: null,
          organization_slug: "default",
          restrictive: false,
          project_refs: [],
        },
      ];
    }

    return slugs.map((slug) => ({
      actions: ["%"],
      resources: ["%"],
      condition: null,
      organization_slug: slug,
      restrictive: false,
      project_refs: [],
    }));
  } finally {
    connection.release();
  }
}
