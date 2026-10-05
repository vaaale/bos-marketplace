import { request as apiRequest, type APIRequestContext, type FrameLocator, type Page } from "@playwright/test";
import { test, expect } from "./fixtures";

// Agentic Text Editor (see ../spec/spec.md) — T047.
//
// Exercises the core workflows through the REAL app: the marketplace item is
// installed, BOS builds its bundle, and the app runs in its sandboxed iframe
// with the postMessage broker in place. That last part matters — the editor
// reaches the VFS only through `window.__bos`, so a test that loaded
// /apps/<id>/ directly would have no file access and would prove nothing about
// opening or saving.
//
// Nothing here involves the model: every assertion is about the editor surface
// and the store behind it, driven by clicks. The agent-driven paths (US2/US3)
// are tool handlers over that same store; asserting them would need a live LLM
// run, which an e2e test must not depend on.
//
// This suite lives in the marketplace item's own repo (bos-marketplace,
// items/agentic-text-editor/e2e/) rather than BOS's e2e/ — it tests this app,
// not BrowserOS itself — and runs against an already-running BOS instance
// (see ../playwright.config.ts). It was moved out of browseros/e2e/ once the
// item existed to install from a live marketplace clone instead of relying on
// pre-seeded data.
//
// Tests share one install and one fixture file, so they run serially.
test.describe.configure({ mode: "serial" });
// Video capture needs an ffmpeg binary that isn't installed here.
test.use({ video: "off" });

const APP_ID = "agentic-text-editor";
/** The app-storage key holding open tabs, the active tab and the view mode
 *  (state/document-store.ts) — cleared before this suite runs, restored after. */
const STATE_KEY = "agentic-text-editor.state";
/** That key as found, so the user's own open tabs survive a test run. */
let originalState: string | null = null;

async function readStateKey(request: APIRequestContext): Promise<string | null> {
  const res = await request.post("/api/app-storage", { data: { app: APP_ID, op: "get", key: STATE_KEY } });
  if (!res.ok()) return null;
  const body = (await res.json()) as { result?: string | null };
  return typeof body.result === "string" ? body.result : null;
}
const LOCAL_MARKETPLACE = "user-apps";
const FIXTURE_PATH = "/Documents/e2e-agentic-editor.md";
const FIXTURE_BODY = ["# Fixture Heading", "", "First paragraph from disk.", ""].join("\n");

/** True when this run installed the item, so cleanup only undoes its own work. */
let installedByThisRun = false;
/** One-shot setup, awaited by every test (`beforeAll` cannot use `request`). */
let setupOnce: Promise<void> | null = null;

async function isInstalled(request: APIRequestContext): Promise<boolean> {
  const res = await request.get("/api/marketplace");
  if (!res.ok()) return false;
  const body = (await res.json()) as { installedItemIds?: string[] };
  return (body.installedItemIds ?? []).includes(APP_ID);
}

async function setup(request: APIRequestContext): Promise<void> {
  await request.post("/api/fs", { data: { op: "write", path: FIXTURE_PATH, content: FIXTURE_BODY } });

  if (!(await isInstalled(request))) {
    const res = await request.post("/api/marketplace", {
      data: { op: "install-item", id: LOCAL_MARKETPLACE, itemId: APP_ID },
    });
    expect(res.ok(), `install-item failed: ${await res.text()}`).toBeTruthy();
    installedByThisRun = true;
  }

  // START FROM NO OPEN DOCUMENTS. The app restores its tabs, the active tab AND
  // the view mode from this key, so a suite that inherits them is testing a
  // surface it did not set up: this file's first test typed into a tab that was
  // already open with the same text ("No changes" instead of "Unsaved
  // changes"), and before that found Preview mode and no textarea at all. It
  // showed up as the suite failing on its OWN second run.
  // The user's snapshot is put back in afterAll.
  originalState = await readStateKey(request);
  await request.post("/api/app-storage", { data: { app: APP_ID, op: "remove", key: STATE_KEY } });

  // Rendering the desktop is what builds an app project's dist/ (ensureBuilt in
  // src/lib/apps/store.ts), so ask for it once before any test navigates.
  await request.get("/");
  const served = await request.get(`/apps/${APP_ID}/`);
  expect(served.status(), "the app must be served after install + build").toBe(200);
}

function ensureReady(request: APIRequestContext): Promise<void> {
  setupOnce ??= setup(request);
  return setupOnce;
}

test.afterAll(async () => {
  // afterAll has no `request` fixture (it is test-scoped), so make a context.
  const ctx = await apiRequest.newContext({
    baseURL: process.env.BOS_E2E_BASE_URL || "http://localhost:3000",
  });
  await ctx.post("/api/fs", { data: { op: "delete", path: FIXTURE_PATH } }).catch(() => undefined);
  await ctx.post("/api/app-storage", {
    data:
      originalState === null
        ? { app: APP_ID, op: "remove", key: STATE_KEY }
        : { app: APP_ID, op: "set", key: STATE_KEY, value: originalState },
  });
  if (installedByThisRun) {
    await ctx.post("/api/marketplace", { data: { op: "uninstall-item", itemId: APP_ID } }).catch(() => undefined);
  }
  await ctx.dispose();
});

/** Launch the app from the desktop and return a locator scoped to its iframe. */
async function openEditor(page: Page, request: APIRequestContext): Promise<FrameLocator> {
  await ensureReady(request);
  // The desktop was rendered before the install, so reload to pick up the icon.
  await page.reload();
  // The DOCK, not the desktop icon: the icon's caption is the app's display
  // name ("Agentic Text Editor") elided to the icon width, so matching it by
  // text matches a CSS truncation — which is what it did, until the app was
  // renamed and every suite here stopped reaching the app at all.
  await page.getByTestId(`dock-${APP_ID}`).click();
  const app = page.frameLocator(`iframe[title="App: ${APP_ID}"]`);
  // The shell only renders once the persisted snapshot has been merged in.
  await expect(app.getByTestId("ate-status-bar")).toBeVisible({ timeout: 30_000 });
  return app;
}

/** Open the fixture file through the app's own file picker. */
async function openFixture(app: FrameLocator): Promise<void> {
  await app.getByTestId("ate-open").click();
  const dialog = app.getByTestId("ate-file-dialog");
  await expect(dialog).toBeVisible();
  await dialog.getByRole("button", { name: /e2e-agentic-editor\.md/ }).click();
  await app.getByTestId("ate-file-dialog-confirm").click();
  await expect(dialog).toBeHidden();
  await expect(app.getByTestId("ate-editor-textarea")).toHaveValue(/Fixture Heading/);
}

async function readFromDisk(request: APIRequestContext): Promise<string> {
  const res = await request.get(`/api/fs?op=read&path=${encodeURIComponent(FIXTURE_PATH)}`);
  const body = (await res.json()) as { content?: string };
  return body.content ?? "";
}

test.describe("Agentic Text Editor", () => {
  test("two-pane shell: editor, chat and a draggable divider", async ({ page, request }) => {
    const app = await openEditor(page, request);

    await expect(app.getByTestId("ate-editor-pane")).toBeVisible();
    await expect(app.getByTestId("ate-chat-pane")).toBeVisible();
    await expect(app.getByTestId("ate-resizer")).toBeVisible();
    await expect(app.getByTestId("ate-chat-input")).toBeVisible();

    // The left pane starts at the specified 45% of the container.
    const width = await app.getByTestId("ate-editor-pane").evaluate((el) => (el as HTMLElement).style.width);
    expect(width).toBe("45%");
  });

  test("open a file, edit it, preview it, and save it back to disk (US1)", async ({ page, request }) => {
    const app = await openEditor(page, request);
    await openFixture(app);

    // A just-opened document is clean, and the status bar names its format.
    await expect(app.getByTestId("ate-status-change")).toHaveText("No changes");
    await expect(app.getByTestId("ate-status-bar")).toContainText("Markdown");

    // Preview renders the markdown; edit mode shows the raw source.
    await app.getByTestId("ate-mode-preview").click();
    await expect(app.getByTestId("ate-preview").locator("h1")).toHaveText("Fixture Heading");
    await app.getByTestId("ate-mode-edit").click();

    const textarea = app.getByTestId("ate-editor-textarea");
    await textarea.fill(`${FIXTURE_BODY}\nA line typed by the e2e test.\n`);

    // Dirty state shows in the status bar and as an amber dot on the tab.
    await expect(app.getByTestId("ate-status-change")).toHaveText("Unsaved changes");
    await expect(app.getByLabel("Unsaved changes").first()).toBeVisible();

    // FR-012: the buffer must NOT have reached disk yet.
    expect(await readFromDisk(request)).toBe(FIXTURE_BODY);

    await app.getByTestId("ate-save").click();
    await expect(app.getByTestId("ate-status-change")).toHaveText("No changes");
    expect(await readFromDisk(request)).toContain("A line typed by the e2e test.");
  });

  test("tabs and buffers survive an app restart (FR-020/021)", async ({ page, request }) => {
    const app = await openEditor(page, request);
    await expect(app.getByTestId("ate-tab-bar")).toContainText("e2e-agentic-editor.md");
    // The line saved by the previous test came back with the tab.
    await expect(app.getByTestId("ate-editor-textarea")).toHaveValue(/A line typed by the e2e test/);
  });

  test("many documents at once, and closing a dirty tab prompts first (US4/FR-022)", async ({ page, request }) => {
    const app = await openEditor(page, request);
    const tabBar = app.getByTestId("ate-tab-bar");
    const before = await tabBar.getByRole("tab").count();

    // SC-003: five more documents alongside whatever is already open.
    for (let i = 0; i < 5; i++) await tabBar.getByRole("button", { name: "New document" }).click();
    await expect(tabBar.getByRole("tab")).toHaveCount(before + 5);

    // Make the active (last created) document dirty, then try to close it.
    await app.getByTestId("ate-editor-textarea").fill("unsaved scratch content");
    await expect(app.getByTestId("ate-status-change")).toHaveText("Unsaved changes");

    await tabBar.getByRole("tab", { selected: true }).getByRole("button", { name: /^Close / }).click();
    const confirm = app.getByTestId("ate-confirm-dialog");
    await expect(confirm).toBeVisible();
    await expect(confirm).toContainText("unsaved changes");

    // Cancel keeps the tab; Discard drops it.
    await app.getByTestId("ate-confirm-cancel").click();
    await expect(confirm).toBeHidden();
    await expect(tabBar.getByRole("tab")).toHaveCount(before + 5);

    await tabBar.getByRole("tab", { selected: true }).getByRole("button", { name: /^Close / }).click();
    await app.getByTestId("ate-confirm-discard").click();
    await expect(tabBar.getByRole("tab")).toHaveCount(before + 4);

    // Clean up the untitled scratch tabs — they were never on disk, so closing
    // them (they are clean) leaves nothing behind.
    for (let i = 0; i < 4; i++) {
      await tabBar.getByRole("tab", { name: /Untitled/ }).first().getByRole("button", { name: /^Close / }).click();
    }
    await expect(tabBar.getByRole("tab")).toHaveCount(before);
  });

  test("appearance settings apply immediately to the editor (US5)", async ({ page, request }) => {
    const app = await openEditor(page, request);
    await openFixture(app);

    const textarea = app.getByTestId("ate-editor-textarea");
    const sizeOf = () => textarea.evaluate((el) => getComputedStyle(el).fontSize);
    const original = await sizeOf();

    await app.getByTestId("ate-settings").click();
    const panel = app.getByTestId("ate-settings-panel");
    await expect(panel).toBeVisible();

    await panel.getByTestId("ate-setting-fontSize").fill("20");
    await expect.poll(sizeOf).toBe("20px");

    // Reset so the run leaves the app's settings as it found them.
    await panel.getByRole("button", { name: "Reset to defaults" }).click();
    await expect.poll(sizeOf).toBe(original);
    await page.waitForTimeout(1000); // let the settings re-render settle before closing
    await panel.getByRole("button", { name: "Done" }).click();
    await expect.poll(() => panel.isVisible()).toBe(false, { timeout: 15_000 });
  });

  test("the chat pane is the agent surface, with an empty state and a live input", async ({ page, request }) => {
    const app = await openEditor(page, request);

    // Green dot = agent idle. No run is started, so nothing here touches an LLM.
    await expect(app.getByTestId("ate-agent-status")).toHaveAttribute("data-busy", "false");

    const input = app.getByTestId("ate-chat-input");
    const send = app.getByTestId("ate-chat-send");
    await expect(send).toBeDisabled();
    await input.fill("add a summary section");
    await expect(send).toBeEnabled();
    await input.fill("");
    await expect(send).toBeDisabled();
  });
});
