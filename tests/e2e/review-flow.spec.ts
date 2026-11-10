import { execFileSync } from "node:child_process";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { expect, test, type Page } from "@playwright/test";

const shots = process.env.E2E_SCREENSHOTS;

async function setupStudioWithVideo(page: Page) {
  const id = Date.now().toString(36);
  const dir = mkdtempSync(join(tmpdir(), "loupe-review-"));
  const clip = join(dir, "SPOT_30s_v01.mp4");
  execFileSync("ffmpeg", [
    "-v", "error", "-f", "lavfi", "-i", "testsrc2=size=1280x720:rate=24000/1001:duration=5",
    "-f", "lavfi", "-i", "sine=frequency=440:duration=5",
    "-c:v", "libx264", "-pix_fmt", "yuv420p", "-c:a", "aac", "-shortest", "-timecode", "01:00:00:00", "-y", clip,
  ]);
  await page.goto("/signup");
  await page.getByLabel("Full name").fill("Ana Colorist");
  await page.getByLabel("Work email").fill(`ana-${id}@example.com`);
  await page.getByLabel("Password").fill("a-long-secure-password");
  await page.getByRole("button", { name: "Create account" }).click();
  await page.getByLabel("Studio name").fill(`Review ${id}`);
  await page.getByRole("button", { name: "Create studio" }).click();
  await page.getByRole("button", { name: "New project" }).first().click();
  await page.getByRole("dialog").getByLabel("Project name").fill("Spring Spot");
  await page.getByRole("dialog").getByRole("button", { name: "Create project" }).click();
  await expect(page.getByRole("heading", { name: "Spring Spot" })).toBeVisible();
  await page.getByTestId("upload-input").setInputFiles([clip]);
  const tile = page.getByRole("button", { name: "SPOT_30s_v01.mp4" });
  await expect(tile.locator("img")).toBeVisible({ timeout: 60_000 });
  // The uploads tray dismisses itself once everything has uploaded.
  await expect(page.getByRole("region", { name: "Uploads" })).toBeHidden({ timeout: 15_000 });
  await tile.dblclick();
  await expect(page.getByTestId("review-video")).toBeVisible();
}

/** Drags inside the annotation layer using normalized coordinates. */
async function drag(page: Page, from: [number, number], to: [number, number]) {
  const box = (await page.getByTestId("annotation-layer").boundingBox())!;
  await page.mouse.move(box.x + from[0] * box.width, box.y + from[1] * box.height);
  await page.mouse.down();
  await page.mouse.move(box.x + ((from[0] + to[0]) / 2) * box.width, box.y + ((from[1] + to[1]) / 2) * box.height, { steps: 4 });
  await page.mouse.move(box.x + to[0] * box.width, box.y + to[1] * box.height, { steps: 4 });
  await page.mouse.up();
}

test("frame-accurate review: draw, comment at a frame, reply, resolve, reopen, filter, panel layout", async ({ page }) => {
  await setupStudioWithVideo(page);
  const timecode = page.getByTestId("timecode");
  const layer = page.getByTestId("annotation-layer");

  // Frame stepping with SMPTE timecode (23.976, start TC 01:00:00:00).
  await page.keyboard.press("Home");
  await expect(timecode).toHaveText("01:00:00:00");
  for (let i = 0; i < 10; i++) await page.keyboard.press("ArrowRight");
  await expect(timecode).toHaveText("01:00:00:10");
  await page.keyboard.press("Shift+ArrowRight");
  await expect(timecode).toHaveText("01:00:01:10");
  await page.keyboard.press("Shift+ArrowLeft");
  await expect(timecode).toHaveText("01:00:00:10");

  // Draw: arrow, rectangle, circle, line, freehand, highlight and text on frame 10.
  await page.keyboard.press("d");
  await expect(page.getByTestId("draw-toolbar")).toBeVisible();
  await page.getByRole("button", { name: "Arrow", exact: true }).click();
  await drag(page, [0.2, 0.2], [0.45, 0.45]);
  await page.getByRole("button", { name: "Rectangle" }).click();
  await drag(page, [0.55, 0.2], [0.8, 0.5]);
  await page.getByRole("button", { name: "Circle / ellipse" }).click();
  await drag(page, [0.1, 0.6], [0.3, 0.85]);
  await page.getByRole("button", { name: "Line", exact: true }).click();
  await drag(page, [0.4, 0.9], [0.7, 0.9]);
  await page.getByRole("button", { name: "Freehand" }).click();
  await drag(page, [0.6, 0.6], [0.75, 0.75]);
  await page.getByRole("button", { name: "Highlighter" }).click();
  await drag(page, [0.35, 0.65], [0.55, 0.65]);
  await page.getByRole("button", { name: "Text", exact: true }).click();
  const box = (await layer.boundingBox())!;
  await page.mouse.click(box.x + box.width * 0.55, box.y + box.height * 0.12);
  await page.getByLabel("Annotation text").fill("Logo");
  await page.getByLabel("Annotation text").press("Enter");
  await expect(page.getByTestId("draw-toolbar").getByText("7 shapes")).toBeVisible();
  await page.getByRole("button", { name: "Done" }).click();

  // Comment at the frame, with an @mention picked from autocomplete.
  const composer = page.getByLabel("New comment");
  await composer.pressSequentially("Move the logo up @An");
  await page.getByRole("listbox", { name: "Mention suggestions" }).getByRole("button", { name: /Ana Colorist/ }).click();
  await composer.press("Enter");
  const thread = page.getByTestId("thread").filter({ hasText: "Move the logo up" });
  await expect(thread.getByTestId("thread-timecode")).toHaveText("01:00:00:10");
  await expect(thread.getByTestId("comment-body")).toHaveText("Move the logo up @Ana Colorist");
  await expect(page.getByRole("button", { name: "Comment at 01:00:00:10", exact: true })).toBeVisible(); // timeline marker
  await expect(layer.locator("polygon, rect, ellipse, line, polyline, text")).not.toHaveCount(0);
  if (shots) await page.screenshot({ path: `${shots}/p2-01-annotated-comment.png` });

  // Annotations belong to their frame; clicking the comment jumps back to it.
  await page.keyboard.press("Home");
  await expect(timecode).toHaveText("01:00:00:00");
  await expect(layer.locator("polygon, rect, ellipse, polyline, text")).toHaveCount(0);
  await thread.getByRole("button", { name: "Go to comment at 01:00:00:10" }).click();
  await expect(timecode).toHaveText("01:00:00:10");
  await expect(layer.locator("rect")).toHaveCount(1);
  await expect(layer.locator("text")).toHaveText("Logo");

  // Hide / show annotations.
  await page.getByRole("button", { name: "Hide annotations (a)" }).click();
  await expect(layer.locator("rect")).toHaveCount(0);
  await page.getByRole("button", { name: "Show annotations (a)" }).click();
  await expect(layer.locator("rect")).toHaveCount(1);

  // A general (non-frame) comment, then reply, resolve, filter, reopen.
  await page.getByLabel(/^At /).uncheck();
  await composer.fill("Overall pacing works well");
  await composer.press("Enter");
  await expect(page.getByTestId("thread").first().getByText("General")).toBeVisible(); // sorted by timecode: general first
  await thread.getByRole("button", { name: "Reply" }).click();
  await page.getByLabel("Reply", { exact: true }).fill("Fixed in the next version");
  await page.getByLabel("Reply", { exact: true }).press("Enter");
  await expect(thread.getByText("Fixed in the next version")).toBeVisible();
  await thread.getByRole("button", { name: "Resolve" }).click();
  await expect(thread.getByText("Resolved by Ana Colorist")).toBeVisible();

  await page.getByRole("button", { name: /^Open 1/ }).click();
  await expect(page.getByTestId("thread")).toHaveCount(1);
  await expect(page.getByTestId("thread").getByText("Overall pacing works well")).toBeVisible();
  await page.getByRole("button", { name: /^Resolved 1/ }).click();
  await expect(page.getByTestId("thread")).toHaveCount(1);
  await page.getByTestId("thread").getByRole("button", { name: "Reopen" }).click();
  await expect(page.getByText("No comments match these filters.")).toBeVisible();
  await page.getByRole("button", { name: "All", exact: true }).click();
  await expect(page.getByTestId("thread")).toHaveCount(2);

  // Chronological sort and search.
  await page.getByLabel("Sort comments").selectOption("newest");
  await expect(page.getByTestId("thread").first().getByText("Overall pacing works well")).toBeVisible();
  await page.getByLabel("Search comments").fill("logo");
  await expect(page.getByTestId("thread")).toHaveCount(1);
  await page.getByLabel("Search comments").fill("");
  await expect(page.getByTestId("thread")).toHaveCount(2);
  if (shots) await page.screenshot({ path: `${shots}/p2-02-threads.png` });

  // Resizable and collapsible panel.
  const panel = page.getByTestId("review-panel");
  const before = (await panel.boundingBox())!.width;
  const handle = (await page.getByRole("separator", { name: "Resize comments panel" }).boundingBox())!;
  await page.mouse.move(handle.x + 1, handle.y + 200);
  await page.mouse.down();
  await page.mouse.move(handle.x - 120, handle.y + 200, { steps: 5 });
  await page.mouse.up();
  expect((await panel.boundingBox())!.width).toBeGreaterThan(before + 100);
  await page.getByRole("button", { name: "Hide comments panel" }).click();
  await expect(panel).toBeHidden();
  if (shots) await page.screenshot({ path: `${shots}/p2-03-collapsed.png` });
  await page.getByRole("button", { name: "Show comments panel" }).first().click();
  await expect(panel).toBeVisible();

  // Feedback survives a reload and stays on its version.
  await page.reload();
  await expect(page.getByTestId("thread")).toHaveCount(2);
});
