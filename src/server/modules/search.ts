import { and, desc, eq, gte, ilike, isNull, lte, or, sql } from "drizzle-orm";
import { z } from "zod";
import { uuid } from "@/lib/validation";
import type { AuthContext } from "../authz/context";
import { accessibleProjectIds } from "../authz/project-access";
import { assetVersions, assets, folders, organizationMembers, projects, roles, users } from "../db/schema";
import { withTenant } from "../db/tenant";
import { parse } from "../lib/validate";
import { previewKeySql, signPreview } from "./previews";
import { escapeLike } from "./projects";

export const searchSchema = z.object({
  q: z.string().trim().max(200).default(""),
  type: z.enum(["all", "projects", "folders", "assets", "people"]).default("all"),
  kind: z.enum(["video", "audio", "image", "document", "spreadsheet", "presentation", "archive", "other"]).optional(),
  projectId: uuid.optional(),
  uploadedBy: uuid.optional(),
  reviewStatus: z
    .enum(["draft", "in_progress", "ready_for_review", "in_review", "changes_requested", "approved", "final"])
    .optional(),
  processing: z.enum(["awaiting_upload", "processing", "ready", "failed"]).optional(),
  from: z.coerce.date().optional(),
  to: z.coerce.date().optional(),
  limit: z.number().int().min(1).max(100).default(30),
});

export type SearchInput = z.input<typeof searchSchema>;

/**
 * Permission-aware search. Every branch is restricted to projects the user can
 * view (and RLS restricts everything to the current org). Matches names,
 * file extensions and custom metadata values.
 */
export async function search(ctx: AuthContext, input: SearchInput) {
  const f = parse(searchSchema, input);
  const pattern = `%${escapeLike(f.q)}%`;
  const hasAssetFilters = !!(f.kind || f.uploadedBy || f.reviewStatus || f.processing || f.from || f.to);
  const want = (t: "projects" | "folders" | "assets" | "people") =>
    (f.type === "all" || f.type === t) && (t === "assets" || !hasAssetFilters || f.type === t);

  const result = await withTenant(ctx, async (tx) => {
    const visible = accessibleProjectIds(ctx);

    const projectRows =
      want("projects") && f.q
        ? await tx
            .select({ id: projects.id, name: projects.name, status: projects.status, clientName: projects.clientName, updatedAt: projects.updatedAt })
            .from(projects)
            .where(
              and(
                isNull(projects.deletedAt),
                visible,
                f.projectId ? eq(projects.id, f.projectId) : undefined,
                or(
                  ilike(projects.name, pattern),
                  ilike(projects.clientName, pattern),
                  sql`exists (select 1 from jsonb_each_text(${projects.metadata}) m where m.value ilike ${pattern} or m.key ilike ${pattern})`,
                ),
              ),
            )
            .orderBy(desc(projects.updatedAt))
            .limit(f.limit)
        : [];

    const folderRows =
      want("folders") && f.q
        ? await tx
            .select({ id: folders.id, name: folders.name, projectId: folders.projectId, projectName: projects.name })
            .from(folders)
            .innerJoin(projects, eq(projects.id, folders.projectId))
            .where(
              and(
                isNull(folders.deletedAt),
                isNull(projects.deletedAt),
                visible,
                f.projectId ? eq(folders.projectId, f.projectId) : undefined,
                ilike(folders.name, pattern),
              ),
            )
            .limit(f.limit)
        : [];

    const assetRows =
      want("assets") && (f.q || hasAssetFilters || f.projectId)
        ? await tx
            .select({
              id: assets.id,
              name: assets.name,
              kind: assets.kind,
              reviewStatus: assets.reviewStatus,
              projectId: assets.projectId,
              projectName: projects.name,
              createdAt: assets.createdAt,
              sizeBytes: assetVersions.sizeBytes,
              versionNumber: assetVersions.versionNumber,
              processingStatus: assetVersions.processingStatus,
              uploaderName: users.name,
              previewKey: previewKeySql(assets.currentVersionId),
            })
            .from(assets)
            .innerJoin(projects, eq(projects.id, assets.projectId))
            .leftJoin(assetVersions, eq(assetVersions.id, assets.currentVersionId))
            .leftJoin(users, eq(users.id, assetVersions.uploadedBy))
            .where(
              and(
                isNull(assets.deletedAt),
                isNull(projects.deletedAt),
                visible,
                f.q
                  ? or(
                      ilike(assets.name, pattern),
                      ilike(assetVersions.originalFilename, pattern),
                      eq(assetVersions.extension, f.q.replace(/^\./, "").toLowerCase()),
                      sql`exists (select 1 from jsonb_each_text(${assets.metadata}) m where m.value ilike ${pattern})`,
                    )
                  : undefined,
                f.kind ? eq(assets.kind, f.kind) : undefined,
                f.projectId ? eq(assets.projectId, f.projectId) : undefined,
                f.uploadedBy ? eq(assetVersions.uploadedBy, f.uploadedBy) : undefined,
                f.reviewStatus ? eq(assets.reviewStatus, f.reviewStatus) : undefined,
                f.processing ? eq(assetVersions.processingStatus, f.processing) : undefined,
                f.from ? gte(assets.createdAt, f.from) : undefined,
                f.to ? lte(assets.createdAt, f.to) : undefined,
              ),
            )
            .orderBy(desc(assets.createdAt))
            .limit(f.limit)
        : [];

    const peopleRows =
      want("people") && f.q && ctx.permissions.has("org.view_internal")
        ? await tx
            .select({ id: users.id, name: users.name, email: users.email, roleName: roles.name })
            .from(organizationMembers)
            .innerJoin(users, eq(users.id, organizationMembers.userId))
            .innerJoin(roles, eq(roles.id, organizationMembers.roleId))
            .where(and(eq(organizationMembers.organizationId, ctx.orgId), or(ilike(users.name, pattern), ilike(users.email, pattern))))
            .limit(f.limit)
        : [];

    return { projects: projectRows, folders: folderRows, assets: assetRows, people: peopleRows };
  });

  return {
    ...result,
    assets: await Promise.all(result.assets.map(async ({ previewKey, ...a }) => ({ ...a, previewUrl: await signPreview(previewKey) }))),
    filters: f,
  };
}
