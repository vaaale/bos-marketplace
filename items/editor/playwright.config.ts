import { defineConfig, devices } from "@playwright/test";

// Convention for a marketplace item's own e2e coverage (see bos-marketplace's
// README/CONTRIBUTING once this is written up): the item bundles its tests
// under items/<id>/e2e/, alongside its own playwright.config.ts here at the
// item root. It assumes a BrowserOS host is ALREADY RUNNING — this repo
// cannot start BOS itself (it has no source tree, only the item), so there is
// no `webServer` entry. Start `npm run dev` in the BOS checkout first, then
// run this config against it.
const BASE_URL = process.env.BOS_E2E_BASE_URL || "http://localhost:3000";

export default defineConfig({
  testDir: "./e2e",
  fullyParallel: true,
  forbidOnly: !!process.env.CI,
  retries: process.env.CI ? 1 : 0,
  workers: process.env.CI ? 1 : 2,
  reporter: [["list"]],
  use: {
    baseURL: BASE_URL,
    trace: "on-first-retry",
    screenshot: "only-on-failure",
  },
  // Use system Google Chrome (channel) rather than Playwright's bundled
  // Chromium, matching the host BOS repo's convention.
  projects: [{ name: "chromium", use: { ...devices["Desktop Chrome"], channel: "chrome" } }],
});
