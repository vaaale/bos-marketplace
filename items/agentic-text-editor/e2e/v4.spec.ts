import { request as apiRequest, type APIRequestContext, type FrameLocator, type Page } from "@playwright/test";
import { test, expect } from "./fixtures";

// Agentic Text Editor v4 (see ../spec/spec.md, US12 / FR-030 → FR-034) — the
// agent's style tools:
//
//   agentic_editor_list_styles / _add_style / _update_style / _remove_style /
//   _reset_style
//
// Everything Settings → Custom Styles can do, an agent can now do from the chat
// pane. Before this suite the style registry had exactly one writer — the
// Settings UI — so "make the Note boxes red" was something the agent could only
// explain, not do.
//
// WHY THIS SUITE DRIVES A REAL RUN (and the v1–v3 suites deliberately do not):
// a tool is only real at the end of its whole dispatch path —
//
//   chat-store.send → surfaceTools on /api/assistant/runs → the server's tool
//   table → a `tool_call` event with execution:"frontend" → dispatchFrontendTool
//   → TOOL_HANDLERS[name] → the store action → saveCustomStyles → per-app
//   storage AND the module cache the renderer reads.
//
// A test that called a handler directly would prove none of that: it would pass
// with the declaration misspelled, with the tool missing from TOOL_DECLARATIONS,
// with the handler never reaching storage. So the run is real — but the MODEL is
// not: BOS's env-gated scripted provider (src/lib/assistant/e2e-provider.ts)
// turns an `@@e2e {...}` line into exactly the tool calls written here.
//
// Running it:
//
//   # in the BOS checkout
//   BOS_E2E_SCRIPTED=1 npm run dev
//   # in this item's repo
//   npx playwright test e2e/v4.spec.ts
//
// Without BOS_E2E_SCRIPTED=1 the directive is just text, a real model is asked
// to answer it, and every assertion here fails for a reason that has nothing to
// do with the code under test — so the suite checks for it and says so.
//
// Tests share one install and one storage key, so they run serially. The suite
// restores the custom-styles key it found, deletes what it seeded, and — like
// its siblings — does not uninstall the item.
test.describe.configure({ mode: "serial" });
// Video capture needs an ffmpeg binary that isn't installed here.
test.use({ video: "off" });

const APP_ID = "agentic-text-editor";
const LOCAL_MARKETPLACE = "user-apps";
/** The app-storage key holding the style registry (config/custom-styles.ts). */
const STYLE_KEY = "agentic-text-editor.custom-styles";
/** The app-storage key holding the app's conversation index (assistant/client.ts). */
const CHAT_STATE_KEY = "chat-state";
/** The app-storage key holding open tabs, the active tab and the VIEW MODE
 *  (state/document-store.ts). This suite switches to Preview to assert that a
 *  style renders, and the app restores that on the next launch — so a suite
 *  that did not put this back would hand the next one an editor with no
 *  textarea in it, which is exactly what happened to the v1 suite. */
const STATE_KEY = "agentic-text-editor.state";
/** Where BOS keeps conversation files; `@/lib/assistant/conversation-store`. */
const CHATS_DIR = "/Documents/Chats";
const MAIN_ASSISTANT_ID = "assistant";

/** The skill the item bundles for the agent (skills/agentic-text-editor/). */
const SKILL_ID = "agentic-text-editor";

/** A document that names every style the suite creates, for the render leg. */
const DOC_PATH = "/Documents/e2e-v4-styles.md";
const DOC_BODY = [
  "# Styles",
  "",
  '::: {custom-style="AgentBox"}',
  "agent-authored box",
  ":::",
  "",
  '::: {custom-style="Note"}',
  "a note",
  ":::",
  "",
].join("\n");

/** The registry each test starts from: one user style, no overrides. */
const SEEDED_STYLES = {
  version: 1 as const,
  user: { Seeded: "background: #111827; border: 1px solid #374151;" },
  overrides: {} as Record<string, string>,
};

const BUILTIN_NAMES = ["Note", "Info", "Warning", "Tip"];

/** The style registry as found, restored in afterAll (null = key absent). */
let originalStyles: string | null = null;
/** The conversation index as found, restored in afterAll. */
let originalChatState: string | null = null;
/** The document/view-mode snapshot as found, restored in afterAll. */
let originalState: string | null = null;
let captured = false;
let installedByThisRun = false;
/** Conversation files this run caused BOS to write, deleted in afterAll. */
const seededConversations = new Set<string>();
let setupOnce: Promise<void> | null = null;

// ------------------------------------------------------------------ the item

async function isInstalled(request: APIRequestContext): Promise<boolean> {
  const res = await request.get("/api/marketplace");
  if (!res.ok()) return false;
  const body = (await res.json()) as { installedItemIds?: string[] };
  return (body.installedItemIds ?? []).includes(APP_ID);
}

// ------------------------------------------------------------- capabilities

/**
 * The chat pane cannot start a run without the `assistant` capability, so an
 * install that predates its declaration in app.json answers every send with
 * `Capability "assistant" not granted` — which looks exactly like a broken tool.
 * Grant it the way the Settings toggle does.
 *
 * The storage assertion is not paranoia: PUT replaces the whole grant set, and a
 * BOS whose route-level allowlist is missing `storage` drops it here — taking
 * the style registry's durable home with it (BOS's
 * tests/apps/app-capabilities-route.test.ts).
 */
async function ensureAssistantCapability(request: APIRequestContext): Promise<void> {
  const read = async (): Promise<{ capabilities: string[]; declared: string[] }> =>
    (await (await request.get(`/api/apps/${APP_ID}/capabilities`)).json()) as {
      capabilities: string[];
      declared: string[];
    };

  const before = await read();
  expect(before.declared, "app/app.json must DECLARE assistant — the grant is declaration-gated").toContain("assistant");
  if (before.capabilities.includes("assistant")) return;

  const res = await request.put(`/api/apps/${APP_ID}/capabilities`, {
    data: { capabilities: [...new Set([...before.capabilities, "assistant"])] },
  });
  expect(res.ok(), `granting the assistant capability failed: ${await res.text()}`).toBeTruthy();

  const after = await read();
  expect(after.capabilities, "the app must now be allowed to drive the assistant").toContain("assistant");
  expect(after.capabilities, "granting must not have revoked the app's storage grant").toContain("storage");
}

// ------------------------------------------------------------------ storage

async function readKey(request: APIRequestContext, key: string): Promise<string | null> {
  const res = await request.post("/api/app-storage", { data: { app: APP_ID, op: "get", key } });
  if (!res.ok()) return null;
  const body = (await res.json()) as { result?: string | null };
  return typeof body.result === "string" ? body.result : null;
}

async function writeKey(request: APIRequestContext, key: string, value: string): Promise<void> {
  const res = await request.post("/api/app-storage", { data: { app: APP_ID, op: "set", key, value } });
  expect(res.ok(), `seeding ${key} must succeed`).toBeTruthy();
}

interface StyleRegistry {
  version: 1;
  user: Record<string, string>;
  overrides: Record<string, string>;
}

/** The PERSISTED registry — the far side of the boundary a tool call crosses.
 *
 *  Polled, not read once: `saveCustomStyles` updates the module cache the
 *  renderer reads SYNCHRONOUSLY and then fires the KV write through the broker
 *  without awaiting it, so a tool result can legitimately arrive a beat before
 *  the value is durable. What the assertions care about is that it gets there. */
async function expectRegistry(
  request: APIRequestContext,
  predicate: (r: StyleRegistry) => boolean,
  what: string,
): Promise<StyleRegistry> {
  await expect
    .poll(
      async () => {
        const raw = await readKey(request, STYLE_KEY);
        if (!raw) return false;
        try {
          return predicate(JSON.parse(raw) as StyleRegistry);
        } catch {
          return false;
        }
      },
      { timeout: 10_000, message: `the persisted style registry must ${what}` },
    )
    .toBe(true);
  return JSON.parse((await readKey(request, STYLE_KEY))!) as StyleRegistry;
}

/** The persisted registry as it stands right now. */
async function readRegistry(request: APIRequestContext): Promise<StyleRegistry> {
  const raw = await readKey(request, STYLE_KEY);
  expect(raw, "the style registry key must exist").toBeTruthy();
  return JSON.parse(raw!) as StyleRegistry;
}

/** Put the registry back to the seeded baseline before a test runs. */
async function resetRegistry(request: APIRequestContext): Promise<void> {
  await writeKey(request, STYLE_KEY, JSON.stringify(SEEDED_STYLES));
}

/** Make `conversationId` the app's active conversation, so the transcript this
 *  run produces is at a path the test knows. */
async function seedConversation(request: APIRequestContext, conversationId: string): Promise<void> {
  const now = Date.now();
  await writeKey(
    request,
    CHAT_STATE_KEY,
    JSON.stringify({
      version: 2,
      conversations: [
        { id: conversationId, title: `v4 ${conversationId}`, agentId: MAIN_ASSISTANT_ID, createdAt: now, lastActiveAt: now },
      ],
      activeConversationId: conversationId,
      selectedAgentId: MAIN_ASSISTANT_ID,
    }),
  );
  seededConversations.add(conversationId);
  // A leftover transcript from a previous run of this file would be read as
  // this run's results. Start from nothing.
  await request.post("/api/fs", { data: { op: "delete", path: `${CHATS_DIR}/${conversationId}.json` } });
}

// ------------------------------------------------------------------ setup

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

  await ensureAssistantCapability(request);

  if (!captured) {
    originalStyles = await readKey(request, STYLE_KEY);
    originalChatState = await readKey(request, CHAT_STATE_KEY);
    originalState = await readKey(request, STATE_KEY);
    captured = true;
  }

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
  for (const id of seededConversations) {
    await ctx.post("/api/fs", { data: { op: "delete", path: `${CHATS_DIR}/${id}.json` } });
  }
  for (const [key, original] of [
    [STYLE_KEY, originalStyles],
    [CHAT_STATE_KEY, originalChatState],
    [STATE_KEY, originalState],
  ] as const) {
    if (!captured) continue;
    await ctx.post("/api/app-storage", {
      data: original === null ? { app: APP_ID, op: "remove", key } : { app: APP_ID, op: "set", key, value: original },
    });
  }
  if (installedByThisRun) {
    await ctx.post("/api/marketplace", { data: { op: "uninstall-item", itemId: APP_ID } });
  }
  await ctx.dispose();
});

// ------------------------------------------------------------------ the run

/** Launch the app from the dock and return a locator scoped to its iframe.
 *
 *  The DOCK, not the desktop icon: the icon's caption is the app's display name
 *  ("Agentic Text Editor") elided to the icon width, so matching it by text is
 *  matching a CSS truncation. `dock-<app id>` is the id itself. */
async function openEditor(page: Page, request: APIRequestContext): Promise<FrameLocator> {
  await ensureReady(request);
  await page.reload();
  await page.getByTestId(`dock-${APP_ID}`).click();
  const app = page.frameLocator(`iframe[title="App: ${APP_ID}"]`);
  await expect(app.getByTestId("ate-status-bar")).toBeVisible({ timeout: 30_000 });
  return app;
}

interface ScriptedCall {
  name: string;
  args?: Record<string, unknown>;
}

/** One tool call's result, as the MODEL received it. */
interface ToolResult {
  name: string;
  ok: boolean;
  error?: string;
  [key: string]: unknown;
}

interface TranscriptMessage {
  role: string;
  content?: string;
  toolCallId?: string;
  toolCalls?: { id: string; function: { name: string; arguments: string } }[];
}

/**
 * Drive one scripted turn through the app's own chat pane and return the tool
 * results it produced, in call order.
 *
 * The directive is typed into the composer, so the message that reaches the
 * server is the real one — `buildAgentContext()` block and all — and the run is
 * started by the app, which is what puts the editor's declarations in the run's
 * tool table as frontend tools.
 */
async function runTools(
  app: FrameLocator,
  request: APIRequestContext,
  conversationId: string,
  calls: ScriptedCall[],
): Promise<ToolResult[]> {
  const script = JSON.stringify({
    turns: [{ text: "working on it", tools: calls.map((c) => ({ name: c.name, args: c.args ?? {} })) }, { text: "done" }],
  });

  await app.getByTestId("ate-chat-input").fill(`@@e2e ${script}`);
  await app.getByTestId("ate-chat-send").click();

  // Poll the TRANSCRIPT, not the run: a run that has not registered yet and a
  // run that has finished both answer "no active run", so waiting on that alone
  // races the send and reads an empty conversation.
  const readResults = async (): Promise<ToolResult[]> => {
    const res = await request.get(`/api/fs?op=read&path=${encodeURIComponent(`${CHATS_DIR}/${conversationId}.json`)}`);
    if (!res.ok()) return [];
    const transcript = JSON.parse(((await res.json()) as { content: string }).content) as {
      messages: TranscriptMessage[];
    };

    // Pair each tool message with the call it answers, so a result is never
    // attributed to the wrong tool when a turn makes several.
    const nameByCallId = new Map<string, string>();
    for (const m of transcript.messages) {
      for (const call of m.toolCalls ?? []) nameByCallId.set(call.id, call.function.name);
    }

    const results: ToolResult[] = [];
    for (const m of transcript.messages) {
      if (m.role !== "tool" || !m.toolCallId) continue;
      const name = nameByCallId.get(m.toolCallId) ?? "(unknown)";
      let parsed: Record<string, unknown>;
      try {
        parsed = JSON.parse(m.content ?? "") as Record<string, unknown>;
      } catch {
        // A non-JSON result is a failure worth seeing in full: "no such tool"
        // arrives this way.
        parsed = { ok: false, error: m.content ?? "" };
      }
      results.push({ ...parsed, name, ok: parsed.ok === true } as ToolResult);
    }
    return results;
  };

  const expected = calls.map((c) => c.name);
  await expect
    .poll(async () => (await readResults()).map((r) => r.name).slice(-expected.length), {
      timeout: 60_000,
      message:
        "every scripted call must come back — if nothing arrives, BOS_E2E_SCRIPTED=1 is probably not set on the dev server",
    })
    .toEqual(expected);

  // Only then wait for the run to stand down, so the next send is not refused
  // as "a reply is already in progress".
  await expect
    .poll(
      async () => {
        const res = await request.get(`/api/assistant/runs?conversationId=${encodeURIComponent(conversationId)}`);
        if (!res.ok()) return "unreachable";
        return ((await res.json()) as { runId: string | null }).runId;
      },
      { timeout: 60_000, message: "the scripted run must finish" },
    )
    .toBeNull();

  return (await readResults()).slice(-expected.length);
}

/** Open the style fixture in preview and return the preview locator. */
async function openPreview(app: FrameLocator) {
  await app.getByTestId("ate-open").click();
  const dialog = app.getByTestId("ate-file-dialog");
  await expect(dialog).toBeVisible();
  await dialog.getByRole("button", { name: /e2e-v4-styles\.md/ }).click();
  await app.getByTestId("ate-file-dialog-confirm").click();
  await expect(dialog).toBeHidden();
  await app.getByTestId("ate-mode-preview").click();
  const preview = app.getByTestId("ate-preview");
  await expect(preview).toBeVisible();
  return preview;
}

// ============================================================ US12 — the tools

test.describe("v4 · US12 agent style tools", () => {
  test("list_styles reports the built-ins and the user's own styles with their CSS", async ({ page, request }) => {
    await ensureReady(request);
    await resetRegistry(request);
    await seedConversation(request, "ate-v4-list");
    const app = await openEditor(page, request);

    const [result] = await runTools(app, request, "ate-v4-list", [{ name: "agentic_editor_list_styles" }]);
    expect(result.ok, `list_styles failed: ${result.error}`).toBe(true);

    const styles = result.styles as { name: string; kind: string; css: string; overridden?: boolean }[];
    expect(styles.filter((s) => s.kind === "builtin").map((s) => s.name)).toEqual(BUILTIN_NAMES);
    // The CSS has to come back: "make Note red" is an EDIT of what is there.
    for (const s of styles) expect(s.css.length, `${s.name} must report its CSS`).toBeGreaterThan(0);
    expect(styles.find((s) => s.name === "Note")!.overridden).toBe(false);

    const seeded = styles.find((s) => s.name === "Seeded");
    expect(seeded, "a user style must be listed").toBeTruthy();
    expect(seeded!.kind).toBe("user");
  });

  test("add_style creates a style that persists and renders in preview", async ({ page, request }) => {
    await ensureReady(request);
    await resetRegistry(request);
    await seedConversation(request, "ate-v4-add");
    const app = await openEditor(page, request);

    const css = "background: rgb(12, 74, 110); border: 1px solid rgb(56, 189, 248);";
    const [result] = await runTools(app, request, "ate-v4-add", [
      { name: "agentic_editor_add_style", args: { name: "AgentBox", css } },
    ]);
    expect(result.ok, `add_style failed: ${result.error}`).toBe(true);

    // It crossed into per-app storage, not just the iframe's module cache.
    await expectRegistry(request, (r) => r.user.AgentBox === css, "hold the new style");

    // …and the renderer resolves it on the next preview, with no reload.
    const preview = await openPreview(app);
    const box = preview.locator('[data-style="AgentBox"]');
    await expect(box).toContainText("agent-authored box");
    expect(await box.getAttribute("style")).toContain("rgb(12, 74, 110)");
  });

  test("add_style refuses a name that is already taken, and changes nothing", async ({ page, request }) => {
    await ensureReady(request);
    await resetRegistry(request);
    await seedConversation(request, "ate-v4-dup");
    const app = await openEditor(page, request);

    const results = await runTools(app, request, "ate-v4-dup", [
      { name: "agentic_editor_add_style", args: { name: "Note", css: "background: red;" } },
      { name: "agentic_editor_add_style", args: { name: "Seeded", css: "background: red;" } },
      { name: "agentic_editor_add_style", args: { name: "  ", css: "background: red;" } },
    ]);
    for (const r of results) expect(r.ok, `${r.name} must refuse: ${JSON.stringify(r)}`).toBe(false);
    // The refusal has to point somewhere — a bare "no" makes the agent retry
    // the same call. (Anywhere in the result: the model reads all of it.)
    expect(JSON.stringify(results[0])).toMatch(/agentic_editor_update_style/);

    const registry = await readRegistry(request);
    expect(registry.user).toEqual(SEEDED_STYLES.user);
    expect(registry.overrides).toEqual({});
  });

  test("update_style edits a user style's CSS and renames it", async ({ page, request }) => {
    await ensureReady(request);
    await resetRegistry(request);
    await seedConversation(request, "ate-v4-update");
    const app = await openEditor(page, request);

    const css = "background: rgb(20, 83, 45);";
    const [edited, renamed, missing] = await runTools(app, request, "ate-v4-update", [
      { name: "agentic_editor_update_style", args: { name: "Seeded", css } },
      { name: "agentic_editor_update_style", args: { name: "Seeded", newName: "Renamed" } },
      { name: "agentic_editor_update_style", args: { name: "NoSuchStyle", css } },
    ]);

    expect(edited.ok, `update_style failed: ${edited.error}`).toBe(true);
    expect(renamed.ok, `rename failed: ${renamed.error}`).toBe(true);
    expect(missing.ok, "an unknown style must not be silently created").toBe(false);

    // A rename keeps the CSS the previous call set — it is the same style.
    const registry = await expectRegistry(request, (r) => r.user.Renamed === css, "hold the renamed style");
    expect(registry.user.Seeded, "the old name must be gone after a rename").toBeUndefined();
  });

  test("update_style overrides a built-in and reset_style puts the shipped CSS back", async ({ page, request }) => {
    await ensureReady(request);
    await resetRegistry(request);
    await seedConversation(request, "ate-v4-builtin");
    const app = await openEditor(page, request);

    const css = "background: rgb(76, 29, 149); border: 1px solid rgb(139, 92, 246);";
    const [overridden, renameRefused] = await runTools(app, request, "ate-v4-builtin", [
      { name: "agentic_editor_update_style", args: { name: "Note", css } },
      { name: "agentic_editor_update_style", args: { name: "Info", newName: "Information" } },
    ]);
    expect(overridden.ok, `overriding a built-in failed: ${overridden.error}`).toBe(true);
    expect(renameRefused.ok, "a built-in name is fixed and must not be renamable").toBe(false);

    await expectRegistry(request, (r) => r.overrides.Note === css, "record the built-in override");

    // The override is what the document renders, immediately.
    const preview = await openPreview(app);
    expect(await preview.locator('[data-style="Note"]').getAttribute("style")).toContain("rgb(76, 29, 149)");

    const [reset, resetAgain] = await runTools(app, request, "ate-v4-builtin", [
      { name: "agentic_editor_reset_style", args: { name: "Note" } },
      { name: "agentic_editor_reset_style", args: { name: "Note" } },
    ]);
    expect(reset.ok, `reset_style failed: ${reset.error}`).toBe(true);
    expect(reset.changed).toBe(true);
    // Resetting an unmodified built-in is a no-op, not a failure — but it must
    // say so rather than claiming it changed something.
    expect(resetAgain.ok).toBe(true);
    expect(resetAgain.changed).toBe(false);

    await expectRegistry(
      request,
      (r) => !("Note" in r.overrides),
      "drop the override entirely — blanking it is not the same as resetting it",
    );
  });

  test("remove_style deletes a user style and refuses a built-in", async ({ page, request }) => {
    await ensureReady(request);
    await resetRegistry(request);
    await seedConversation(request, "ate-v4-remove");
    const app = await openEditor(page, request);

    const [removed, refused] = await runTools(app, request, "ate-v4-remove", [
      { name: "agentic_editor_remove_style", args: { name: "Seeded" } },
      { name: "agentic_editor_remove_style", args: { name: "Warning" } },
    ]);
    expect(removed.ok, `remove_style failed: ${removed.error}`).toBe(true);
    expect(refused.ok, "a built-in must survive remove_style").toBe(false);
    expect(JSON.stringify(refused)).toMatch(/agentic_editor_reset_style/);

    const registry = await expectRegistry(
      request,
      (r) => Object.keys(r.user).length === 0,
      "no longer hold the removed style",
    );
    expect(registry.overrides, "refusing to remove a built-in must not have touched the overrides").toEqual({});
  });
});

// ============================================================ US13 — the skill

test.describe("v4 · US13 the editor skill", () => {
  test("the item's skill is discoverable in BOS's skill library", async ({ request }) => {
    await ensureReady(request);
    const res = await request.get("/api/skills");
    expect(res.ok()).toBeTruthy();
    const { skills } = (await res.json()) as { skills: { id: string; description: string; readOnly?: boolean }[] };

    const skill = skills.find((s) => s.id === SKILL_ID);
    expect(
      skill,
      "the item's bundled skill must be reconciled into data/skills — note BOS memoizes that scan per process, so a server started before the skill existed will not see it",
    ).toBeTruthy();
    // An installed item's skill lives in the marketplace clone (035), so the
    // store must report it read-only rather than letting an edit be lost.
    expect(skill!.readOnly).toBe(true);

    // The description is the whole of what the model sees until it calls
    // skill_load, so it has to name the app it is about.
    expect(skill!.description.toLowerCase()).toContain("editor");

    const body = await request.get(`/api/skills?id=${SKILL_ID}`);
    expect(body.ok()).toBeTruthy();
    const { skill: full } = (await body.json()) as { skill: { content: string } };
    // The skill exists to make the tool surface usable — every tool name is in
    // it, and so is the rule that separates a buffer edit from a save.
    for (const tool of [
      "agentic_editor_open_file",
      "agentic_editor_add_content",
      "agentic_editor_modify_content",
      "agentic_editor_save_document",
      "agentic_editor_list_styles",
      "agentic_editor_add_style",
      "agentic_editor_update_style",
      "agentic_editor_remove_style",
      "agentic_editor_reset_style",
    ]) {
      expect(full.content, `the skill must document ${tool}`).toContain(tool);
    }
    expect(full.content).toContain('custom-style="');
  });
});
