import type {
  ProjectCredentials,
  ProjectProvisioner,
  ProvisionOpts,
} from "./local.provisioner.ts";

export class ApiProvisioner implements ProjectProvisioner {
  private baseUrl: string;

  constructor() {
    const url = Deno.env.get("PROVISIONER_API_URL");
    if (!url) {
      throw new Error(
        "PROVISIONER_API_URL not configured. " +
        "Set PROJECT_PROVISIONER=local for Docker development mode, " +
        "or set PROVISIONER_API_URL for production API mode."
      );
    }
    this.baseUrl = url.replace(/\/$/, "");
  }

  async provision(ref: string, opts: ProvisionOpts): Promise<ProjectCredentials> {
    const res = await fetch(`${this.baseUrl}/projects`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ ref, region: opts.region, plan: opts.plan }),
    });

    if (!res.ok) {
      const text = await res.text();
      throw new Error(`Provisioner API error (${res.status}): ${text}`);
    }

    const data = await res.json();
    return {
      endpoint: data.endpoint,
      anon_key: data.anon_key,
      service_key: data.service_key,
      db_host: data.db_host,
      db_pass: data.db_pass,
    };
  }

  async deprovision(ref: string): Promise<void> {
    const res = await fetch(`${this.baseUrl}/projects/${ref}`, {
      method: "DELETE",
    });

    if (!res.ok) {
      const text = await res.text();
      throw new Error(`Provisioner API deprovision error (${res.status}): ${text}`);
    }
  }
}
