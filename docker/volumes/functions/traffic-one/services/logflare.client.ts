const LOGFLARE_URL = Deno.env.get("LOGFLARE_URL") ?? "http://analytics:4000";
const LOGFLARE_KEY = Deno.env.get("LOGFLARE_PRIVATE_ACCESS_TOKEN") ?? "";

export async function queryLogflare(
  sql: string,
  isoStart: string,
  isoEnd: string,
  projectRef = "default",
): Promise<Record<string, unknown>[]> {
  const url = new URL(`${LOGFLARE_URL}/api/endpoints/query/logs.all`);
  url.searchParams.set("project", projectRef);
  url.searchParams.set("sql", sql);
  url.searchParams.set("iso_timestamp_start", isoStart);
  url.searchParams.set("iso_timestamp_end", isoEnd);

  const res = await fetch(url.toString(), {
    headers: {
      "x-api-key": LOGFLARE_KEY,
      "Content-Type": "application/json",
    },
  });

  if (!res.ok) {
    console.error(`Logflare query failed (${res.status}): ${await res.text()}`);
    return [];
  }

  const data = await res.json();
  return data?.result ?? [];
}
