import { sql } from "drizzle-orm";
import { appDb, type Tx } from "./client";

export type TenantScope = { orgId: string | null; userId: string | null };

/**
 * Runs `fn` in a transaction on the restricted role with the tenant context set
 * transaction-locally. RLS policies read it through app_org()/app_user(), so a
 * query that forgets its organization filter still cannot see another tenant.
 */
export async function withScope<T>(scope: TenantScope, fn: (tx: Tx) => Promise<T>): Promise<T> {
  return appDb().transaction(async (tx) => {
    await tx.execute(
      sql`select set_config('app.org_id', ${scope.orgId ?? ""}, true), set_config('app.user_id', ${scope.userId ?? ""}, true)`,
    );
    return fn(tx);
  });
}

export function withTenant<T>(ctx: { orgId: string; userId: string }, fn: (tx: Tx) => Promise<T>) {
  return withScope({ orgId: ctx.orgId, userId: ctx.userId }, fn);
}

/** User-only scope (no org): lists the user's own memberships and organizations. */
export function withUser<T>(userId: string, fn: (tx: Tx) => Promise<T>) {
  return withScope({ orgId: null, userId }, fn);
}
