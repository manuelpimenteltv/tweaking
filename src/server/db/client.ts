import { drizzle, type NodePgDatabase } from "drizzle-orm/node-postgres";
import pg from "pg";
import { env } from "../env";
import * as schema from "./schema";

export type Database = NodePgDatabase<typeof schema>;
export type Tx = Parameters<Parameters<Database["transaction"]>[0]>[0];
export type Executor = Database | Tx;

type Pools = { app?: pg.Pool; system?: pg.Pool; appDb?: Database; systemDb?: Database };
// Survive Next.js dev hot reloads without leaking pools.
const g = globalThis as unknown as { __loupePools?: Pools };
const pools: Pools = (g.__loupePools ??= {});

function makePool(url: string, max: number) {
  const pool = new pg.Pool({ connectionString: url, max, idleTimeoutMillis: 30_000 });
  pool.on("error", (err) => console.error("[db] idle client error", err));
  return pool;
}

/** Tenant data path: restricted role, RLS enforced. Use through withTenant()/withUser() only. */
export function appDb(): Database {
  if (!pools.appDb) {
    pools.app = makePool(env().DATABASE_URL, env().DATABASE_POOL_MAX);
    pools.appDb = drizzle(pools.app, { schema });
  }
  return pools.appDb;
}

/**
 * System data path: schema owner, bypasses RLS. Restricted to authentication,
 * token lookups, org bootstrap and the job queue (see src/server/db/system.ts).
 */
export function systemDb(): Database {
  if (!pools.systemDb) {
    pools.system = makePool(env().DATABASE_URL_SYSTEM, Math.max(2, Math.floor(env().DATABASE_POOL_MAX / 2)));
    pools.systemDb = drizzle(pools.system, { schema });
  }
  return pools.systemDb;
}

export async function closePools() {
  await Promise.all([pools.app?.end(), pools.system?.end()]);
  pools.app = pools.system = undefined;
  pools.appDb = pools.systemDb = undefined;
}
