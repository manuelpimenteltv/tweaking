import { sql } from "drizzle-orm";
import { authorize, type AuthContext } from "../authz/context";
import { organizations, storageConnections, storageProviders } from "../db/schema";
import { withTenant } from "../db/tenant";
import { eq } from "drizzle-orm";

type Row = Record<string, unknown>;
const num = (v: unknown) => Number(v ?? 0);

/** Headline numbers (dashboard widget, visible to internal members). */
export async function storageSummary(ctx: AuthContext) {
  authorize(ctx, "org.view_internal");
  return withTenant(ctx, async (tx) => {
    const res = await tx.execute<Row>(sql`
      select
        coalesce(sum(v.size_bytes) filter (where v.uploaded_at is not null), 0)::text as originals,
        coalesce((select sum(p.size_bytes) from previews p), 0)::text as derived,
        coalesce(sum(v.size_bytes) filter (where v.uploaded_at is not null and (a.deleted_at is not null or pr.deleted_at is not null)), 0)::text as trash,
        count(*) filter (where v.uploaded_at is not null)::int as files
      from asset_versions v
      join assets a on a.id = v.asset_id
      join projects pr on pr.id = a.project_id`);
    const [org] = await tx.select({ quota: organizations.storageQuotaBytes }).from(organizations).where(eq(organizations.id, ctx.orgId));
    const r = res.rows[0];
    return {
      originalBytes: num(r.originals),
      derivedBytes: num(r.derived),
      trashBytes: num(r.trash),
      fileCount: num(r.files),
      quotaBytes: org?.quota ?? null,
    };
  });
}

/** Breakdown for the Storage page (administrators). */
export async function storageAnalytics(ctx: AuthContext) {
  authorize(ctx, "org.manage_storage");
  return withTenant(ctx, async (tx) => {
    const byProject = await tx.execute<Row>(sql`
      select pr.id, pr.name, pr.deleted_at is not null as deleted,
        coalesce(sum(v.size_bytes), 0)::text as bytes, count(v.id)::int as files
      from projects pr
      left join assets a on a.project_id = pr.id
      left join asset_versions v on v.asset_id = a.id and v.uploaded_at is not null
      group by pr.id order by sum(v.size_bytes) desc nulls last limit 50`);
    const byUser = await tx.execute<Row>(sql`
      select u.id, u.name, coalesce(sum(v.size_bytes), 0)::text as bytes, count(v.id)::int as files
      from asset_versions v join users u on u.id = v.uploaded_by
      where v.uploaded_at is not null
      group by u.id order by sum(v.size_bytes) desc limit 50`);
    const byKind = await tx.execute<Row>(sql`
      select a.kind, coalesce(sum(v.size_bytes), 0)::text as bytes, count(v.id)::int as files
      from asset_versions v join assets a on a.id = v.asset_id
      where v.uploaded_at is not null
      group by a.kind order by sum(v.size_bytes) desc`);
    const byConnection = await tx.execute<Row>(sql`
      select c.id, c.name, c.provider_id as provider, c.status,
        coalesce(sum(sl.size_bytes), 0)::text as bytes, count(sl.id)::int as objects
      from storage_connections c left join storage_locations sl on sl.connection_id = c.id
      group by c.id order by c.is_default desc, c.name`);
    const pendingUploads = await tx.execute<Row>(sql`
      select count(*)::int as n, coalesce(sum(size_bytes), 0)::text as bytes from upload_sessions where status = 'active'`);
    return {
      byProject: byProject.rows.map((r) => ({ id: String(r.id), name: String(r.name), deleted: Boolean(r.deleted), bytes: num(r.bytes), files: num(r.files) })),
      byUser: byUser.rows.map((r) => ({ id: String(r.id), name: String(r.name), bytes: num(r.bytes), files: num(r.files) })),
      byKind: byKind.rows.map((r) => ({ kind: String(r.kind), bytes: num(r.bytes), files: num(r.files) })),
      byConnection: byConnection.rows.map((r) => ({
        id: String(r.id),
        name: String(r.name),
        provider: String(r.provider),
        status: String(r.status),
        bytes: num(r.bytes),
        objects: num(r.objects),
      })),
      pendingUploads: { count: num(pendingUploads.rows[0]?.n), bytes: num(pendingUploads.rows[0]?.bytes) },
    };
  });
}

export async function listStorageConnections(ctx: AuthContext) {
  authorize(ctx, "org.view_internal");
  return withTenant(ctx, (tx) =>
    tx
      .select({
        id: storageConnections.id,
        name: storageConnections.name,
        providerId: storageConnections.providerId,
        providerName: storageProviders.name,
        status: storageConnections.status,
        isDefault: storageConnections.isDefault,
        lastVerifiedAt: storageConnections.lastVerifiedAt,
        createdAt: storageConnections.createdAt,
      })
      .from(storageConnections)
      .innerJoin(storageProviders, eq(storageProviders.id, storageConnections.providerId)),
  );
}
