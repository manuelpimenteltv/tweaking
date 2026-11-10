import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { and, eq, inArray, sql } from "drizzle-orm";
import { assetVersions, previews, storageConnections, storageLocations, type MediaInfo } from "../db/schema";
import { withScope } from "../db/tenant";
import { env } from "../env";
import { run } from "../media/process";
import { keys, platformStorage, storageForConnection } from "../storage/registry";
import { PermanentJobError } from "./ingest";
import type { ClaimedJob } from "./queue";

/** Rendition ladder (by output height). Never upscales; always produces at least one. */
const LADDER = [1080, 540] as const;

export function renditionHeights(sourceHeight: number): number[] {
  const out = LADDER.filter((h) => h < sourceHeight || h === LADDER[0]).map((h) => Math.min(h, sourceHeight));
  const even = [...new Set(out.map((h) => h - (h % 2)))].filter((h) => h >= 64);
  return even.length ? even : [sourceHeight - (sourceHeight % 2)];
}

/** Picks a sprite interval so the timeline gets ≤ 100 thumbnails. */
export function spriteLayout(durationSec: number) {
  const interval = Math.max(1, Math.ceil(durationSec / 100));
  const count = Math.max(1, Math.ceil(durationSec / interval));
  const columns = Math.min(10, count);
  return { interval, count, columns, rows: Math.ceil(count / columns) };
}

const TILE_WIDTH = 160;

/**
 * Builds review proxies: constant-frame-rate H.264 (yuv420p, BT.709-tagged),
 * a keyframe every 12 frames for precise scrubbing and frame stepping, AAC
 * stereo, faststart MP4. Plus a sprite sheet for timeline hover previews.
 * Variable-frame-rate sources are normalized to their average rate, which is
 * the timeline that frame-anchored comments use.
 */
export async function runProxy(job: ClaimedJob, signal: AbortSignal): Promise<void> {
  const e = env();
  const v = await withScope({ orgId: job.organizationId, userId: null }, async (tx) => {
    const [row] = await tx
      .select({ version: assetVersions, objectKey: storageLocations.objectKey, connection: storageConnections })
      .from(assetVersions)
      .innerJoin(storageLocations, eq(storageLocations.id, assetVersions.storageLocationId))
      .innerJoin(storageConnections, eq(storageConnections.id, storageLocations.connectionId))
      .where(eq(assetVersions.id, job.assetVersionId))
      .limit(1);
    return row;
  });
  if (!v || !v.objectKey) throw new PermanentJobError("Version no longer exists.");
  const info: MediaInfo = v.version.mediaInfo;
  if (!info.width || !info.height || !info.fps) throw new PermanentJobError("No video stream to build a review proxy from.");

  const source = await storageForConnection(v.connection).presignDownload(v.objectKey, { internal: true, expiresInSeconds: 6 * 3600 });
  const dir = await mkdtemp(join(tmpdir(), "loupe-proxy-"));
  const fps = `${info.fps.num}/${info.fps.den}`;
  const timeoutMs = e.WORKER_JOB_TIMEOUT_SECONDS * 1000;
  const orgId = job.organizationId;
  const versionId = job.assetVersionId;

  try {
    const heights = renditionHeights(info.height);
    const outputs: { name: string; path: string; height: number; width: number }[] = [];
    for (const h of heights) {
      const path = join(dir, `${h}p.mp4`);
      await run(
        e.FFMPEG_PATH,
        [
          "-v", "error", "-y",
          "-rw_timeout", "30000000",
          "-i", source,
          "-map", "0:v:0", "-map", "0:a:0?",
          "-vf", `scale=-2:${h}:flags=lanczos,format=yuv420p`,
          "-fps_mode", "cfr", "-r", fps,
          "-c:v", "libx264", "-preset", "veryfast", "-crf", h >= 1080 ? "20" : "23",
          "-g", "12", "-keyint_min", "12", "-sc_threshold", "0",
          "-color_primaries", "bt709", "-color_trc", "bt709", "-colorspace", "bt709",
          "-c:a", "aac", "-b:a", "160k", "-ac", "2",
          "-movflags", "+faststart",
          path,
        ],
        { timeoutMs, signal, maxStdout: 1024 * 1024 },
      );
      const width = Math.round(((info.width / info.height) * h) / 2) * 2;
      outputs.push({ name: `${h}p`, path, height: h, width });
    }

    // Sprite sheet from the smallest proxy (fast to decode).
    const layout = spriteLayout(info.durationSec ?? 1);
    const spritePath = join(dir, "sprite.jpg");
    const smallest = outputs[outputs.length - 1];
    await run(
      e.FFMPEG_PATH,
      [
        "-v", "error", "-y", "-i", smallest.path,
        "-vf", `fps=1/${layout.interval},scale=${TILE_WIDTH}:-2,tile=${layout.columns}x${layout.rows}`,
        "-frames:v", "1", "-q:v", "5", spritePath,
      ],
      { timeoutMs: 600_000, signal, maxStdout: 1024 * 1024 },
    );
    const tileHeight = Math.round(((info.height / info.width) * TILE_WIDTH) / 2) * 2;

    // Upload, then swap preview rows atomically. Originals are never touched.
    const platform = platformStorage();
    const uploaded: { kind: "proxy" | "sprite"; key: string; size: number; mime: string; width: number; height: number; rendition?: string; metadata: Record<string, unknown> }[] = [];
    for (const o of outputs) {
      const key = keys.derived(orgId, versionId, `proxy_${o.name}.mp4`);
      const size = await platform.putFile(key, o.path, { contentType: "video/mp4", cacheControl: "private, max-age=31536000, immutable" });
      uploaded.push({ kind: "proxy", key, size, mime: "video/mp4", width: o.width, height: o.height, rendition: o.name, metadata: { fps: info.fps } });
    }
    const spriteKey = keys.derived(orgId, versionId, "sprite.jpg");
    const spriteSize = await platform.putFile(spriteKey, spritePath, { contentType: "image/jpeg", cacheControl: "private, max-age=31536000, immutable" });
    uploaded.push({
      kind: "sprite",
      key: spriteKey,
      size: spriteSize,
      mime: "image/jpeg",
      width: TILE_WIDTH * layout.columns,
      height: tileHeight * layout.rows,
      metadata: { ...layout, tileWidth: TILE_WIDTH, tileHeight },
    });

    await withScope({ orgId, userId: null }, async (tx) => {
      const [conn] = await tx
        .select({ id: storageConnections.id })
        .from(storageConnections)
        .where(and(eq(storageConnections.organizationId, orgId), eq(storageConnections.providerId, "platform")))
        .limit(1);
      await tx.delete(previews).where(and(eq(previews.assetVersionId, versionId), inArray(previews.kind, ["proxy", "sprite"])));
      for (const u of uploaded) {
        const [loc] = await tx
          .insert(storageLocations)
          .values({ organizationId: orgId, connectionId: conn.id, objectKey: u.key, sizeBytes: u.size })
          .onConflictDoUpdate({
            target: [storageLocations.connectionId, storageLocations.objectKey],
            targetWhere: sql`object_key is not null`,
            set: { sizeBytes: u.size },
          })
          .returning({ id: storageLocations.id });
        await tx.insert(previews).values({
          organizationId: orgId,
          assetVersionId: versionId,
          kind: u.kind,
          storageLocationId: loc.id,
          mimeType: u.mime,
          width: u.width,
          height: u.height,
          rendition: u.rendition ?? null,
          sizeBytes: u.size,
          metadata: u.metadata,
        });
      }
    });
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
}
