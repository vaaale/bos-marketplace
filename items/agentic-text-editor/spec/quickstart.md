# Quickstart: Agentic Text Editor

Validation guide for the feature (T052). Everything below is manual except the
last section, which runs the automated checks.

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

## v3 — file handlers, tables, custom styles (US9/US10/US11)

### File handlers (US9 → SC-011)

1. In **Files**, double-click a `.md` file → it opens in **Editor**, in
   **Preview** mode, with the markdown rendered.
2. Double-click a `.txt` file → it opens in Editor, in **Edit** mode.
3. Right-click a `.md`, `.txt` or `.html` file → *Open with* lists **Open with
   Editor** for all three. For HTML, **Open with Web View** keeps the checkmark
   until you pick Editor; for md/txt, Editor has it from install
   (`default: true` in `app/app.json`).
4. API check: `GET /api/file-handlers?mime=text/markdown` (and `text/plain`) →
   `selected: "agentic-text-editor"`.

### GFM tables (US10 → SC-012)

Open a `.md` file containing each of these, then flip to Preview:

1. A basic pipe table → a real `<table>` with `<thead>`/`<tbody>`.
2. A delimiter row `| :--- | :---: | ---: |` → left/center/right-aligned columns.
3. A cell with `a \| b` → renders as the literal `a | b`, one cell.
4. A cell with `**bold**`, `` `code` `` and a `[link](…)` → all render inline.
5. A table indented under a list item → renders **inside** that item.
6. `| a | b |` inside a fenced ``` code block → stays literal code.
7. Flip to Edit → the raw pipe source is unmodified.

### Custom styles (US11 → SC-013)

1. Open a `.md` file with `::: {custom-style="Note"} text :::` → Preview shows
   a violet callout box (the built-in Note style). `::: {.Note}` renders the
   same.
2. `::: {custom-style="RuleBox"} text :::` (unknown name) → a neutral box;
   content is never dropped.
3. Nest a `{.Warning}` div inside a `Note` div → both containers render, each
   with its own style.
4. **Settings (gear) → Custom Styles**: the Built-in group lists
   Note/Info/Warning/Tip with lock icons (no remove); the Your-styles group is
   empty (dashed placeholder) until you add one.
5. **Add style** → name `PinkBox`, CSS `background:#fce7f3;` → the live preview
   box updates as you type → Done → the row appears with a `user` pill. A
   document using `PinkBox` now renders it — and if that preview is already
   open, it restyles the moment you hit Done, no reload.
6. Edit built-in `Note`'s CSS → its row shows `modified`; open it again →
   **Reset to default** restores the shipped CSS.
7. Restart the app → your styles are still there (`storage`-backed). A `:::`
   inside a fenced code block stays literal.

## 7. Automated checks

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
npx playwright test e2e/agentic-text-editor.spec.ts
npx playwright test e2e/v2.spec.ts
npx playwright test e2e/v3.spec.ts
```

The e2e suite covers the shell layout, open/edit/preview/save, restart
persistence, multi-tab + the unsaved-changes prompt, live settings, and the chat
surface. It deliberately does **not** drive an LLM run — the agent tool handlers
act on the same store the UI tests, and an e2e test that needed a model would be
neither fast nor deterministic.

---

## Known limitations

- **Agent tools need the window open.** The tools are registered as the run's
  surface tools by the app's own chat, so a BOS-wide assistant conversation
  cannot call them while the editor is closed. SC-004 is satisfied in the sense
  that the agent — not the user's clicks — drives the app.
- **External modification is not detected.** If a file changes on disk while a
  tab holds it, saving overwrites it (out of scope for v1, per the spec).
- **No undo/redo** beyond the browser's own textarea history.
