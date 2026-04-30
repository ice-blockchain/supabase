// M11: shared request-body size limits for every project-scoped proxy
// handler that forwards JSON to a downstream Supabase service.
//
// Without this guard a malicious (or buggy) client could POST an
// arbitrarily-large body and hold open an outbound connection to GoTrue /
// pg-meta / Logflare, amplifying a resource-exhaustion attack. Each
// dispatcher calls `enforceBodyLimit(req, MAX_*)` BEFORE parsing JSON /
// forwarding the body; on overflow we emit a canonical RFC-9110 413 and
// never touch the upstream.
//
// Limits are conservative defaults:
//   - auth-admin     : 64 KiB   (user records, invite payloads)
//   - pg-meta /query : 1 MiB    (Studio SQL editor; typical queries ≪ 1MB)
//   - analytics      : 256 KiB  (logflare JSON payloads, GraphQL queries)
//
// Override at the route level if a specific surface genuinely needs more.

import { corsHeaders } from '../index.ts'

export const MAX_BODY_AUTH_ADMIN = 64 * 1024
export const MAX_BODY_PG_META = 1 * 1024 * 1024
export const MAX_BODY_ANALYTICS = 256 * 1024

export interface BodyLimitExceeded {
  response: Response
}

// If the request's Content-Length header declares a body larger than
// `maxBytes`, or if we stream more than `maxBytes` out of the body, return
// a ready-made 413 Response. Returns `null` on success (caller should then
// continue with its usual body-parsing path).
//
// We peek at the header first so the fast path (oversized but honest
// clients) never pays the streaming cost. For chunked / unknown-length
// bodies we fall through to a streamed cap in `readBodyWithLimit`.
export function checkContentLengthHeader(req: Request, maxBytes: number): Response | null {
  const raw = req.headers.get('Content-Length')
  if (!raw) return null
  const declared = Number(raw)
  if (Number.isFinite(declared) && declared > maxBytes) {
    return bodyTooLargeResponse(declared, maxBytes)
  }
  return null
}

// Streams the request body while enforcing a hard byte cap, then returns
// the accumulated UTF-8 text (empty string on no body). Throws via a
// thrown Response so the caller can `catch (r) if (r instanceof Response)
// return r`. Returning a union would leak into every call-site and break
// existing `await req.text()` / `readJsonBody` flows.
export async function readBodyWithLimit(req: Request, maxBytes: number): Promise<string> {
  const preflight = checkContentLengthHeader(req, maxBytes)
  if (preflight) throw preflight

  if (!req.body) return ''

  const reader = req.body.getReader()
  const decoder = new TextDecoder()
  let total = 0
  let text = ''
  while (true) {
    const { value, done } = await reader.read()
    if (done) break
    if (value) {
      total += value.byteLength
      if (total > maxBytes) {
        // Cancel the underlying stream so we don't keep downloading.
        try {
          await reader.cancel()
        } catch {
          // If cancel races with the producer, we've already bailed.
        }
        throw bodyTooLargeResponse(total, maxBytes)
      }
      text += decoder.decode(value, { stream: true })
    }
  }
  text += decoder.decode()
  return text
}

function bodyTooLargeResponse(actualBytes: number, maxBytes: number): Response {
  return Response.json(
    {
      code: 'request_body_too_large',
      message: `Request body exceeds the ${maxBytes}-byte limit for this surface` +
        (Number.isFinite(actualBytes) ? ` (got ${actualBytes} bytes)` : ''),
      max_bytes: maxBytes,
    },
    { status: 413, headers: corsHeaders },
  )
}
