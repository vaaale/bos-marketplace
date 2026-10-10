import { defineConfig, devices } from "@playwright/test";

// The item's OWN Playwright config — `buildstudio_run_tests` runs an item's e2e
// from the item, under this file (src/lib/specs/test-target.ts), so nothing has
// to be written into BOS's checkout to test an item. An earlier run had no
// supported path and improvised one in /app; that untracked file then blocked a
// promote.
//
// baseURL is the SUPERVISOR's origin (8090), not a Next port: the service is
// reached through `httpPath` (/__supervisor/services/<id>/), which only the
// Supervisor routes. See the note at the top of e2e/okf-knowledge-base.spec.ts.
const BASE_URL = process.env.BOS_PREVIEW_URL || "http://localhost:8090";

export default defineConfig({
  testDir: "./e2e",
  fullyParallel: false,
  forbidOnly: !!process.env.CI,
  retries: 0,
  workers: 1,
  reporter: [["list"]],
  outputDir: "./.test-results",
  use: {
    baseURL: BASE_URL,
    trace: "on-first-retry",
    screenshot: "only-on-failure",
  },
  // No `webServer`: BOS and the item's service are already running — this suite
  // tests an INSTALLED item on a live deployment, it does not stand one up.
  projects: [
    {
      name: "chromium",
      use: {
        ...devices["Desktop Chrome"],
        channel: "chrome",
        // NOT Desktop Chrome's default 1280x720. BOS's dock floats above every
        // window (z-[100000], src/components/desktop/Dock.tsx), and at 720p a
        // launched app window runs to y=731 while the dock occupies y=642..708
        // — an 89px strip of the app that is covered by the dock. Playwright
        // hit-tests occlusion WITHIN the frame's own document, so a click on an
        // app element in that strip passes its actionability check and is then
        // delivered to the dock button on top: the app never sees it and the
        // test fails on a silent no-op. 900px of height lifts the app's content
        // clear of the dock.
        viewport: { width: 1440, height: 900 },
      },
    },
  ],
});
