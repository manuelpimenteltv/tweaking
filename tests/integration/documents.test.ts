import { createHash } from "node:crypto";
import { execFileSync } from "node:child_process";
import { mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import ExcelJS from "exceljs";
import sharp from "sharp";
import { beforeAll, beforeEach, describe, expect, it } from "vitest";
import type { AuthContext } from "@/server/authz/context";
import { runOnce } from "@/server/jobs/runner";
import type { SheetChunk } from "@/server/jobs/sheets";
import { getAsset, getSheetChunkUrl } from "@/server/modules/assets";
import { createProject } from "@/server/modules/projects";
import { completeUpload, initiateUpload, signUploadParts } from "@/server/modules/uploads";
import { listWorkspaces } from "@/server/modules/workspaces";
import { execSetupStorage } from "./storage-setup";
import { ctxFor, makeOrg, makeUser, resetDb } from "../helpers";

const dir = mkdtempSync(join(tmpdir(), "loupe-docs-"));
const soffice = (args: string[]) =>
  execFileSync("soffice", [`-env:UserInstallation=file://${join(dir, "profile")}`, "--headless", ...args], { stdio: "ignore", timeout: 120_000 });

async function upload(ctx: AuthContext, projectId: string, filename: string, data: Buffer, mime: string) {
  const init = await initiateUpload(ctx, { projectId, filename, size: data.length, mimeType: mime });
  const checksum = createHash("sha256").update(data).digest("base64");
  const [s] = await signUploadParts(ctx, init.uploadId, { parts: [{ partNumber: 1, checksumSha256: checksum }] });
  const res = await fetch(s.url, { method: "PUT", headers: s.headers, body: new Uint8Array(data) });
  expect(res.status).toBe(200);
  await completeUpload(ctx, init.uploadId, { parts: [{ partNumber: 1, etag: res.headers.get("etag")!, checksumSha256: checksum }] });
  while (await runOnce("doc-test")) {
    /* drain: ingest, then document/sheet jobs */
  }
  return getAsset(ctx, init.assetId);
}

let ctx: AuthContext;
let projectId: string;

beforeAll(async () => {
  await execSetupStorage();
  // Two-page document with a heading and a page break, created by LibreOffice itself.
  writeFileSync(
    join(dir, "script.html"),
    `<html><body><h1>HORIZON — Script v4</h1><p>INT. GARAGE — NIGHT</p><p style="page-break-before: always">Page two dialogue.</p></body></html>`,
  );
  soffice(["--convert-to", "docx:MS Word 2007 XML", "--outdir", dir, join(dir, "script.html")]);
  soffice(["--convert-to", "pdf", "--outdir", dir, join(dir, "script.docx")]);
  soffice(["--infilter=impress_pdf_import", "--convert-to", "pptx", "--outdir", dir, join(dir, "script.pdf")]);

  const wb = new ExcelJS.Workbook();
  const sum = wb.addWorksheet("Summary");
  sum.getCell("A1").value = "Item";
  sum.getCell("A1").font = { bold: true };
  sum.getCell("B1").value = "Cost";
  sum.getCell("A2").value = "Camera";
  sum.getCell("B2").value = 1234.5;
  sum.getCell("B2").numFmt = "$#,##0.00";
  sum.getCell("A3").value = "Grade";
  sum.getCell("B3").value = 800;
  sum.getCell("B3").numFmt = "$#,##0.00";
  sum.getCell("A4").value = "Total";
  sum.getCell("B4").value = { formula: "SUM(B2:B3)", result: 2034.5 };
  sum.getCell("B4").numFmt = "$#,##0.00";
  sum.getCell("C2").value = 0.25;
  sum.getCell("C2").numFmt = "0%";
  sum.getCell("D2").value = new Date(Date.UTC(2026, 11, 12));
  sum.getCell("D2").numFmt = "yyyy-mm-dd";
  sum.getRow(3).hidden = true;
  sum.getColumn(5).hidden = true;
  sum.getCell("E1").value = "secret column";
  sum.mergeCells("A6:C6");
  sum.getCell("A6").value = "Approved by client";
  const crew = wb.addWorksheet("Crew", { state: "hidden" });
  crew.getCell("A1").value = "DP";
  await wb.xlsx.writeFile(join(dir, "budget.xlsx"));
  soffice(["--convert-to", "xls", "--outdir", dir, join(dir, "budget.xlsx")]);
});

beforeEach(async () => {
  await resetDb();
  const u = await makeUser("Producer");
  await makeOrg(u, "doc-pipeline");
  ctx = await ctxFor(u, "doc-pipeline");
  const [ws] = await listWorkspaces(ctx);
  projectId = (await createProject(ctx, { name: "Horizon", workspaceId: ws.id })).id;
});

describe("document pipeline", () => {
  it("renders Word documents to a review PDF with page count and cover thumbnail", async () => {
    const a = await upload(ctx, projectId, "Horizon_Script_v4.docx", readFileSync(join(dir, "script.docx")), "application/vnd.openxmlformats-officedocument.wordprocessingml.document");
    expect(a.selected?.processingStatus).toBe("ready");
    expect(a.selected?.mediaInfo.pages).toBe(2);
    expect(a.jobs.map((j) => `${j.type}:${j.status}`)).toContain("document:succeeded");
    expect(a.documentUrl).toMatch(/review\.pdf/);
    expect(a.thumbnailUrl).toBeTruthy();
    expect(a.selected?.mediaInfo.notes?.join(" ")).toMatch(/LibreOffice/);
    const pdf = Buffer.from(await (await fetch(a.documentUrl!)).arrayBuffer());
    expect(pdf.subarray(0, 5).toString()).toBe("%PDF-");
  });

  it("uses native PDFs as-is (no conversion) and presentations as slides", async () => {
    const pdf = await upload(ctx, projectId, "script.pdf", readFileSync(join(dir, "script.pdf")), "application/pdf");
    expect(pdf.selected?.mediaInfo.pages).toBe(2);
    expect(pdf.documentUrl).toMatch(/originals/);
    const deck = await upload(ctx, projectId, "Pitch_Deck.pptx", readFileSync(join(dir, "script.pptx")), "application/vnd.openxmlformats-officedocument.presentationml.presentation");
    expect(deck.selected?.mediaInfo.pages).toBe(2);
    expect(deck.documentUrl).toMatch(/review\.pdf/);
  });

  it("builds a spreadsheet model with displayed values, formulas, hidden rows/cols, merges and hidden sheets", async () => {
    const a = await upload(ctx, projectId, "Budget_v3.xlsx", readFileSync(join(dir, "budget.xlsx")), "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet");
    expect(a.selected?.mediaInfo.sheets).toEqual([
      { name: "Summary", rows: 6, cols: 5 },
      { name: "Crew", rows: 1, cols: 1, hidden: true },
    ]);
    expect(a.sheet).toBeTruthy();
    const manifest = a.sheet!.manifest;
    const summary = manifest.sheets[0];
    expect(summary.hiddenCols).toEqual([4]);
    expect(summary.merges).toEqual(["A6:C6"]);
    expect(summary.formulas).toBe(1);
    const chunk = (await (await fetch(await getSheetChunkUrl(ctx, a.selected!.id, 0, 0))).json()) as SheetChunk["data"];
    const cell = (r: number, c: number) => chunk.rows.find((row) => row[0] === r)?.[3].find((x) => x[0] === c);
    expect(cell(1, 1)?.[1]).toBe("$1,234.50");
    expect(cell(3, 1)?.slice(1, 3)).toEqual(["$2,034.50", "=SUM(B2:B3)"]);
    expect(cell(1, 2)?.[1]).toBe("25%");
    expect(cell(1, 3)?.[1]).toBe("2026-12-12");
    expect(chunk.rows.find((r) => r[0] === 2)?.[2]).toBe(1); // hidden row kept, flagged
    expect(cell(0, 4)?.[1]).toBe("secret column"); // hidden column's values are kept
    expect(summary.styles[cell(0, 0)![3]!]).toMatchObject({ b: 1 });
  });

  it("converts legacy XLS through LibreOffice and parses CSV", async () => {
    const xls = await upload(ctx, projectId, "Budget_v3.xls", readFileSync(join(dir, "budget.xls")), "application/vnd.ms-excel");
    expect(xls.selected?.mediaInfo.sheets?.map((s) => s.name)).toEqual(["Summary", "Crew"]);
    const csv = await upload(ctx, projectId, "shot_list.csv", Buffer.from('Shot,Lens,Notes\n1A,35mm,"Dolly in, slow"\n1B,85mm,\n'), "text/csv");
    expect(csv.selected?.mediaInfo.sheets).toEqual([{ name: "shot_list", rows: 4, cols: 3 }]);
    const chunk = (await (await fetch(await getSheetChunkUrl(ctx, csv.selected!.id, 0, 0))).json()) as SheetChunk["data"];
    expect(chunk.rows[1][3].map((c) => c[1])).toEqual(["1A", "35mm", "Dolly in, slow"]);
  });

  it("gives non-browser image formats a large review copy", async () => {
    const tiff = await sharp({ create: { width: 3000, height: 2000, channels: 3, background: "#224466" } }).tiff().toBuffer();
    const a = await upload(ctx, projectId, "plate_0042.tif", tiff, "image/tiff");
    expect(a.selected?.mediaInfo).toMatchObject({ width: 3000, height: 2000 });
    expect(a.imageUrl).toMatch(/proxy\.webp/);
    const png = await sharp({ create: { width: 800, height: 600, channels: 3, background: "#000" } }).png().toBuffer();
    const b = await upload(ctx, projectId, "still.png", png, "image/png");
    expect(b.imageUrl).toMatch(/originals/); // browsers show PNG at full resolution
  });
});
