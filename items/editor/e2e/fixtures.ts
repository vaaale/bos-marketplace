import { test as base, expect } from "@playwright/test";

// Shared fixture: each test starts on a ready BrowserOS desktop. Mirrors
// browseros/e2e/fixtures.ts — kept as a plain copy here rather than a shared
// import, since this item's e2e/ must be runnable from the item's own repo
// (bos-marketplace), independent of the BOS source tree layout.
export const test = base.extend({
  // `runTest` is Playwright's fixture-use callback (named to avoid the
  // react-hooks lint rule that treats a `use(...)` call as a React hook).
  page: async ({ page }, runTest) => {
    await page.goto("/");
    const skip = page.getByRole("button", { name: "Skip" });
    if (await skip.isVisible().catch(() => false)) {
      await skip.click().catch(() => {});
    }
    await runTest(page);
  },
});

export { expect };
