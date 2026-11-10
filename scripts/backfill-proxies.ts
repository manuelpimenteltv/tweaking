/**
 * Queues preview generation for files processed before the matching viewer
 * existed: video review proxies (Phase 2) and document / spreadsheet previews
 * (Phase 3). Idempotent: skips versions that already have them or are queued.
 *   pnpm media:backfill   (then run the worker)
 */
import "dotenv/config";
import { sql } from "drizzle-orm";
import { closePools, systemDb } from "../src/server/db/client";

const JOBS = [
  { type: "proxy", kinds: ["video"], preview: "proxy", extensions: null },
  { type: "document", kinds: ["document", "presentation"], preview: "pdf", extensions: ["pdf", "doc", "docx", "rtf", "odt", "txt", "md", "pages", "ppt", "pptx", "odp", "key"] },
  { type: "sheet", kinds: ["spreadsheet"], preview: "sheet_model", extensions: ["xlsx", "xlsm", "xls", "ods", "csv", "tsv", "numbers"] },
] as const;

async function main() {
  for (const j of JOBS) {
    const res = await systemDb().execute(sql`
      with todo as (
        select v.id, v.organization_id from asset_versions v
        join assets a on a.id = v.asset_id
        where a.kind::text = any(${`{${j.kinds.join(",")}}`}::text[]) and v.processing_status = 'ready'
          and (${j.extensions === null} or v.extension = any(${`{${(j.extensions ?? []).join(",")}}`}::text[]))
          and (${j.type !== "proxy"} or (v.media_info ? 'width'))
          and (${j.type !== "document"} or not (v.media_info ? 'pages'))
          and not exists (select 1 from previews p where p.asset_version_id = v.id and p.kind::text = ${j.preview})
          and not exists (select 1 from processing_jobs pj where pj.asset_version_id = v.id and pj.type = ${j.type} and pj.status in ('queued','running'))
      )
      insert into processing_jobs (organization_id, asset_version_id, type)
      select organization_id, id, ${j.type} from todo
      returning id`);
    console.log(`Queued ${res.rows.length} ${j.type} job(s).`);
  }
  console.log('Run "pnpm worker" to process them.');
}

main()
  .catch((err) => {
    console.error(err);
    process.exitCode = 1;
  })
  .finally(() => closePools());
