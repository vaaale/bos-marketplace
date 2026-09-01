import { request as apiRequest, type APIRequestContext, type FrameLocator, type Page } from "@playwright/test";
import { test, expect } from "./fixtures";

// Agentic Text Editor v2 — the chat surface (see ../spec/spec.md): the agent
// selector (FR-023), the conversation index and its dropdown (FR-024), and the
// dual-colour tool row (FR-025).
//
// Same rule as the v1 suite next door: NOTHING here starts a run, so no test
// depends on a model being configured, reachable, or in a particular mood. The
// two things that would normally only exist AFTER a run — a transcript with
// tool calls on it, and an index entry pointing at it — are seeded through the
// same server APIs the app itself reads:
//
//   * the transcript is a plain VFS file at /Documents/Chats/<id>.json
//     (BOS's `conversation-store`, mirrored by the item's assistant/client.ts),
//     written with the /api/fs write op the v1 suite already uses;
//   * the app-scoped conversation INDEX is the item's own "chat-state" key in
//     per-app storage, written through /api/app-storage with the app id — the
//     same namespace the SDK's `storage` capability writes to from the iframe.
//
// Seeding the index rather than clicking a conversation into existence is what
// makes the tool-row test possible at all: the dropdown lists ids this app
// minted, and a conversation only has a transcript once a turn has actually
// run.
//
// Tests share one install and one storage key, so they run serially. This file
// does NOT uninstall the item on the way out — the sibling spec may be running
// in another worker, and pulling the item out from under it would break it —
// but it does restore the "chat-state" key it found and delete every file it
// seeded.
test.describe.configure({ mode: "serial" });
// Video capture needs an ffmpeg binary that isn't installed here.
test.use({ video: "off" });

const APP_ID = "agentic-text-editor";
const LOCAL_MARKETPLACE = "user-apps";
/** The app-storage key holding the app's conversation index (assistant/client.ts). */
const CHAT_STATE_KEY = "chat-state";
/** Where BOS keeps conversation files; the app reads them through fs:read. */
const CHATS_DIR = "/Documents/Chats";
const MAIN_ASSISTANT_ID = "assistant";

/** The conversation seeded with a two-tool transcript (C). */
const TOOL_ROW_ID = "ate-v2-test";
const TOOL_ROW_TITLE = "Tool Row Test";
/** A conversation that never ran, used for the reload-persistence test (B7). */
const PERSIST_ID = "ate-v2-persist";
const PERSIST_TITLE = "Persisted Conversation";

/** Conversation files this run wrote, deleted in afterAll. */
const seededTranscripts = new Set<string>();
/** The "chat-state" value as found, restored in afterAll (null = key absent). */
let originalChatState: string | null = null;
let chatStateCaptured = false;
/** One-shot build/serve check, awaited by every test (`beforeAll` has no `request`). */
let builtOnce: Promise<void> | null = null;

// ------------------------------------------------------------------ the item

async function isInstalled(request: APIRequestContext): Promise<boolean> {
  const res = await request.get("/api/marketplace");
  if (!res.ok()) return false;
  const body = (await res.json()) as { installedItemIds?: string[] };
  return (body.installedItemIds ?? []).includes(APP_ID);
}

/** Install the item if it is not already installed. Cheap enough to re-check
 *  per test, which also survives the sibling suite uninstalling it mid-run. */
async function ensureInstalled(request: APIRequestContext): Promise<void> {
  if (await isInstalled(request)) return;
  const res = await request.post("/api/marketplace", {
    data: { op: "install-item", id: LOCAL_MARKETPLACE, itemId: APP_ID },
  });
  expect(res.ok(), `install-item failed: ${await res.text()}`).toBeTruthy();
}

async function ensureBuilt(request: APIRequestContext): Promise<void> {
  // Rendering the desktop is what builds an app project's dist/ (ensureBuilt in
  // src/lib/apps/store.ts), so ask for it once before any test navigates.
  await request.get("/");
  const served = await request.get(`/apps/${APP_ID}/`);
  expect(served.status(), "the app must be served after install + build").toBe(200);
}

async function ensureReady(request: APIRequestContext): Promise<void> {
  await ensureInstalled(request);
  builtOnce ??= ensureBuilt(request);
  await builtOnce;
  await captureChatState(request);
}

// ------------------------------------------------------------------ seeding

/** The app's persisted conversation index (types.ts `ChatPersistence`). */
interface SeedConversation {
  id: string;
  title: string;
  agentId: string;
  createdAt: number;
  lastActiveAt: number;
}
interface SeedChatState {
  version: 2;
  conversations: SeedConversation[];
  activeConversationId: string | null;
  selectedAgentId: string;
}

async function readStoredChatState(request: APIRequestContext): Promise<string | null> {
  const res = await request.post("/api/app-storage", {
    data: { app: APP_ID, op: "get", key: CHAT_STATE_KEY },
  });
  if (!res.ok()) return null;
  const body = (await res.json()) as { result?: string | null };
  return typeof body.result === "string" ? body.result : null;
}

/** Remember the user's own index once, so the run can put it back. */
async function captureChatState(request: APIRequestContext): Promise<void> {
  if (chatStateCaptured) return;
  chatStateCaptured = true;
  originalChatState = await readStoredChatState(request);
}

/** Replace the app's conversation index. The app reads this on mount, so it
 *  must be written BEFORE the iframe loads (i.e. before `openEditor`). */
async function writeChatState(request: APIRequestContext, state: SeedChatState): Promise<void> {
  const res = await request.post("/api/app-storage", {
    data: { app: APP_ID, op: "set", key: CHAT_STATE_KEY, value: JSON.stringify(state) },
  });
  expect(res.ok(), `app-storage set failed: ${await res.text()}`).toBeTruthy();
}

/** Write a conversation file in the exact shape the app reads on open. */
async function seedTranscript(
  request: APIRequestContext,
  conversation: { id: string; title: string; agentId: string; messages: unknown[] },
): Promise<void> {
  const path = `${CHATS_DIR}/${conversation.id}.json`;
  const res = await request.post("/api/fs", {
    data: {
      op: "write",
      path,
      content: JSON.stringify(
        {
          id: conversation.id,
          title: conversation.title,
          createdAt: 1_700_000_000_000,
          agentId: conversation.agentId,
          messages: conversation.messages,
        },
        null,
        2,
      ),
    },
  });
  expect(res.ok(), `seeding ${path} failed: ${await res.text()}`).toBeTruthy();
  seededTranscripts.add(path);
}

test.afterAll(async () => {
  // afterAll has no `request` fixture (it is test-scoped), so make a context.
  const ctx = await apiRequest.newContext({
    baseURL: process.env.BOS_E2E_BASE_URL || "http://localhost:3000",
  });
  for (const path of seededTranscripts) {
    await ctx.post("/api/fs", { data: { op: "delete", path } }).catch(() => undefined);
  }
  if (chatStateCaptured) {
    await ctx
      .post("/api/app-storage", {
        data:
          originalChatState === null
            ? { app: APP_ID, op: "remove", key: CHAT_STATE_KEY }
            : { app: APP_ID, op: "set", key: CHAT_STATE_KEY, value: originalChatState },
      })
      .catch(() => undefined);
  }
  await ctx.dispose();
});

// ------------------------------------------------------------------ helpers

/** Launch the app from the desktop and return a locator scoped to its iframe. */
async function openEditor(page: Page, request: APIRequestContext): Promise<FrameLocator> {
  await ensureReady(request);
  // The desktop may have been rendered before the install (or before a seed
  // landed), so reload to pick up the icon and a freshly-read index.
  await page.reload();
  await page.getByText("Editor", { exact: true }).first().dblclick();
  const app = page.frameLocator(`iframe[title="App: ${APP_ID}"]`);
  // The shell only renders once the persisted snapshot has been merged in.
  await expect(app.getByTestId("ate-status-bar")).toBeVisible({ timeout: 30_000 });
  await expect(app.getByTestId("ate-agent-selector")).toBeVisible();
  return app;
}

/** The agents BOS has registered, read straight from the API the broker wraps. */
async function registeredAgents(request: APIRequestContext): Promise<{ id: string; name: string }[]> {
  const res = await request.get("/api/assistant/agent");
  if (!res.ok()) return [];
  const body = (await res.json()) as { agents?: { id?: string; name?: string }[] };
  return (body.agents ?? [])
    .filter((a): a is { id: string; name?: string } => typeof a.id === "string" && !!a.id)
    .map((a) => ({ id: a.id, name: a.name && a.name.trim() ? a.name : a.id }));
}

/** The label the trigger pill is currently showing. */
function selectorLabel(app: FrameLocator, testId: string) {
  return app.getByTestId(testId).locator(".ate-selector-label");
}

async function openMenu(app: FrameLocator, testId: string) {
  await app.getByTestId(testId).click();
  const menu = app.getByTestId(`${testId}-menu`);
  await expect(menu).toBeVisible();
  return menu;
}

/**
 * Wait for the app's own index write to reach the server.
 *
 * A selection updates React state and persists asynchronously (storage goes
 * over postMessage to the parent, which POSTs it). Reloading the moment the
 * label changes would race that write, so persistence tests poll the stored
 * value rather than guessing with a sleep.
 */
async function waitForChatState(
  request: APIRequestContext,
  accept: (state: SeedChatState) => boolean,
  what: string,
): Promise<void> {
  await expect
    .poll(
      async () => {
        const raw = await readStoredChatState(request);
        if (!raw) return false;
        try {
          return accept(JSON.parse(raw) as SeedChatState);
        } catch {
          return false;
        }
      },
      { message: `the app never persisted ${what}`, timeout: 15_000 },
    )
    .toBe(true);
}

// ------------------------------------------------------------------ tests

test.describe("Agentic Text Editor v2 — agent selector", () => {
  test("lists registered agents", async ({ page, request }) => {
    const app = await openEditor(page, request);

    const menu = await openMenu(app, "ate-agent-selector");
    await expect(menu).toContainText("Agents");
    // The Assistant is well-known and always registered, so it is the one
    // option that can be asserted by name on any BOS install.
    const main = menu.getByTestId(`ate-agent-option-${MAIN_ASSISTANT_ID}`);
    await expect(main).toBeVisible();
    await expect(main).toContainText("Assistant");

    // Leave the header as it was found — Escape closes the menu (focus is on
    // the trigger inside the iframe, which is where the handler lives).
    await page.keyboard.press("Escape");
    await expect(menu).toBeHidden();
  });

  test("selection updates the trigger label", async ({ page, request }) => {
    const app = await openEditor(page, request);

    const menu = await openMenu(app, "ate-agent-selector");
    await menu.getByTestId(`ate-agent-option-${MAIN_ASSISTANT_ID}`).click();
    await expect(menu).toBeHidden();

    await expect(selectorLabel(app, "ate-agent-selector")).toHaveText("Assistant");
  });

  test("agent selection persists across reload", async ({ page, request }) => {
    const agents = await registeredAgents(request);
    const other = agents.find((a) => a.id !== MAIN_ASSISTANT_ID);
    test.skip(!other, "only the Assistant is registered on this install");
    const second = other as { id: string; name: string };

    const app = await openEditor(page, request);
    const menu = await openMenu(app, "ate-agent-selector");
    // Waiting for the real catalog to arrive: until it does, the selector shows
    // the seeded Main-Assistant-only fallback list.
    const option = menu.getByTestId(`ate-agent-option-${second.id}`);
    await expect(option).toBeVisible({ timeout: 15_000 });
    await option.click();
    await expect(selectorLabel(app, "ate-agent-selector")).toHaveText(second.name);
    await waitForChatState(request, (s) => s.selectedAgentId === second.id, "the agent selection");

    const reopened = await openEditor(page, request);
    await expect(selectorLabel(reopened, "ate-agent-selector")).toHaveText(second.name);

    // Put the Assistant back so the rest of the run starts where it did.
    const backMenu = await openMenu(reopened, "ate-agent-selector");
    await backMenu.getByTestId(`ate-agent-option-${MAIN_ASSISTANT_ID}`).click();
    await expect(selectorLabel(reopened, "ate-agent-selector")).toHaveText("Assistant");
  });
});

test.describe("Agentic Text Editor v2 — conversations", () => {
  test("new conversation shows empty state", async ({ page, request }) => {
    const app = await openEditor(page, request);

    await app.getByTestId("ate-new-conversation").click();

    await expect(app.getByTestId("ate-chat-empty")).toBeVisible();
    await expect(app.getByTestId("ate-chat-empty")).toContainText("No messages yet");
    // A brand-new conversation has no transcript file, and none is asked for.
    await expect(app.getByTestId("ate-transcript-error")).toBeHidden();
  });

  test("new conversation inherits selected agent", async ({ page, request }) => {
    const app = await openEditor(page, request);

    const label = selectorLabel(app, "ate-agent-selector");
    // Wait for the real agent catalog to arrive (label changes from the
    // seeded fallback name to the real one, e.g. "Assistant").
    await expect(label).not.toHaveText("Main Assistant", { timeout: 10_000 });
    const before = (await label.textContent())?.trim() ?? "";
    expect(before.length).toBeGreaterThan(0);

    await app.getByTestId("ate-new-conversation").click();
    await expect(app.getByTestId("ate-chat-empty")).toBeVisible();

    await expect(label).toHaveText(before);
  });

  test("conversation dropdown lists app conversations with agent + time sub-line", async ({ page, request }) => {
    const app = await openEditor(page, request);

    // Guarantee there is something to list, whatever ran before this test.
    await app.getByTestId("ate-new-conversation").click();
    await expect(app.getByTestId("ate-chat-empty")).toBeVisible();
    const agentName = (await selectorLabel(app, "ate-agent-selector").textContent())?.trim() ?? "";

    const menu = await openMenu(app, "ate-conversation-selector");
    await expect(menu).toContainText("Conversations");

    const options = menu.locator('[data-testid^="ate-conversation-option-"]');
    await expect(options.first()).toBeVisible();
    expect(await options.count()).toBeGreaterThanOrEqual(1);

    // Exactly one option is the active one, and it carries the check mark.
    const active = menu.locator('[data-testid^="ate-conversation-option-"][aria-checked="true"]');
    await expect(active).toHaveCount(1);
    await expect(active.locator(".ate-di-check")).toBeVisible();

    // Title on top, "<agent> · <relative time>" underneath.
    await expect(active.locator(".ate-di-name")).toHaveText("New conversation");
    const sub = active.locator(".ate-di-sub");
    await expect(sub).toContainText(agentName);
    await expect(sub).toContainText("·");
  });

  test("active conversation persists across reload", async ({ page, request }) => {
    await ensureReady(request);
    // A conversation that never ran: the app treats a missing transcript for one
    // as "empty", not "gone", so no file is needed to make it selectable.
    const now = Date.now();
    await writeChatState(request, {
      version: 2,
      conversations: [
        {
          id: PERSIST_ID,
          title: PERSIST_TITLE,
          agentId: MAIN_ASSISTANT_ID,
          createdAt: now,
          lastActiveAt: now,
        },
      ],
      activeConversationId: null,
      selectedAgentId: MAIN_ASSISTANT_ID,
    });

    const app = await openEditor(page, request);
    const menu = await openMenu(app, "ate-conversation-selector");
    await menu.getByTestId(`ate-conversation-option-${PERSIST_ID}`).click();
    await expect(selectorLabel(app, "ate-conversation-selector")).toHaveText(PERSIST_TITLE);
    await waitForChatState(request, (s) => s.activeConversationId === PERSIST_ID, "the active conversation");

    const reopened = await openEditor(page, request);
    await expect(selectorLabel(reopened, "ate-conversation-selector")).toHaveText(PERSIST_TITLE);
  });
});

test.describe("Agentic Text Editor v2 — tool row", () => {
  test("renders dual-color tool chips from a transcript", async ({ page, request }) => {
    await ensureReady(request);

    // One turn, two tools: a BOS server tool and one of this app's own. The
    // shape is BOS's persisted message contract (src/lib/assistant/messages.ts,
    // mirrored by the item's types.ts) — the raw file, tool results included,
    // exactly as `readTranscript` sees it.
    await seedTranscript(request, {
      id: TOOL_ROW_ID,
      title: TOOL_ROW_TITLE,
      agentId: MAIN_ASSISTANT_ID,
      messages: [
        {
          id: `${TOOL_ROW_ID}-u1`,
          role: "user",
          content: "Look up the release date and add it to the document.",
        },
        {
          id: `${TOOL_ROW_ID}-a1`,
          role: "assistant",
          content: "I searched for the date and added it to the document.",
          toolCalls: [
            {
              id: `${TOOL_ROW_ID}-call-search`,
              type: "function",
              function: { name: "web_search", arguments: JSON.stringify({ query: "release date" }) },
            },
            {
              id: `${TOOL_ROW_ID}-call-edit`,
              type: "function",
              function: {
                name: "agentic_editor_add_content",
                arguments: JSON.stringify({ content: "Released in March." }),
              },
            },
          ],
        },
        {
          id: `${TOOL_ROW_ID}-t1`,
          role: "tool",
          toolCallId: `${TOOL_ROW_ID}-call-search`,
          content: JSON.stringify({ ok: true, results: [] }),
        },
        {
          id: `${TOOL_ROW_ID}-t2`,
          role: "tool",
          toolCallId: `${TOOL_ROW_ID}-call-edit`,
          content: JSON.stringify({ ok: true }),
        },
      ],
    });

    // Make the app's index aware of it — the dropdown lists the index, never
    // the chats directory. `lastActiveAt > createdAt` marks it as having run,
    // which is what makes the app read the file at all.
    const now = Date.now();
    await writeChatState(request, {
      version: 2,
      conversations: [
        {
          id: TOOL_ROW_ID,
          title: TOOL_ROW_TITLE,
          agentId: MAIN_ASSISTANT_ID,
          createdAt: now - 60_000,
          lastActiveAt: now - 30_000,
        },
      ],
      activeConversationId: null,
      selectedAgentId: MAIN_ASSISTANT_ID,
    });

    const app = await openEditor(page, request);
    const menu = await openMenu(app, "ate-conversation-selector");
    await menu.getByTestId(`ate-conversation-option-${TOOL_ROW_ID}`).click();
    await expect(selectorLabel(app, "ate-conversation-selector")).toHaveText(TOOL_ROW_TITLE);

    // The transcript renders: the question, the reply, and no tool-result noise.
    await expect(app.getByTestId("ate-message-user")).toHaveCount(1);
    await expect(app.getByTestId("ate-message-user")).toContainText("Look up the release date");
    const reply = app.getByTestId("ate-message-agent");
    await expect(reply).toHaveCount(1);
    await expect(reply).toContainText("added it to the document");

    // FR-025: one row, two colours — grey for what the agent did elsewhere,
    // violet for what it did to the user's document.
    const row = reply.getByTestId("ate-tool-row");
    await expect(row).toBeVisible();
    await expect(row.locator(".ate-tool-chip")).toHaveCount(2);

    const other = row.locator(".ate-tool-chip.ate-other");
    await expect(other).toHaveCount(1);
    await expect(other).toContainText("web search");

    const editor = row.locator(".ate-tool-chip.ate-editor");
    await expect(editor).toHaveCount(1);
    await expect(editor).toContainText("add content");
  });
});

test.describe("Agentic Text Editor v2 — sanity", () => {
  test("assistant is available in the normal case", async ({ page, request }) => {
    const app = await openEditor(page, request);

    // The regression this guards: a transient cold-start failure latching the
    // degraded state, which disables every control in the header.
    await expect(app.getByTestId("ate-chat-messages")).toBeVisible();
    await expect(app.getByTestId("ate-assistant-unavailable")).toBeHidden();
    await expect(app.getByTestId("ate-agent-selector")).toBeEnabled();
    await expect(app.getByTestId("ate-conversation-selector")).toBeEnabled();
    await expect(app.getByTestId("ate-new-conversation")).toBeEnabled();
    await expect(app.getByTestId("ate-chat-input")).toBeEnabled();
  });
});
