import { and, asc, desc, eq, inArray, isNull, sql, type SQL } from "drizzle-orm";
import { z } from "zod";
import { assetNameSchema, folderNameSchema, uuid } from "@/lib/validation";
import type { AuthContext } from "../authz/context";
import { requireProject } from "../authz/project-access";
import type { Tx } from "../db/client";
import {
  assetVersions,
  assets,
  folders,
  previews,
  processingJobs,
  storageConnections,
  storageLocations,
  users,
} from "../db/schema";
import { withTenant } from "../db/tenant";
import { conflict, invalid, isUniqueViolation, notFound } from "../errors";
import { parse } from "../lib/validate";
import { platformStorage, storageForConnection } from "../storage/registry";
import { auditFromCtx, recordAudit } from "./audit";
import { recordActivity } from "./activity";
import { previewKeySql, signPreview } from "./previews";
import { touchProject } from "./projects";

const MAX_FOLDER_DEPTH = 32;

// ── Folder helpers ──────────────────────────────────────────────────────────

/** Root-to-leaf chain of a folder (inclusive). */
export async function folderChain(tx: Tx, folderId: string): Promise<{ id: string; name: string }[]> {
  const res = await tx.execute<{ id: string; name: string }>(sql`
    with recursive chain as (
      select id, parent_id, name, 0 as depth from folders where id = ${folderId} and deleted_at is null
      union all
      select f.id, f.parent_id, f.name, c.depth + 1 from folders f
      join chain c on f.id = c.parent_id
      where c.depth < ${MAX_FOLDER_DEPTH * 2} and f.deleted_at is null
    )
    select id, name from chain order by depth desc`);
  return res.rows;
}

async function requireFolder(tx: Tx, projectId: string, folderId: string) {
  const [folder] = await tx
    .select()
    .from(folders)
    .where(and(eq(folders.id, folderId), eq(folders.projectId, projectId), isNull(folders.deletedAt)))
    .limit(1);
  if (!folder) throw notFound("Folder");
  return folder;
}

// ── Listing ─────────────────────────────────────────────────────────────────

export const listContentsSchema = z.object({
  projectId: uuid,
  folderId: uuid.nullable().default(null),
  sort: z.enum(["name", "date", "size", "type"]).default("name"),
  dir: z.enum(["asc", "desc"]).default("asc"),
  kind: z.enum(["video", "audio", "image", "document", "spreadsheet", "presentation", "archive", "other"]).optional(),
});

export async function listFolderContents(ctx: AuthContext, input: z.input<typeof listContentsSchema>) {
  const opts = parse(listContentsSchema, input);
  const result = await withTenant(ctx, async (tx) => {
    const access = await requireProject(tx, ctx, opts.projectId);
    const folder = opts.folderId ? await requireFolder(tx, opts.projectId, opts.folderId) : null;
    const breadcrumbs = folder ? await folderChain(tx, folder.id) : [];

    const parentCond = opts.folderId ? eq(folders.parentId, opts.folderId) : isNull(folders.parentId);
    const folderRows = await tx
      .select({
        id: folders.id,
        name: folders.name,
        updatedAt: folders.updatedAt,
        createdAt: folders.createdAt,
        itemCount: sql<number>`(
          (select count(*) from folders c where c.parent_id = ${folders.id} and c.deleted_at is null) +
          (select count(*) from assets a where a.folder_id = ${folders.id} and a.deleted_at is null))::int`,
      })
      .from(folders)
      .where(and(eq(folders.projectId, opts.projectId), parentCond, isNull(folders.deletedAt)))
      .orderBy(opts.sort === "date" ? (opts.dir === "asc" ? asc(folders.createdAt) : desc(folders.createdAt)) : asc(sql`lower(${folders.name})`));

    const assetFolderCond = opts.folderId ? eq(assets.folderId, opts.folderId) : isNull(assets.folderId);
    const dirFn = opts.dir === "asc" ? asc : desc;
    const order: SQL[] =
      opts.sort === "date"
        ? [dirFn(assets.createdAt)]
        : opts.sort === "size"
          ? [dirFn(assetVersions.sizeBytes)]
          : opts.sort === "type"
            ? [dirFn(assets.kind), asc(sql`lower(${assets.name})`)]
            : [dirFn(sql`lower(${assets.name})`)];
    const assetRows = await tx
      .select({
        id: assets.id,
        name: assets.name,
        kind: assets.kind,
        reviewStatus: assets.reviewStatus,
        versionCount: assets.versionCount,
        createdAt: assets.createdAt,
        currentVersionId: assets.currentVersionId,
        versionNumber: assetVersions.versionNumber,
        extension: assetVersions.extension,
        sizeBytes: assetVersions.sizeBytes,
        processingStatus: assetVersions.processingStatus,
        mediaInfo: assetVersions.mediaInfo,
        uploaderName: users.name,
        previewKey: previewKeySql(assets.currentVersionId),
      })
      .from(assets)
      .leftJoin(assetVersions, eq(assetVersions.id, assets.currentVersionId))
      .leftJoin(users, eq(users.id, assetVersions.uploadedBy))
      .where(
        and(
          eq(assets.projectId, opts.projectId),
          assetFolderCond,
          isNull(assets.deletedAt),
          opts.kind ? eq(assets.kind, opts.kind) : undefined,
        ),
      )
      .orderBy(...order)
      .limit(5000);

    return { project: access.project, permissions: [...access.permissions], folder, breadcrumbs, folders: folderRows, assets: assetRows };
  });
  const signed = await Promise.all(
    result.assets.map(async ({ previewKey, ...a }) => ({ ...a, previewUrl: await signPreview(previewKey) })),
  );
  return { ...result, assets: signed };
}

/** Every folder of a project (for move dialogs). */
export async function listFolderTree(ctx: AuthContext, projectId: string) {
  parse(uuid, projectId);
  return withTenant(ctx, async (tx) => {
    await requireProject(tx, ctx, projectId);
    return tx
      .select({ id: folders.id, name: folders.name, parentId: folders.parentId })
      .from(folders)
      .where(and(eq(folders.projectId, projectId), isNull(folders.deletedAt)))
      .orderBy(asc(sql`lower(${folders.name})`));
  });
}

// ── Folder mutations ────────────────────────────────────────────────────────

export async function createFolder(ctx: AuthContext, input: unknown) {
  const data = parse(z.object({ projectId: uuid, parentId: uuid.nullable().default(null), name: folderNameSchema }), input);
  try {
    return await withTenant(ctx, async (tx) => {
      await requireProject(tx, ctx, data.projectId, "folder.create");
      if (data.parentId) {
        await requireFolder(tx, data.projectId, data.parentId);
        const chain = await folderChain(tx, data.parentId);
        if (chain.length >= MAX_FOLDER_DEPTH) throw invalid(`Folders can be nested at most ${MAX_FOLDER_DEPTH} levels deep.`);
      }
      const [folder] = await tx
        .insert(folders)
        .values({ organizationId: ctx.orgId, projectId: data.projectId, parentId: data.parentId, name: data.name, createdBy: ctx.userId })
        .returning();
      await recordActivity(tx, ctx, { projectId: data.projectId, verb: "folder.created", subjectType: "folder", subjectId: folder.id, subjectName: folder.name });
      await touchProject(tx, data.projectId);
      return folder;
    });
  } catch (err) {
    if (isUniqueViolation(err)) throw conflict("A folder with this name already exists here.", { name: "Name already in use here." });
    throw err;
  }
}

export async function renameFolder(ctx: AuthContext, input: unknown) {
  const data = parse(z.object({ projectId: uuid, folderId: uuid, name: folderNameSchema }), input);
  try {
    return await withTenant(ctx, async (tx) => {
      await requireProject(tx, ctx, data.projectId, "folder.edit");
      const before = await requireFolder(tx, data.projectId, data.folderId);
      await tx.update(folders).set({ name: data.name, updatedAt: new Date() }).where(eq(folders.id, data.folderId));
      await recordActivity(tx, ctx, {
        projectId: data.projectId,
        verb: "folder.renamed",
        subjectType: "folder",
        subjectId: data.folderId,
        subjectName: data.name,
        data: { from: before.name },
      });
    });
  } catch (err) {
    if (isUniqueViolation(err)) throw conflict("A folder with this name already exists here.", { name: "Name already in use here." });
    throw err;
  }
}

export async function renameAsset(ctx: AuthContext, input: unknown) {
  const data = parse(z.object({ projectId: uuid, assetId: uuid, name: assetNameSchema }), input);
  return withTenant(ctx, async (tx) => {
    await requireProject(tx, ctx, data.projectId, "asset.edit");
    const [before] = await tx
      .select({ name: assets.name })
      .from(assets)
      .where(and(eq(assets.id, data.assetId), eq(assets.projectId, data.projectId), isNull(assets.deletedAt)));
    if (!before) throw notFound("Asset");
    await tx.update(assets).set({ name: data.name, updatedAt: new Date() }).where(eq(assets.id, data.assetId));
    await recordActivity(tx, ctx, {
      projectId: data.projectId,
      verb: "asset.renamed",
      subjectType: "asset",
      subjectId: data.assetId,
      subjectName: data.name,
      data: { from: before.name },
    });
  });
}

const bulkSchema = z.object({
  projectId: uuid,
  assetIds: z.array(uuid).max(1000).default([]),
  folderIds: z.array(uuid).max(1000).default([]),
});

/** Moves folders and assets into `targetFolderId` (null = project root), rejecting cycles. */
export async function moveItems(ctx: AuthContext, input: unknown) {
  const data = parse(bulkSchema.extend({ targetFolderId: uuid.nullable() }), input);
  if (!data.assetIds.length && !data.folderIds.length) throw invalid("Nothing selected.");
  try {
    return await withTenant(ctx, async (tx) => {
      const access = await requireProject(tx, ctx, data.projectId, data.folderIds.length ? "folder.edit" : "asset.edit");
      if (data.assetIds.length && !access.permissions.has("asset.edit")) throw invalid("You can't move assets in this project.");
      let targetChain: { id: string }[] = [];
      if (data.targetFolderId) {
        await requireFolder(tx, data.projectId, data.targetFolderId);
        targetChain = await folderChain(tx, data.targetFolderId);
      }
      const ancestorIds = new Set(targetChain.map((f) => f.id));
      for (const fid of data.folderIds) {
        if (ancestorIds.has(fid)) throw invalid("A folder can't be moved into itself or one of its subfolders.");
      }
      if (data.folderIds.length) {
        const moved = await tx
          .update(folders)
          .set({ parentId: data.targetFolderId, updatedAt: new Date() })
          .where(and(inArray(folders.id, data.folderIds), eq(folders.projectId, data.projectId), isNull(folders.deletedAt)))
          .returning({ id: folders.id });
        if (moved.length !== data.folderIds.length) throw notFound("Folder");
      }
      if (data.assetIds.length) {
        const moved = await tx
          .update(assets)
          .set({ folderId: data.targetFolderId, updatedAt: new Date() })
          .where(and(inArray(assets.id, data.assetIds), eq(assets.projectId, data.projectId), isNull(assets.deletedAt)))
          .returning({ id: assets.id });
        if (moved.length !== data.assetIds.length) throw notFound("Asset");
      }
      const targetName = data.targetFolderId ? (targetChain.at(-1) as { name?: string })?.name ?? "" : access.project.name;
      await recordActivity(tx, ctx, {
        projectId: data.projectId,
        verb: "items.moved",
        subjectType: "folder",
        subjectId: data.targetFolderId,
        subjectName: targetName,
        data: { assets: data.assetIds.length, folders: data.folderIds.length },
      });
      await touchProject(tx, data.projectId);
    });
  } catch (err) {
    if (isUniqueViolation(err)) throw conflict("The destination already has a folder with the same name.");
    throw err;
  }
}

/**
 * Soft-deletes folders (with their whole subtree and contents) and assets.
 * Bytes stay in storage until the retention purge (docs/OPERATIONS.md).
 */
export async function deleteItems(ctx: AuthContext, input: unknown) {
  const data = parse(bulkSchema, input);
  if (!data.assetIds.length && !data.folderIds.length) throw invalid("Nothing selected.");
  return withTenant(ctx, async (tx) => {
    const access = await requireProject(tx, ctx, data.projectId, data.folderIds.length ? "folder.delete" : "asset.delete");
    if (data.assetIds.length && !access.permissions.has("asset.delete")) throw invalid("You can't delete assets in this project.");
    const now = new Date();
    let folderCount = 0;
    let assetCount = 0;
    if (data.folderIds.length) {
      const subtree = sql`(with recursive sub as (
          select id from folders where id in ${data.folderIds} and project_id = ${data.projectId} and deleted_at is null
          union all
          select f.id from folders f join sub on f.parent_id = sub.id where f.deleted_at is null)
        select id from sub)`;
      const a = await tx
        .update(assets)
        .set({ deletedAt: now })
        .where(and(sql`${assets.folderId} in ${subtree}`, isNull(assets.deletedAt)))
        .returning({ id: assets.id });
      const f = await tx
        .update(folders)
        .set({ deletedAt: now })
        .where(sql`${folders.id} in ${subtree}`)
        .returning({ id: folders.id });
      folderCount = f.length;
      assetCount += a.length;
    }
    if (data.assetIds.length) {
      const a = await tx
        .update(assets)
        .set({ deletedAt: now })
        .where(and(inArray(assets.id, data.assetIds), eq(assets.projectId, data.projectId), isNull(assets.deletedAt)))
        .returning({ id: assets.id });
      assetCount += a.length;
    }
    await recordActivity(tx, ctx, {
      projectId: data.projectId,
      verb: "items.deleted",
      subjectType: "project",
      subjectId: data.projectId,
      subjectName: access.project.name,
      data: { assets: assetCount, folders: folderCount },
    });
    await recordAudit(tx, auditFromCtx(ctx, "items.deleted", { type: "project", id: data.projectId }, { assetIds: data.assetIds, folderIds: data.folderIds }));
    await touchProject(tx, data.projectId);
    return { assets: assetCount, folders: folderCount };
  });
}

// ── Asset detail ────────────────────────────────────────────────────────────

export async function getAsset(ctx: AuthContext, assetId: string, versionNumber?: number) {
  parse(uuid, assetId);
  const data = await withTenant(ctx, async (tx) => {
    const [asset] = await tx.select().from(assets).where(and(eq(assets.id, assetId), isNull(assets.deletedAt))).limit(1);
    if (!asset) throw notFound("Asset");
    const access = await requireProject(tx, ctx, asset.projectId);
    const breadcrumbs = asset.folderId ? await folderChain(tx, asset.folderId) : [];
    const versions = await tx
      .select({
        id: assetVersions.id,
        versionNumber: assetVersions.versionNumber,
        originalFilename: assetVersions.originalFilename,
        extension: assetVersions.extension,
        declaredMimeType: assetVersions.declaredMimeType,
        detectedMimeType: assetVersions.detectedMimeType,
        sizeBytes: assetVersions.sizeBytes,
        contentSha256: assetVersions.contentSha256,
        storageSource: assetVersions.storageSource,
        processingStatus: assetVersions.processingStatus,
        processingError: assetVersions.processingError,
        mediaInfo: assetVersions.mediaInfo,
        uploadedAt: assetVersions.uploadedAt,
        createdAt: assetVersions.createdAt,
        uploaderName: users.name,
        connectionName: storageConnections.name,
        providerId: storageConnections.providerId,
        objectKey: storageLocations.objectKey,
        thumbKey: previewKeySql(assetVersions.id, "thumbnail"),
        posterKey: previewKeySql(assetVersions.id, "poster"),
      })
      .from(assetVersions)
      .leftJoin(users, eq(users.id, assetVersions.uploadedBy))
      .innerJoin(storageLocations, eq(storageLocations.id, assetVersions.storageLocationId))
      .innerJoin(storageConnections, eq(storageConnections.id, storageLocations.connectionId))
      .where(eq(assetVersions.assetId, assetId))
      .orderBy(desc(assetVersions.versionNumber));
    const selected =
      (versionNumber ? versions.find((v) => v.versionNumber === versionNumber) : versions.find((v) => v.id === asset.currentVersionId)) ??
      versions[0];
    const jobs = selected
      ? await tx
          .select({
            id: processingJobs.id,
            type: processingJobs.type,
            status: processingJobs.status,
            attempts: processingJobs.attempts,
            maxAttempts: processingJobs.maxAttempts,
            lastError: processingJobs.lastError,
            createdAt: processingJobs.createdAt,
            finishedAt: processingJobs.finishedAt,
          })
          .from(processingJobs)
          .where(eq(processingJobs.assetVersionId, selected.id))
          .orderBy(desc(processingJobs.createdAt))
          .limit(10)
      : [];
    const media = selected
      ? await tx
          .select({
            kind: previews.kind,
            rendition: previews.rendition,
            width: previews.width,
            height: previews.height,
            metadata: previews.metadata,
            objectKey: storageLocations.objectKey,
          })
          .from(previews)
          .innerJoin(storageLocations, eq(storageLocations.id, previews.storageLocationId))
          .where(and(eq(previews.assetVersionId, selected.id), inArray(previews.kind, ["proxy", "sprite"])))
      : [];
    const previewCount = selected
      ? (await tx.select({ n: sql<number>`count(*)::int` }).from(previews).where(eq(previews.assetVersionId, selected.id)))[0].n
      : 0;
    return { asset, project: access.project, permissions: [...access.permissions], breadcrumbs, versions, selected, jobs, previewCount, media };
  });

  const sel = data.selected;
  let playbackUrl: string | null = null;
  if (sel && sel.processingStatus === "ready" && sel.objectKey && sel.providerId === "platform") {
    const playable =
      (data.asset.kind === "video" && sel.mediaInfo.browserPlayable) ||
      (data.asset.kind === "audio" && sel.mediaInfo.browserPlayable);
    if (playable) {
      // Inline playback of a verified, browser-compatible original. Review proxies (HLS) arrive in Phase 2.
      playbackUrl = await storageForConnection({ id: "", providerId: sel.providerId, config: {} }).presignDownload(sel.objectKey, {
        disposition: "inline",
        contentType: sel.detectedMimeType ?? sel.declaredMimeType,
      });
    }
  }
  // Review proxies (constant frame rate, short GOP) are preferred for playback; largest first.
  const storage = platformStorage();
  const renditions = await Promise.all(
    data.media
      .filter((m) => m.kind === "proxy" && m.objectKey)
      .sort((a, b) => (b.height ?? 0) - (a.height ?? 0))
      .map(async (m) => ({
        name: m.rendition ?? `${m.height}p`,
        height: m.height ?? 0,
        url: await storage.presignDownload(m.objectKey!, { disposition: "inline", contentType: "video/mp4" }),
      })),
  );
  const spriteRow = data.media.find((m) => m.kind === "sprite" && m.objectKey);
  const sprite = spriteRow
    ? {
        url: await storage.presignDownload(spriteRow.objectKey!, { disposition: "inline", contentType: "image/jpeg" }),
        ...(spriteRow.metadata as { interval: number; count: number; columns: number; rows: number; tileWidth: number; tileHeight: number }),
      }
    : null;
  const proxyJob = data.jobs.find((j) => j.type === "proxy");

  return {
    ...data,
    renditions,
    sprite,
    proxyStatus: renditions.length ? ("ready" as const) : proxyJob ? (proxyJob.status === "failed" ? ("failed" as const) : ("processing" as const)) : ("none" as const),
    thumbnailUrl: await signPreview(sel?.thumbKey),
    posterUrl: await signPreview(sel?.posterKey),
    playbackUrl,
  };
}

/** Signed download of an original. Authorized and audited; URLs expire. */
export async function getDownloadUrl(ctx: AuthContext, versionId: string) {
  parse(uuid, versionId);
  return withTenant(ctx, async (tx) => {
    const [row] = await tx
      .select({
        projectId: assets.projectId,
        assetId: assets.id,
        assetName: assets.name,
        filename: assetVersions.originalFilename,
        mime: assetVersions.declaredMimeType,
        uploadedAt: assetVersions.uploadedAt,
        versionNumber: assetVersions.versionNumber,
        objectKey: storageLocations.objectKey,
        connectionId: storageConnections.id,
        providerId: storageConnections.providerId,
        config: storageConnections.config,
      })
      .from(assetVersions)
      .innerJoin(assets, eq(assets.id, assetVersions.assetId))
      .innerJoin(storageLocations, eq(storageLocations.id, assetVersions.storageLocationId))
      .innerJoin(storageConnections, eq(storageConnections.id, storageLocations.connectionId))
      .where(and(eq(assetVersions.id, versionId), isNull(assets.deletedAt)))
      .limit(1);
    if (!row) throw notFound("Version");
    await requireProject(tx, ctx, row.projectId, "asset.download");
    if (!row.uploadedAt || !row.objectKey) throw conflict("This file hasn't finished uploading.");
    const storage = storageForConnection({ id: row.connectionId, providerId: row.providerId, config: row.config });
    const url = await storage.presignDownload(row.objectKey, {
      filename: row.filename,
      contentType: row.mime,
      disposition: "attachment",
      expiresInSeconds: 300,
    });
    await recordAudit(tx, auditFromCtx(ctx, "asset.downloaded", { type: "asset_version", id: versionId }, { asset: row.assetName, version: row.versionNumber }));
    return url;
  });
}
