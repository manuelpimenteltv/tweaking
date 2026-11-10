import { createHash } from "node:crypto";
import { sql } from "drizzle-orm";
import { beforeEach, describe, expect, it } from "vitest";
import type { AuthContext } from "@/server/authz/context";
import { systemDb } from "@/server/db/client";
import { assetVersions, type MediaInfo } from "@/server/db/schema";
import { createProject } from "@/server/modules/projects";
import { createThread, listThreads } from "@/server/modules/review";
import { completeUpload, initiateUpload, signUploadParts } from "@/server/modules/uploads";
import { listWorkspaces } from "@/server/modules/workspaces";
import { ctxFor, makeOrg, makeUser, resetDb } from "../helpers";

const box = { tool: "rect" as const, points: [[0.1, 0.1], [0.3, 0.2]] as [number, number][], color: "#F2A93B", width: 3 };

async function uploadAs(ctx: AuthContext, projectId: string, filename: string, mime: string, info: MediaInfo) {
  const data = Buffer.from(`content ${Math.random()}`);
  const init = await initiateUpload(ctx, { projectId, filename, size: data.length, mimeType: mime });
  const checksum = createHash("sha256").update(data).digest("base64");
  const [s] = await signUploadParts(ctx, init.uploadId, { parts: [{ partNumber: 1, checksumSha256: checksum }] });
  const res = await fetch(s.url, { method: "PUT", headers: s.headers, body: new Uint8Array(data) });
  await completeUpload(ctx, init.uploadId, { parts: [{ partNumber: 1, etag: res.headers.get("etag")!, checksumSha256: checksum }] });
  await systemDb().update(assetVersions).set({ processingStatus: "ready", mediaInfo: info }).where(sql`id = ${init.versionId}`);
  return init.versionId;
}

let ctx: AuthContext;
let projectId: string;

beforeEach(async () => {
  await resetDb();
  const u = await makeUser("Writer");
  await makeOrg(u, "docs-studio");
  ctx = await ctxFor(u, "docs-studio");
  const [ws] = await listWorkspaces(ctx);
  projectId = (await createProject(ctx, { name: "Script", workspaceId: ws.id })).id;
});

describe("document, image and spreadsheet anchors", () => {
  it("anchors document comments to pages and page regions, sorted in reading order", async () => {
    const v = await uploadAs(ctx, projectId, "script_v4.docx", "application/vnd.openxmlformats-officedocument.wordprocessingml.document", { pages: 12 });
    await createThread(ctx, { versionId: v, anchor: { type: "page", page: 7 }, body: "Scene 12 runs long" });
    await createThread(ctx, {
      versionId: v,
      anchor: { type: "page", page: 2, region: { x: 0.1, y: 0.5, w: 0.3, h: 0.1 } },
      body: "Typo in this paragraph",
      shapes: [box],
    });
    await createThread(ctx, { versionId: v, anchor: { type: "page", page: 2 }, body: "Title page needs logo" });
    await expect(createThread(ctx, { versionId: v, anchor: { type: "page", page: 13 }, body: "x" })).rejects.toMatchObject({ code: "validation" });
    await expect(createThread(ctx, { versionId: v, frame: 4, body: "x" })).rejects.toMatchObject({ code: "validation" });
    await expect(createThread(ctx, { versionId: v, anchor: { type: "cell", sheet: "S", cell: "A1" }, body: "x" })).rejects.toMatchObject({ code: "validation" });

    const { threads } = await listThreads(ctx, v);
    expect(threads.map((t) => [t.page, t.anchorType])).toEqual([
      [2, "page"],
      [2, "region"],
      [7, "page"],
    ]);
    const region = threads.find((t) => t.anchorType === "region")!;
    expect(region.anchor.region).toEqual({ x: 0.1, y: 0.5, w: 0.3, h: 0.1 });
    expect(region.comments[0].annotation).toMatchObject({ page: 2, shapes: [{ tool: "rect" }] });
  });

  it("anchors image comments to regions", async () => {
    const v = await uploadAs(ctx, projectId, "poster_v2.jpg", "image/jpeg", { width: 4000, height: 6000 });
    await createThread(ctx, { versionId: v, anchor: { type: "region", region: { x: 0.6, y: 0.1, w: 0.2, h: 0.1 } }, body: "Logo too close to the edge", shapes: [box] });
    await expect(
      createThread(ctx, { versionId: v, anchor: { type: "region", region: { x: 0.9, y: 0.1, w: 0.5, h: 0.1 } }, body: "x" }),
    ).rejects.toMatchObject({ code: "validation" });
    await expect(createThread(ctx, { versionId: v, anchor: { type: "page", page: 1 }, body: "x" })).rejects.toMatchObject({ code: "validation" });
    const [t] = (await listThreads(ctx, v)).threads;
    expect(t).toMatchObject({ anchorType: "region", anchor: { region: { x: 0.6, y: 0.1, w: 0.2, h: 0.1 } } });
  });

  it("anchors spreadsheet comments to cells of existing sheets, in sheet/row/column order", async () => {
    const v = await uploadAs(ctx, projectId, "budget_v3.xlsx", "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet", {
      sheets: [
        { name: "Summary", rows: 40, cols: 8 },
        { name: "Crew", rows: 120, cols: 12 },
      ],
    });
    await createThread(ctx, { versionId: v, anchor: { type: "cell", sheet: "Crew", cell: "C4" }, body: "Rate changed" });
    await createThread(ctx, { versionId: v, anchor: { type: "cell", sheet: "Summary", cell: "B12" }, body: "Total doesn't match" });
    await createThread(ctx, { versionId: v, anchor: { type: "cell", sheet: "Summary", cell: "AA2" }, body: "Hidden column?" });
    await expect(createThread(ctx, { versionId: v, anchor: { type: "cell", sheet: "Nope", cell: "A1" }, body: "x" })).rejects.toMatchObject({ code: "validation" });
    await expect(createThread(ctx, { versionId: v, anchor: { type: "cell", sheet: "Crew", cell: "a1" }, body: "x" })).rejects.toMatchObject({ code: "validation" });
    await expect(
      createThread(ctx, { versionId: v, anchor: { type: "cell", sheet: "Crew", cell: "A1" }, body: "x", shapes: [box] }),
    ).rejects.toMatchObject({ code: "validation" });

    const { threads } = await listThreads(ctx, v);
    expect(threads.map((t) => `${t.anchor.sheet}!${t.anchor.cell}`)).toEqual(["Summary!AA2", "Summary!B12", "Crew!C4"]);
    expect(threads[0].anchor).toMatchObject({ row: 1, col: 26, sheetIndex: 0 });
  });
});
