import { request as apiRequest, type APIRequestContext, type FrameLocator, type Page } from "@playwright/test";
import { test, expect } from "./fixtures";

// Agentic Text Editor v3 (see ../spec/spec.md, FR-026 → FR-029) — T141:
//
//   * US9  — file-handler registration: the Editor is the selected
//     (double-click) handler for text/markdown and text/plain, and an
//     "Open with Editor" option for md/txt/html;
//   * US10 — GFM tables render in preview (structure, alignment, escaped
//     pipes, inline markdown in cells, list nesting, fence literality);
//   * US11 — pandoc fenced-div custom styles: the renderer (built-in / class
//     form / unknown-neutral / nested / user-defined) and the Settings
//     "Custom Styles" surface (groups, add/edit/remove/override/reset, live
//     preview, persistence, preview reactivity).
//
// Same rule as the v1/v2 suites next door: NOTHING here starts an agent run,
// so no test depends on a model. Documents are seeded through /api/fs and the
// style registry through /api/app-storage — the same channels the app's own
// `window.__bos` broker calls land on — and every assertion is against the
// rendered DOM inside the app's real sandboxed iframe.
//
// Tests share one install, one fixture set and one storage key, so they run
// serially. The suite restores the custom-styles key it found and deletes
// every file it seeded; like the sibling suites it does not uninstall the item.
test.describe.configure({ mode: "serial" });
// Video capture needs an ffmpeg binary that isn't installed here.
test.use({ video: "off" });

const APP_ID = "agentic-text-editor";
const LOCAL_MARKETPLACE = "user-apps";
/** The app-storage key holding the style registry (config/custom-styles.ts). */
const STYLE_KEY = "agentic-text-editor.custom-styles";

// ------------------------------------------------------------------ fixtures

/** US9's double-click fixture — also the cross-cutting proof: it carries a
 *  table AND a fenced div, so one launch exercises all three v3 features. */
const MD_PATH = "/Documents/e2e-v3-launch.md";
const MD_BODY = [
  "# Launch Fixture",
  "",
  "| col1 | col2 |",
  "| :--- | ---: |",
  "| a | b |",
  "",
  '::: {custom-style="Note"}',
  "Launched note",
  ":::",
  "",
].join("\n");

const TXT_PATH = "/Documents/e2e-v3-launch.txt";
const TXT_BODY = "plain text fixture\n";

/** US10's table gallery. */
const TABLE_PATH = "/Documents/e2e-v3-tables.md";
const TABLE_BODY = [
  "# Tables",
  "",
  "| h1 | h2 | h3 |",
  "| :--- | :---: | ---: |",
  "| left | center | right |",
  "| a \\| b | **bold** and `code` and [link](https://example.com) | last |",
  "",
  "adjacent paragraph",
  "| p1 | p2 |",
  "| --- | --- |",
  "| x | y |",
  "",
  "- list item",
  "  | li1 | li2 |",
  "  | --- | --- |",
  "  | 1 | 2 |",
  "- second item",
  "",
  "```",
  "| not | a | table |",
  "```",
  "",
].join("\n");

/** US11's fenced-div gallery. */
const DIVS_PATH = "/Documents/e2e-v3-divs.md";
const DIVS_BODY = [
  "# Divs",
  "",
  '::: {custom-style="Note"}',
  "Hello note",
  ":::",
  "",
  "::: {.Tip}",
  "Class-form tip",
  ":::",
  "",
  '::: {custom-style="RuleBox"}',
  "Content here",
  ":::",
  "",
  '::: {custom-style="Note"}',
  "Outer",
  "::: {.Warning}",
  "Inner",
  ":::",
  "Outer tail",
  ":::",
  "",
  '::: {custom-style="PinkBox"}',
  "pink text",
  ":::",
  "",
  "```",
  '::: {custom-style="Note"} not a div :::',
  "```",
  "",
].join("\n");

const SEEDED_FILES = [MD_PATH, TXT_PATH, TABLE_PATH, DIVS_PATH];

/** PinkBox — the seeded user style US11's renderer tests resolve. */
const SEEDED_STYLES = JSON.stringify({
  version: 1,
  user: { PinkBox: "background: #fce7f3; border: 1px solid #f9a8d4;" },
  overrides: {},
});

/** The style registry as found, restored in afterAll (null = key absent). */
let originalStyles: string | null = null;
let stylesCaptured = false;
/** True when this run installed the item, so cleanup only undoes its own work. */
let installedByThisRun = false;
/** One-shot setup, awaited by every test (`beforeAll` cannot use `request`). */
let setupOnce: Promise<void> | null = null;

// ------------------------------------------------------------------ helpers

async function isInstalled(request: APIRequestContext): Promise<boolean> {
  const res = await request.get("/api/marketplace");
  if (!res.ok()) return false;
  const body = (await res.json()) as { installedItemIds?: string[] };
  return (body.installedItemIds ?? []).includes(APP_ID);
}

async function readStyleKey(request: APIRequestContext): Promise<string | null> {
  const res = await request.post("/api/app-storage", {
    data: { app: APP_ID, op: "get", key: STYLE_KEY },
  });
  if (!res.ok()) return null;
  const body = (await res.json()) as { result?: string | null };
  return typeof body.result === "string" ? body.result : null;
}

async function writeStyleKey(request: APIRequestContext, value: string): Promise<void> {
  const res = await request.post("/api/app-storage", {
    data: { app: APP_ID, op: "set", key: STYLE_KEY, value },
  });
  expect(res.ok(), "seeding the style registry must succeed").toBeTruthy();
}

async function setup(request: APIRequestContext): Promise<void> {
  for (const [path, content] of [
    [MD_PATH, MD_BODY],
    [TXT_PATH, TXT_BODY],
    [TABLE_PATH, TABLE_BODY],
    [DIVS_PATH, DIVS_BODY],
  ] as const) {
    await request.post("/api/fs", { data: { op: "write", path, content } });
  }

  if (!(await isInstalled(request))) {
    const res = await request.post("/api/marketplace", {
      data: { op: "install-item", id: LOCAL_MARKETPLACE, itemId: APP_ID },
    });
    expect(res.ok(), `install-item failed: ${await res.text()}`).toBeTruthy();
    installedByThisRun = true;
  }

  // Remember the user's registry once, then seed the PinkBox user style the
  // renderer tests rely on. The app reads the key at hydrate(), so it must be
  // in place before any test opens the iframe.
  if (!stylesCaptured) {
    originalStyles = await readStyleKey(request);
    stylesCaptured = true;
  }
  await writeStyleKey(request, SEEDED_STYLES);

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
  const ctx = await apiRequest.newContext({
    baseURL: process.env.BOS_E2E_BASE_URL || "http://localhost:3000",
  });
  for (const path of SEEDED_FILES) {
    await ctx.post("/api/fs", { data: { op: "delete", path } }).catch(() => undefined);
  }
  if (stylesCaptured) {
    if (originalStyles === null) {
      await ctx
        .post("/api/app-storage", { data: { app: APP_ID, op: "remove", key: STYLE_KEY } })
        .catch(() => undefined);
    } else {
      await ctx
        .post("/api/app-storage", { data: { app: APP_ID, op: "set", key: STYLE_KEY, value: originalStyles } })
        .catch(() => undefined);
    }
  }
  if (installedByThisRun) {
    await ctx.post("/api/marketplace", { data: { op: "uninstall-item", itemId: APP_ID } }).catch(() => undefined);
  }
  await ctx.dispose();
});

/** Launch the app from the desktop and return a locator scoped to its iframe. */
async function openEditor(page: Page, request: APIRequestContext): Promise<FrameLocator> {
  await ensureReady(request);
  await page.reload();
  await page.getByText("Editor", { exact: true }).first().dblclick();
  const app = page.frameLocator(`iframe[title="App: ${APP_ID}"]`);
  await expect(app.getByTestId("ate-status-bar")).toBeVisible({ timeout: 30_000 });
  return app;
}

/** Open a seeded file through the app's own file picker. */
async function openViaPicker(app: FrameLocator, filename: string): Promise<void> {
  await app.getByTestId("ate-open").click();
  const dialog = app.getByTestId("ate-file-dialog");
  await expect(dialog).toBeVisible();
  await dialog.getByRole("button", { name: new RegExp(filename.replace(/\./g, "\\.")) }).click();
  await app.getByTestId("ate-file-dialog-confirm").click();
  await expect(dialog).toBeHidden();
}

/** Open a file in preview mode and return the preview locator. */
async function openPreview(app: FrameLocator, filename: string) {
  await openViaPicker(app, filename);
  await app.getByTestId("ate-mode-preview").click();
  const preview = app.getByTestId("ate-preview");
  await expect(preview).toBeVisible();
  return preview;
}

/** Double-click a file in the Files app (a built-in, rendered inline — not an
 *  iframe); expects the Editor window to open in response. */
async function launchFromFiles(page: Page, request: APIRequestContext, filename: string): Promise<FrameLocator> {
  await ensureReady(request);
  await page.reload();
  await page.getByTestId("dock-files").click();
  const files = page.getByTestId("window-files");
  await expect(files).toBeVisible();
  await files.getByRole("button", { name: "root" }).click();
  // The seeded fixtures live in /Documents.
  await files.locator('[data-testid="files-entry"][data-name="Documents"]').dblclick();
  await files.locator(`[data-testid="files-entry"][data-name="${filename}"]`).dblclick();
  const app = page.frameLocator(`iframe[title="App: ${APP_ID}"]`);
  await expect(app.getByTestId("ate-status-bar")).toBeVisible({ timeout: 30_000 });
  return app;
}

// ============================================================ shell regression

test.describe("v3 · shell integrity (regression)", () => {
  test("two-pane shell, chat header and the tabbed Settings dialog", async ({ page, request }) => {
    const app = await openEditor(page, request);

    await expect(app.getByTestId("ate-editor-pane")).toBeVisible();
    await expect(app.getByTestId("ate-chat-pane")).toBeVisible();
    await expect(app.getByTestId("ate-chat-input")).toBeVisible();

    await app.getByTestId("ate-settings").click();
    const panel = app.getByTestId("ate-settings-panel");
    await expect(panel).toBeVisible();

    // T121: two tabs, Appearance active by default.
    const appearanceTab = panel.getByTestId("ate-settings-tab-appearance");
    const stylesTab = panel.getByTestId("ate-settings-tab-styles");
    await expect(appearanceTab).toBeVisible();
    await expect(stylesTab).toBeVisible();
    await expect(appearanceTab).toHaveAttribute("aria-selected", "true");

    // T122: the existing appearance fields are still there (regression).
    await expect(panel.getByTestId("ate-setting-fontFamily")).toBeVisible();
    await expect(panel.getByTestId("ate-setting-fontSize")).toBeVisible();
    await expect(panel.getByTestId("ate-setting-linkColor")).toBeVisible();
    await expect(panel.getByRole("button", { name: "Reset to defaults" })).toBeVisible();

    await panel.getByTestId("ate-settings-done").click();
    await expect(panel).toBeHidden();
  });
});

// ==================================================== US9 — file registration

test.describe("v3 · US9 file handlers", () => {
  test("Editor is the selected (default) handler for text/markdown and text/plain", async ({ request }) => {
    await ensureReady(request);
    for (const mime of ["text/markdown", "text/plain"]) {
      // Clear any per-type user selection so the assertion is about `default`.
      await request.post("/api/file-handlers", { data: { mime } });
      const res = await request.get(`/api/file-handlers?mime=${encodeURIComponent(mime)}`);
      expect(res.ok()).toBeTruthy();
      const body = (await res.json()) as { selected: string | null };
      expect(body.selected, `${mime} must default to the Editor`).toBe(APP_ID);
    }
  });

  test('"Open with Editor" is offered for md, txt and html', async ({ request }) => {
    await ensureReady(request);
    for (const mime of ["text/markdown", "text/plain", "text/html"]) {
      const res = await request.get(`/api/file-handlers?mime=${encodeURIComponent(mime)}`);
      expect(res.ok()).toBeTruthy();
      const body = (await res.json()) as { handlers: { appId: string; label: string }[] };
      const mine = body.handlers.find((h) => h.appId === APP_ID);
      expect(mine, `${mime} must list the Editor as a handler`).toBeTruthy();
      expect(mine!.label).toBe("Editor");
    }
  });

  test("double-click .md in Files opens the Editor in Preview — tables and divs rendered", async ({
    page,
    request,
  }) => {
    const app = await launchFromFiles(page, request, "e2e-v3-launch.md");
    const preview = app.getByTestId("ate-preview");
    await expect(preview).toBeVisible();
    // The cross-cutting proof: one launched document exercises US9+US10+US11.
    await expect(preview.locator("h1")).toHaveText("Launch Fixture");
    await expect(preview.locator("table thead th").first()).toHaveText("col1");
    const note = preview.locator('[data-style="Note"]');
    await expect(note).toContainText("Launched note");
    await expect(note).toHaveClass(/custom-style--Note/);
  });

  test("double-click .txt in Files opens the Editor in Edit mode", async ({ page, request }) => {
    const app = await launchFromFiles(page, request, "e2e-v3-launch.txt");
    await expect(app.getByTestId("ate-editor-textarea")).toBeVisible();
    await expect(app.getByTestId("ate-editor-textarea")).toHaveValue(/plain text fixture/);
  });
});

// ======================================================== US10 — GFM tables

test.describe("v3 · US10 tables", () => {
  test("structure, alignment, escaped pipes and inline markdown in cells", async ({ page, request }) => {
    const app = await openEditor(page, request);
    const preview = await openPreview(app, "e2e-v3-tables.md");

    // T101: thead + tbody with the right cells.
    const table = preview.locator("table").first();
    await expect(table.locator("thead th")).toHaveCount(3);
    await expect(table.locator("tbody tr")).toHaveCount(2);
    await expect(table.locator("thead th").nth(0)).toHaveText("h1");

    // T102: per-column alignment.
    await expect(table.locator("thead th").nth(0)).toHaveAttribute("style", /text-align:\s*left/);
    await expect(table.locator("thead th").nth(1)).toHaveAttribute("style", /text-align:\s*center/);
    await expect(table.locator("thead th").nth(2)).toHaveAttribute("style", /text-align:\s*right/);

    // T103: the escaped pipe is one literal cell, not a column split.
    const secondRow = table.locator("tbody tr").nth(1);
    await expect(secondRow.locator("td")).toHaveCount(3);
    await expect(secondRow.locator("td").nth(0)).toHaveText("a | b");

    // T104: inline markdown inside a cell.
    const inlineCell = secondRow.locator("td").nth(1);
    await expect(inlineCell.locator("strong")).toHaveText("bold");
    await expect(inlineCell.locator("code")).toHaveText("code");
    await expect(inlineCell.locator('a[href="https://example.com"]')).toHaveText("link");
  });

  test("adjacent paragraph, table nested in a list item, and fence literality", async ({ page, request }) => {
    const app = await openEditor(page, request);
    const preview = await openPreview(app, "e2e-v3-tables.md");

    // T106: paragraph and table are separate siblings.
    await expect(preview.locator("p", { hasText: "adjacent paragraph" })).toBeVisible();
    await expect(preview.locator("table")).toHaveCount(3); // gallery + adjacent + in-list

    // T105: the in-list table is a CHILD of the <li>, not a sibling.
    const li = preview.locator("li", { hasText: "list item" }).first();
    await expect(li.locator("table td").first()).toHaveText("1");

    // T108: pipes inside the fenced code block stay literal.
    const pre = preview.locator("pre code");
    await expect(pre).toContainText("| not | a | table |");

    // T107: edit mode shows the raw pipe source unmodified.
    await app.getByTestId("ate-mode-edit").click();
    await expect(app.getByTestId("ate-editor-textarea")).toHaveValue(/\| h1 \| h2 \| h3 \|/);
  });
});

// ================================================== US11 — fenced-div renderer

test.describe("v3 · US11 fenced divs", () => {
  test("built-in, class form, unknown-neutral, nested, user style and fence literality", async ({
    page,
    request,
  }) => {
    const app = await openEditor(page, request);
    const preview = await openPreview(app, "e2e-v3-divs.md");

    // T111: built-in custom-style.
    const note = preview.locator('[data-style="Note"]').first();
    await expect(note).toHaveClass(/custom-style custom-style--Note/);
    await expect(note).toContainText("Hello note");
    const noteStyle = await note.getAttribute("style");
    expect(noteStyle, "the container must carry inline CSS").toBeTruthy();
    expect(noteStyle!.length).toBeGreaterThan(0);

    // T112: the class form resolves the same registry entry.
    const tip = preview.locator('[data-style="Tip"]');
    await expect(tip).toHaveClass(/custom-style--Tip/);
    await expect(tip).toContainText("Class-form tip");

    // T113: unknown name → neutral container, content preserved.
    const rulebox = preview.locator('[data-style="RuleBox"]');
    await expect(rulebox).toHaveClass(/custom-style--RuleBox/);
    await expect(rulebox).toContainText("Content here");
    await expect(rulebox).toHaveAttribute("style", /rgba\(255,\s*255,\s*255,\s*0?\.13\)/);

    // T114: nesting — the Warning div renders INSIDE the second Note div.
    const outer = preview.locator('[data-style="Note"]').nth(1);
    await expect(outer.locator('[data-style="Warning"]')).toContainText("Inner");
    await expect(outer).toContainText("Outer tail");

    // T115: the seeded user style resolves its CSS.
    const pink = preview.locator('[data-style="PinkBox"]');
    await expect(pink).toContainText("pink text");
    await expect(pink).toHaveAttribute("style", /#fce7f3/);

    // T116: a ::: inside a code fence is literal, not a container.
    await expect(preview.locator("pre code")).toContainText('::: {custom-style="Note"} not a div :::');
    await expect(preview.locator('[data-style="Note"]')).toHaveCount(2);
  });

  test("edit mode shows the raw fenced-div source (T117)", async ({ page, request }) => {
    const app = await openEditor(page, request);
    await openViaPicker(app, "e2e-v3-divs.md");
    await app.getByTestId("ate-mode-edit").click();
    await expect(app.getByTestId("ate-editor-textarea")).toHaveValue(/::: \{custom-style="Note"\}/);
  });
});

// ============================================= US11 — Custom Styles settings UI

test.describe("v3 · US11 settings UI", () => {
  /** Open Settings on the Custom Styles tab. */
  async function openStylesTab(app: FrameLocator) {
    await app.getByTestId("ate-settings").click();
    const panel = app.getByTestId("ate-settings-panel");
    await expect(panel).toBeVisible();
    await panel.getByTestId("ate-settings-tab-styles").click();
    return panel;
  }

  test("built-in group (locked) and user group (seeded PinkBox)", async ({ page, request }) => {
    const app = await openEditor(page, request);
    const panel = await openStylesTab(app);

    // T123: four locked built-in rows.
    for (const name of ["Note", "Info", "Warning", "Tip"]) {
      const row = panel.getByTestId(`ate-style-row-${name}`);
      await expect(row).toBeVisible();
      await expect(panel.getByTestId(`ate-style-lock-${name}`)).toBeVisible();
      await expect(panel.getByTestId(`ate-style-remove-${name}`)).toHaveCount(0);
    }

    // T124: the user group holds the seeded style.
    const pinkRow = panel.getByTestId("ate-style-row-PinkBox");
    await expect(pinkRow).toBeVisible();
    await expect(pinkRow).toContainText("user");
    await expect(panel.getByTestId("ate-style-remove-PinkBox")).toBeVisible();
  });

  test("add a style with live preview, then remove it (T125/T126/T129)", async ({ page, request }) => {
    const app = await openEditor(page, request);
    const panel = await openStylesTab(app);

    await panel.getByTestId("ate-cs-add").click();
    await expect(panel.getByTestId("ate-cs-editor")).toBeVisible();
    await panel.getByTestId("ate-cs-name").fill("TealBox");
    await panel.getByTestId("ate-cs-css").fill("background: #0d9488; color: #fff;");

    // T126: the live box restyles on keystrokes.
    await expect
      .poll(() => panel.getByTestId("ate-cs-live-box").evaluate((el) => (el as HTMLElement).style.cssText))
      .toContain("rgb(13, 148, 136)");

    await panel.getByTestId("ate-cs-save").click();
    const row = panel.getByTestId("ate-style-row-TealBox");
    await expect(row).toBeVisible();
    await expect(row).toContainText("user");

    // T129: remove via the inline confirm-strip.
    await panel.getByTestId("ate-style-remove-TealBox").click();
    await expect(panel.getByTestId("ate-style-confirm-TealBox")).toBeVisible();
    await panel.getByTestId("ate-style-confirm-yes-TealBox").click();
    await expect(panel.getByTestId("ate-style-row-TealBox")).toHaveCount(0);
  });

  test("override a built-in → modified pill; reset restores it (T127/T128)", async ({ page, request }) => {
    const app = await openEditor(page, request);
    const panel = await openStylesTab(app);

    await panel.getByTestId("ate-style-edit-Note").click();
    const editor = panel.getByTestId("ate-cs-editor");
    await expect(editor).toBeVisible();
    await expect(panel.getByTestId("ate-cs-name")).toBeDisabled();

    await panel.getByTestId("ate-cs-css").fill("background: #333; color: #eee;");
    await panel.getByTestId("ate-cs-save").click();
    await expect(panel.getByTestId("ate-style-row-Note")).toContainText("modified");

    await panel.getByTestId("ate-style-edit-Note").click();
    const reset = panel.getByTestId("ate-cs-reset");
    await expect(reset).toBeEnabled();
    await reset.click();
    await panel.getByTestId("ate-cs-save").click();
    await expect(panel.getByTestId("ate-style-row-Note")).toContainText("built-in");
    await expect(panel.getByTestId("ate-style-row-Note")).not.toContainText("modified");
  });

  test("user styles persist across an app restart (T130)", async ({ page, request }) => {
    let app = await openEditor(page, request);
    let panel = await openStylesTab(app);

    await panel.getByTestId("ate-cs-add").click();
    await panel.getByTestId("ate-cs-name").fill("KeeperBox");
    await panel.getByTestId("ate-cs-css").fill("background: #1e3a8a;");
    await panel.getByTestId("ate-cs-save").click();
    await expect(panel.getByTestId("ate-style-row-KeeperBox")).toBeVisible();
    await panel.getByTestId("ate-settings-done").click();
    // Give the debounced KV write a moment before tearing the page down.
    await page.waitForTimeout(500);

    app = await openEditor(page, request); // page.reload() + relaunch
    panel = await openStylesTab(app);
    await expect(panel.getByTestId("ate-style-row-KeeperBox")).toBeVisible();

    // Leave the registry as the suite seeded it.
    await panel.getByTestId("ate-style-remove-KeeperBox").click();
    await panel.getByTestId("ate-style-confirm-yes-KeeperBox").click();
    await expect(panel.getByTestId("ate-style-row-KeeperBox")).toHaveCount(0);
  });

  test("saving a style re-renders an open preview immediately (T131)", async ({ page, request }) => {
    const app = await openEditor(page, request);
    const preview = await openPreview(app, "e2e-v3-divs.md");
    const pink = preview.locator('[data-style="PinkBox"]');
    await expect(pink).toHaveAttribute("style", /#fce7f3/);

    const panel = await openStylesTab(app);
    await panel.getByTestId("ate-style-edit-PinkBox").click();
    await panel.getByTestId("ate-cs-css").fill("background: #365314; color: #ecfccb;");
    await panel.getByTestId("ate-cs-save").click();

    // The preview behind the dialog restyles without any reload or reopen.
    await expect(pink).toHaveAttribute("style", /#365314/);
    await expect(pink).not.toHaveAttribute("style", /#fce7f3/);

    // Restore the seeded CSS so other tests see what setup wrote.
    await panel.getByTestId("ate-style-edit-PinkBox").click();
    await panel.getByTestId("ate-cs-css").fill("background: #fce7f3; border: 1px solid #f9a8d4;");
    await panel.getByTestId("ate-cs-save").click();
    await expect(pink).toHaveAttribute("style", /#fce7f3/);
  });
});
