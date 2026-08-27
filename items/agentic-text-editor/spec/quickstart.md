# Quickstart: Agentic Text Editor

Validation guide for the feature. Everything below is manual except the last
section, which runs the automated checks. Sections 7 and 8 cover the v2 scope
(agent & conversation management, full tool-call visibility).

**What it is**: a marketplace app — a tabbed text/markdown editor in the left
pane and a chat with the BrowserOS assistant in the right pane. The agent edits
the same in-memory buffers the user types into, and nothing reaches disk until
an explicit save.

**Where it lives**: `data/user-apps/items/agentic-text-editor/app/` (the `app/`
facet of an item in the user's own marketplace), listed in
`data/user-apps/marketplace.json`.

---

## 0. Install it

The app is a marketplace item, so it has to be installed before it appears on
the desktop:

1. Open **Marketplace** → **My Apps** → **Agentic Text Editor** → **Install**.
2. Or from a shell: `curl -X POST localhost:3000/api/marketplace -H 'content-type: application/json' -d '{"op":"install-item","id":"user-apps","itemId":"agentic-text-editor"}'`

Installing is one symlink (`data/system/agentic-text-editor` → the item). The
TSX project is bundled with esbuild into `app/dist/` the first time the desktop
renders after install — no `npm install`, no BOS rebuild.

Then launch **Editor** from the desktop.

Expected: a two-pane window — editor at 45% on the left, chat at 55% on the
right, a violet status bar along the bottom of the editor pane.

---

## 1. Open, edit, preview, save (US1 → SC-001)

1. Click **Open**. The picker starts in `/Documents`; pick a `.md` file (the
   seeded `welcome.txt` works too).
2. A tab appears with the filename; the status bar reads `No changes`, `UTF-8`,
   `Markdown`.
3. Type something. The status bar switches to `Unsaved changes` and an amber dot
   appears on the tab.
4. **Verify nothing has been written**: `cat data/vfs/Documents/<file>` still
   shows the old text (FR-012).
5. Click **Preview**. Headings, code blocks, lists, links and emphasis render;
   `h1` has a violet underline, `h2` a violet left border.
6. Click **Edit**, then **Save** (or ⌘/Ctrl+S). The status bar returns to
   `No changes`, and the file on disk now has your text.

Also check: with unsaved changes, clicking **Open** prompts
*Save / Don't save / Cancel* before it lets you leave.

---

## 2. Let the agent edit the document (US2 → SC-002)

With a document open and active, in the chat:

| Ask | Expect |
|---|---|
| "add a paragraph about hedgehogs" | text appended to the buffer; it appears in the editor as the turn completes, tab goes amber, a violet `Agent added content` flash appears in the status bar |
| "elaborate on the second paragraph" | the agent reads the buffer, then rewrites/extends that paragraph |
| "delete the first paragraph" | that paragraph disappears from the buffer |
| "save it" | the file on disk now matches the pane |

Two things to confirm:

- Agent edits are **never** written to disk on their own — check the file after
  an edit and before you save.
- The chip row under each agent reply names the tools it used
  (`add content`, `modify content`, …).

---

## 3. Let the agent drive the files (US3 → SC-004)

| Ask | Expect |
|---|---|
| "open /Documents/welcome.txt" | a new tab, focused |
| "create a document called draft.md" | a new untitled tab (no path yet) |
| "what documents do I have open?" | a list with filenames, paths and unsaved state |
| "search this document for 'hedgehog'" | matching line numbers with context |
| "switch to welcome.txt" | that tab becomes active |
| "save everything" | every dirty document with a path is written; never-saved ones are reported back, not silently skipped |

The twelve tools are all prefixed `agentic_editor_`. They ride along as the
run's surface tools, so they are callable for as long as the app window is open.

---

## 4. Multiple documents (US4 → SC-003)

1. Open five or six documents. The tab strip scrolls; the active tab scrolls
   itself into view.
2. Click between tabs — content switches instantly, no layout shift, and the
   editor starts each document at the top rather than inheriting the previous
   scroll offset.
3. Ask the chat about "the file called X" — the agent targets that tab, not the
   active one.
4. Close a tab with unsaved changes: *Save and close / Discard / Cancel*.
5. Type into the editor while the agent is mid-edit — both write to the same
   buffer, last write wins (no dialog, no lost tab).

---

## 5. Appearance settings (US5 → SC-005/SC-006)

1. Click the gear in the toolbar.
2. Change **Font family** and **Font size** — both the editor and the preview
   change while the panel is still open.
3. Change **Heading 1**, **Links**, **Code background**, **Code text** — switch
   to Preview to see them.
4. **Reset to defaults** restores everything.
5. Close and relaunch the app: settings, open tabs, buffer contents and chat
   history all come back (they are persisted to the app's per-app KV store,
   `data/app-storage/agentic-text-editor.json`).

---

## 6. Adding a new format (SC-007)

The proof that the format architecture is pluggable — a new format is one module
and one call, with no change to the editor, store or tools:

```ts
// app/services/formats/html.ts
import type { FormatHandler } from "../../types";
export const htmlHandler: FormatHandler = {
  id: "html",
  name: "HTML",
  extensions: [".html", ".htm"],
  supportsPreview: true,
  render: (content) => escapeAndHighlight(content),
};

// app/tools/registry.ts — one line
registerFormat(htmlHandler);
```

Opening a `.html` file then picks it up automatically: the status bar names it,
the Preview toggle uses its renderer, and the assistant's
`agentic_editor_list_documents` reports it.

---

## 7. Agent & conversation management (v2 → SC-008 / SC-009)

With the app open, in the chat header (the bar across the top of the right pane):

| Control | Where | What it does |
|---------|-------|-------------|
| **Agent selector** (sparkles icon + label, left) | Chat header, left | Opens a dropdown listing every registered BOS agent. Select one and the next message in the active conversation goes to that agent. The choice is remembered per conversation and survives restarts. |
| **New conversation** (plus icon, right) | Chat header, right | Clears the chat pane to the empty state and starts a fresh thread on the currently-selected agent. The previous conversation is kept and still available in the dropdown. |
| **Conversation selector** (label + chevron, right) | Chat header, right | Lists every conversation this app started, most-recent first, with each item showing the conversation title, the agent name, and a relative timestamp. Select one to restore its transcript and its agent. |

To verify persistence:

1. Select a non-default agent (or just note the current one).
2. Click New conversation → confirm the empty state appears.
3. Close the app window, reopen it.
4. The agent selector should still show the same agent; the conversation selector should still show the same conversation (its title, not "New conversation").

The app's conversation index is stored in its per-app KV store. Transcript files live at `/Documents/Chats/ate-<id>.json` (one per conversation), written by the BOS assistant loop — the item never writes to that directory directly.

## 8. Full tool-call visibility (v2 → SC-010)

Send a message that causes the agent to call both an `agentic_editor_*` tool and a non-editor tool (e.g. "search the web for hedgehogs and add a paragraph about them to the document").

In the agent's reply, a single tool row appears with chips: the editor tool (`agentic_editor_add_content`) renders in **violet** ("add content"), and the non-editor tool (`web_search`) renders in **neutral gray** ("web search"). Both chips are the same pill shape — only the accent color differs. This row is also present on any conversation restored from a previous session (replayed from the transcript, not re-executed).

## 9. Automated checks

```bash
# Types (the app is outside the Next.js tsconfig graph, so check it directly)
npx tsc --noEmit --strict --jsx react-jsx --target ES2020 --module esnext \
  --moduleResolution bundler --skipLibCheck --lib dom,dom.iterable,esnext \
  --types node,react,react-dom \
  data/user-apps/items/agentic-text-editor/app/index.tsx

# The rest of the repo
npx tsc --noEmit
npm run lint

# End-to-end (needs a running BOS; installs the item itself if it isn't yet)
# v1: shell layout, open/edit/preview/save, restart persistence, multi-tab, settings, chat
npx playwright test e2e/agentic-text-editor.spec.ts
# v2: agent selector, conversation management, dual-color tool row, sanity guards
npx playwright test e2e/v2.spec.ts
```

The e2e suites deliberately do **not** drive an LLM run — the v1 suite tests
the document editor and chat surface against the real app, and the v2 suite
seeds conversation transcripts and index entries through the BOS API so the
tool-row and persistence tests are deterministic without a model. The v2 suite
is serial and cleans up everything it seeds (transcript files, index entries).

> **Note**: the v2 spec uses `expect.poll` to wait for the app's async
> persistence writes before reloading, so it is safe against the race between
> a selection and the postMessage→POST storage write.

---

## Known limitations

- **Agent tools need the window open.** The tools are registered as the run's
  surface tools by the app's own chat, so a BOS-wide assistant conversation
  cannot call them while the editor is closed. SC-004 is satisfied in the sense
  that the agent — not the user's clicks — drives the app.
- **External modification is not detected.** If a file changes on disk while a
  tab holds it, saving overwrites it (out of scope for v1, per the spec).
- **No undo/redo** beyond the browser's own textarea history.
- **v2 conversations are app-scoped.** The conversation dropdown lists only
  conversations this app started (the `ate-` prefix). They are real BOS
  assistant conversations and will also appear in the global BOS chat list
  under the selected agent — the app's dropdown simply does not enumerate
  conversations started elsewhere (per clarification A2).
- **Storage capability fallback.** If the item's `storage` capability is not
  granted (Settings → Apps), the app falls back to `localStorage` for its
  conversation index. Persistence still works per browser profile, but the
  index is not shared across BOS instances. Grant `storage` in the item's
  capability settings for full shared-store persistence.
