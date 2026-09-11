# Architecture Design: Agentic Text Editor — v3 (File Handlers · GFM Tables · Pandoc Fenced-Div Custom Styles)

**Spec**: `item-agentic-text-editor/spec.md` (v3 scope: FR-026 → FR-029 / US9 → US11 / SC-011 → SC-013, Clarifications Q1–Q3 + the "markdown rendering mechanism" ASSUMPTION)
**Target**: marketplace item, `app/` facet only (no `services/` facet, no BOS source change)
**Mockup (v3)**: `item-agentic-text-editor/mockup.html` (Settings "Custom Styles" tab + "Result in a document" page — the binding UI contract for the settings surface)
**Mockup (v2, unchanged)**: `item-agentic-text-editor/ui-mockup.html` (two-pane editor + chat)
**Baseline**: `design.md` v2 (agent & conversation management + full tool-call visibility) and the installed v1 code. **This is the v3 delta** — v1's editor components, `file-service`, `format-service`, `assistant-tools`, and v2's `assistant/` + chat components are unchanged unless explicitly listed below.

> **Why a delta doc**: v1 and v2 are already installed and working (see `discrepancies.md`: v2 code is consistent with spec, one accepted install-side manifest gap). v3 adds three orthogonal capabilities on top. The file/module plan below lists **only the v3 changes**.

---

## 0. The one premise this design corrects (read first)

The spec's **"markdown rendering mechanism" ASSUMPTION** (Clarifications, v3) says the table + fenced-div fixes are *"expected"* to come from `remark-gfm` + `remark-directive`/`remark-directive-rehype`, **and** that "if the current renderer is not `react-markdown`-based, the equivalent is a small pre-transform… same behavior, different plumbing." The spec explicitly hands the design step the job of confirming the mechanism against the item's actual renderer.

**Confirmed by reading the source** (`app/src/services/formats/markdown.ts`): the Editor's preview renderer is **not** `react-markdown`/`remark`/`unified` at all. `renderMarkdown(content)` is a **hand-rolled, dependency-free CommonMark-subset string builder**: a line-loop with a paragraph/list/quote state machine plus an `escapeHtml`-first `renderInline` pass. It emits an HTML string that `components/editor/preview-view.tsx` injects via `dangerouslySetInnerHTML`. There is **no `package.json`** at the item root and the `app/` facet is bundled to a single esbuild IIFE — the parser deliberately imports nothing but `types`. The module header even states its own extension contract: *"Adding a richer renderer later means swapping this one module."*

**Consequence (this is ADR-1):** v3 does **not** introduce `remark-gfm`/`remark-directive`. It **extends the existing hand-rolled parser** with two bounded block recognizers — a GFM-table pass and a pandoc `fenced_div` pass — which is exactly the spec's sanctioned fallback. This keeps the item dependency-free, keeps the blast radius inside one module, and honors the "one module + one register()" pluggable promise (SC-007). The *behavior* the spec pins (FR-027/FR-028) is met; only the *plumbing* differs from the assumed mechanism.

Everything else about the v3 design inherits the v2 constraints verbatim: **no BOS source change, no new capability, a sandboxed-iframe IIFE that cannot import main-bundle modules, and all BOS interaction via `window.__bos`.**

---

## 1. Classification

**App Target: `marketplace-item` — `app/` facet only (no `services/` facet, no BOS source change).**

- The item lives at `data/user-apps/items/agentic-text-editor/` and is installed as a sandboxed-iframe app (`docs/dev/apps/installed-apps.md`), built to a single esbuild IIFE. It is not `src/apps/<id>/` (not `builtin-app`) and modifies **no** file under `src/` (not `bos-core`).
- No background daemon, network port, or raw-protocol need → **no `services/` facet**. All three v3 features (file-handler registration, table rendering, fenced-div styles) are pure app-facet work.
- File-handler registration is a **manifest declaration** (`app.json` → `AppManifest.fileHandlers`), consumed by the existing 036 file-handler registry at query time — it is not a new capability and requires no BOS code (see `src/lib/file-handlers/registry.ts`, which derives handler sets from installed manifests on each query).
- **Agrees with the spec** — `spec.md` declares `**App Type**: Marketplace (data/user-apps/items/agentic-text-editor/)`. No reconciliation needed.

---

## 2. Constitution check

| Principle | Compliance |
|---|---|
| **I. Spec-Driven** | v3 is fully specified (FR-026/027/028/029, US9/10/11, SC-011/012/013, Clarifications Q1–Q3 + the mechanism ASSUMPTION). This `design.md` is the structural pass before `plan`; it **resolves** the ASSUMPTION (see §0/ADR-1) rather than deferring it. ✓ |
| **IV. Minimize Blast Radius** | **App-side only.** No BOS source change, no new capability, no new route. The renderer changes are confined to one module (`formats/markdown.ts`) plus one new config module and the settings UI; the file-handler change is a manifest-only edit. ✓ |
| **II. Server Authority** | Not engaged by v3's new state. Custom styles are **app-owned** appearance data (like v1's font/colour settings), so they live in the item's per-app KV store — not the server-owned transcript store and not a global config namespace. No message content or server state is touched. ✓ |
| **V. VFS / data layout** | Style persistence reuses the item's per-app store (`data/app-storage/agentic-text-editor.json`) via the `storage` capability (`src/app/api/app-storage/route.ts`) — the same first-class layer v1 settings and the v2 conversation index already use. No invented storage. ✓ |
| **VI. Specs & Docs in Sync** | This is a marketplace item (its own GitFS repo). v3 updates the item's `docs/usage/Editor/` and `docs/dev/Editor/` (see §4). BOS behavior is unchanged, so `docs/dev` (BOS's own) is untouched. ✓ |

**No conflicts.** The design's central property (inherited from v2 and preserved here): **zero BOS-source changes** — every mechanism v3 needs (the 036 registry, `withFileParams`, the storage broker, the format-registry contract) already exists.

---

## 3. Architecture

### 3.1 Context (how the user/agent sees it)

The app is the same installed window as v1/v2. v3 changes three things from the user's point of view:

1. **Reachability (FR-026/US9):** double-clicking a `.md` or `.txt` file in the Files app opens the Editor directly (it is now the *selected* handler for both types); "Open with Editor" also appears for `.md`/`.txt`/`.html`.
2. **Correct tables (FR-027/US10):** GFM pipe tables in preview now render as real `<table>`s (header/body rows, alignment, escaped pipes, inline markdown in cells) instead of literal pipe text.
3. **Custom styles (FR-028/FR-029/US11):** pandoc fenced divs (`::: {custom-style="Note"} … :::` / `::: {.Tip} … :::`) render as styled containers resolved from a **style registry** (built-in Note/Info/Warning/Tip + user-defined). A Settings **"Custom Styles"** tab manages the registry (add/edit/remove user styles, override built-in CSS, live preview). Unknown names degrade to a neutral container — never dropped, never thrown.

```mermaid
flowchart LR
  subgraph Files
    F1[.md / .txt / .html file]
  end
  F1 -->|double-click / Open with| Reg[036 file-handler registry<br/>src/lib/file-handlers/registry.ts]
  Reg -->|{path, action} via URL| Ifr[Editor iframe<br/>services/launch.ts]
  Ifr -->|fs.read| VFS[(VFS file)]
  VFS -->|content| MD[formats/markdown.ts renderMarkdown]
  subgraph MD
    TBL[GFM table pass]
    FD[fenced_div pass]
    FD -->|resolve name→CSS| SR[style registry<br/>config/custom-styles.ts]
  end
  MD -->|escaped HTML string| PV[preview-view.tsx<br/>dangerouslySetInnerHTML]
  SR <-->|load/save JSON| KV[per-app KV store<br/>data/app-storage/agentic-text-editor.json]
  CSS[Settings · Custom Styles tab<br/>components/settings/*] <-->|CRUD| SR
```

### 3.2 Container (BOS's real containers this item participates in — all pre-existing, none new)

| Container | Role for v3 |
|---|---|
| **036 file-handler registry** (`src/lib/file-handlers/registry.ts` + `src/os/file-handlers.ts`) | At each Files query, derives "which apps open this type?" from every installed manifest. Consumes the Editor's new `fileHandlers` entries for `text/markdown`/`text/plain`. **Unchanged.** |
| **The item's sandboxed iframe** (`/apps/agentic-text-editor`) | A separate JS context (esbuild IIFE). All v3 code lives here. Origin `local` (Build-Studio-authored) keeps `allow-same-origin` (`IframeApp.tsx`), but the design uses only `window.__bos.*` + a pure manifest declaration, so it is correct under any origin. |
| **Per-app KV store** `data/app-storage/agentic-text-editor.json` | Now also holds the **style registry** (user styles + built-in CSS overrides), keyed under a new key, via the `storage` capability. |
| **The item's format registry** (`src/services/format-service.ts`) | The `markdown` handler's `render()` now emits tables + fenced-div containers. The registry itself (id/ext → handler, `render(formatId, content)`) is **unchanged** — v3 changes what the markdown handler produces, not how it is reached. |

### 3.3 Component (the modules v3 creates or modifies — all inside the item)

```
app/
├── app.json                              # MODIFY — add text/markdown + text/plain fileHandlers (default:true)
├── src/
│   ├── config/
│   │   └── custom-styles.ts             # NEW — BUILTIN_STYLES, NEUTRAL, load/save, effectiveCss(name),
│   │                                    #       the module-level registry the markdown handler reads
│   ├── services/formats/
│   │   └── markdown.ts                  # MODIFY — GFM-table block + fenced_div block in renderMarkdown;
│   │                                    #       fenced_div CSS via effectiveCss; fence-first order preserved
│   ├── state/
│   │   └── document-store.ts            # MODIFY — load custom styles in hydrate(); CRUD actions; a
│   │                                    #       customStylesVersion the preview memo depends on
│   ├── components/
│   │   ├── settings-panel.tsx           # MODIFY — single-scroll dialog → Appearance / Custom Styles tabs
│   │   └── settings/                    # NEW — the Custom Styles surface (mockup.html is the contract)
│   │       ├── custom-styles-panel.tsx  #   list-view ↔ editor-view swap (per mockup renderList/renderEditor)
│   │       ├── style-list.tsx           #   built-in group + user group
│   │       ├── style-row.tsx            #   swatch row + name/pills/actions + list-level remove-confirm
│   │       ├── style-editor.tsx         #   name field + CSS textarea + remove/reset/done actions
│   │       └── style-preview.tsx        #   live-preview box (effectiveCss) + neutral fallback box
│   ├── styles.css                       # MODIFY — callout / table / custom-styles UI styles (ate-* classes)
│   └── types.ts                         # MODIFY — NamedStyle + custom-styles persistence shape
└── docs/
    ├── usage/Editor/editor.md           # MODIFY — opening .md/.txt from Files + a "custom styles" usage section
    └── dev/Editor/
        ├── file-handling.md             # MODIFY — manifest example now lists md/txt (default:true); fix the
        │                                #       "claims only HTML" prose (now: specific base types, still not text/)
        └── markdown-rendering.md        # NEW — table + fenced_div parsing in the hand-rolled renderer +
                                         #       the style-registry architecture (supersedes "swap this module")
```

#### The markdown renderer, extended (FR-027 + FR-028)

`renderMarkdown` keeps its line-loop + state machine. Two new block recognizers are added, **both placed after the existing fenced-code check** (which runs first in the loop and consumes a whole ``` block before any other logic) — that single ordering choice is what makes the edge case *"a `:::` inside a ``` fence is literal"* hold by construction: a directive delimiter inside a code block is already swallowed by the fence branch and never re-parsed.

**GFM table pass (FR-027).** A table is recognized when a line contains an unescaped `|` **and** the *next* line is a valid delimiter row (`| :--- | :---: | ---: |` — hyphens, optional colons, optional pipes/whitespace, no other content). On match the parser consumes the header row, the delimiter row (for per-column alignment), and subsequent body rows until a line that is no longer a pipe row (no unescaped `|`) or a blank line, then emits:

- `<table><thead><tr><th>` from the header row; `<tbody><tr><td>` from the body rows.
- **Alignment**: each delimiter cell `:---` → left (default), `:---:` → center, `---:` → right, applied as `style="text-align:…"` on that column's cells (US10.2).
- **Cell splitting** is on *unescaped* pipes only: `\|` is treated as a literal `|` and does not split a column (US10.3), and the emitted cell keeps the pipe visible.
- **Each cell's text is run through the existing `renderInline`**, so bold / inline code / links inside a cell render (US10.3). Because `renderInline` escapes `<`, a literal `<br>` in a cell is shown as text; to honour GFM's soft-break-within-cell convention the table cell renderer additionally maps an explicit `<br>`/`<br/>` (and backslash+newline) to a real `<br>`. This is the one inline nuance to verify in e2e (SC-012 "multi-line cells").
- **Standalone vs adjacent**: a table not in a list flushes any open paragraph/list/quote first (the existing `flushAll`), so "table immediately adjacent to a paragraph" (US10.4) works with no special case.
- **Nested in a list** (US10.4): when a table is detected while a list is open and the table rows are indented to the list-content column, they are emitted **inside the current `<li>`** rather than starting a new one. This is the non-trivial sub-case of the line parser (the existing list model emits one `<li>` per line) and is flagged as the primary e2e-verify item in §7.

**fenced_div pass (FR-028).** A fenced div opens on a line matching `^:::\s*<attr>` where `<attr>` is either the **class form** `::: {.Name}` or the **attribute form** `::: {custom-style="Name"}` (a full pandoc attribute list `{#id .class key="value"}` is also accepted — unknown keys are ignored, `custom-style` and a leading class are the two that matter). On open, the parser collects inner lines until the matching closing `^:::` line, then:

- **Recurse**: the inner block is itself rendered with `renderMarkdown(innerText)` — **nesting is free** (US11.4), because a fenced div inside a fenced div is just markdown inside markdown.
- **Resolve the name → CSS**: `effectiveCss(name)` from `config/custom-styles.ts` (see §3.4). 
- **Emit**: `<div class="custom-style custom-style--<escapedName>" data-style="<escapedName>" style="<escapedCss>"><innerHtml></div>`. The container is never empty and never throws: an unknown name resolves to the **neutral fallback CSS** (US11.3), so the content is always wrapped and rendered.
- The name used for `--<Name>` is URL/sanitized (alphanumeric + `-`/`_`) so an odd name can't break the class attribute; `data-style` carries the raw name for testability (e2e can assert on it).

Both recognizers emit fully escaped markup, so `preview-view.tsx`'s invariant — "`render()` output is always safe to inject" — holds unchanged. **No `FormatHandler` interface change and no `PreviewView` change are required** for either feature; only the markdown handler's output changes.

#### The style registry (FR-028/FR-029) — `config/custom-styles.ts`

Mirrors `config/editor-config.ts` (declarative defaults + load/save against the KV store), but for named styles instead of appearance scalars:

- `BUILTIN_STYLES`: the shipped set — `Note`, `Info`, `Warning`, `Tip` (Clarification Q3; `RuleBox` is deliberately **not** built-in — it was the spec's illustrative example, not a requested style). Each is `{ name, css, builtin: true }`. Names are **not removable** (FR-029); only their CSS is overridable.
- `NEUTRAL_STYLE.css`: the fallback container for any name not in the registry (the mockup's `.cs-box.neutral`).
- **Persistence shape** — stored under a single KV key `STYLE_KEY = "agentic-text-editor.custom-styles"` (parallel to `CONFIG_NAMESPACE = "agentic-text-editor.appearance"`):
  ```ts
  interface CustomStylesPersistence {
    version: 1;
    user:      Record<string, string>;   // user-owned styles: name → css (add/edit/rename/remove freely)
    overrides: Record<string, string>;   // built-in name → css (CSS-only override; name fixed)
  }
  ```
- **Resolution order** — `effectiveCss(name)`:
  1. name is a built-in → `overrides[name] ?? BUILTIN_STYLES[name].css` (ADR-2: the override wins when present, else the shipped default; this is exactly the mockup's "modified" state and "Reset to default").
  2. else name is in `user` → `user[name]`.
  3. else → `NEUTRAL_STYLE.css`.
  This three-way split is what makes the mockup's built-in-vs-user grouping, the "modified" pill, and the neutral fallback fall out directly from one function.
- `loadCustomStyles()` reads the key, merges built-ins, and caches the result in a module-level variable. `saveCustomStyles(next)` writes the key and updates the cache. `markdown.ts` calls `effectiveCss(name)` during render, so the preview always reflects the current registry.
- **Reactivity**: `state/document-store.ts` loads the registry in `hydrate()` and bumps a `customStylesVersion` on every style CRUD; `PreviewView` receives that version (prop or store read) and includes it in its render `useMemo` deps, so saving a style in Settings re-renders any open preview immediately (FR-029 "take effect in the preview immediately on save").
- **Graceful degradation** (inherited from v2 ADR-5 + the spec's storage-revoked edge case): if `storage` is revoked, `services/bos.ts` `storageGet`/`storageSet` already fall back to localStorage / no-op. Built-in styles are in code, so they always render; user styles simply don't persist across restarts. Nothing throws.

#### Settings surface (FR-029) — `components/settings/*`

`settings-panel.tsx` is currently a single-scroll dialog rendering the `SETTINGS_FIELDS` groups (Typography, Colours). The v3 mockup (`mockup.html`) is a **two-tab** modal — **Appearance** and **Custom Styles**. v3 therefore converts the dialog to a tabbed one:

- **Appearance tab** = the existing Typography + Colours content, moved verbatim (no behavior change; the "Reset to defaults" button stays). This is cosmetic restructuring only (ADR-4).
- **Custom Styles tab** = `custom-styles-panel.tsx`, which swaps between two views within the tab (mockup `renderList` / `renderEditor`):
  - **List view** (`style-list.tsx`): a **Built-in styles** group (lock glyph, "can't be removed, but their CSS can be overridden") and a **Your styles** group (add/edit/remove freely; dashed empty-state when none). Each row (`style-row.tsx`) shows a **swatch** (a tiny `div` styled with the style's CSS, padding stripped so it fits the 56×34 box — the mockup's `swatchStyle`), the **name**, a **pill** (`built-in` / `modified` / `user`), and **actions** (pencil = override/edit; trash = user-style remove with the inline confirm-strip; built-ins show the lock instead of trash).
  - **Editor view** (`style-editor.tsx` + `style-preview.tsx`): a **name** input (disabled for built-ins) + a **CSS** textarea ("declaration block — no surrounding braces"), the form actions (Remove style [user only] / Reset to default [built-in, enabled only when modified] / Done), and a **live-preview column** that shows the fenced-div source (`::: {custom-style="Name"} … :::`) plus a box styled with the *current* CSS, updated on every keystroke (the mockup's `updateLive`), and a permanent **neutral fallback** box beneath a divider ("content is never dropped").
- The swatch/live-box CSS mechanism is the mockup's `boxStyle`: a minimal neutral base is **prepended** so an empty/partial CSS still shows a box, and the user's declarations are **appended** so they win (later CSS rules override earlier). The same `effectiveCss` value feeds both the swatch and the document preview, so what you tune in Settings is exactly what renders in a file.
- All new UI uses the item's `ate-*` classes in `styles.css` (the mockup's `.style-row`/`.cs-*` names are the visual contract and are translated to the app's existing naming, consistent with how v1/v2 mapped their mockups).

### 3.4 The three v3 behaviors, mapped to mechanisms

**FR-026 — file handlers (US9).** Pure manifest edit in `app.json` (ADR-5). The OS does the rest: `handlersFor(mime)` lists the Editor for `text/markdown`/`text/plain`/`text/html`; `effectiveSelected` returns the Editor for the two new types because it is the (only) `default:true` render-capable candidate and there is no existing user selection. The launch path is **already built and shared**: `IframeApp.withFileParams` appends `bosFilePath`/`bosFileAction` to the iframe URL → `services/launch.ts` parses `{path, action}` at import time (one-shot `takeFileLaunch`) → `main.tsx`'s launch effect (gated on hydration) reads the file via `fs.read` and sets the view mode to **preview** for a previewable format and **edit** otherwise. So `.md` (markdown, `supportsPreview: true`) opens in **Preview**; `.txt` (plaintext, `supportsPreview: false`) opens in **Edit** — matching US9.4 and the plaintext "honest rendering" intent. **No launch code changes are needed.**

**FR-027 — GFM tables (US10).** The table pass in §3.3, confined to `formats/markdown.ts`. Edit mode is untouched (the monospace textarea always shows raw source, so the pipe table shows unmodified — US10.5) and the fence-first ordering keeps `:::`/`|` inside code blocks literal.

**FR-028/FR-029 — custom styles (US11).** The fenced_div pass (§3.3) + the registry (§3.4) + the Settings tab (§3.3). Built-ins ship in code; user styles + overrides persist under `STYLE_KEY`; unknown → neutral. The mockup's "Result in a document" page (Page 2) is the acceptance proof: Note/Warning (built-in), PinkBox (user), RuleBox (unknown → neutral), the syntax in a code block, and the footnote stating edit-mode shows raw source + nesting + "a `:::` in a ``` block is literal."

---

## 4. Concrete file/module plan (v3 delta only)

All paths are under the item root (`data/user-apps/items/agentic-text-editor/`). **Delta** over v2 — v1 editor/format/file/assistant modules and v2's `assistant/` + chat components are unchanged.

| Path | Status | Purpose |
|---|---|---|
| `app/app.json` | MODIFY | Add two `fileHandlers` entries: `text/markdown` and `text/plain`, each `{ capabilities:["render","edit"], label:"Editor", default:true }`, alongside the existing `text/html` entry (ADR-5). |
| `app/src/config/custom-styles.ts` | NEW | `BUILTIN_STYLES` (Note/Info/Warning/Tip), `NEUTRAL_STYLE`, `NamedStyle`/persistence shape, `STYLE_KEY`, `loadCustomStyles()`/`saveCustomStyles()`, `effectiveCss(name)` + the module-level cache the markdown handler reads (mirrors `editor-config.ts`). |
| `app/src/services/formats/markdown.ts` | MODIFY | Add the GFM-table block and the fenced_div block to `renderMarkdown` (both after the fence check); fenced_div resolves CSS via `effectiveCss`; emit escaped, injection-safe markup. No `FormatHandler`/`PreviewView` change. |
| `app/src/state/document-store.ts` | MODIFY | Load the registry in `hydrate()`; add `addStyle`/`updateStyle`/`removeStyle`/`overrideBuiltIn`/`resetBuiltIn` actions; add `customStylesVersion` (bumped on each) for preview reactivity. |
| `app/src/components/settings-panel.tsx` | MODIFY | Convert the single-scroll dialog into **Appearance** / **Custom Styles** tabs; move existing fields into Appearance (unchanged behavior). |
| `app/src/components/settings/custom-styles-panel.tsx` | NEW | Custom Styles tab: list-view ↔ editor-view swap (mockup `renderList`/`renderEditor`). |
| `app/src/components/settings/style-list.tsx` | NEW | Built-in + user groups. |
| `app/src/components/settings/style-row.tsx` | NEW | One swatch row: swatch, name, pill (`built-in`/`modified`/`user`), actions (override/edit, remove+confirm, lock for built-ins). |
| `app/src/components/settings/style-editor.tsx` | NEW | Name input (built-ins locked) + CSS textarea + Remove/Reset-to-default/Done. |
| `app/src/components/settings/style-preview.tsx` | NEW | Live-preview box (`boxStyle` pattern: base + current CSS) + fenced-div source + permanent neutral fallback box. |
| `app/src/styles.css` | MODIFY | Table cell/alignment styles, fenced-div container base, and the Custom Styles UI (swatch, rows, pills, editor, preview) as `ate-*` classes. |
| `app/src/types.ts` | MODIFY | Add `NamedStyle` and the custom-styles persistence shape. (`FormatHandler` unchanged.) |
| `docs/usage/Editor/editor.md` | MODIFY | (a) Extend "Opening an HTML file from Files" to cover `.md`/`.txt` (double-click + "Open with Editor"); (b) new "Custom styles" section (authoring `::: {custom-style="…"} … :::`, managing in Settings, neutral fallback, nesting, edit-mode shows raw source). |
| `docs/dev/Editor/file-handling.md` | MODIFY | Update the `fileHandlers` manifest example to include `text/markdown` + `text/plain` (`default:true`); rewrite the "this item deliberately claims only HTML… claiming `text/` would put Editor in the menu for every text file" paragraph → now claims **specific base types** (md/txt/html) and *still not* the whole `text/` family. |
| `docs/dev/Editor/markdown-rendering.md` | NEW | The v3 renderer: the GFM-table algorithm, the fenced_div parse + nesting, the style-registry architecture (built-ins in code, KV persistence, `effectiveCss` resolution, reactivity), and the fence-first ordering that keeps code-block delimiters literal. Supersedes the "swap this module for a richer renderer" note in `markdown.ts`. |

**Unchanged and load-bearing** (do not re-list): the `format-service` registry, `file-service`, the v1 `editor/` components, the v2 `assistant/` client + chat components, and `services/launch.ts`/`main.tsx` launch effect (FR-026 reuses them as-is).

---

## 5. Integration points (existing BOS mechanisms this design calls into — NOT created/modified)

| Mechanism | Real route / file | How v3 uses it |
|---|---|---|
| File-handler registry (query) | `src/lib/file-handlers/registry.ts` (`handlersFor`, `effectiveSelected`, `resolveSelected`) | Derives the Editor's presence + selected-handler status from the new `app.json` entries, on each Files query. No BOS change. |
| Extension→MIME map | `src/os/file-handlers.ts` (`MIME`, `baseMime`, `matchDeclared`) | Confirms `.md`→`text/markdown`, `.txt`→`text/plain` (base types, parameters dropped) — the exact `type` values the manifest must declare. |
| Launch param builder (server) | `src/os/file-handlers.ts` (`buildLaunchParams`) | Builds `{path, action}` (+`title` only if `paramShape.title`); `url` only if `paramShape.url==="raw"` (built-in only — N/A here). |
| Iframe URL hand-off | `src/components/apps/IframeApp.tsx` (`withFileParams`) | Appends `bosFilePath`/`bosFileAction`/`bosFileTitle?` to the iframe `src`. The iframe's `src` is always `manifest.url` — **no `url` is supplied**. |
| Open-file launch contract (item side) | `app/src/services/launch.ts` + `main.tsx` launch effect | Already parses `{path, action}` and maps to preview/edit. **Reused unchanged** by FR-026. |
| Per-app KV store | `window.__bos.storage.get/set` → `POST /api/app-storage` (`src/app/api/app-storage/route.ts`, file `data/app-storage/<id>.json`) | Persists the style registry under `STYLE_KEY`. Same channel as v1 settings + v2 chat index. |
| `storage` capability gate | `IframeApp.tsx` `CAP_FOR_METHOD` (`storage:*` → `storage`); already declared in `app.json` | Makes the storage calls legal; revocation degrades to the `services/bos.ts` localStorage/no-op fallback (built-ins still render). |

**No new BOS route, capability, or broker method is required.** The `storage` capability is already declared (`app.json` lists `assistant, storage, fs:read, fs:write, window:title, notify`), so v3 needs **no capability change** — only the `fileHandlers` array grows.

> **Install-side note (from `discrepancies.md` Finding 1):** the *installed* `app.json` on disk is missing the `capabilities` array even though the staging manifest and the live grant carry it. FR-026's change lands in the manifest the next build installs from, so this gap closes naturally on the v3 build — the new `fileHandlers` and the (already-correct) `capabilities` both ship together. No extra action beyond "reinstall from staging on the v3 build."

---

## 6. ADRs

### ADR-1 — Extend the hand-rolled parser; do NOT introduce remark/unified
- **Context.** The spec's mechanism ASSUMPTION expects `remark-gfm` + `remark-directive`. Reading `formats/markdown.ts` shows the renderer is a dependency-free, escape-first CommonMark-subset **string builder** — not `react-markdown`/`remark`. The item has no `package.json` and is a single esbuild IIFE; the module's own header says "adding a richer renderer later means swapping this one module."
- **Options.**
  (a) **Introduce `remark-gfm` / `remark-directive` / `unified`** (from BOS `node_modules` via esbuild `nodePaths`) and rework `markdown.ts` to a React/`unified` pipeline. Full GFM + the idiomatic fenced-div mechanism, but a large new dependency tree in a deliberately dependency-free IIFE, a change to how preview HTML is produced (string vs. React elements vs. HTML string), and a departure from the existing `FormatHandler.render(): string` contract.
  (b) **Extend the existing line parser** with a GFM-table recognizer and a fenced_div recognizer (the spec's explicit fallback: "the equivalent is a small pre-transform… same behavior, different plumbing").
- **Decision.** **(b).** Two bounded block passes added to `renderMarkdown`; fenced divs resolve to `effectiveCss(name)` and emit an escaped `<div style="…">`. Behavior pinned by FR-027/FR-028 is met with no new dependency.
- **Consequences.** Keeps the IIFE dependency-free and the blast radius inside one module; preserves the `render(): string` contract and the "output is always safe to inject" invariant. Cost: the two new recognizers must be written and e2e'd to GFM fidelity (tables in lists; `<br>` in cells) — the exact sub-cases the spec lists — and the design is documented so a future swap to a real `react-markdown` pipeline (option a) remains a one-module change, as the original author intended.

### ADR-2 — Style registry = built-ins in code + user styles & built-in overrides in the KV store
- **Context.** FR-028/FR-029: a name→CSS registry with a shipped built-in set (Q3) plus user-extensible styles that persist (FR-029), where built-in names are not removable but their CSS is overridable, and unknown names fall back to neutral (US11.3).
- **Options.** (a) One flat map of name→css with a separate `builtin` set; (b) **two maps** — `user` (freely add/remove/rename) and `overrides` (built-in name→css, CSS-only) — merged over the code-shipped `BUILTIN_STYLES`.
- **Decision.** **(b)**, persisted under `STYLE_KEY` as `{ version, user, overrides }`. `effectiveCss(name)`: built-in → `overrides[name] ?? BUILTIN_STYLES[name].css`; else → `user[name]`; else → `NEUTRAL`.
- **Consequences.** The mockup's every affordance is direct: "modified" pill = `overrides[name] != null`; "Reset to default" = delete `overrides[name]`; "Your styles" group = keys of `user`; neutral fallback = the else branch. Built-in immutability is structural (names come from code, not from `user`). Persistence reuses the proven `services/bos.ts` storage channel and degrades gracefully if `storage` is revoked (ADR in v2 design + the spec's storage-revoked edge case).

### ADR-3 — Inline `style` attribute on the fenced-div container (not a scoped `<style>` tag)
- **Context.** The renderer produces an HTML *string* injected into `.ate-preview`. How does a given style's CSS reach the container?
- **Options.** (a) A `<style>` block / CSS class injected once into the preview container, scoped to it; (b) an **inline `style="…"`** on each fenced-div `<div>`.
- **Decision.** **(b)** inline, using the mockup's `boxStyle` pattern (neutral base prepended, user declarations appended so they win). 
- **Consequences.** Matches the mockup exactly; dependency-free and per-node (no stylesheet scoping/ID juggling in a string renderer); trivially correct for nesting (each container carries its own CSS). The value is user-authored CSS placed in a `style=""` **attribute**, so the only injection risk is breaking out of the attribute — handled by escaping `"` (and `&`/`<`) when embedding it; CSS is not HTML, so there is no markup-injection surface. A broken/empty CSS still renders because the base is prepended. (Alternative (a) would also work but adds a stylesheet-management step the string renderer doesn't otherwise need; noted, not chosen.)

### ADR-4 — Settings becomes two tabs (Appearance / Custom Styles), not a third scroll section
- **Context.** The current `settings-panel.tsx` is a single scroll of Typography + Colours. The v3 mockup is a **tabbed** modal (Appearance | Custom Styles).
- **Options.** (a) Append a "Custom Styles" section to the existing scroll (no tabs); (b) **Adopt the mockup's tab structure** — move the existing fields into an "Appearance" tab and add the "Custom Styles" tab.
- **Decision.** **(b)** — the mockup is the binding UI contract and is tabbed; the Custom Styles surface (list ↔ editor with a live-preview column) is too large to sit in one long scroll.
- **Consequences.** Restructuring `settings-panel.tsx` is the only change to the existing surface, and it is cosmetic: the Appearance tab renders the same `SETTINGS_FIELDS` groups with the same reset/persist behavior, so v1's appearance settings (FR-018/FR-019) are unaffected. A user who previously scrolled now tabs; nothing is lost.

### ADR-5 — `default:true` for `text/markdown` + `text/plain`; no `paramShape`
- **Context.** FR-026/US9 (Q1): the Editor is the *selected* (double-click) handler for md/txt and an "Open with" option for md/txt/html.
- **Finding.** Verified: the **only** installed app declaring `fileHandlers` is the built-in `html-viewer` (`src/apps/html-viewer/manifest.ts`), and it claims **only** `text/html` (`default:true`, `paramShape:{url:"raw", title:"basename"}`). Nothing declares `text/markdown` or `text/plain`. So with `default:true` on the two new entries, `resolveSelected` (no prior selection → the `default:true` render-capable candidate) makes the Editor the double-click handler for both, uncontested.
- **Decision.** Declare `text/markdown` and `text/plain` with `{ capabilities:["render","edit"], label:"Editor", default:true }`. Add **no `paramShape`**: an iframe app's `src` is always its own `manifest.url`, so the OS never supplies a `url` (`paramShape.url:"raw"` is for built-in component handlers only — see the `AppFileHandlerDeclaration` doc and `withFileParams`), and the app already derives the basename from the path (`launch.ts`/`openFile`), making `title:"basename"` redundant.
- **Consequences.** SC-011 holds: double-click `.md`/`.txt` → Editor, no manual "Open with"; "Open with Editor" present for all three types. The existing `text/html` entry is left as-is (its `paramShape.title` is harmless/redundant; not churned). If a user later re-points a type elsewhere via the "Open with" always-use behavior, that per-type selection overrides `default` (spec 036) — intended.

---

## 7. Risks / open questions

1. **GFM table inside a list (US10.4) — the hardest sub-case.** The existing list model emits one `<li>` per line and doesn't buffer multi-line list items; folding an indented table into the *current* `<li>` requires a small change to when the list flushes. **Mitigation/verify:** e2e-assert a table nested in a list item renders inside that item (SC-012). The standalone and paragraph-adjacent cases are low-risk. *This is the #1 thing to validate during implementation.*
2. **Cell rendering nuances (US10.3).** Escaped pipe `\|` must not split a column; inline markdown (bold/code/link) in a cell renders via `renderInline`; a literal `<br>` in a cell must become a real break (since `renderInline` otherwise escapes `<`). All three need explicit e2e assertions (SC-012 "0 such tables render as literal pipe text").
3. **fenced_div attribute parsing robustness.** We need `custom-style="Name"` and `.Name`; a full pandoc attr list `{#id .class key="value"}` must be tolerated (parse the two we care about, ignore the rest, never crash). Unknown keys/odd spacing should degrade to "no recognized name" → neutral, not an error. *Verify:* a `::: {.Note}` matches the same style as `::: {custom-style="Note"}` (US11.2).
4. **Unknown-name fallback (US11.3).** `effectiveCss` must always return a CSS string (the neutral one) so the container is never empty and `renderMarkdown` never throws. The e2e "RuleBox → neutral, content preserved" assertion is the acceptance proof.
5. **CSS-attribute escaping (ADR-3).** User-authored CSS is embedded in a `style=""` attribute; escape `"`/`&`/`<`. A pathological value must not break out of the attribute or the surrounding markup. *Low* risk given CSS-not-HTML, but unit-test the escaper.
6. **Preview reactivity to style edits.** Saving a style in Settings must re-render an open preview (FR-029 "immediately on save"). Relies on `customStylesVersion` being in the preview memo's deps — confirm the wiring in implementation (the one subtle React dependency in v3).
7. **`paramShape` doc drift (minor).** The installed `app.json`'s `text/html` entry has `paramShape:{title:"basename"}` while `docs/dev/Editor/file-handling.md` says `paramShape` is "intentionally absent." Not functionally significant (the basename is derived from the path regardless). The v3 doc update should align the example with the new md/txt entries (no `paramShape`) and can note the html entry's `paramShape.title` as redundant-but-present.
8. **Storage revocation.** If `storage` is revoked, built-ins still render; user styles don't persist (spec edge case). `services/bos.ts` already handles the fallback — confirm the Custom Styles panel shows styles correctly when persistence is off (it edits in-memory; the "persists across restarts" claim is simply absent). No blocking decision.

No open question blocks `plan` — #1 and #2 are the implementation-time validations to carry into `tasks`/`quickstart`.

---

## 8. UI mockup reference

**Path:** `item-agentic-text-editor/mockup.html` (v3). It is the **binding contract** for the Settings "Custom Styles" surface. Its two pages map onto the design as follows:

| Mockup element | Maps to |
|---|---|
| Settings modal, **tabbed**: `Appearance` ‖ `Custom Styles` (new-dot on the latter) | `settings-panel.tsx` (ADR-4): the two-tab restructure; Appearance = existing fields verbatim |
| Custom Styles header ("Define named styles used by pandoc fenced divs…") + **Add style** button | `custom-styles-panel.tsx` list view |
| **Built-in styles** group (lock; "can't be removed, but their CSS can be overridden") | `style-list.tsx` → `style-row.tsx` (built-in branch; lock glyph, no trash) |
| **Your styles** group ("add, edit, and remove freely") + dashed empty-state | `style-list.tsx` → `style-row.tsx` (user branch) + `style-list.tsx` empty-state |
| Style row: **swatch** (mini CSS box, padding stripped) · name · pill (`built-in`/`modified`/`user`) · actions (pencil; trash+confirm-strip; lock) | `style-row.tsx` (swatch via the `swatchStyle` pattern; confirm-strip = list-level remove confirm) |
| Editor view: **name** (disabled for built-ins) + **CSS** textarea ("no surrounding braces") + **Remove style** / **Reset to default** / **Done** | `style-editor.tsx` (built-in read-only note; Reset enabled only when modified) |
| **Live preview column**: fenced-div source + box styled with current CSS (updates as you type) + divider + permanent **neutral fallback** box | `style-preview.tsx` (`boxStyle`: base + current CSS; the fallback box is the `effectiveCss` else-branch) |
| Page 2 "Result in a document": Note/Warning (built-in), PinkBox (user), RuleBox (unknown → neutral), the syntax in a code block, footnote on edit-mode raw source + nesting + "a `:::` in a ``` block is literal" | Acceptance proof for FR-027/FR-028 (SC-012/SC-013) and the renderer notes in `docs/dev/Editor/markdown-rendering.md` |

The mockup's CSS (`.style-row`, `.cs-*`, `.cs-box.neutral`, `.boxStyle`/`swatchStyle`) is the visual target, translated into the item's `ate-*` classes in `styles.css` — the same mockup-to-app mapping v1/v2 used with `ui-mockup.html`.
