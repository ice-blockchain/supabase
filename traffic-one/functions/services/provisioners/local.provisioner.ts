export interface ProjectCredentials {
  endpoint: string
  anon_key: string
  service_key: string
  db_host: string
  db_pass: string
}

export interface ProvisionOpts {
  region?: string
  plan?: string
  db_pass?: string
}

export interface ProjectProvisioner {
  provision(ref: string, opts: ProvisionOpts): Promise<ProjectCredentials>
  deprovision(ref: string): Promise<void>
}

export class LocalProvisioner implements ProjectProvisioner {
  // deno-lint-ignore require-await
  async provision(_ref: string, opts: ProvisionOpts): Promise<ProjectCredentials> {
    return {
      endpoint: Deno.env.get('SUPABASE_URL') || 'http://kong:8000',
      anon_key: Deno.env.get('SUPABASE_ANON_KEY') || '',
      service_key: Deno.env.get('SUPABASE_SERVICE_ROLE_KEY') || '',
      db_host: Deno.env.get('POSTGRES_HOST') || 'db',
      db_pass: opts.db_pass || Deno.env.get('POSTGRES_PASSWORD') || '',
    }
  }

  async deprovision(_ref: string): Promise<void> {
    // Local mode: no-op, all projects share the same Docker instance
  }
}
