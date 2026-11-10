import { execFileSync } from "node:child_process";
import { mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { expect, test } from "@playwright/test";
import sharp from "sharp";

const shots = process.env.E2E_SCREENSHOTS;

test("studio onboarding → project → folder → direct upload → processed asset → invite", async ({ page }) => {
  const id = Date.now().toString(36);
  const dir = mkdtempSync(join(tmpdir(), "loupe-e2e-"));
  const still = join(dir, "hero_still_v001.png");
  writeFileSync(
    still,
    await sharp({ create: { width: 2048, height: 858, channels: 3, background: "#1d3557" } })
      .composite([{ input: Buffer.from(`<svg width="2048" height="858"><rect x="200" y="200" width="900" height="400" fill="#e63946"/><circle cx="1500" cy="430" r="260" fill="#f1faee"/></svg>`) }])
      .png()
      .toBuffer(),
  );
  const clip = join(dir, "A001C007_220914.mp4");
  execFileSync("ffmpeg", ["-v", "error", "-f", "lavfi", "-i", "testsrc2=size=1280x720:rate=24000/1001:duration=3", "-c:v", "libx264", "-pix_fmt", "yuv420p", "-timecode", "10:00:00:00", "-y", clip]);

  // Sign up
  await page.goto("/signup");
  await page.getByLabel("Full name").fill("Ana Colorist");
  await page.getByLabel("Work email").fill(`ana-${id}@example.com`);
  await page.getByLabel("Password").fill("a-long-secure-password");
  await page.getByRole("button", { name: "Create account" }).click();

  // Create studio
  await expect(page).toHaveURL(/\/onboarding/);
  await page.getByLabel("Studio name").fill(`Northlight ${id}`);
  await expect(page.getByLabel("Studio address")).toHaveValue(`northlight-${id}`);
  await page.getByRole("button", { name: "Create studio" }).click();
  await expect(page.getByRole("heading", { name: "Welcome back, Ana" })).toBeVisible();
  if (shots) await page.screenshot({ path: `${shots}/01-dashboard-empty.png` });

  // Create project
  await page.getByRole("button", { name: "New project" }).first().click();
  const projectDialog = page.getByRole("dialog");
  await projectDialog.getByLabel("Project name").fill("Aurora — 60s Brand Film");
  await projectDialog.getByLabel("Client", { exact: true }).fill("Aurora Motors");
  await projectDialog.getByRole("button", { name: "Create project" }).click();
  await expect(page.getByRole("heading", { name: "Aurora — 60s Brand Film" })).toBeVisible();

  // Folder
  await page.getByRole("button", { name: "New folder" }).click();
  // Next.js keeps recently visited routes mounted (hidden), so scope to the open dialog.
  await page.getByRole("dialog").getByLabel("Name").fill("Selects");
  await page.getByRole("dialog").getByRole("button", { name: "Create", exact: true }).click();
  await page.getByRole("button", { name: /Selects/ }).dblclick();
  await expect(page.getByRole("navigation", { name: "Folder path" }).getByText("Selects")).toBeVisible();

  // Upload two files straight to object storage
  await page.getByTestId("upload-input").setInputFiles([still, clip]);
  await expect(page.getByText("Uploads complete")).toBeVisible({ timeout: 60_000 });

  // Worker generates thumbnails; the browser polls until they appear.
  const stillTile = page.getByRole("button", { name: "hero_still_v001.png" });
  await expect(stillTile.locator("img")).toBeVisible({ timeout: 60_000 });
  await expect(page.getByRole("button", { name: "A001C007_220914.mp4" }).locator("img")).toBeVisible({ timeout: 60_000 });
  if (shots) await page.screenshot({ path: `${shots}/02-browser.png` });

  // Asset detail: verified metadata
  await page.getByRole("button", { name: "A001C007_220914.mp4" }).dblclick();
  // Video opens in the review workspace; file metadata lives in the panel's Details tab.
  await expect(page.locator("video")).toBeVisible();
  await expect(page.getByTestId("timecode")).toHaveText("10:00:00:00");
  const panel = page.getByTestId("review-panel");
  await panel.getByRole("tab", { name: "Details" }).click();
  await expect(panel.getByText("1280 × 720")).toBeVisible();
  await expect(panel.getByText("23.976 fps", { exact: false })).toBeVisible();
  if (shots) await page.screenshot({ path: `${shots}/03-asset.png` });

  // Download goes through the authorized, audited endpoint and redirects to a signed URL.
  const download = page.waitForEvent("download");
  await page.getByRole("link", { name: "Download" }).click();
  expect((await download).suggestedFilename()).toBe("A001C007_220914.mp4");

  // Invite a teammate
  await page.getByRole("link", { name: "Administration" }).click();
  await page.getByRole("link", { name: "Members" }).click();
  await page.getByRole("button", { name: "Invite" }).click();
  const inviteDialog = page.getByRole("dialog");
  await inviteDialog.getByLabel("Email").fill(`editor-${id}@example.com`);
  await inviteDialog.getByRole("button", { name: "Create invitation" }).click();
  await expect(inviteDialog.getByLabel("Invitation link")).toHaveValue(/\/invite\//);
  if (shots) await page.screenshot({ path: `${shots}/04-invite.png` });

  // Dashboard now shows the project, uploads and activity
  await page.getByRole("button", { name: "Done" }).click();
  await page.getByRole("link", { name: "Home" }).click();
  await expect(page.getByText("Recently uploaded")).toBeVisible();
  if (shots) await page.screenshot({ path: `${shots}/05-dashboard.png` });
});
