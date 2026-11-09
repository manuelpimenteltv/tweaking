import { and, desc, eq, isNull, sql } from "drizzle-orm";
import { can, type AuthContext } from "../authz/context";
import { accessibleProjectIds } from "../authz/project-access";
import { assetVersions, assets, projects, users } from "../db/schema";
import { withTenant } from "../db/tenant";
import { listOrgActivity } from "./activity";
import { previewKeySql, signPreview } from "./previews";
import { listProjects } from "./projects";
import { storageSummary } from "./storage-usage";

export async function getDashboard(ctx: AuthContext) {
  const internal = can(ctx, "org.view_internal");
  const [recent, favorites, mine, uploads, activity, storage, failed] = await Promise.all([
    listProjects(ctx, { sort: "updated", limit: 8 }),
    listProjects(ctx, { scope: "favorites", sort: "name", limit: 12 }),
    listProjects(ctx, { scope: "mine", sort: "updated", limit: 8 }),
    recentUploads(ctx, 12),
    listOrgActivity(ctx, 20),
    internal ? storageSummary(ctx) : Promise.resolve(null),
    failedProcessing(ctx),
  ]);
  return { recent, favorites, mine, uploads, activity, storage, failed };
}

async function recentUploads(ctx: AuthContext, limit: number) {
  const rows = await withTenant(ctx, (tx) =>
    tx
      .select({
        id: assets.id,
        name: assets.name,
        kind: assets.kind,
        projectId: assets.projectId,
        projectName: projects.name,
        uploadedAt: assetVersions.uploadedAt,
        versionNumber: assetVersions.versionNumber,
        processingStatus: assetVersions.processingStatus,
        uploaderName: users.name,
        previewKey: previewKeySql(assets.currentVersionId),
      })
      .from(assets)
      .innerJoin(projects, eq(projects.id, assets.projectId))
      .innerJoin(assetVersions, eq(assetVersions.id, assets.currentVersionId))
      .leftJoin(users, eq(users.id, assetVersions.uploadedBy))
      .where(and(isNull(assets.deletedAt), isNull(projects.deletedAt), sql`${assetVersions.uploadedAt} is not null`, accessibleProjectIds(ctx)))
      .orderBy(desc(assetVersions.uploadedAt))
      .limit(limit),
  );
  return Promise.all(rows.map(async ({ previewKey, ...r }) => ({ ...r, previewUrl: await signPreview(previewKey) })));
}

async function failedProcessing(ctx: AuthContext) {
  return withTenant(ctx, (tx) =>
    tx
      .select({ id: assets.id, name: assets.name, projectId: assets.projectId, error: assetVersions.processingError })
      .from(assets)
      .innerJoin(projects, eq(projects.id, assets.projectId))
      .innerJoin(assetVersions, eq(assetVersions.id, assets.currentVersionId))
      .where(and(isNull(assets.deletedAt), isNull(projects.deletedAt), eq(assetVersions.processingStatus, "failed"), accessibleProjectIds(ctx)))
      .limit(10),
  );
}
