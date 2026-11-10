import { execFileSync } from "node:child_process";
import { mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { expect, test, type Page } from "@playwright/test";
import ExcelJS from "exceljs";
import sharp from "sharp";

const shots = process.env.E2E_SCREENSHOTS;
const dir = mkdtempSync(join(tmpdir(), "loupe-docs-e2e-"));
const soffice = (args: string[]) =>
  execFileSync("soffice", [`-env:UserInstallation=file://${join(dir, "profile")}`, "--headless", ...args], { stdio: "ignore", timeout: 120_000 });

async function makeFiles() {
  writeFileSync(
    join(dir, "Horizon_Script_v4.html"),
    `<html><body><h1>HORIZON Script v4</h1><p>INT. GARAGE - NIGHT. Marina checks the car.</p><p style="page-break-before: always">Page two: the closing dialogue.</p></body></html>`,
  );
  soffice(["--convert-to", "docx:MS Word 2007 XML", "--outdir", dir, join(dir, "Horizon_Script_v4.html")]);
  soffice(["--convert-to", "pdf", "--outdir", dir, join(dir, "Horizon_Script_v4.docx")]);
  soffice(["--infilter=impress_pdf_import", "--convert-to", "pptx", "--outdir", dir, join(dir, "Horizon_Script_v4.pdf")]);
  execFileSync("mv", [join(dir, "Horizon_Script_v4.pptx"), join(dir, "Pitch_Deck.pptx")]);

  const wb = new ExcelJS.Workbook();
  const s = wb.addWorksheet("Summary");
  s.getCell("A1").value = "Item";
  s.getCell("A1").font = { bold: true };
  s.getCell("B1").value = "Cost";
  s.getCell("A2").value = "Camera";
  s.getCell("B2").value = 1234.5;
  s.getCell("A3").value = "Grade";
  s.getCell("B3").value = 800;
  s.getCell("A4").value = "Total";
  s.getCell("B4").value = { formula: "SUM(B2:B3)", result: 2034.5 };
  for (const ref of ["B2", "B3", "B4"]) s.getCell(ref).numFmt = "$#,##0.00";
  s.getColumn(5).hidden = true;
  s.getCell("E1").value = "secret column";
  wb.addWorksheet("Crew", { state: "hidden" }).getCell("A1").value = "DP";
  await wb.xlsx.writeFile(join(dir, "Budget_v3.xlsx"));

  await sharp({ create: { width: 2400, height: 1600, channels: 3, background: "#5b8fb9" } })
    .composite([{ input: Buffer.from(`<svg width="2400" height="1600"><rect y="1100" width="2400" height="500" fill="#2d4a22"/><circle cx="1800" cy="400" r="180" fill="#fff4c2"/></svg>`) }])
    .tiff()
    .toFile(join(dir, "Plate_0042.tif"));
}

async function setup(page: Page) {
  const id = Date.now().toString(36);
  await page.goto("/signup");
  await page.getByLabel("Full name").fill("Dana Producer");
  await page.getByLabel("Work email").fill(`dana-${id}@example.com`);
  await page.getByLabel("Password").fill("a-long-secure-password");
  await page.getByRole("button", { name: "Create account" }).click();
  await page.getByLabel("Studio name").fill(`Docs ${id}`);
  await page.getByRole("button", { name: "Create studio" }).click();
  await page.getByRole("button", { name: "New project" }).first().click();
  await page.getByRole("dialog").getByLabel("Project name").fill("Horizon Paperwork");
  await page.getByRole("dialog").getByRole("button", { name: "Create project" }).click();
  await expect(page.getByRole("heading", { name: "Horizon Paperwork" })).toBeVisible();
  await page.getByTestId("upload-input").setInputFiles(
    ["Horizon_Script_v4.docx", "Pitch_Deck.pptx", "Budget_v3.xlsx", "Plate_0042.tif"].map((f) => join(dir, f)),
  );
  for (const name of ["Horizon_Script_v4.docx", "Pitch_Deck.pptx", "Budget_v3.xlsx", "Plate_0042.tif"]) {
    await expect(page.getByRole("button", { name }).locator("img")).toBeVisible({ timeout: 90_000 });
  }
  await expect(page.getByRole("region", { name: "Uploads" })).toBeHidden({ timeout: 15_000 });
  return page.url();
}

async function drag(page: Page, target: ReturnType<Page["locator"]>, from: [number, number], to: [number, number]) {
  const box = (await target.boundingBox())!;
  await page.mouse.move(box.x + from[0] * box.width, box.y + from[1] * box.height);
  await page.mouse.down();
  await page.mouse.move(box.x + to[0] * box.width, box.y + to[1] * box.height, { steps: 6 });
  await page.mouse.up();
}

test.beforeAll(makeFiles);

test("documents, slides, spreadsheets and images: viewers and anchored comments", async ({ page }) => {
  test.setTimeout(240_000);
  const projectUrl = await setup(page);
  const composer = page.getByLabel("New comment");
  const threads = page.getByTestId("thread");

  // ── Word document → PDF viewer ─────────────────────────────────────────
  await page.getByRole("button", { name: "Horizon_Script_v4.docx" }).dblclick();
  const doc = page.getByTestId("document-viewer");
  await expect(doc).toBeVisible();
  await expect(page.getByTestId("page-count")).toHaveText("of 2");
  await expect(page.locator('.page[data-page-number="1"] .textLayer')).toContainText("HORIZON", { timeout: 20_000 }); // selectable text
  await page.getByLabel("Find in document").fill("dialogue");
  await page.getByLabel("Find in document").press("Enter");
  await expect(page.getByTestId("find-count")).toHaveText("1 of 1");
  await expect(page.getByTestId("page-input")).toHaveValue("2");
  await expect(page.getByTestId("composer-position")).toHaveText("Page 2");
  await composer.fill("Tighten this scene");
  await composer.press("Enter");
  await expect(threads.first().getByTestId("thread-anchor")).toHaveText("p. 2");

  // Draw a box on page 2 → region comment.
  await page.getByRole("button", { name: "Draw on this page (d)" }).click();
  await page.getByRole("button", { name: "Rectangle" }).click();
  await drag(page, page.locator('.page[data-page-number="2"] [data-testid="annotation-layer"]'), [0.15, 0.1], [0.6, 0.2]);
  await page.getByRole("button", { name: "Done" }).click();
  await composer.fill("Logo goes here");
  await composer.press("Enter");
  await expect(threads.filter({ hasText: "Logo goes here" }).getByTestId("thread-anchor")).toHaveText("p. 2 · area");
  await expect(page.getByRole("button", { name: "Comment area: Logo goes here" })).toBeVisible();
  await page.getByRole("button", { name: "Previous page" }).click();
  await expect(page.getByTestId("page-input")).toHaveValue("1");
  await threads.filter({ hasText: "Tighten this scene" }).getByRole("button", { name: /Go to comment/ }).click();
  await expect(page.getByTestId("page-input")).toHaveValue("2");
  if (shots) await page.screenshot({ path: `${shots}/p3-01-document.png` });

  // ── PowerPoint → slides with thumbnails ────────────────────────────────
  await page.goto(projectUrl);
  await page.getByRole("button", { name: "Pitch_Deck.pptx" }).dblclick();
  await expect(page.getByTestId("thumbnails")).toBeVisible();
  await page.getByTestId("thumbnails").getByRole("button", { name: "Slide 2" }).click();
  await expect(page.getByTestId("page-input")).toHaveValue("2");
  await expect(page.getByTestId("composer-position")).toHaveText("Slide 2");
  await composer.fill("Swap this slide with the case study");
  await composer.press("Enter");
  await expect(threads.first().getByTestId("thread-anchor")).toHaveText("Slide 2");
  await expect(page.getByTestId("thumbnails").getByRole("button", { name: "Slide 2" })).toContainText("1");
  if (shots) await page.screenshot({ path: `${shots}/p3-02-slides.png` });

  // ── Excel → grid with formulas, hidden columns/sheets, cell comments ───
  await page.goto(projectUrl);
  await page.getByRole("button", { name: "Budget_v3.xlsx" }).dblclick();
  const grid = page.getByTestId("sheet-grid");
  await expect(grid.locator('[data-cell="B2"]')).toHaveText("$1,234.50");
  await grid.locator('[data-cell="B4"]').click();
  await expect(page.getByTestId("formula")).toHaveText("=SUM(B2:B3)");
  await expect(page.getByTestId("formula-bar")).toContainText("shows $2,034.50");
  await expect(page.getByTestId("composer-position")).toHaveText("Summary!B4");
  await composer.fill("Total should include insurance");
  await composer.press("Enter");
  await expect(threads.first().getByTestId("thread-anchor")).toHaveText("Summary!B4");
  await expect(grid.locator('[data-cell="B4"] [aria-label="1 comment"]')).toBeVisible();
  await expect(grid.locator('[data-cell="E1"]')).toHaveCount(0); // hidden column
  await page.getByLabel(/Show hidden rows & columns/).check();
  await expect(grid.locator('[data-cell="E1"]')).toHaveText("secret column");
  if (shots) await page.screenshot({ path: `${shots}/p3-03-spreadsheet.png` });
  await page.getByRole("tab", { name: /Crew/ }).click();
  await expect(grid.locator('[data-cell="A1"]')).toHaveText("DP");
  await threads.first().getByRole("button", { name: /Go to comment/ }).click(); // jumps back to Summary!B4
  await expect(page.getByTestId("formula")).toHaveText("=SUM(B2:B3)");

  // ── TIFF → image viewer with region comments ───────────────────────────
  await page.goto(projectUrl);
  await page.getByRole("button", { name: "Plate_0042.tif" }).dblclick();
  await expect(page.getByTestId("review-image")).toHaveAttribute("src", /proxy\.webp/);
  const zoomBefore = await page.getByTestId("image-zoom").textContent();
  await page.getByRole("button", { name: "Zoom in (+)" }).click();
  await expect(page.getByTestId("image-zoom")).not.toHaveText(zoomBefore!);
  await page.getByRole("button", { name: "Fit to view (0)" }).click();
  await page.getByRole("button", { name: "Mark an area (d)" }).click();
  await page.getByRole("button", { name: "Circle / ellipse" }).click();
  await drag(page, page.getByTestId("annotation-layer"), [0.65, 0.12], [0.85, 0.38]);
  await page.getByRole("button", { name: "Done" }).click();
  await composer.fill("Sun is clipping, bring it down");
  await composer.press("Enter");
  await expect(threads.first().getByTestId("thread-anchor")).toHaveText("Area");
  await expect(page.getByRole("button", { name: "Comment area: Sun is clipping, bring it down" })).toBeVisible();
  if (shots) await page.screenshot({ path: `${shots}/p3-04-image.png` });
});
