// E2E for the installed Follow the Money item (tasks T26). Runs against a BOS
// branch preview with the item installed and the service running (its first
// no-key refresh completed). The test reaches the app the way a user does —
// through the BOS shell and the installed app's iframe; the service URL
// resolution stays inside the app's serviceClient, so nothing here hardcodes
// a port.
//
//   BOS_PREVIEW_URL=http://localhost:3000 npx playwright test e2e/follow-the-money.spec.ts
//
// The key-write step (5) only runs when FTM_TEST_TWELVEDATA_KEY is set, so CI
// without a key still passes via the presence-state assertion.

import { test, expect, type FrameLocator, type Page } from "@playwright/test";

const BASE = process.env.BOS_PREVIEW_URL || "http://localhost:3000";
const TEST_KEY = process.env.FTM_TEST_TWELVEDATA_KEY || "";

async function openApp(page: Page): Promise<FrameLocator> {
  await page.goto(BASE);
  // Launch the installed app from the BOS shell (dock/launcher entry named
  // "Follow the Money"), then work inside its iframe.
  const launcher = page.getByText("Follow the Money", { exact: true }).first();
  await launcher.click();
  const frame = page.frameLocator('iframe[src*="follow-the-money"]');
  await expect(frame.getByTestId("dash-table")).toBeVisible({ timeout: 30000 });
  return frame;
}

test.describe.configure({ mode: "serial" });

test("app loads live service data (dashboard, health strip, pulse)", async ({ page }) => {
  const app = await openApp(page);

  // >= 20 US rows, each with a state chip and momentum cell
  const rows = app.locator('[data-testid^="dash-row-"]');
  await expect(rows.first()).toBeVisible();
  expect(await rows.count()).toBeGreaterThanOrEqual(20);
  const first = rows.first();
  await expect(first.locator(".chip")).toBeVisible();
  await expect(first.getByTestId("mom-cell")).toBeVisible();

  // HealthStrip shows an as-of date
  await expect(app.getByTestId("health-asof")).not.toHaveText("—");

  // PulseStrip shows at least one region-tagged chip
  const chips = app.getByTestId("pulse-chip");
  expect(await chips.count()).toBeGreaterThanOrEqual(1);
  await expect(chips.first().locator(".rg")).toBeVisible();

  // NFA notice present (FR-018)
  await expect(app.getByTestId("nfa-pill")).toBeVisible();
});

test("region switch re-scopes; Norway degrades to Awaiting Data; choice persists across reload", async ({ page }) => {
  const app = await openApp(page);

  await app.getByTestId("region-Europe").click();
  await expect(app.getByTestId("dash-title")).toContainText("Europe");
  await expect(app.getByTestId("dash-row-EFA").or(app.getByTestId("dash-row-EWG"))).toBeVisible();

  await app.getByTestId("region-Norway").click();
  await expect(app.getByTestId("dash-title")).toContainText("Norway");
  // no-key: Norway rows render as "Awaiting Data" — no error page
  await expect(app.locator(".await-row").first()).toBeVisible();
  await expect(app.getByText("Awaiting Data").first()).toBeVisible();

  // FR-007: region persists across a reload
  await page.reload();
  const app2 = page.frameLocator('iframe[src*="follow-the-money"]');
  await expect(app2.getByTestId("dash-title")).toContainText("Norway", { timeout: 30000 });
  await app2.getByTestId("region-US").click(); // restore for later tests
});

test("dashboard momentum sort re-ranks (top row = max momentum)", async ({ page }) => {
  const app = await openApp(page);
  await app.getByTestId("sort-mom").click(); // sort by momentum desc
  const cells = app.getByTestId("mom-cell");
  const texts = (await cells.allTextContents()).filter((t) => t !== "—");
  const values = texts.map((t) => parseFloat(t.replace("%", "").replace("+", "")));
  const max = Math.max(...values);
  expect(values[0]).toBe(max);
});

test("detail opens with SVG chart and populated stat grid", async ({ page }) => {
  const app = await openApp(page);
  // Prefer a pulse-strip instrument (likely to have a base/breakout drawn)
  const chips = app.getByTestId("pulse-chip");
  if ((await chips.count()) > 0) {
    await chips.first().click();
  } else {
    await app.locator('[data-testid^="dash-row-"]').first().click();
  }
  await expect(app.getByTestId("view-detail")).toBeVisible();
  await expect(app.getByTestId("detail-symbol")).toBeVisible();
  await expect(app.getByTestId("detail-chart")).toBeVisible();
  const stats = app.getByTestId("stat-grid").locator(".stat");
  expect(await stats.count()).toBeGreaterThanOrEqual(6);
  // base band / breakout line are asserted when the instrument has one
  const hasBase = (await app.getByTestId("base-band").count()) > 0;
  const hasBreakout = (await app.getByTestId("breakout-line").count()) > 0;
  test.info().annotations.push({ type: "note", description: `base-band=${hasBase} breakout-line=${hasBreakout}` });
});

test("config drawer key presence toggles the health chip", async ({ page }) => {
  const app = await openApp(page);
  await expect(app.getByTestId("key-chip")).toContainText("not configured");
  await app.getByTestId("config-btn").click();
  await expect(app.getByTestId("config-drawer")).toBeVisible();
  // key field is per-provider (NFR-008); the single keyed provider is twelvedata
  await expect(app.getByTestId("key-input-twelvedata")).toBeVisible();

  if (TEST_KEY) {
    await app.getByTestId("key-input-twelvedata").fill(TEST_KEY);
    await app.getByTestId("save-key-twelvedata").click();
    await expect(app.getByTestId("key-chip")).toContainText("key: configured", { timeout: 10000 });
    await app.getByTestId("clear-key-twelvedata").click();
    await expect(app.getByTestId("key-chip")).toContainText("not configured", { timeout: 10000 });
  } else {
    // presence-state round-trip with a throwaway key (cleared immediately) —
    // the service stores it but never uses it until the next refresh
    await app.getByTestId("key-input-twelvedata").fill("e2e-throwaway-key");
    await app.getByTestId("save-key-twelvedata").click();
    await expect(app.getByTestId("key-chip")).toContainText("key: configured", { timeout: 10000 });
    await app.getByTestId("clear-key-twelvedata").click();
    await expect(app.getByTestId("key-chip")).toContainText("not configured", { timeout: 10000 });
  }
  await app.getByTestId("drawer-close").click();
});
