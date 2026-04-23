/**
 * Extracts the trusted client IP from a request.
 *
 * M5: Kong appends its view of the TCP peer to any caller-supplied
 * `X-Forwarded-For` header. Callers therefore control every entry EXCEPT the
 * last one (which Kong writes itself). Reading `req.headers.get('x-forwarded-for')`
 * naively returns the whole comma-separated list, which lets callers spoof
 * audit-log IPs by sending their own XFF header.
 *
 * This helper trusts only Kong's last entry. `x-real-ip` is used as a
 * fallback for environments where Kong is configured to emit only the
 * single-value header, and `unknown` is the final fallback when neither is
 * present (e.g. local `deno serve` without Kong in front).
 *
 * The helper is intentionally pure: it reads `Request.headers` and nothing
 * else, so callers can unit-test it without a live Kong/router in the loop.
 */
export function getClientIp(req: Request): string {
  const xff = req.headers.get('x-forwarded-for')
  if (xff) {
    // Kong's injected value is always the LAST entry. Anything before it may
    // be caller-controlled, so we ignore everything except the tail.
    const parts = xff
      .split(',')
      .map((s) => s.trim())
      .filter(Boolean)
    if (parts.length > 0) {
      return parts[parts.length - 1]
    }
  }
  return req.headers.get('x-real-ip') ?? 'unknown'
}
