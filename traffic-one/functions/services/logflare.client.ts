// ─────────────────────────────────────────────────────────────────────────────
//
// Thin HTTP client for a project's Logflare analytics endpoint. Callers pass
// a `LogflareBackend` (a structural subset of `ProjectBackend`) so the same
// client can target either the shared Docker Logflare in local mode or a
// per-project analytics stack in api mode — the resolver in
// `project-backend.service.ts` picks which one based on
// `traffic.projects.endpoint`.
//
// On any transport / parse error or non-2xx status the returned `result` is
// an empty array so callers can surface `{ result: [] }` to the UI without
// propagating a 5xx.
//
// ─────────────────────────────────────────────────────────────────────────────

export interface LogflareBackend {
  logflareUrl: string
  logflareToken: string
}

export interface LogflareEndpointResult {
  status: number
  result: Record<string, unknown>[]
  raw: unknown
}

export async function queryEndpoint(
  backend: LogflareBackend,
  name: string,
  params: Record<string, string | undefined>,
  body?: unknown,
  method: 'GET' | 'POST' = 'GET',
): Promise<LogflareEndpointResult> {
  if (!backend.logflareUrl) {
    return { status: 0, result: [], raw: null }
  }

  let url: URL
  try {
    url = new URL(`${backend.logflareUrl.replace(/\/$/, '')}/api/endpoints/query/${name}`)
  } catch (err) {
    console.error('Logflare URL construction failed:', err)
    return { status: 0, result: [], raw: null }
  }

  for (const [key, value] of Object.entries(params)) {
    if (typeof value === 'string' && value.length > 0) {
      url.searchParams.set(key, value)
    }
  }

  try {
    const init: RequestInit = {
      method,
      headers: {
        'x-api-key': backend.logflareToken,
        'Content-Type': 'application/json',
      },
    }
    if (method === 'POST' && body !== undefined) {
      init.body = typeof body === 'string' ? body : JSON.stringify(body)
    }

    const res = await fetch(url.toString(), init)

    if (!res.ok) {
      const text = await res.text().catch(() => '')
      console.error(`Logflare endpoint ${name} returned ${res.status}: ${text.slice(0, 400)}`)
      return { status: res.status, result: [], raw: null }
    }

    const data = await res.json().catch((err: unknown) => {
      console.error('Logflare response JSON parse failed:', err)
      return null
    })

    const result = Array.isArray((data as { result?: unknown } | null)?.result)
      ? (data as { result: Record<string, unknown>[] }).result
      : []
    return { status: res.status, result, raw: data }
  } catch (err) {
    console.error(`Logflare endpoint ${name} fetch failed:`, err)
    return { status: 0, result: [], raw: null }
  }
}

export async function queryLogflare(
  backend: LogflareBackend,
  sql: string,
  isoStart: string,
  isoEnd: string,
  sourceName = 'default',
): Promise<Record<string, unknown>[]> {
  const { result } = await queryEndpoint(backend, 'logs.all', {
    project: sourceName,
    sql,
    iso_timestamp_start: isoStart,
    iso_timestamp_end: isoEnd,
  })
  return result
}
