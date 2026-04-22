import { Pool } from "https://deno.land/x/postgres@v0.17.0/mod.ts";

const TRAFFIC_DB_URL = Deno.env.get("TRAFFIC_DB_URL") ?? Deno.env.get("SUPABASE_DB_URL")!;

export const pool = new Pool(TRAFFIC_DB_URL, 3, true);
