import type { ProjectCredentials, ProjectProvisioner, ProvisionOpts } from './local.provisioner.ts'

// Thrown when PROJECT_PROVISIONER=api but PROVISIONER_API_URL is missing at
// the time of a provision/deprovision call. Pre-M4 the constructor threw
// directly, which bubbled up to the generic Edge Function handler and
// surfaced as an opaque 500 for every /projects request. Deferring the check
// to the call sites lets route handlers translate it into a structured 503
// (`provisioner_unconfigured`) that Studio can render as a config-miss toast.
export class ProvisionerNotConfiguredError extends Error {
  override name = 'ProvisionerNotConfiguredError'
  code = 'provisioner_unconfigured'

  constructor(message: string) {
    super(message)
  }
}

export class ApiProvisioner implements ProjectProvisioner {
  private readonly configuredBaseUrl: string | null

  constructor() {
    const url = Deno.env.get('PROVISIONER_API_URL')
    // Defer the missing-config error so constructing a provisioner doesn't
    // take down routes that never end up hitting it (e.g. GET /projects).
    this.configuredBaseUrl = url ? url.replace(/\/$/, '') : null
  }

  private baseUrl(): string {
    if (this.configuredBaseUrl === null) {
      throw new ProvisionerNotConfiguredError(
        'PROVISIONER_API_URL not configured. ' +
          'Set PROJECT_PROVISIONER=local for Docker development mode, ' +
          'or set PROVISIONER_API_URL for production API mode.',
      )
    }
    return this.configuredBaseUrl
  }

  async provision(ref: string, opts: ProvisionOpts): Promise<ProjectCredentials> {
    const base = this.baseUrl()
    const res = await fetch(`${base}/projects`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ ref, region: opts.region, plan: opts.plan }),
    })

    if (!res.ok) {
      const text = await res.text()
      throw new Error(`Provisioner API error (${res.status}): ${text}`)
    }

    const data = await res.json()
    return {
      endpoint: data.endpoint,
      anon_key: data.anon_key,
      service_key: data.service_key,
      db_host: data.db_host,
      db_pass: data.db_pass,
    }
  }

  async deprovision(ref: string): Promise<void> {
    const base = this.baseUrl()
    const res = await fetch(`${base}/projects/${ref}`, {
      method: 'DELETE',
    })

    if (!res.ok) {
      const text = await res.text()
      throw new Error(`Provisioner API deprovision error (${res.status}): ${text}`)
    }
  }
}
