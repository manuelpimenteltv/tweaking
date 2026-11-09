/**
 * Applies SQL migrations (drizzle/) as the schema owner, then syncs reference
 * data: system roles (from src/server/authz/permissions.ts) and storage providers.
 *   pnpm db:migrate
 */
import "dotenv/config";
import { drizzle } from "drizzle-orm/node-postgres";
import { migrate } from "drizzle-orm/node-postgres/migrator";
import pg from "pg";
import { syncSystemRoles } from "../src/server/authz/roles";
import * as schema from "../src/server/db/schema";

async function main() {
  const url = process.env.DATABASE_URL_SYSTEM;
  if (!url) throw new Error("DATABASE_URL_SYSTEM is required");
  const pool = new pg.Pool({ connectionString: url, max: 1 });
  const db = drizzle(pool, { schema });
  await migrate(db, { migrationsFolder: "drizzle" });
  await syncSystemRoles(db);
  await db
    .insert(schema.storageProviders)
    .values({
      id: "platform",
      name: "Loupe Cloud Storage",
      kind: "object",
      capabilities: { presignedUpload: true, multipart: true, partChecksums: true, presignedDownload: true, rangeReads: true },
    })
    .onConflictDoNothing();
  await pool.end();
  console.log("Migrations applied; system roles and providers synced.");
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
