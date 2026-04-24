// L4: project-ref input validation.
//
// Every per-project handler extracts a project `ref` out of the URL path
// (or in the case of `/organizations/{slug}/usage`, out of a query
// parameter) and threads it straight into `getProjectByRef` /
// `getProjectBackend`. The extraction regex in each route only rejects
// `/` characters, so without an additional check an attacker could
// pass a ref containing e.g. `..`, backslashes, URL-encoded slashes, or
// unexpected whitespace. That would never match a real row — but the
// extra surface is easy to close up with a simple format check.
//
// Policy:
//   - Supabase project refs issued by `project.service.ts#generateRef()`
//     are 20 lowercase hex characters (`[a-f0-9]{20}`).
//   - Cloud refs historically widen that to 20 lowercase alphanumerics
//     (`[a-z0-9]{20}`). We accept the union to keep test fixtures like
//     `nonexistent00000000` working.
//   - Anything else is a client error (400) — it cannot correspond to a
//     real project, so returning 404 "project not found" would be
//     slightly misleading.
//
// Callers pass `assertValidRef(ref) ?? continue…`: the helper returns a
// 400 `Response` when the ref is malformed, or `null` when it is OK.
// That lets handlers write `const bad = assertValidRef(ref); if (bad) return bad`
// without importing a separate error class or catching an exception.

import { corsHeaders } from '../index.ts'

const REF_REGEX = /^[a-z0-9]{20}$/

export function isValidRef(ref: string): boolean {
  return REF_REGEX.test(ref)
}

export function invalidRefResponse(): Response {
  return Response.json(
    {
      code: 'invalid_project_ref',
      message: 'project_ref must be 20 lowercase alphanumeric characters',
    },
    { status: 400, headers: corsHeaders },
  )
}

// Returns `null` when the ref is well-formed, or a ready-to-return 400
// Response otherwise. Intended use:
//
//   const bad = assertValidRef(ref)
//   if (bad) return bad
//   // proceed with getProjectByRef / getProjectBackend
export function assertValidRef(ref: string): Response | null {
  return isValidRef(ref) ? null : invalidRefResponse()
}
