/**
 * Queues review-proxy generation for processed videos that don't have proxies
 * yet (e.g. uploaded before Phase 2). Run the worker to process them.
 *   pnpm media:backfill
 */
import "dotenv/config";
import { sql } from "drizzle-orm";
import { closePools, systemDb } from "../src/server/db/client";

async function main() {
  const res = await systemDb().execute<{ n: number }>(sql`
    with todo as (
      select v.id, v.organization_id from asset_versions v
      join assets a on a.id = v.asset_id
      where a.kind = 'video' and v.processing_status = 'ready' and (v.media_info ? 'width')
        and not exists (select 1 from previews p where p.asset_version_id = v.id and p.kind = 'proxy')
        and not exists (select 1 from processing_jobs j where j.asset_version_id = v.id and j.type = 'proxy' and j.status in ('queued','running'))
    )
    insert into processing_jobs (organization_id, asset_version_id, type)
    select organization_id, id, 'proxy' from todo
    returning 1 as n`);
  console.log(`Queued ${res.rows.length} proxy job(s). Run "pnpm worker" to process them.`);
}

main()
  .catch((err) => {
    console.error(err);
    process.exitCode = 1;
  })
  .finally(() => closePools());
