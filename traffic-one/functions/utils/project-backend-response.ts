// M6: Centralize the `ProjectBackendNotProvisionedError` → 501 translation.
//
// Every project-scoped route needs to convert
// `ProjectBackendNotProvisionedError` into a consistent JSON response so
// Studio's error toasts can reliably switch on `code ===
// 'project_backend_not_provisioned'` and surface a "provisioner not wired"
// banner. Before this helper existed every dispatcher hand-rolled its own
// `Response.json({ message, code, missing }, { status: 501 })` call — which
// drifted in subtle ways (some included `missing`, some didn't; some used
// `err.name` instead of `err.code`; one degraded to a fallback payload
// instead).
//
// This module ships a single `notProvisionedResponse(err)` builder and a
// ready-made `assertBackend(...)` wrapper so callers can collapse the
// try/catch down to:
//
//   const backend = await resolveBackendOr501(pool, ref)
//   if (backend instanceof Response) return backend
//
// Keeping it under `utils/` (rather than in the resolver service) avoids
// circular imports with routes that already depend on `project-backend.service`.

import { corsHeaders } from '../index.ts'
import {
  type BackendPool,
  getProjectBackend,
  type ProjectBackend,
  ProjectBackendNotProvisionedError,
} from '../services/project-backend.service.ts'

// The exact body shape every `traffic-one` route emits for a not-provisioned
// backend. Studio keys off `code` first, then falls back to `message`.
export function notProvisionedResponse(err: ProjectBackendNotProvisionedError): Response {
  return Response.json(
    { message: err.message, code: err.code, missing: err.missing },
    { status: 501, headers: corsHeaders },
  )
}

// Convenience wrapper that resolves the backend or converts a
// ProjectBackendNotProvisionedError into the canonical 501 response. All
// other errors propagate so a truly unexpected DB failure still surfaces as
// a 5xx in the outer handler. Callers branch on `instanceof Response`.
export async function resolveBackendOr501(
  pool: BackendPool,
  ref: string,
): Promise<ProjectBackend | Response> {
  try {
    return await getProjectBackend(ref, pool)
  } catch (err) {
    if (err instanceof ProjectBackendNotProvisionedError) {
      return notProvisionedResponse(err)
    }
    throw err
  }
}
