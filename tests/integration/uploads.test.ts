import { createHash, randomBytes } from "node:crypto";
import { execFileSync } from "node:child_process";
import { mkdtempSync, readFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import sharp from "sharp";
import { beforeAll, beforeEach, describe, expect, it } from "vitest";
import type { AuthContext } from "@/server/authz/context";
import { runOnce } from "@/server/jobs/runner";
import { createFolder, deleteItems, getAsset, getDownloadUrl, listFolderContents, moveItems } from "@/server/modules/assets";
import { retryProcessing } from "@/server/modules/processing";
import { createProject } from "@/server/modules/projects";
import { storageSummary } from "@/server/modules/storage-usage";
import {
  abortUpload,
  choosePartSize,
  completeUpload,
  initiateUpload,
  listUploadedParts,
  signUploadParts,
} from "@/server/modules/uploads";
import { listWorkspaces } from "@/server/modules/workspaces";
import { platformStorage } from "@/server/storage/registry";
import { execSetupStorage } from "./storage-setup";
import { ctxFor, makeOrg, makeUser, resetDb } from "../helpers";

const sha256b64 = (b: Buffer) => createHash("sha256").update(b).digest("base64");

/** Mirrors the browser uploader: per-part SHA-256, presigned PUTs, then complete. */
async function upload(
  ctx: AuthContext,
  args: { projectId: string; folderId?: string | null; assetId?: string; filename: string; data: Buffer; mime: string },
  opts: { stopAfterParts?: number } = {},
) {
  const init = await initiateUpload(ctx, {
    projectId: args.projectId,
    folderId: args.folderId ?? null,
    assetId: args.assetId ?? null,
    filename: args.filename,
    size: args.data.length,
    mimeType: args.mime,
  });
  const parts: { partNumber: number; etag: string; checksumSha256: string }[] = [];
  for (let n = 1; n <= init.partCount; n++) {
    if (opts.stopAfterParts !== undefined && n > opts.stopAfterParts) break;
    const body = args.data.subarray((n - 1) * init.partSize, n * init.partSize);
    const checksum = sha256b64(body);
    const [signed] = await signUploadParts(ctx, init.uploadId, { parts: [{ partNumber: n, checksumSha256: checksum }] });
    const res = await fetch(signed.url, { method: "PUT", headers: signed.headers, body: new Uint8Array(body) });
    expect(res.status, await res.clone().text()).toBe(200);
    parts.push({ partNumber: n, etag: res.headers.get("etag")!, checksumSha256: checksum });
  }
  return { init, parts };
}

async function drainQueue() {
  while (await runOnce("test-worker")) {
    /* keep going */
  }
}

let ctx: AuthContext;
let projectId: string;

beforeAll(async () => {
  await execSetupStorage();
});

beforeEach(async () => {
  await resetDb();
  const owner = await makeUser("Editor");
  await makeOrg(owner, "east-edit");
  ctx = await ctxFor(owner, "east-edit");
  const [ws] = await listWorkspaces(ctx);
  projectId = (await createProject(ctx, { name: "Documentary", workspaceId: ws.id })).id;
});

describe("folders", () => {
  it("nests, rejects cycles and duplicate names, and soft-deletes subtrees", async () => {
    const edit = await createFolder(ctx, { projectId, name: "Edit" });
    const cuts = await createFolder(ctx, { projectId, parentId: edit.id, name: "Cuts" });
    const v1 = await createFolder(ctx, { projectId, parentId: cuts.id, name: "V1" });
    await expect(createFolder(ctx, { projectId, parentId: edit.id, name: "cuts" })).rejects.toMatchObject({ code: "conflict" });
    await expect(moveItems(ctx, { projectId, folderIds: [edit.id], targetFolderId: v1.id })).rejects.toMatchObject({ code: "validation" });

    const listing = await listFolderContents(ctx, { projectId, folderId: v1.id });
    expect(listing.breadcrumbs.map((b) => b.name)).toEqual(["Edit", "Cuts", "V1"]);

    const { init, parts } = await upload(ctx, { projectId, folderId: v1.id, filename: "notes.txt", data: Buffer.from("hello"), mime: "text/plain" });
    await completeUpload(ctx, init.uploadId, { parts });
    const removed = await deleteItems(ctx, { projectId, folderIds: [edit.id] });
    expect(removed).toEqual({ assets: 1, folders: 3 });
    expect((await listFolderContents(ctx, { projectId })).folders).toEqual([]);
  });
});

describe("uploads", () => {
  it("chooses part sizes within S3's 10,000-part limit", () => {
    expect(choosePartSize(1)).toBe(8 * 1024 * 1024);
    const huge = 4 * 1024 ** 4; // 4 TiB
    expect(Math.ceil(huge / choosePartSize(huge))).toBeLessThanOrEqual(10_000);
  });

  it("uploads an image directly to storage, verifies it and generates previews", async () => {
    const png = await sharp({ create: { width: 1600, height: 900, channels: 3, background: "#3a6ea5" } }).png().toBuffer();
    const { init, parts } = await upload(ctx, { projectId, filename: "frame_0001.png", data: png, mime: "image/png" });
    await completeUpload(ctx, init.uploadId, { parts });
    expect((await getAsset(ctx, init.assetId)).selected?.processingStatus).toBe("processing");

    await drainQueue();
    const asset = await getAsset(ctx, init.assetId);
    expect(asset.selected).toMatchObject({
      processingStatus: "ready",
      detectedMimeType: "image/png",
      contentSha256: createHash("sha256").update(png).digest("hex"),
      mediaInfo: { width: 1600, height: 900 },
    });
    expect(asset.previewCount).toBe(2);
    expect(asset.thumbnailUrl).toMatch(/X-Amz-Signature=/);
    const thumb = await fetch(asset.thumbnailUrl!);
    expect(thumb.headers.get("content-type")).toBe("image/webp");

    const download = await getDownloadUrl(ctx, init.versionId);
    const res = await fetch(download);
    expect(Buffer.from(await res.arrayBuffer()).equals(png)).toBe(true);
    expect(res.headers.get("content-disposition")).toContain('attachment; filename="frame_0001.png"');

    expect((await storageSummary(ctx)).originalBytes).toBe(png.length);
  });

  it("resumes a multipart upload from the parts already stored", async () => {
    const data = randomBytes(20 * 1024 * 1024 + 123);
    const first = await upload(ctx, { projectId, filename: "plates.bin", data, mime: "application/octet-stream" }, { stopAfterParts: 2 });
    expect(first.init.partCount).toBe(3);
    const state = await listUploadedParts(ctx, first.init.uploadId);
    expect(state.parts.map((p) => p.partNumber)).toEqual([1, 2]);

    // "After a reload": upload only the missing part, then complete with all parts.
    const body = data.subarray(2 * first.init.partSize);
    const checksum = sha256b64(body);
    const [signed] = await signUploadParts(ctx, first.init.uploadId, { parts: [{ partNumber: 3, checksumSha256: checksum }] });
    const res = await fetch(signed.url, { method: "PUT", headers: signed.headers, body: new Uint8Array(body) });
    expect(res.status).toBe(200);
    const parts = [
      ...state.parts.map((p) => ({ partNumber: p.partNumber, etag: p.etag, checksumSha256: p.checksumSha256! })),
      { partNumber: 3, etag: res.headers.get("etag")!, checksumSha256: checksum },
    ];
    await completeUpload(ctx, first.init.uploadId, { parts });
    await drainQueue();
    const asset = await getAsset(ctx, first.init.assetId);
    expect(asset.selected?.contentSha256).toBe(createHash("sha256").update(data).digest("hex"));
    expect(asset.selected?.processingStatus).toBe("ready");
  });

  it("storage rejects a part whose bytes don't match the signed checksum", async () => {
    const init = await initiateUpload(ctx, { projectId, filename: "a.txt", size: 11, mimeType: "text/plain" });
    const [signed] = await signUploadParts(ctx, init.uploadId, {
      parts: [{ partNumber: 1, checksumSha256: sha256b64(Buffer.from("hello world")) }],
    });
    const res = await fetch(signed.url, { method: "PUT", headers: signed.headers, body: new Uint8Array(Buffer.from("hello WORLD")) });
    expect(res.status).toBe(400);
  });

  it("rejects blocked file types and mismatched versions", async () => {
    await expect(initiateUpload(ctx, { projectId, filename: "setup.exe", size: 10, mimeType: "application/octet-stream" })).rejects.toMatchObject({
      code: "validation",
    });
    await expect(initiateUpload(ctx, { projectId, filename: "clip.mp4", size: 10, mimeType: "text/html" })).rejects.toMatchObject({
      code: "validation",
    });
    const { init, parts } = await upload(ctx, { projectId, filename: "script.pdf", data: Buffer.from("%PDF-1.4 fake"), mime: "application/pdf" });
    await completeUpload(ctx, init.uploadId, { parts });
    await expect(
      initiateUpload(ctx, { projectId, assetId: init.assetId, filename: "cut.mov", size: 10, mimeType: "video/quicktime" }),
    ).rejects.toMatchObject({ code: "validation" });
  });

  it("fails processing when content doesn't match the extension, and allows retry", async () => {
    const png = await sharp({ create: { width: 64, height: 64, channels: 3, background: "#000" } }).png().toBuffer();
    const { init, parts } = await upload(ctx, { projectId, filename: "clip.mp4", data: png, mime: "video/mp4" });
    await completeUpload(ctx, init.uploadId, { parts });
    await drainQueue();
    const failed = await getAsset(ctx, init.assetId);
    expect(failed.selected?.processingStatus).toBe("failed");
    expect(failed.selected?.processingError).toMatch(/doesn't match its extension/);
    await retryProcessing(ctx, init.versionId);
    expect((await getAsset(ctx, init.assetId)).selected?.processingStatus).toBe("processing");
    await drainQueue();
    expect((await getAsset(ctx, init.assetId)).selected?.processingStatus).toBe("failed");
  });

  it("probes video: rational frame rate, start timecode, playability, poster", async () => {
    const dir = mkdtempSync(join(tmpdir(), "loupe-"));
    const file = join(dir, "clip.mp4");
    execFileSync("ffmpeg", [
      "-v", "error", "-f", "lavfi", "-i", "testsrc=size=640x360:rate=24000/1001:duration=2",
      "-f", "lavfi", "-i", "sine=frequency=1000:duration=2",
      "-c:v", "libx264", "-pix_fmt", "yuv420p", "-c:a", "aac", "-shortest",
      "-timecode", "01:00:00:00", "-y", file,
    ]);
    const data = readFileSync(file);
    const { init, parts } = await upload(ctx, { projectId, filename: "A001C003_clip.mp4", data, mime: "video/mp4" });
    await completeUpload(ctx, init.uploadId, { parts });
    await drainQueue();
    const asset = await getAsset(ctx, init.assetId);
    expect(asset.selected?.processingStatus).toBe("ready");
    expect(asset.selected?.mediaInfo).toMatchObject({
      width: 640,
      height: 360,
      videoCodec: "h264",
      fps: { num: 24000, den: 1001 },
      vfr: false,
      startTimecode: "01:00:00:00",
      browserPlayable: true,
    });
    expect(asset.posterUrl).toBeTruthy();
    expect(asset.playbackUrl).toBeTruthy();
  });

  it("uploads a new version that becomes current, and cancels cleanly", async () => {
    const v1 = await upload(ctx, { projectId, filename: "cut_v1.txt", data: Buffer.from("one"), mime: "text/plain" });
    await completeUpload(ctx, v1.init.uploadId, { parts: v1.parts });
    const v2 = await upload(ctx, { projectId, assetId: v1.init.assetId, filename: "cut_v2.txt", data: Buffer.from("two!"), mime: "text/plain" });
    // Until v2 completes, v1 stays current.
    expect((await getAsset(ctx, v1.init.assetId)).selected?.versionNumber).toBe(1);
    await completeUpload(ctx, v2.init.uploadId, { parts: v2.parts });
    const asset = await getAsset(ctx, v1.init.assetId);
    expect(asset.versions.map((v) => v.versionNumber)).toEqual([2, 1]);
    expect(asset.selected?.versionNumber).toBe(2);

    const pending = await initiateUpload(ctx, { projectId, filename: "abandoned.txt", size: 5, mimeType: "text/plain" });
    await abortUpload(ctx, pending.uploadId);
    await expect(getAsset(ctx, pending.assetId)).rejects.toMatchObject({ code: "not_found" });
    expect(await platformStorage().head(`orgs/${ctx.orgId}/originals/${pending.versionId}/abandoned.txt`)).toBeNull();
  });
});
