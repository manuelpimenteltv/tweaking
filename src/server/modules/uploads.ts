import { randomUUID } from "node:crypto";
import { and, desc, eq, isNull, lt, sql } from "drizzle-orm";
import { checkUploadable, declaredMimeIsPlausible } from "@/lib/file-types";
import { completeUploadSchema, initiateUploadSchema, signPartsSchema, uuid } from "@/lib/validation";
import type { AuthContext } from "../authz/context";
import { requireProject } from "../authz/project-access";
import { systemDb, type Tx } from "../db/client";
import {
  assetVersions,
  assets,
  folders,
  organizations,
  projects,
  storageConnections,
  storageLocations,
  uploadSessions,
} from "../db/schema";
import { withTenant } from "../db/tenant";
import { env } from "../env";
import { AppError, conflict, forbidden, invalid, notFound } from "../errors";
import { enqueueJob } from "../jobs/queue";
import { parse } from "../lib/validate";
import { keys, storageForConnection } from "../storage/registry";
import { recordActivity } from "./activity";
import { touchProject } from "./projects";

const MiB = 1024 * 1024;
export const MIN_PART_SIZE = 8 * MiB;
export const MAX_PARTS = 10_000;

/** Smallest part size ≥ 8 MiB (rounded to whole MiB) that keeps the part count ≤ 10,000 (S3 limit). */
export function choosePartSize(size: number): number {
  const needed = Math.ceil(size / MAX_PARTS);
  return Math.max(MIN_PART_SIZE, Math.ceil(needed / MiB) * MiB);
}

export function partLength(size: number, partSize: number, partNumber: number): number {
  const start = (partNumber - 1) * partSize;
  return Math.max(0, Math.min(partSize, size - start));
}

async function defaultConnection(tx: Tx, orgId: string) {
  const [conn] = await tx
    .select()
    .from(storageConnections)
    .where(and(eq(storageConnections.organizationId, orgId), eq(storageConnections.isDefault, true)))
    .limit(1);
  if (!conn) throw new AppError("storage_error", "No default storage is configured for this organization.");
  if (conn.status !== "active") throw new AppError("storage_error", `Storage "${conn.name}" is ${conn.status.replace("_", " ")}.`);
  return conn;
}

/** Bytes counted against the quota: every version (including trash) plus in-flight uploads. */
export async function usedBytes(tx: Tx, orgId: string): Promise<number> {
  const [r] = await tx
    .select({ total: sql<string>`coalesce(sum(${assetVersions.sizeBytes}), 0)::text` })
    .from(assetVersions)
    .where(eq(assetVersions.organizationId, orgId));
  return Number(r.total);
}

export type InitiatedUpload = {
  uploadId: string;
  assetId: string;
  versionId: string;
  versionNumber: number;
  partSize: number;
  partCount: number;
  checksums: boolean;
};

export async function initiateUpload(ctx: AuthContext, input: unknown): Promise<InitiatedUpload> {
  const data = parse(initiateUploadSchema, input);
  const check = checkUploadable(data.filename, data.size, env().UPLOAD_MAX_BYTES);
  if (!check.ok) throw invalid(check.reason, { file: check.reason });
  if (!declaredMimeIsPlausible(check.kind, data.mimeType)) {
    throw invalid("The file's type doesn't match its extension.", { file: "Type doesn't match extension." });
  }

  return withTenant(ctx, async (tx) => {
    await requireProject(tx, ctx, data.projectId, data.assetId ? "asset.version" : "asset.upload");

    if (data.folderId) {
      const [folder] = await tx
        .select({ id: folders.id })
        .from(folders)
        .where(and(eq(folders.id, data.folderId), eq(folders.projectId, data.projectId), isNull(folders.deletedAt)));
      if (!folder) throw notFound("Folder");
    }

    const [org] = await tx.select({ quota: organizations.storageQuotaBytes }).from(organizations).where(eq(organizations.id, ctx.orgId));
    if (org?.quota != null && (await usedBytes(tx, ctx.orgId)) + data.size > org.quota) {
      throw new AppError("quota_exceeded", "This upload would exceed your organization's storage quota.");
    }

    // Existing asset → new version (lock the row so concurrent uploads get distinct numbers).
    let assetId = data.assetId;
    let versionNumber = 1;
    if (assetId) {
      const [asset] = await tx
        .select()
        .from(assets)
        .where(and(eq(assets.id, assetId), eq(assets.projectId, data.projectId), isNull(assets.deletedAt)))
        .for("update");
      if (!asset) throw notFound("Asset");
      if (asset.kind !== check.kind) {
        throw invalid(`A new version must be the same kind of file (${asset.kind}).`, { file: `Expected a ${asset.kind} file.` });
      }
      versionNumber = asset.versionCount + 1;
    }

    const conn = await defaultConnection(tx, ctx.orgId);
    const storage = storageForConnection(conn);
    const versionId = randomUUID();
    const objectKey = keys.original(ctx.orgId, versionId, data.filename);
    const partSize = choosePartSize(data.size);
    const partCount = Math.ceil(data.size / partSize);
    const { uploadId: providerUploadId } = await storage.createMultipartUpload(objectKey, {
      contentType: data.mimeType || "application/octet-stream",
    });

    if (!assetId) {
      const [created] = await tx
        .insert(assets)
        .values({
          organizationId: ctx.orgId,
          projectId: data.projectId,
          folderId: data.folderId,
          name: data.filename.trim(),
          kind: check.kind,
          createdBy: ctx.userId,
        })
        .returning({ id: assets.id });
      assetId = created.id;
    }

    const [location] = await tx
      .insert(storageLocations)
      .values({ organizationId: ctx.orgId, connectionId: conn.id, objectKey, sizeBytes: data.size })
      .returning({ id: storageLocations.id });

    await tx.insert(assetVersions).values({
      id: versionId,
      organizationId: ctx.orgId,
      assetId,
      versionNumber,
      originalFilename: data.filename.trim(),
      extension: check.extension,
      declaredMimeType: data.mimeType || "application/octet-stream",
      sizeBytes: data.size,
      storageSource: "native",
      storageLocationId: location.id,
      processingStatus: "awaiting_upload",
      uploadedBy: ctx.userId,
    });

    await tx
      .update(assets)
      .set({
        versionCount: versionNumber,
        // A brand-new asset points at its first version immediately; new versions become current on completion.
        ...(versionNumber === 1 ? { currentVersionId: versionId } : {}),
        updatedAt: new Date(),
      })
      .where(eq(assets.id, assetId));

    const [session] = await tx
      .insert(uploadSessions)
      .values({
        organizationId: ctx.orgId,
        assetVersionId: versionId,
        storageLocationId: location.id,
        providerUploadId,
        partSize,
        partCount,
        sizeBytes: data.size,
        createdBy: ctx.userId,
        expiresAt: new Date(Date.now() + env().UPLOAD_SESSION_TTL_HOURS * 3_600_000),
      })
      .returning({ id: uploadSessions.id });

    return {
      uploadId: session.id,
      assetId,
      versionId,
      versionNumber,
      partSize,
      partCount,
      checksums: storage.capabilities.partChecksums,
    };
  });
}

/** Loads an active upload session owned by the caller, with its storage target. */
async function loadSession(tx: Tx, ctx: AuthContext, uploadId: string) {
  parse(uuid, uploadId);
  const [row] = await tx
    .select({
      session: uploadSessions,
      objectKey: storageLocations.objectKey,
      connection: storageConnections,
      assetId: assetVersions.assetId,
      versionNumber: assetVersions.versionNumber,
      filename: assetVersions.originalFilename,
      projectId: assets.projectId,
      assetName: assets.name,
    })
    .from(uploadSessions)
    .innerJoin(storageLocations, eq(storageLocations.id, uploadSessions.storageLocationId))
    .innerJoin(storageConnections, eq(storageConnections.id, storageLocations.connectionId))
    .innerJoin(assetVersions, eq(assetVersions.id, uploadSessions.assetVersionId))
    .innerJoin(assets, eq(assets.id, assetVersions.assetId))
    .where(and(eq(uploadSessions.id, uploadId), eq(uploadSessions.createdBy, ctx.userId)))
    .limit(1);
  if (!row || !row.objectKey) throw notFound("Upload");
  return { ...row, objectKey: row.objectKey, storage: storageForConnection(row.connection) };
}

function assertActive(session: typeof uploadSessions.$inferSelect) {
  if (session.status !== "active") throw conflict(`This upload is already ${session.status}.`);
  if (session.expiresAt < new Date()) throw conflict("This upload session has expired. Please upload the file again.");
}

export async function signUploadParts(ctx: AuthContext, uploadId: string, input: unknown) {
  const data = parse(signPartsSchema, input);
  return withTenant(ctx, async (tx) => {
    const s = await loadSession(tx, ctx, uploadId);
    assertActive(s.session);
    // Re-check on every signing request: revoking someone's access stops an in-flight upload.
    const access = await requireProject(tx, ctx, s.projectId);
    if (!access.permissions.has("asset.upload") && !access.permissions.has("asset.version")) throw forbidden();
    const requireChecksum = s.storage.capabilities.partChecksums;
    return Promise.all(
      data.parts.map(async (p) => {
        if (p.partNumber > s.session.partCount) throw invalid(`Part ${p.partNumber} is out of range.`);
        if (requireChecksum && !p.checksumSha256) throw invalid("Each part needs a SHA-256 checksum.");
        const signed = await s.storage.presignUploadPart(s.objectKey, s.session.providerUploadId, p.partNumber, {
          checksumSha256Base64: p.checksumSha256,
          contentLength: partLength(s.session.sizeBytes, s.session.partSize, p.partNumber),
        });
        return { partNumber: p.partNumber, ...signed };
      }),
    );
  });
}

/** Parts already stored (for resuming after a reload or network loss). */
export async function listUploadedParts(ctx: AuthContext, uploadId: string) {
  return withTenant(ctx, async (tx) => {
    const s = await loadSession(tx, ctx, uploadId);
    assertActive(s.session);
    const parts = await s.storage.listUploadedParts(s.objectKey, s.session.providerUploadId);
    return { partSize: s.session.partSize, partCount: s.session.partCount, size: s.session.sizeBytes, parts };
  });
}

export async function completeUpload(ctx: AuthContext, uploadId: string, input: unknown) {
  const data = parse(completeUploadSchema, input);
  return withTenant(ctx, async (tx) => {
    const s = await loadSession(tx, ctx, uploadId);
    if (s.session.status === "completed") return { assetId: s.assetId, versionId: s.session.assetVersionId, alreadyCompleted: true };
    assertActive(s.session);

    const numbers = new Set(data.parts.map((p) => p.partNumber));
    if (numbers.size !== s.session.partCount || data.parts.length !== s.session.partCount) {
      throw invalid(`Expected ${s.session.partCount} parts, received ${numbers.size}.`);
    }
    for (let n = 1; n <= s.session.partCount; n++) if (!numbers.has(n)) throw invalid(`Part ${n} is missing.`);
    if (s.storage.capabilities.partChecksums && data.parts.some((p) => !p.checksumSha256)) {
      throw invalid("Each part needs a SHA-256 checksum.");
    }

    const { etag } = await s.storage.completeMultipartUpload(s.objectKey, s.session.providerUploadId, data.parts);
    const head = await s.storage.head(s.objectKey);
    if (!head || head.size !== s.session.sizeBytes) {
      await s.storage.delete(s.objectKey).catch(() => undefined);
      await tx.update(uploadSessions).set({ status: "aborted" }).where(eq(uploadSessions.id, uploadId));
      throw new AppError("storage_error", "The uploaded file size doesn't match. Please upload it again.");
    }

    const now = new Date();
    await tx.update(uploadSessions).set({ status: "completed", completedAt: now }).where(eq(uploadSessions.id, uploadId));
    await tx.update(storageLocations).set({ etag: etag ?? head.etag, sizeBytes: head.size }).where(eq(storageLocations.id, s.session.storageLocationId));
    await tx
      .update(assetVersions)
      .set({ uploadedAt: now, processingStatus: "processing" })
      .where(eq(assetVersions.id, s.session.assetVersionId));
    await tx
      .update(assets)
      .set({ currentVersionId: s.session.assetVersionId, updatedAt: now })
      .where(eq(assets.id, s.assetId));
    await enqueueJob(tx, { orgId: ctx.orgId, assetVersionId: s.session.assetVersionId, type: "ingest", requestedBy: ctx.userId });
    await recordActivity(tx, ctx, {
      projectId: s.projectId,
      verb: s.versionNumber > 1 ? "asset.version_uploaded" : "asset.uploaded",
      subjectType: "asset",
      subjectId: s.assetId,
      subjectName: s.assetName,
      data: { version: s.versionNumber, size: s.session.sizeBytes },
    });
    await touchProject(tx, s.projectId);
    return { assetId: s.assetId, versionId: s.session.assetVersionId, alreadyCompleted: false };
  });
}

/** Cancels an upload: aborts the multipart upload and removes the never-completed version. */
export async function abortUpload(ctx: AuthContext, uploadId: string) {
  return withTenant(ctx, async (tx) => {
    const s = await loadSession(tx, ctx, uploadId);
    if (s.session.status !== "active") return;
    await s.storage.abortMultipartUpload(s.objectKey, s.session.providerUploadId);
    await discardPendingVersion(tx, s.session.id, s.session.assetVersionId, s.assetId);
  });
}

async function discardPendingVersion(tx: Tx, sessionId: string, versionId: string, assetId: string) {
  await tx.update(uploadSessions).set({ status: "aborted" }).where(eq(uploadSessions.id, sessionId));
  const [version] = await tx
    .select({ locationId: assetVersions.storageLocationId })
    .from(assetVersions)
    .where(eq(assetVersions.id, versionId));
  const [asset] = await tx.select().from(assets).where(eq(assets.id, assetId));
  if (asset && asset.currentVersionId === versionId) {
    const [prev] = await tx
      .select({ id: assetVersions.id })
      .from(assetVersions)
      .where(and(eq(assetVersions.assetId, assetId), sql`${assetVersions.id} <> ${versionId}`, sql`${assetVersions.uploadedAt} is not null`))
      .orderBy(desc(assetVersions.versionNumber))
      .limit(1);
    await tx.update(assets).set({ currentVersionId: prev?.id ?? null }).where(eq(assets.id, assetId));
  }
  await tx.delete(uploadSessions).where(eq(uploadSessions.id, sessionId));
  await tx.delete(assetVersions).where(eq(assetVersions.id, versionId));
  if (version) await tx.delete(storageLocations).where(eq(storageLocations.id, version.locationId));
  const [{ maxVersion }] = await tx
    .select({ maxVersion: sql<number>`coalesce(max(${assetVersions.versionNumber}), 0)::int` })
    .from(assetVersions)
    .where(eq(assetVersions.assetId, assetId));
  if (maxVersion === 0) {
    await tx.delete(assets).where(eq(assets.id, assetId));
  } else {
    await tx.update(assets).set({ versionCount: maxVersion }).where(eq(assets.id, assetId));
  }
}

/** The caller's unfinished uploads in this org (for the "resume" tray). */
export async function listMyActiveUploads(ctx: AuthContext) {
  return withTenant(ctx, (tx) =>
    tx
      .select({
        uploadId: uploadSessions.id,
        filename: assetVersions.originalFilename,
        size: uploadSessions.sizeBytes,
        projectId: assets.projectId,
        projectName: projects.name,
        folderId: assets.folderId,
        assetId: assets.id,
        versionNumber: assetVersions.versionNumber,
        createdAt: uploadSessions.createdAt,
        expiresAt: uploadSessions.expiresAt,
      })
      .from(uploadSessions)
      .innerJoin(assetVersions, eq(assetVersions.id, uploadSessions.assetVersionId))
      .innerJoin(assets, eq(assets.id, assetVersions.assetId))
      .innerJoin(projects, eq(projects.id, assets.projectId))
      .where(
        and(
          eq(uploadSessions.createdBy, ctx.userId),
          eq(uploadSessions.status, "active"),
          sql`${uploadSessions.expiresAt} > now()`,
        ),
      )
      .orderBy(desc(uploadSessions.createdAt))
      .limit(50),
  );
}

/**
 * Maintenance (worker): aborts expired multipart uploads across all orgs so
 * orphaned parts don't accrue storage cost. Runs on the system path.
 */
export async function sweepExpiredUploads(limit = 100) {
  const db = systemDb();
  const expired = await db
    .select({
      id: uploadSessions.id,
      orgId: uploadSessions.organizationId,
      versionId: uploadSessions.assetVersionId,
      providerUploadId: uploadSessions.providerUploadId,
      objectKey: storageLocations.objectKey,
      connection: storageConnections,
      assetId: assetVersions.assetId,
    })
    .from(uploadSessions)
    .innerJoin(storageLocations, eq(storageLocations.id, uploadSessions.storageLocationId))
    .innerJoin(storageConnections, eq(storageConnections.id, storageLocations.connectionId))
    .innerJoin(assetVersions, eq(assetVersions.id, uploadSessions.assetVersionId))
    .where(and(eq(uploadSessions.status, "active"), lt(uploadSessions.expiresAt, sql`now()`)))
    .limit(limit);
  for (const e of expired) {
    try {
      if (e.objectKey) await storageForConnection(e.connection).abortMultipartUpload(e.objectKey, e.providerUploadId);
      await db.transaction((tx) => discardPendingVersion(tx, e.id, e.versionId, e.assetId));
    } catch (err) {
      console.error(`[uploads] failed to sweep upload ${e.id}`, err);
    }
  }
  return expired.length;
}
