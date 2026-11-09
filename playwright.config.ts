import { defineConfig } from "@playwright/test";

/**
 * End-to-end tests run against a running app + worker + PostgreSQL + S3 storage
 * (see docs/DEVELOPMENT.md). Set E2E_BASE_URL to target another deployment.
 */
export default defineConfig({
  testDir: "tests/e2e",
  timeout: 120_000,
  expect: { timeout: 20_000 },
  fullyParallel: false,
  reporter: [["list"]],
  use: {
    baseURL: process.env.E2E_BASE_URL ?? "http://localhost:3000",
    viewport: { width: 1440, height: 900 },
    launchOptions: process.env.PW_CHROMIUM_PATH ? { executablePath: process.env.PW_CHROMIUM_PATH } : undefined,
  },
  webServer: process.env.E2E_BASE_URL
    ? undefined
    : { command: "pnpm start", url: "http://localhost:3000/login", reuseExistingServer: true, timeout: 120_000 },
});
