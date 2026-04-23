const LOGFLARE_URL = Deno.env.get('LOGFLARE_URL') ?? 'http://analytics:4000'
const LOGFLARE_KEY = Deno.env.get('LOGFLARE_PRIVATE_ACCESS_TOKEN') ?? ''

export interface LogflareEndpointResult {
  status: number
  result: Record<string, unknown>[]
  raw: unknown
}

/**
 * Low-level helper that proxies a Logflare endpoint query.
 *
 * On any transport/parse error or non-2xx status the returned `result` is an
 * empty array so callers can surface `{ result: [] }` to the UI without
 * propagating a 5xx.
 */
export async function queryEndpoint(
  name: string,
  params: Record<string, string | undefined>,
  body?: unknown,
  method: 'GET' | 'POST' = 'GET'
): Promise<LogflareEndpointResult> {
  let url: URL
  try {
    url = new URL(`${LOGFLARE_URL}/api/endpoints/query/${name}`)
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
        'x-api-key': LOGFLARE_KEY,
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
  sql: string,
  isoStart: string,
  isoEnd: string,
  projectRef = 'default'
): Promise<Record<string, unknown>[]> {
  const { result } = await queryEndpoint('logs.all', {
    project: projectRef,
    sql,
    iso_timestamp_start: isoStart,
    iso_timestamp_end: isoEnd,
  })
  return result
}
