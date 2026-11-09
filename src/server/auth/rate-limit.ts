import { sql } from "drizzle-orm";
import { systemDb } from "../db/client";
import { AppError } from "../errors";

/**
 * Fixed-window counter in PostgreSQL, shared by every app instance.
 * Throws rate_limited once `limit` is exceeded inside `windowSeconds`.
 */
export async function consumeRateLimit(key: string, limit: number, windowSeconds: number): Promise<void> {
  const result = await systemDb().execute<{ count: number }>(sql`
    insert into rate_limits (key, window_start, count) values (${key}, now(), 1)
    on conflict (key) do update set
      count = case when rate_limits.window_start < now() - make_interval(secs => ${windowSeconds})
                   then 1 else rate_limits.count + 1 end,
      window_start = case when rate_limits.window_start < now() - make_interval(secs => ${windowSeconds})
                   then now() else rate_limits.window_start end
    returning count`);
  const count = Number(result.rows[0]?.count ?? 0);
  if (count > limit) {
    throw new AppError("rate_limited", "Too many attempts. Please wait a few minutes and try again.");
  }
}
