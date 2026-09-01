# Editor — file handling and formats

How the Editor item (`agentic-text-editor`) participates in BrowserOS's
file-type-handler mechanism, and how its format registry renders what it opens.
This describes the shipped item; the end-user view is `docs/usage/Editor/`.

Layout of the relevant source:

```
app/
├── app.json                            # the manifest — declares fileHandlers
└── src/
    ├── main.tsx                        # app shell: consumes the launch contract
    ├── services/
    │   ├── launch.ts                   # parses bosFilePath / bosFileAction
    │   ├── format-service.ts           # the format registry
    │   └── formats/
    │       ├── markdown.ts             # previewMode "inline" (default)
    │       ├── plaintext.ts            # previewMode "inline" (default)
    │       └── html.ts                 # previewMode "document"
    ├── components/editor/preview-view.tsx  # the two preview paths
    ├── state/document-store.ts         # re-derives formatId on hydration
    └── types.ts                        # FormatHandler
```

## 1. Registering as a file-type handler

Handler registration is a **manifest declaration**, not code. `app/app.json`:

```json
"fileHandlers": [
  {
    "type": "text/html",
    "capabilities": ["render", "edit"],
    "label": "Editor"
  }
]
```

- `type` — the base MIME type handled. BOS maps extensions to MIME types
  (`.html`/`.htm` → `text/html`) and compares base types only, so a declaration
  without parameters still matches `text/html; charset=utf-8`. A trailing slash
  would claim a whole family (`"text/"`); this item deliberately claims only
  HTML, because Markdown and plain text already open through the app's own
  *Open* dialog and claiming `text/` would put Editor in the menu for every text
  file.
- `capabilities` — `render` means "can display it", `edit` means "can modify
  it". Both are true here. Only a **render**-capable handler may become the
  *selected* (double-click) handler for a type, which is why declaring `render`
  is what puts Editor in line to become HTML's default app.
- `label` — the text in the menu row: *Open with Editor*. Defaults to the
  manifest `name`, which is already "Editor"; it is stated explicitly so a
  later rename of the app cannot silently reword the menu.

Nothing else is needed. BOS's registry (`src/lib/file-handlers/registry.ts`)
derives "which apps open this type?" from every installed manifest on each
query, so the item appears in the Files context menu as soon as it is installed
and disappears when it is uninstalled — no registration call, no cache to
invalidate.

What the user sees: Files' right-click menu grows an *Open with* section listing
every handler for the type — **Open with Web View** (the built-in
`html-viewer`, which declares `default: true`) and **Open with Editor**. This
item does **not** declare `default`, so Web View keeps the checkmark until the
user picks Editor; picking a render-capable handler also persists it as the
type's selection, so double-click follows it from then on.

`paramShape` is intentionally absent. It is how a handler asks for extra
contract fields, and its two options do not help here: `url: "raw"` applies to
built-in component handlers only (an iframe app's `src` is always its own
`manifest.url`), and `title: "basename"` would hand over a filename this app
already derives from the path.

## 2. The open-file launch contract

An iframe app has exactly one inbound channel at launch — its URL. So BOS
appends the file to the iframe `src` (`withFileParams` in
`src/components/apps/IframeApp.tsx`):

```
/apps/agentic-text-editor/?bosFilePath=/Documents/report.html&bosFileAction=open
```

| Param | Meaning |
| --- | --- |
| `bosFilePath` | the file's absolute VFS path |
| `bosFileAction` | `"open"` (display it) or `"edit"` (modify it) |
| `bosFileTitle` | basename — only when the manifest asked via `paramShape` |

The `bos` prefix is the OS's guarantee that these never collide with a query
param the app defines for itself. Both `path` and `action` must be present and
`action` must be one of the two literals: `bosFilePath` alone is not a handler
launch, since an app is free to have a `path` param of its own.

### How this item consumes it

`services/launch.ts` is pure parsing and is deliberately unaware of the store:

- It reads `window.location.search` **at import time** — before React renders —
  because the launch is a fact about how the window was opened, not mutable
  state, and the app is free to rewrite its own URL later.
- `parseFileLaunch(search)` returns `{ path, action, title } | null`, rejecting
  anything that is not a well-formed launch.
- `takeFileLaunch()` is **one-shot**. The params stay in the URL for the life of
  the frame, so anything that acted on them twice — a remount, a StrictMode
  double-invoked effect — would fight the user over the active tab and the view
  mode long after the launch was honoured. `peekFileLaunch()` is the
  non-consuming read.

`main.tsx` acts on it in one effect, gated on hydration:

```tsx
useEffect(() => {
  if (!hydrated) return;
  const launch = takeFileLaunch();
  if (!launch) return;
  const path = normalizePath(launch.path);
  void useEditorStore.getState().openPath(path)
    .then((doc) => {
      const previewable = getFormat(doc.formatId).supportsPreview;
      useEditorStore.getState().setViewMode(
        launch.action === "edit" || !previewable ? "edit" : "preview",
      );
    })
    .catch((err) => reportError(`Could not open ${path}: ${err.message}`));
}, [hydrated, reportError]);
```

Four things that effect is doing on purpose:

1. **Waiting for `hydrate()`.** Hydration *replaces* the document list with the
   persisted snapshot, so a tab opened before it lands would be silently thrown
   away. Waiting is also what makes de-duplication work against restored tabs.
2. **De-duplicating.** The store's `openPath` focuses an existing tab when one
   already has that path, so a second *Open with Editor* on the same file
   focuses rather than duplicates. The path is normalised first, because that
   match is by string and the persisted tabs hold normalised paths.
3. **Reading through the SDK.** `openPath` → `file-service.openFile` →
   `services/bos.vfsRead` → `window.__bos.fs.read(path)` — the same route the
   *Open* dialog takes, so nothing about reading a file is launch-specific. The
   `fs:read` capability in the manifest is what makes that call legal.
4. **Choosing the mode.** `"edit"` → Edit, `"open"` → Preview, except that a
   format with no rich preview (a `.txt`) falls back to Edit rather than showing
   the user a preview pane containing their own text again.

Note that the view mode is app-global, not per-tab: a launch sets the mode for
the window, matching what the toolbar toggle does.

The filename comes from the basename of `bosFilePath` (via `openFile`), never
from `bosFileTitle` — a wrong or absent title can then never affect what a save
writes.

Reachability of `"edit"`: Files sends `"open"` for any handler that declares
`render` and `"edit"` only for edit-only handlers, so today this item is
launched with `"open"`. `"edit"` is still honoured rather than assumed away —
it is part of the contract, and the branch is one expression.

## 3. The HTML format handler

Formats are pluggable: `services/format-service.ts` maps ids and extensions to
`FormatHandler`s, and the rest of the app only ever asks the registry. Adding
HTML was one module plus one `register()` call — no change to the editor, the
store, the tab bar or the assistant tools.

```ts
export const htmlHandler: FormatHandler = {
  id: "html",
  name: "HTML",
  extensions: [".html", ".htm"],
  supportsPreview: true,
  previewMode: "document",
  render: (content) => `<pre class="ate-plaintext">${escapeHtml(content)}</pre>`,
  renderDocument: (content) => content,
  editorHints: { tabSize: 2, spellcheck: false },
};
```

Registration order in `format-service.ts` is plaintext (the catch-all fallback),
then markdown, then html; later registrations win a contested extension, and
these three do not overlap.

### Why `previewMode` exists

Every pre-v3 handler renders markup **it built itself**, fully escaped, which
the preview pane injects with `dangerouslySetInnerHTML`. HTML is the first
format whose preview is the content *itself*. Injecting that inline would be
wrong twice over: the app's own stylesheet would restyle the page, and the page
would get the editor's origin.

So `FormatHandler` gained one discriminator and one method
(`types.ts`), and `PreviewView` gained one branch:

- `previewMode: "inline"` (the default when absent) — inject `render()`'s
  output. The invariant "`render()` output is always safe to inject" is
  preserved for every handler.
- `previewMode: "document"` — hand `renderDocument()`'s output to a sandboxed
  iframe:

```tsx
<iframe
  className="ate-preview-frame"
  data-testid="ate-preview-frame"
  title={`Preview of ${format.name} document`}
  sandbox="allow-scripts"
  srcDoc={html}
/>
```

The pane picks the branch once, in a memo, and **degrades to inline** whenever
the document path cannot actually be honoured — `previewMode: "document"` with
no `renderDocument`, or one that throws or returns a non-string. Degrading is
safe by construction because the inline path escapes everything: the worst a
broken document handler can produce is the source it failed to render, never
unescaped markup injected into the app's own DOM.

`htmlHandler.render` still returns escaped source in a `<pre>` even though the
document path never calls it, so any future caller that ignores `previewMode`
degrades to safe output instead of injecting live markup.

### `formatId` is derived state, and hydration must re-derive it

A document's `formatId` is a **cache of a pure function of its filename**.
Every writer agrees on that: `openFile`, `createDocument` and `saveFile`
(`services/file-service.ts`) and the store's `renameDocument` all set it via
`getForFilename` / `formatIdFor`. There is no UI and no tool for choosing a
format by hand, so the filename is the only input there has ever been.

The one place that used to break the rule was **restore**. `formatId` is part
of the persisted snapshot (`PersistedState.documents`), and `hydrate()` took
those documents verbatim — so a snapshot could only ever be as clever as the
build that wrote it. A `.html` tab left open by a pre-v3 build came back
carrying `"plaintext"`, nothing recomputed it, and the preview pane duly took
the inline branch and showed **escaped source instead of the rendered page**
for a format that had shipped a `"document"` handler in the meantime.

`state/document-store.ts` therefore re-derives the id as snapshots come in:

```ts
function withResolvedFormat(doc: EditorDocument): EditorDocument {
  const formatId = formatIdFor(doc.filename);
  return doc.formatId === formatId ? doc : { ...doc, formatId };
}

function documentsOf(snapshot: Partial<PersistedState> | null): EditorDocument[] {
  return snapshot && Array.isArray(snapshot.documents)
    ? snapshot.documents.filter(isDocument).map(withResolvedFormat)
    : [];
}
```

`documentsOf` is the single funnel for **both** persisted copies — the KV
snapshot and the localStorage mirror — so the normalisation cannot be bypassed
by whichever one hydration decides is fresher. Doing it unconditionally is safe
for the reason above (there is no user choice to override) and it is what makes
**registering a format retroactive**: add a handler, and documents already open
in restored tabs pick it up on the next start rather than being frozen at
whatever the registry looked like when they were last persisted. Any future
format added per the recipe below inherits that for free.

### Why `srcdoc`, and why that sandbox

- **`srcdoc`, not `src`** — the frame is fed the **buffer**, so the preview is
  live: it reflects unsaved keystrokes and agent edits with no save and no
  reload. Pointing the frame at the file's raw URL (what `html-viewer` does)
  would show the last saved version, which is the wrong thing for an editor.
  The trade-off is that the document has no base URL, so relative links and
  relative asset paths do not resolve.
- **`sandbox="allow-scripts"` with no `allow-same-origin`** — scripts run,
  because a preview that skipped the page's own JavaScript would misrepresent
  the file; but the frame gets a throwaway opaque origin, so the previewed page
  cannot reach the editor's DOM, the injected `window.__bos` SDK, or the user's
  files. Adding `allow-same-origin` alongside `allow-scripts` would hand
  arbitrary previewed HTML the app's own origin and its granted capabilities —
  never do it.

Edit mode needed no work at all: the shared monospace textarea already shows raw
source, which for HTML is exactly right. `editorHints` only sets the tab size
and turns spellcheck off.

### Adding another document format

1. Write `services/formats/<id>.ts` exporting a `FormatHandler`. Set
   `previewMode: "document"` plus `renderDocument` if the preview is the content
   itself; otherwise return escaped markup from `render` and leave
   `previewMode` unset.
2. `register(<id>Handler)` in `services/format-service.ts`. Restored tabs pick
   the new format up on the next start — see the derived-`formatId` rule above.
3. If the format should appear in Files' *Open with* menu, add an entry to
   `fileHandlers` in `app/app.json` — the launch contract already routes it here
   and needs no code change.

Styling for the sandboxed frame lives in `src/styles.css` as
`.ate-preview-frame` (no padding, no colours of its own — the previewed page
brings its own).
