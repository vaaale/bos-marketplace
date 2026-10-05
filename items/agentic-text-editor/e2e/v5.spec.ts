import { request as apiRequest, type APIRequestContext, type FrameLocator, type Page } from "@playwright/test";
import { test, expect } from "./fixtures";

// Agentic Text Editor v5 (see ../spec/spec.md, US14 / FR-036) — Mermaid.
//
// A ```mermaid fence rendered as a code block, which is what it did before this
// suite: the user wrote a diagram and the preview showed them the source they
// had just typed.
//
// What is asserted here is the RENDERED RESULT in the real preview — an <svg>
// carrying the node labels — not that some function was called with the right
// string. Mermaid renders asynchronously after the markdown pass has already
// put escaped HTML into the pane, so the only honest question is whether a
// diagram ends up on screen, and whether a broken one still shows its source
// instead of a blank gap.
//
// No agent run is involved: this is the render path, driven by clicks.
//
// Running it:
//
//   # in the BOS checkout
//   npm run dev
//   # in this item's repo
//   npx playwright test e2e/v5.spec.ts
//
// Tests share one install and one fixture, so they run serially. The suite
// clears the app's persisted snapshot before it starts (it asserts on a
// specific open tab and view mode) and puts the user's back afterwards.
test.describe.configure({ mode: "serial" });
// Video capture needs an ffmpeg binary that isn't installed here.
test.use({ video: "off" });

const APP_ID = "agentic-text-editor";
const LOCAL_MARKETPLACE = "user-apps";
/** Open tabs, active tab and view mode (state/document-store.ts). */
const STATE_KEY = "agentic-text-editor.state";

const DOC_PATH = "/Documents/e2e-v5-mermaid.md";
const DOC_BODY = [
  "# Diagrams",
  "",
  "```mermaid",
  "graph TD",
  "  Alpha[Alpha] --> Beta[Beta]",
  "```",
  "",
  "```js",
  'const notADiagram = "graph TD";',
  "```",
  "",
  "```mermaid",
  "graph TD",
  "  this is not ( valid mermaid",
  "```",
  "",
].join("\n");

/** The app-storage snapshot as found, restored in afterAll. */
let originalState: string | null = null;
let installedByThisRun = false;
let setupOnce: Promise<void> | null = null;

async function isInstalled(request: APIRequestContext): Promise<boolean> {
  const res = await request.get("/api/marketplace");
  if (!res.ok()) return false;
  const body = (await res.json()) as { installedItemIds?: string[] };
  return (body.installedItemIds ?? []).includes(APP_ID);
}

async function readStateKey(request: APIRequestContext): Promise<string | null> {
  const res = await request.post("/api/app-storage", { data: { app: APP_ID, op: "get", key: STATE_KEY } });
  if (!res.ok()) return null;
  const body = (await res.json()) as { result?: string | null };
  return typeof body.result === "string" ? body.result : null;
}

async function setup(request: APIRequestContext): Promise<void> {
  const reachable = await request.get("/api/marketplace");
  expect(reachable.ok(), "BOS must be running and reachable").toBeTruthy();

  await request.post("/api/fs", { data: { op: "write", path: DOC_PATH, content: DOC_BODY } });

  if (!(await isInstalled(request))) {
    const res = await request.post("/api/marketplace", {
      data: { op: "install-item", id: LOCAL_MARKETPLACE, itemId: APP_ID },
    });
    expect(res.ok(), `install-item failed: ${await res.text()}`).toBeTruthy();
    installedByThisRun = true;
  }

  // Start from no open documents: this suite asserts on ONE open tab and on the
  // view mode, both of which the app restores from the snapshot.
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
  const ctx = await apiRequest.newContext({ baseURL: process.env.BOS_E2E_BASE_URL || "http://localhost:3000" });
  await ctx.post("/api/fs", { data: { op: "delete", path: DOC_PATH } });
  await ctx.post("/api/app-storage", {
    data:
      originalState === null
        ? { app: APP_ID, op: "remove", key: STATE_KEY }
        : { app: APP_ID, op: "set", key: STATE_KEY, value: originalState },
  });
  if (installedByThisRun) {
    await ctx.post("/api/marketplace", { data: { op: "uninstall-item", itemId: APP_ID } });
  }
  await ctx.dispose();
});

/** Launch the app from the dock and return a locator scoped to its iframe. */
async function openEditor(page: Page, request: APIRequestContext): Promise<FrameLocator> {
  await ensureReady(request);
  await page.reload();
  await page.getByTestId(`dock-${APP_ID}`).click();
  const app = page.frameLocator(`iframe[title="App: ${APP_ID}"]`);
  await expect(app.getByTestId("ate-status-bar")).toBeVisible({ timeout: 30_000 });
  return app;
}

/** Open the fixture through the app's own file picker and switch to preview. */
async function openPreview(app: FrameLocator) {
  await app.getByTestId("ate-open").click();
  const dialog = app.getByTestId("ate-file-dialog");
  await expect(dialog).toBeVisible();
  await dialog.getByRole("button", { name: /e2e-v5-mermaid\.md/ }).click();
  await app.getByTestId("ate-file-dialog-confirm").click();
  await expect(dialog).toBeHidden();
  await app.getByTestId("ate-mode-preview").click();
  const preview = app.getByTestId("ate-preview");
  await expect(preview).toBeVisible();
  return preview;
}

test.describe("v5 · US14 mermaid diagrams", () => {
  test("a mermaid fence renders as a diagram, not as its own source", async ({ page, request }) => {
    const app = await openEditor(page, request);
    const preview = await openPreview(app);

    const diagram = preview.getByTestId("ate-mermaid").first();
    await expect(diagram).toBeVisible({ timeout: 15_000 });

    // A real diagram: an <svg> carrying the labels from the source.
    const svg = diagram.locator("svg");
    await expect(svg).toBeVisible();
    await expect(svg).toContainText("Alpha");
    await expect(svg).toContainText("Beta");
    // It must have LAID OUT, not just parsed — a zero-height svg is a diagram
    // the user cannot see.
    const box = await svg.boundingBox();
    expect(box, "the diagram must occupy space").toBeTruthy();
    expect(box!.height).toBeGreaterThan(20);

    // …and the source is no longer sitting there as a code block.
    await expect(preview.locator('pre[data-lang="mermaid"]')).toHaveCount(0);
  });

  test("a fence in another language is still a code block, verbatim", async ({ page, request }) => {
    const app = await openEditor(page, request);
    const preview = await openPreview(app);

    const code = preview.locator('pre[data-lang="js"]');
    await expect(code).toHaveCount(1);
    await expect(code).toContainText('const notADiagram = "graph TD";');
    // Mermaid must not have been let loose on it.
    await expect(code.locator("svg")).toHaveCount(0);
  });

  test("a diagram mermaid cannot parse shows the error AND the source", async ({ page, request }) => {
    const app = await openEditor(page, request);
    const preview = await openPreview(app);

    // The second mermaid block in the fixture is deliberately broken.
    const failed = preview.getByTestId("ate-mermaid-error");
    await expect(failed).toBeVisible({ timeout: 15_000 });
    // Never a blank gap: the user gets their source back…
    await expect(failed).toContainText("this is not ( valid mermaid");
    // …and a reason, not just a shrug.
    await expect(failed).toContainText(/error|expecting|parse/i);
  });

  test("edit mode shows the raw fence, and a buffer edit re-renders the diagram", async ({ page, request }) => {
    const app = await openEditor(page, request);
    await openPreview(app);

    // The syntax is plain markdown source — edit mode never rewrites it.
    await app.getByTestId("ate-mode-edit").click();
    const textarea = app.getByTestId("ate-editor-textarea");
    await expect(textarea).toHaveValue(/```mermaid/);
    await expect(textarea).toHaveValue(/Alpha\[Alpha\] --> Beta\[Beta\]/);

    // Rename a node in the buffer: the preview must show the NEW diagram, not a
    // cached picture of the old one.
    await textarea.fill(DOC_BODY.replace("Beta[Beta]", "Beta[Gamma]"));
    await app.getByTestId("ate-mode-preview").click();

    const svg = app.getByTestId("ate-preview").getByTestId("ate-mermaid").first().locator("svg");
    await expect(svg).toContainText("Gamma", { timeout: 15_000 });
    await expect(svg).not.toContainText("Beta");
  });
});
