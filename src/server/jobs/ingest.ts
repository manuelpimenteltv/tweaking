import { createHash } from "node:crypto";
import { and, eq, sql } from "drizzle-orm";
import { fileTypeFromBuffer } from "file-type";
import sharp from "sharp";
import type { AssetKind } from "@/lib/file-types";
import { assetVersions, assets, previews, storageConnections, storageLocations, type MediaInfo } from "../db/schema";
import { withScope } from "../db/tenant";
import { env } from "../env";
import { extractFrame, ffprobe } from "../media/probe";
import { keys, platformStorage, storageForConnection } from "../storage/registry";
import { enqueueJob, type ClaimedJob } from "./queue";

/** Thrown for failures that retrying cannot fix (bad content, unsupported input). */
export class PermanentJobError extends Error {
  constructor(
    message: string,
    public readonly versionFields: Partial<typeof assetVersions.$inferInsert> = {},
  ) {
    super(message);
  }
}

const HEAD_BYTES = 4100;
const MAX_IMAGE_BUFFER = 512 * 1024 * 1024;
const THUMB_WIDTH = 640;
const POSTER_WIDTH = 1920;

const EXECUTABLE_MIME = new Set([
  "application/x-msdownload",
  "application/x-elf",
  "application/x-mach-binary",
  "application/x-sharedlib",
  "application/vnd.microsoft.portable-executable",
  "application/x-dosexec",
  "application/java-archive",
]);

/**
 * Checks magic-byte detection against the kind implied by the extension.
 * `undefined` detection (plain text, many camera RAW formats) is accepted but
 * recorded as unverified.
 */
export function contentMatchesKind(kind: AssetKind, detectedMime: string | undefined): boolean {
  if (!detectedMime) return true;
  if (EXECUTABLE_MIME.has(detectedMime)) return false;
  const family = detectedMime.split("/")[0];
  switch (kind) {
    case "video":
      return family === "video" || family === "audio" || detectedMime === "application/mxf" || detectedMime === "application/octet-stream";
    case "audio":
      return family === "audio" || family === "video";
    case "image":
      return family === "image" || detectedMime === "application/octet-stream" || detectedMime === "application/postscript";
    default:
      return true;
  }
}

type Loaded = {
  versionId: string;
  orgId: string;
  kind: AssetKind;
  objectKey: string;
  locationId: string;
  connection: typeof storageConnections.$inferSelect;
  sizeBytes: number;
};

async function load(job: ClaimedJob): Promise<Loaded> {
  return withScope({ orgId: job.organizationId, userId: null }, async (tx) => {
    const [row] = await tx
      .select({
        version: assetVersions,
        kind: assets.kind,
        objectKey: storageLocations.objectKey,
        connection: storageConnections,
      })
      .from(assetVersions)
      .innerJoin(assets, eq(assets.id, assetVersions.assetId))
      .innerJoin(storageLocations, eq(storageLocations.id, assetVersions.storageLocationId))
      .innerJoin(storageConnections, eq(storageConnections.id, storageLocations.connectionId))
      .where(eq(assetVersions.id, job.assetVersionId))
      .limit(1);
    if (!row) throw new PermanentJobError("Version no longer exists.");
    if (!row.version.uploadedAt || !row.objectKey) throw new PermanentJobError("Upload was not completed.");
    if (row.version.storageSource === "external_reference") {
      // Phase 5: external references are processed only after access verification.
      throw new PermanentJobError("Processing of external references is not available yet.");
    }
    return {
      versionId: row.version.id,
      orgId: job.organizationId,
      kind: row.kind as AssetKind,
      objectKey: row.objectKey,
      locationId: row.version.storageLocationId,
      connection: row.connection,
      sizeBytes: row.version.sizeBytes,
    };
  });
}

type Derived = { kind: "thumbnail" | "poster"; buffer: Buffer; width: number; height: number };

async function renderPreviews(source: Buffer): Promise<Derived[]> {
  const out: Derived[] = [];
  for (const [kind, width] of [["thumbnail", THUMB_WIDTH], ["poster", POSTER_WIDTH]] as const) {
    const { data, info } = await sharp(source, { limitInputPixels: 268_402_689, failOn: "error" })
      .rotate()
      .resize({ width, withoutEnlargement: true })
      .webp({ quality: kind === "thumbnail" ? 72 : 82 })
      .toBuffer({ resolveWithObject: true });
    out.push({ kind, buffer: data, width: info.width, height: info.height });
  }
  return out;
}

/**
 * Ingest pipeline for one uploaded version. Reads the original (never modifies
 * it), computes SHA-256, verifies content type, extracts metadata and writes
 * derived previews to the derived/ prefix.
 */
export async function runIngest(job: ClaimedJob, signal: AbortSignal): Promise<void> {
  const v = await load(job);
  const storage = storageForConnection(v.connection);
  const e = env();

  // 1. Stream the original once: hash everything, keep the head for type detection
  //    and (for reasonably sized images) the full buffer for thumbnailing.
  const hash = createHash("sha256");
  const head: Buffer[] = [];
  let headLen = 0;
  const keepAll = v.kind === "image" && v.sizeBytes <= MAX_IMAGE_BUFFER;
  const all: Buffer[] = [];
  let total = 0;
  const stream = await storage.getStream(v.objectKey);
  for await (const chunk of stream as AsyncIterable<Buffer>) {
    if (signal.aborted) throw new Error("Job aborted");
    hash.update(chunk);
    total += chunk.length;
    if (headLen < HEAD_BYTES) {
      head.push(chunk);
      headLen += chunk.length;
    }
    if (keepAll) all.push(chunk);
  }
  if (total !== v.sizeBytes) throw new Error(`Stored size ${total} doesn't match expected ${v.sizeBytes}.`);
  const sha256 = hash.digest("hex");

  const detected = await fileTypeFromBuffer(Buffer.concat(head).subarray(0, HEAD_BYTES));
  if (!contentMatchesKind(v.kind, detected?.mime)) {
    throw new PermanentJobError(`File content (${detected?.mime}) doesn't match its extension. It was not processed.`, {
      contentSha256: sha256,
      detectedMimeType: detected?.mime ?? null,
    });
  }

  // 2. Metadata + previews by kind. Preview failures are recorded, not fatal.
  let mediaInfo: MediaInfo = {};
  const derived: Derived[] = [];
  const notes: string[] = [];
  if (v.kind === "video" || v.kind === "audio") {
    const url = await storage.presignDownload(v.objectKey, { internal: true, expiresInSeconds: 3600 });
    try {
      mediaInfo = await ffprobe(e.FFPROBE_PATH, url, signal);
    } catch (err) {
      throw new PermanentJobError(`Could not read media: ${(err as Error).message}`);
    }
    if (v.kind === "video" && mediaInfo.width) {
      try {
        const at = Math.min(1, (mediaInfo.durationSec ?? 0) * 0.1);
        const frame = await extractFrame(e.FFMPEG_PATH, url, at, signal);
        derived.push(...(await renderPreviews(frame)));
      } catch (err) {
        notes.push(`Thumbnail unavailable: ${(err as Error).message}`);
      }
    }
  } else if (v.kind === "image") {
    if (keepAll) {
      const buffer = Buffer.concat(all);
      try {
        const meta = await sharp(buffer).metadata();
        mediaInfo = { width: meta.autoOrient?.width ?? meta.width, height: meta.autoOrient?.height ?? meta.height, colorSpace: meta.space };
        derived.push(...(await renderPreviews(buffer)));
      } catch (err) {
        notes.push(`Preview unavailable for this image format (${(err as Error).message}).`);
      }
    } else {
      notes.push("Image is too large for in-process preview generation.");
    }
  }
  // Documents, spreadsheets and presentations get page/slide renders in Phase 3.

  // 3. Persist derived files to native storage, then metadata — originals untouched.
  const platform = platformStorage();
  const written: { kind: Derived["kind"]; key: string; size: number; width: number; height: number }[] = [];
  for (const d of derived) {
    const key = keys.derived(v.orgId, v.versionId, `${d.kind}.webp`);
    await platform.put(key, d.buffer, { contentType: "image/webp", cacheControl: "private, max-age=31536000, immutable" });
    written.push({ kind: d.kind, key, size: d.buffer.length, width: d.width, height: d.height });
  }

  await withScope({ orgId: v.orgId, userId: null }, async (tx) => {
    const [platformConn] = await tx
      .select({ id: storageConnections.id })
      .from(storageConnections)
      .where(and(eq(storageConnections.organizationId, v.orgId), eq(storageConnections.providerId, "platform")))
      .limit(1);
    // Re-running ingest replaces previous previews.
    await tx.delete(previews).where(eq(previews.assetVersionId, v.versionId));
    for (const w of written) {
      const [loc] = await tx
        .insert(storageLocations)
        .values({ organizationId: v.orgId, connectionId: platformConn.id, objectKey: w.key, sizeBytes: w.size })
        .onConflictDoUpdate({
          target: [storageLocations.connectionId, storageLocations.objectKey],
          targetWhere: sqlObjectKeyNotNull,
          set: { sizeBytes: w.size },
        })
        .returning({ id: storageLocations.id });
      await tx.insert(previews).values({
        organizationId: v.orgId,
        assetVersionId: v.versionId,
        kind: w.kind,
        storageLocationId: loc.id,
        mimeType: "image/webp",
        width: w.width,
        height: w.height,
        sizeBytes: w.size,
      });
    }
    await tx.update(storageLocations).set({ checksumSha256: sha256 }).where(eq(storageLocations.id, v.locationId));
    await tx
      .update(assetVersions)
      .set({
        contentSha256: sha256,
        detectedMimeType: detected?.mime ?? null,
        mediaInfo: notes.length ? { ...mediaInfo, notes } : mediaInfo,
        processingStatus: "ready",
        processingError: null,
      })
      .where(eq(assetVersions.id, v.versionId));
    // Videos get browser review proxies + timeline sprites in a follow-up job (same transaction).
    if (v.kind === "video" && mediaInfo.width) {
      await enqueueJob(tx, { orgId: v.orgId, assetVersionId: v.versionId, type: "proxy" });
    }
  });
}

const sqlObjectKeyNotNull = sql`object_key is not null`;

/** Called by the worker once a job has permanently failed. */
export async function markVersionFailed(job: ClaimedJob, message: string, extra: Partial<typeof assetVersions.$inferInsert> = {}) {
  await withScope({ orgId: job.organizationId, userId: null }, (tx) =>
    tx
      .update(assetVersions)
      .set({ processingStatus: "failed", processingError: message.slice(0, 1000), ...extra })
      .where(eq(assetVersions.id, job.assetVersionId)),
  );
}
