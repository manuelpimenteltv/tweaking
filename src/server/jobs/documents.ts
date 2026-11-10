import { createWriteStream, existsSync } from "node:fs";
import { mkdtemp, readdir, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { basename, extname, join } from "node:path";
import { pipeline } from "node:stream/promises";
import { gzipSync } from "node:zlib";
import { and, eq, inArray, sql } from "drizzle-orm";
import sharp from "sharp";
import { assetVersions, assets, previews, storageConnections, storageLocations, type MediaInfo } from "../db/schema";
import { withScope } from "../db/tenant";
import { env } from "../env";
import { ProcessError, run } from "../media/process";
import { keys, platformStorage, storageForConnection } from "../storage/registry";
import { PermanentJobError } from "./ingest";
import type { ClaimedJob } from "./queue";
import { buildSheetModel, type SheetManifest } from "./sheets";

type Loaded = {
  orgId: string;
  versionId: string;
  kind: string;
  extension: string;
  filename: string;
  objectKey: string;
  sizeBytes: number;
  mediaInfo: MediaInfo;
  connection: typeof storageConnections.$inferSelect;
};

async function load(job: ClaimedJob): Promise<Loaded> {
  const row = await withScope({ orgId: job.organizationId, userId: null }, async (tx) => {
    const [r] = await tx
      .select({ version: assetVersions, kind: assets.kind, objectKey: storageLocations.objectKey, connection: storageConnections })
      .from(assetVersions)
      .innerJoin(assets, eq(assets.id, assetVersions.assetId))
      .innerJoin(storageLocations, eq(storageLocations.id, assetVersions.storageLocationId))
      .innerJoin(storageConnections, eq(storageConnections.id, storageLocations.connectionId))
      .where(eq(assetVersions.id, job.assetVersionId))
      .limit(1);
    return r;
  });
  if (!row || !row.objectKey) throw new PermanentJobError("Version no longer exists.");
  if (row.version.sizeBytes > env().DOCUMENT_PREVIEW_MAX_BYTES) {
    throw new PermanentJobError("This file is too large for an in-browser preview. Download the original to view it.");
  }
  return {
    orgId: job.organizationId,
    versionId: row.version.id,
    kind: row.kind,
    extension: row.version.extension,
    filename: row.version.originalFilename,
    objectKey: row.objectKey,
    sizeBytes: row.version.sizeBytes,
    mediaInfo: row.version.mediaInfo,
    connection: row.connection,
  };
}

/** Copies the original into the job's scratch directory (read-only use; never written back). */
async function download(v: Loaded, dir: string): Promise<string> {
  // Fixed ASCII name: user-supplied filenames never reach a command line.
  const path = join(dir, `source.${v.extension || "bin"}`);
  await pipeline(await storageForConnection(v.connection).getStream(v.objectKey), createWriteStream(path));
  return path;
}

/** LibreOffice binary: SOFFICE_PATH, else the macOS app bundle when present, else `soffice` on PATH. */
export function sofficeBinary(): string {
  const configured = env().SOFFICE_PATH;
  if (configured !== "soffice") return configured;
  const mac = "/Applications/LibreOffice.app/Contents/MacOS/soffice";
  return process.platform === "darwin" && existsSync(mac) ? mac : "soffice";
}

/**
 * Converts with LibreOffice in headless mode. Each conversion gets its own
 * throwaway profile (parallel jobs can't share one) and runs under the worker's
 * timeout. Macros are not executed in headless conversion.
 */
export async function convertWithLibreOffice(input: string, outDir: string, format: "pdf" | "xlsx", signal: AbortSignal): Promise<string> {
  const profile = await mkdtemp(join(tmpdir(), "loupe-lo-profile-"));
  try {
    await run(
      sofficeBinary(),
      [
        `-env:UserInstallation=file://${profile}`,
        "--headless", "--invisible", "--nodefault", "--nolockcheck", "--nologo", "--norestore",
        "--convert-to", format,
        "--outdir", outDir,
        input,
      ],
      { timeoutMs: 240_000, signal, maxStdout: 1024 * 1024 },
    );
  } catch (err) {
    if (err instanceof ProcessError && /failed to start/.test(err.message)) {
      throw new PermanentJobError("LibreOffice is not installed on the processing worker, so Office files can't be previewed yet.");
    }
    throw err;
  } finally {
    await rm(profile, { recursive: true, force: true });
  }
  const expected = join(outDir, `${basename(input, extname(input))}.${format}`);
  const files = await readdir(outDir);
  if (!files.includes(basename(expected))) throw new PermanentJobError("The file couldn't be converted for preview (it may be damaged or in an unsupported format).");
  return expected;
}

export async function pdfInfo(path: string, signal: AbortSignal): Promise<{ pages: number; width: number; height: number; encrypted: boolean }> {
  const out = (await run(env().PDFINFO_PATH, [path], { timeoutMs: 60_000, signal, maxStdout: 1024 * 1024 })).toString("utf8");
  const pages = Number(/^Pages:\s+(\d+)/m.exec(out)?.[1] ?? 0);
  const size = /^Page size:\s+([\d.]+) x ([\d.]+)/m.exec(out);
  return { pages, width: Number(size?.[1] ?? 612), height: Number(size?.[2] ?? 792), encrypted: /^Encrypted:\s+yes/m.test(out) };
}

async function firstPageImage(pdf: string, dir: string, signal: AbortSignal): Promise<Buffer> {
  const prefix = join(dir, "page");
  await run(env().PDFTOPPM_PATH, ["-f", "1", "-l", "1", "-png", "-scale-to", "1920", "-singlefile", pdf, prefix], { timeoutMs: 120_000, signal, maxStdout: 1024 * 1024 });
  return readFile(`${prefix}.png`);
}

type Upload = { kind: "pdf" | "thumbnail" | "poster" | "sheet_model"; key: string; body: Buffer; mime: string; width?: number; height?: number; metadata?: Record<string, unknown>; encoding?: "gzip" };

async function storeDerived(v: Loaded, uploads: Upload[], replaceKinds: ("pdf" | "thumbnail" | "poster" | "sheet_model")[], mediaInfo: MediaInfo) {
  const platform = platformStorage();
  for (const u of uploads) {
    await platform.put(u.key, u.body, { contentType: u.mime, cacheControl: "private, max-age=31536000, immutable", contentEncoding: u.encoding });
  }
  await withScope({ orgId: v.orgId, userId: null }, async (tx) => {
    const [conn] = await tx
      .select({ id: storageConnections.id })
      .from(storageConnections)
      .where(and(eq(storageConnections.organizationId, v.orgId), eq(storageConnections.providerId, "platform")))
      .limit(1);
    await tx.delete(previews).where(and(eq(previews.assetVersionId, v.versionId), inArray(previews.kind, replaceKinds)));
    for (const u of uploads.filter((x) => replaceKinds.includes(x.kind))) {
      const [loc] = await tx
        .insert(storageLocations)
        .values({ organizationId: v.orgId, connectionId: conn.id, objectKey: u.key, sizeBytes: u.body.length })
        .onConflictDoUpdate({ target: [storageLocations.connectionId, storageLocations.objectKey], targetWhere: sql`object_key is not null`, set: { sizeBytes: u.body.length } })
        .returning({ id: storageLocations.id });
      await tx.insert(previews).values({
        organizationId: v.orgId,
        assetVersionId: v.versionId,
        kind: u.kind,
        storageLocationId: loc.id,
        mimeType: u.mime,
        width: u.width ?? null,
        height: u.height ?? null,
        sizeBytes: u.body.length,
        metadata: u.metadata ?? {},
      });
    }
    await tx.update(assetVersions).set({ mediaInfo }).where(eq(assetVersions.id, v.versionId));
  });
}

async function thumbnails(v: Loaded, png: Buffer): Promise<Upload[]> {
  const out: Upload[] = [];
  for (const [kind, width] of [["thumbnail", 640], ["poster", 1600]] as const) {
    const { data, info } = await sharp(png).flatten({ background: "#ffffff" }).resize({ width, withoutEnlargement: true }).webp({ quality: 82 }).toBuffer({ resolveWithObject: true });
    out.push({ kind, key: keys.derived(v.orgId, v.versionId, `${kind}.webp`), body: data, mime: "image/webp", width: info.width, height: info.height });
  }
  return out;
}

/**
 * Documents and presentations → a review PDF (the original for PDFs, a
 * LibreOffice rendering otherwise) plus page count and a cover thumbnail.
 */
export async function runDocument(job: ClaimedJob, signal: AbortSignal): Promise<void> {
  const v = await load(job);
  const dir = await mkdtemp(join(tmpdir(), "loupe-doc-"));
  try {
    const source = await download(v, dir);
    const isPdf = v.extension === "pdf";
    const pdf = isPdf ? source : await convertWithLibreOffice(source, dir, "pdf", signal);
    let info;
    try {
      info = await pdfInfo(pdf, signal);
    } catch {
      throw new PermanentJobError("This PDF couldn't be read. It may be damaged.");
    }
    if (info.encrypted && isPdf) throw new PermanentJobError("This PDF is password-protected and can't be previewed.");
    if (!info.pages) throw new PermanentJobError("The document has no pages to preview.");

    const uploads: Upload[] = [];
    if (!isPdf) {
      uploads.push({ kind: "pdf", key: keys.derived(v.orgId, v.versionId, "review.pdf"), body: await readFile(pdf), mime: "application/pdf", metadata: { renderer: "libreoffice" } });
    }
    const notes = (v.mediaInfo.notes ?? []).filter((n) => !n.startsWith("Rendered with LibreOffice"));
    try {
      uploads.push(...(await thumbnails(v, await firstPageImage(pdf, dir, signal))));
    } catch (err) {
      notes.push(`Cover thumbnail unavailable: ${(err as Error).message}`);
    }
    if (!isPdf) notes.push("Rendered with LibreOffice for review. Layout can differ slightly from Microsoft Office or Keynote; the original is unchanged and available for download.");
    await storeDerived(v, uploads, isPdf ? ["thumbnail", "poster"] : ["pdf", "thumbnail", "poster"], {
      ...v.mediaInfo,
      pages: info.pages,
      width: Math.round(info.width),
      height: Math.round(info.height),
      notes: notes.length ? notes : undefined,
    });
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
}

/**
 * Spreadsheets → a chunked JSON model (displayed values, formulas, basic
 * formatting, hidden rows/columns, merges) for the in-browser grid, plus a
 * cover thumbnail. Legacy formats are converted to XLSX by LibreOffice first.
 */
export async function runSheet(job: ClaimedJob, signal: AbortSignal): Promise<void> {
  const v = await load(job);
  const dir = await mkdtemp(join(tmpdir(), "loupe-sheet-"));
  try {
    const source = await download(v, dir);
    const native = ["xlsx", "xlsm", "csv", "tsv"].includes(v.extension);
    const input = native ? source : await convertWithLibreOffice(source, dir, "xlsx", signal);
    const format = v.extension === "csv" || v.extension === "tsv" ? (v.extension as "csv" | "tsv") : "xlsx";
    const { manifest, chunks } = await buildSheetModel(input, format, v.filename);
    if (!manifest.sheets.length) throw new PermanentJobError("The workbook has no sheets to preview.");

    const uploads: Upload[] = chunks.map((c) => ({
      kind: "sheet_model" as const,
      key: keys.derived(v.orgId, v.versionId, `sheets/${c.sheet}/${c.chunk}.json`),
      body: gzipSync(JSON.stringify(c.data)),
      mime: "application/json",
      encoding: "gzip" as const,
    }));
    const manifestUpload: Upload = {
      kind: "sheet_model",
      key: keys.derived(v.orgId, v.versionId, "sheets/manifest.json"),
      body: Buffer.from(JSON.stringify(manifest)),
      mime: "application/json",
      metadata: manifestSummary(manifest),
    };

    const notes = [...manifest.notes];
    const extra: Upload[] = [];
    try {
      const pdf = await convertWithLibreOffice(input, dir, "pdf", signal);
      extra.push(...(await thumbnails(v, await firstPageImage(pdf, dir, signal))));
    } catch (err) {
      notes.push(`Cover thumbnail unavailable: ${(err as Error).message}`);
    }
    // Chunks are uploaded but only the manifest is a preview row (chunk keys are derived from it).
    const platform = platformStorage();
    for (const u of uploads) await platform.put(u.key, u.body, { contentType: u.mime, contentEncoding: "gzip", cacheControl: "private, max-age=31536000, immutable" });
    await storeDerived(v, [manifestUpload, ...extra], ["sheet_model", "thumbnail", "poster"], {
      ...v.mediaInfo,
      sheets: manifest.sheets.map((s) => ({ name: s.name, rows: s.rows, cols: s.cols, hidden: s.hidden || undefined })),
      notes: notes.length ? notes : undefined,
    });
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
}

function manifestSummary(m: SheetManifest) {
  return { sheets: m.sheets.length, chunkRows: m.chunkRows };
}
