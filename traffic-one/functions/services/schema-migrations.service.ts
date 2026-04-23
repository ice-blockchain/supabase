import type { Pool } from "https://deno.land/x/postgres@v0.17.0/mod.ts";

export interface SchemaMigration {
  version: string;
  name: string;
  statements: string[];
}

interface SchemaMigrationRow {
  id: number;
  project_ref: string;
  version: string;
  name: string;
  statements: string[];
  inserted_at: string;
}

interface AuditContext {
  email: string;
  ip: string;
  method: string;
  route: string;
}

export async function listMigrations(
  pool: Pool,
  projectRef: string,
): Promise<SchemaMigration[]> {
  const connection = await pool.connect();
  try {
    const result = await connection.queryObject<SchemaMigrationRow>`
      SELECT id, project_ref, version, name, statements, inserted_at
      FROM traffic.schema_migrations
      WHERE project_ref = ${projectRef}
      ORDER BY version DESC
    `;
    return result.rows.map((row) => ({
      version: row.version,
      name: row.name,
      statements: row.statements ?? [],
    }));
  } finally {
    connection.release();
  }
}

export interface InsertMigrationResult {
  status: "inserted";
  migration: SchemaMigration;
}

export interface ConflictMigrationResult {
  status: "conflict";
  migration: SchemaMigration;
}

export type MigrationInsertOutcome = InsertMigrationResult | ConflictMigrationResult;

export async function insertMigration(
  pool: Pool,
  projectRef: string,
  version: string,
  name: string,
  statements: string[],
  profileId: number,
  organizationId: number,
  gotrueId: string,
  auditContext: AuditContext,
): Promise<MigrationInsertOutcome> {
  const connection = await pool.connect();
  try {
    const tx = connection.createTransaction("insert_schema_migration");
    await tx.begin();

    const existing = await tx.queryObject<SchemaMigrationRow>`
      SELECT id, project_ref, version, name, statements, inserted_at
      FROM traffic.schema_migrations
      WHERE project_ref = ${projectRef} AND version = ${version}
    `;
    if (existing.rows.length > 0) {
      await tx.rollback();
      const row = existing.rows[0];
      return {
        status: "conflict",
        migration: {
          version: row.version,
          name: row.name,
          statements: row.statements ?? [],
        },
      };
    }

    const inserted = await tx.queryObject<SchemaMigrationRow>`
      INSERT INTO traffic.schema_migrations (project_ref, version, name, statements)
      VALUES (${projectRef}, ${version}, ${name}, ${statements})
      RETURNING id, project_ref, version, name, statements, inserted_at
    `;
    const row = inserted.rows[0];

    await tx.queryObject`
      INSERT INTO traffic.audit_logs (
        id, profile_id, organization_id, action_name, action_metadata,
        actor_id, actor_type, actor_metadata,
        target_description, target_metadata, occurred_at
      ) VALUES (
        gen_random_uuid(), ${profileId}, ${organizationId}, 'schema_migrations.insert',
        ${JSON.stringify([{ method: auditContext.method, route: auditContext.route, status: 201 }])}::jsonb,
        ${gotrueId}, 'user',
        ${JSON.stringify([{ email: auditContext.email, ip: auditContext.ip }])}::jsonb,
        ${"schema_migrations #" + row.id + " (ref: " + projectRef + ", version: " + version + ")"},
        ${JSON.stringify({ version, name })}::jsonb,
        now()
      )
    `;

    await tx.commit();

    return {
      status: "inserted",
      migration: {
        version: row.version,
        name: row.name,
        statements: row.statements ?? [],
      },
    };
  } finally {
    connection.release();
  }
}
