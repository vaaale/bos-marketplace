# Tasks: Agentic Text Editor — v3 (File Handlers · GFM Tables · Pandoc Fenced-Div Custom Styles)

**Input**: spec.md (v3 scope), plan.md, design.md, mockup.html (UI contract)

**Prerequisites**: v2 code (T053–T092) is installed and working. Tasks below are the **v3 delta only**, numbered T093+.

**Tests**: Full Playwright e2e in `e2e/agentic-text-editor.spec.ts` (extended for v3). The e2e tests mock the broker (`window.__bos.*`) and use pre-seeded document content — no real LLM runs.

## Format: `[ID] [P?] [Story] Description`

- **[P]**: Can run in parallel (different files, no dependencies)
- **[Story]**: Which user story this task belongs to
- Include exact file paths in descriptions

---

## Phase 93: v3 Setup (Shared Infrastructure)

**Purpose**: Types and the style-registry module — the foundation US11 depends on. US9 (file handlers) and US10 (tables) have no dependency on this phase and can start immediately.

- [ ] T093 [P] Add v3 types to `app/src/types.ts`: `NamedStyle { name: string, css: string, builtin: boolean }`, `CustomStylesPersistence { version: 1, user: Record<string, string>, overrides: Record<string, string> }`
- [ ] T094 [P] Create `app/src/config/custom-styles.ts` — the style registry module. Exports: `BUILTIN_STYLES` (Note/Info/Warning/Tip, each `{ name, css, builtin: true }`), `NEUTRAL_STYLE` (`{ name: "__neutral__", css: "…", builtin: false }`), `STYLE_KEY = "agentic-text-editor.custom-styles"`, `loadCustomStyles(): CustomStylesPersistence` (reads KV store via `window.__bos.storage.get`, merges with built-ins, caches module-level), `saveCustomStyles(next: CustomStylesPersistence): void` (writes KV store, updates cache), `effectiveCss(name: string): string` (resolution order: built-in override → built-in default → user style → neutral). Also exports `getBuiltinNames(): string[]` and `getUserStyles(): Record<string,string>` for the Settings UI. Mirrors the structure of `app/src/config/editor-config.ts`.

**Checkpoint**: Style registry available — US11 can proceed

---

## Phase 94: User Story 9 — File Handler Registration (Priority: P1)

**Goal**: The Editor is the double-click (selected) handler for `text/markdown` and `text/plain`. "Open with Editor" appears for `.md`/`.txt`/`.html`.

**Independent Test**: In the Files app, double-click a `.md` file → Editor opens in Preview mode; double-click a `.txt` file → Editor opens in Edit mode; right-click any of the three → "Open with Editor" is present.

### Tests for User Story 9 ⚠️

- [ ] T095 [P] [US9] E2E test: "double-click .md opens Editor in preview mode" — seed a `.md` file in the VFS, simulate double-click in the Files app, assert the Editor iframe launches with `bosFilePath` param set, and the document opens in Preview mode (not Edit)
- [ ] T096 [P] [US9] E2E test: "double-click .txt opens Editor in edit mode" — seed a `.txt` file, simulate double-click, assert the Editor launches and the document opens in Edit mode
- [ ] T097 [P] [US9] E2E test: "Open with Editor appears in right-click context menu" — right-click a `.md` file, assert the context menu contains an "Open with Editor" entry; right-click a `.txt` file, assert same; right-click an `.html` file, assert same
- [ ] T098 [P] [US9] E2E test: "Editor is the selected (default) handler for text/markdown" — call `GET /api/file-handlers?mime=text/markdown` (or assert via the Files app state), assert `selected === "agentic-text-editor"`
- [ ] T099 [P] [US9] E2E test: "Editor is the selected (default) handler for text/plain" — same assertion for `text/plain`

### Implementation for User Story 9

- [ ] T100 [US9] Modify `app/app.json` — add two entries to the `fileHandlers` array: `{ "type": "text/markdown", "capabilities": ["render", "edit"], "label": "Editor", "default": true }` and `{ "type": "text/plain", "capabilities": ["render", "edit"], "label": "Editor", "default": true }`. The existing `text/html` entry is left unchanged. No `paramShape` (iframe apps don't receive a URL from the OS).

**Checkpoint**: File handler registration complete — US9 independently testable

---

## Phase 95: User Story 10 — GFM Table Rendering (Priority: P1)

**Goal**: GFM pipe tables render as proper `<table>`/`<thead>`/`<tbody>` with alignment, escaped pipes, inline markdown in cells, and list nesting. Edit mode shows raw source unmodified.

**Independent Test**: Open a `.md` file containing: a basic table, an aligned table, a table with an escaped pipe, a table with inline markdown in cells, a table nested in a list → preview → verify each renders correctly.

### Tests for User Story 10 ⚠️

- [ ] T101 [P] [US10] E2E test: "basic GFM table renders as table element" — seed a `.md` file with a 3-column, 2-row table (header + 2 body rows), open in preview, assert a `<table>` element exists with a `<thead>` containing 3 `<th>` cells and a `<tbody>` containing 2 `<tr>` rows of `<td>` cells, and assert the cell text matches the source
- [ ] T102 [P] [US10] E2E test: "aligned table cells have text-align styles" — seed a table with delimiter row `| :--- | :---: | ---: |`, assert the first column cells have `style="text-align:left"`, second column `text-align:center`, third `text-align:right`
- [ ] T103 [P] [US10] E2E test: "escaped pipe renders as literal pipe" — seed a table cell containing `a \| b`, assert the rendered cell text is `a | b` (not split into two cells)
- [ ] T104 [P] [US10] E2E test: "inline markdown in table cell renders" — seed a table cell containing `**bold** and \`code\` and [link](url)`, assert the rendered cell contains `<strong>bold</strong>`, `<code>code</code>`, and `<a href="url">link</a>`
- [ ] T105 [P] [US10] E2E test: "table nested in list item renders inside the li" — seed a markdown document with a list item containing an indented table, assert the `<table>` is a child of the `<li>` element (not a sibling)
- [ ] T106 [P] [US10] E2E test: "table adjacent to paragraph renders correctly" — seed a paragraph immediately followed by a table (no blank line between), assert both the paragraph and the table render as separate elements
- [ ] T107 [P] [US10] E2E test: "edit mode shows raw table source" — open a document with a table in Edit mode, assert the textarea contains the literal pipe characters (not rendered HTML)
- [ ] T108 [P] [US10] E2E test: "pipe characters inside a fenced code block are literal" — seed a fenced code block containing `| a | b |`, assert the code block renders as `<pre><code>| a | b |</code></pre>` (not as a table)

### Implementation for User Story 10

- [ ] T109 [US10] Add GFM table recognizer to `app/src/services/formats/markdown.ts` — in the `renderMarkdown` line-loop, after the existing fenced-code check (which must remain first), add a table detection block: (1) a line containing an unescaped `|` is a table header candidate; (2) the next line must match the delimiter pattern (`/^\|?\s*:?-+(:?\s*\|)*\s*:?-+\s*\|?\s*$/` with alignment colons); (3) if both match, consume the header row, the delimiter row (parsing per-column alignment: `:---` left, `:---:` center, `---:` right), and subsequent body rows until a non-pipe or blank line; (4) emit `<table><thead><tr><th>` for header cells and `<tbody><tr><td>` for body cells, applying `style="text-align:…"` per column alignment; (5) split cells on unescaped pipes only (`\|` → literal `|`, does not split); (6) run each cell's text through `renderInline` for inline markdown; (7) for tables inside an open list, emit inside the current `<li>` rather than starting a new one (the non-trivial sub-case — see design.md §7 risk #1); (8) flush any open paragraph/list/quote before a standalone table (the existing `flushAll`).
- [ ] T110 [P] [US10] Add table styles to `app/src/styles.css` — `.ate-preview table` (full-width, border-collapse, margin), `.ate-preview th` (background, border, padding, font-weight), `.ate-preview td` (border, padding), `.ate-preview thead tr` (top/bottom border accent)

**Checkpoint**: GFM tables render correctly — US10 independently testable

---

## Phase 96: User Story 11 — Fenced-Div Custom Styles: Renderer (Priority: P1)

**Goal**: `::: {custom-style="Name"} … :::` and `::: {.Name} … :::` render as styled containers from the style registry. Nested fenced divs work. Unknown names → neutral container. `:::` inside code blocks is literal.

**Independent Test**: Open a `.md` file containing `::: {custom-style="Note"} text :::` → preview shows a styled box. `::: {custom-style="RuleBox"} text :::` (unknown) → neutral box. `::: {custom-style="A"} ::: {.B} text ::: :::` → nested boxes.

### Tests for User Story 11 (renderer) ⚠️

- [ ] T111 [P] [US11] E2E test: "fenced div with built-in custom-style renders styled container" — seed `::: {custom-style="Note"} Hello :::\n:::`, open in preview, assert a `<div class="custom-style custom-style--Note" data-style="Note">` exists with non-empty inline `style` attribute, and the text "Hello" is inside it
- [ ] T112 [P] [US11] E2E test: "fenced div with class form renders same style" — seed `::: {.Note} Hello :::`, assert the same `custom-style--Note` class and style as T111
- [ ] T113 [P] [US11] E2E test: "unknown style name renders neutral container" — seed `::: {custom-style="RuleBox"} Content here :::`, assert a `<div class="custom-style custom-style--RuleBox" data-style="RuleBox">` exists, its inline style matches the neutral fallback CSS, and "Content here" is inside it
- [ ] T114 [P] [US11] E2E test: "nested fenced divs render both containers" — seed `::: {custom-style="Note"} Outer ::: {.Warning} Inner ::: Outer tail :::` (properly nested), assert the outer div contains the inner div, both have their respective `custom-style--*` classes, and "Inner" is inside the inner div
- [ ] T115 [P] [US11] E2E test: "user-defined style from registry renders" — seed the KV store with a user style `PinkBox: "background: #fce7f3; border: 1px solid #f9a8d4;"`, seed `::: {custom-style="PinkBox"} text :::` in the document, assert the rendered div's inline style contains `background: #fce7f3`
- [ ] T116 [P] [US11] E2E test: "fenced div delimiter inside code block is literal" — seed a fenced code block containing `::: {custom-style="Note"} not a div :::` as code, assert the code block renders as `<pre><code>` with the literal `:::` text (not as a styled div)
- [ ] T117 [P] [US11] E2E test: "edit mode shows raw fenced-div source" — open a document with `::: {custom-style="Note"} … :::` in Edit mode, assert the textarea shows the literal `:::` syntax
- [ ] T118 [P] [US11] Unit test: `effectiveCss("Note")` returns the built-in Note CSS; `effectiveCss("RuleBox")` returns the neutral CSS; `effectiveCss("PinkBox")` (after seeding user styles) returns the user CSS; `effectiveCss("Note")` (after seeding an override) returns the override CSS

### Implementation for User Story 11 (renderer)

- [ ] T119 [US11] Add fenced_div recognizer to `app/src/services/formats/markdown.ts` — in the `renderMarkdown` line-loop, after the fenced-code check and the table check (order: code → table → fenced_div), add: (1) detect an opening line matching `/^:::\s*\{(.+)\}\s*$/` — parse the attribute list to extract the style name (from `custom-style="Name"` or `.Name` class; full pandoc attr lists are tolerated, unknown keys ignored); (2) collect inner lines until the matching closing `/^:::\s*$/` line; (3) recursively call `renderMarkdown(innerText)` to render the inner content (nesting is free); (4) resolve the style via `effectiveCss(name)` from `config/custom-styles.ts`; (5) emit `<div class="custom-style custom-style--<sanitizedName>" data-style="<rawName>" style="<escapedCss>"><innerHtml></div>`; (6) escape `"`/`&`/`<` in the CSS value before embedding it in the `style` attribute (ADR-3); (7) the name in the class attribute is sanitized to alphanumeric + `-`/`_`; `data-style` carries the raw name.
- [ ] T120 [P] [US11] Add fenced_div container base styles to `app/src/styles.css` — `.custom-style` (margin, border-radius, overflow) and `.ate-preview .custom-style` (inherited typography)

**Checkpoint**: Fenced-div rendering works — US11 renderer independently testable

---

## Phase 97: User Story 11 — Custom Styles Settings UI (Priority: P1)

**Goal**: The Settings panel has a "Custom Styles" tab where the user can view, add, edit, remove, and override named styles. Live preview updates on keystroke. Built-in styles are not removable but CSS-overridable.

**Independent Test**: Open Settings → Custom Styles tab → see built-in group (Note/Info/Warning/Tip with lock icons) and user group → click "Add style" → enter name + CSS → live preview updates → Done → style appears in user group → edit it → persists across restart.

### Tests for User Story 11 (settings UI) ⚠️

- [ ] T121 [P] [US11] E2E test: "Settings opens with Appearance and Custom Styles tabs" — open Settings, assert two tabs are visible: "Appearance" and "Custom Styles"; assert Appearance is the default active tab
- [ ] T122 [P] [US11] E2E test: "Appearance tab shows existing settings unchanged" — click Appearance tab, assert font family/size/colour fields are present (regression check)
- [ ] T123 [P] [US11] E2E test: "Custom Styles tab shows built-in group" — click Custom Styles tab, assert a "Built-in styles" section header is visible, and four rows are present (Note, Info, Warning, Tip), each with a lock icon (no trash icon)
- [ ] T124 [P] [US11] E2E test: "Custom Styles tab shows user group" — assert a "Your styles" section header is visible below the built-in group; if no user styles exist, a dashed empty-state is shown
- [ ] T125 [P] [US11] E2E test: "Add style creates a new user style" — click "Add style", enter name "PinkBox" and CSS "background: #fce7f3;", click Done, assert "PinkBox" appears in the Your styles group with a swatch and "user" pill
- [ ] T126 [P] [US11] E2E test: "Editing a user style's CSS updates the live preview" — open a user style for editing, type new CSS into the textarea, assert the live preview box in the editor view updates its appearance on each keystroke (or on debounce)
- [ ] T127 [P] [US11] E2E test: "Overriding a built-in style shows modified pill" — open built-in "Note" for editing, change its CSS, click Done, assert the Note row now shows a "modified" pill (not "built-in")
- [ ] T128 [P] [US11] E2E test: "Reset to default removes the override" — open a modified built-in style, click "Reset to default", assert the style's CSS reverts to the built-in default and the pill changes back to "built-in"
- [ ] T129 [P] [US11] E2E test: "Removing a user style removes it from the list" — open a user style, click Remove, confirm the inline confirm-strip, assert the style is gone from the list
- [ ] T130 [P] [US11] E2E test: "User styles persist across app restart" — add a user style, close and reopen the app, open Settings → Custom Styles, assert the user style is still present with its CSS
- [ ] T131 [P] [US11] E2E test: "Saving a style in Settings re-renders an open preview immediately" — open a `.md` file with `::: {custom-style="PinkBox"} text :::` in preview, open Settings → Custom Styles, edit PinkBox's CSS, assert the preview's PinkBox box updates its appearance without reloading the document

### Implementation for User Story 11 (settings UI)

- [ ] T132 [US11] Modify `app/src/components/settings-panel.tsx` — convert the single-scroll dialog into a two-tab layout: **Appearance** (existing Typography + Colours content, moved verbatim) and **Custom Styles** (renders `<CustomStylesPanel />`). Tab styling per mockup (pill-shaped, violet active indicator). The "Reset to defaults" button in Appearance stays. No behavior change to existing settings.
- [ ] T133 [US11] Create `app/src/components/settings/custom-styles-panel.tsx` — the Custom Styles tab content. Manages two views: **list view** (default) and **editor view** (when editing a style). Props: `onEditStyle(name: string)`, `onCreateStyle()`. Renders `<StyleList />` in list view; `<StyleEditor />` + `<StylePreview />` in editor view. The "Add style" button in the list-view header triggers `onCreateStyle()` (creates an in-memory draft, switches to editor view).
- [ ] T134 [US11] Create `app/src/components/settings/style-list.tsx` — renders two groups: **Built-in styles** (from `getBuiltinNames()`, each row with lock icon, no remove) and **Your styles** (from `getUserStyles()`, each row with remove; dashed empty-state when none). Each row is a `<StyleRow />`.
- [ ] T135 [US11] Create `app/src/components/settings/style-row.tsx` — one style row: a swatch (a small `<div>` styled with `effectiveCss(name)` via the `boxStyle` pattern — neutral base prepended, user CSS appended, padding stripped for the 56×34 box), the style name, a pill (`built-in` / `modified` / `user` — "modified" when `overrides[name] != null`), and action buttons (pencil/edit for all; trash/remove for user styles only, with an inline confirm-strip; lock icon for built-ins). Props: `name`, `css`, `builtin`, `modified`, `onEdit`, `onRemove?`.
- [ ] T136 [US11] Create `app/src/components/settings/style-editor.tsx` — the editor view form: a **name** input (disabled/readonly for built-ins, editable for user styles and new styles), a **CSS** textarea (placeholder: "background: #dbeafe; border: 1px solid #93c5fd; padding: 10px 14px; border-radius: 6px;", helper text "Declaration block — no surrounding braces"), and form actions: **Remove style** (user only), **Reset to default** (built-in only, enabled only when modified), **Done** (saves + returns to list view). Props: `name`, `css`, `builtin`, `modified`, `onSave(name, css)`, `onRemove(name)`, `onReset(name)`, `onDone()`.
- [ ] T137 [US11] Create `app/src/components/settings/style-preview.tsx` — the live-preview column beside the editor: shows the fenced-div source code (`::: {custom-style="<Name>"} Sample text :::`) in a monospace block, then a preview box styled with the **current** CSS (updated on every keystroke from the textarea via the parent's state), then a divider, then a permanent **neutral fallback** box (labelled "Unknown style name → neutral container"). The preview box uses the `boxStyle` pattern (neutral base + current CSS). Props: `name`, `css`.
- [ ] T138 [US11] Add Custom Styles UI styles to `app/src/styles.css` — the `ate-*` classes for: tab bar, style groups (headers + dividers), style rows (swatch, name, pill, actions), the inline confirm-strip, the editor form (name input, CSS textarea, action buttons), the live preview column, and the neutral fallback box. Translated from the mockup's `.style-row`/`.cs-*`/`.boxStyle`/`swatchStyle` CSS.
- [ ] T139 [US11] Modify `app/src/state/document-store.ts` — in `hydrate()`, call `loadCustomStyles()` from `config/custom-styles.ts` and store the result. Add CRUD actions: `addStyle(name, css)`, `updateStyle(name, css)`, `removeStyle(name)`, `overrideBuiltIn(name, css)`, `resetBuiltIn(name)`. Each action calls `saveCustomStyles()` to persist and bumps a `customStylesVersion` counter (a `number` in the store state, incremented by 1 on each call).
- [ ] T140 [US11] Wire `customStylesVersion` into `PreviewView` — in `app/src/components/editor/preview-view.tsx`, read `customStylesVersion` from the document store and include it in the render `useMemo` dependency array, so saving a style in Settings triggers a re-render of any open preview (FR-029 "immediately on save").

**Checkpoint**: Custom Styles settings UI complete — US11 fully testable

---

## Phase 98: E2E Test Suite — v3 Full Coverage

**Purpose**: The complete e2e test file covers all v3 user stories end-to-end, including cross-cutting scenarios and regression checks.

- [ ] T141 Create `e2e/v3.spec.ts` (dedicated v3 suite) covering:
  1. **Shell integrity (regression)**: app renders two-pane layout, chat header intact (agent selector + conversation selector), Settings opens
  2. **US9 — File handlers**: `.md` → Editor Preview; `.txt` → Editor Edit; context menu "Open with Editor" for all three types; default handler assertion
  3. **US10 — GFM tables**: basic table, aligned table, escaped pipe, inline markdown in cell, table-in-list, table-adjacent-to-paragraph, edit-mode raw source, pipe-in-code-block literal
  4. **US11 — Fenced divs**: built-in custom-style, class form, unknown → neutral, nested, user-defined, `:::` in code block literal, edit-mode raw source
  5. **US11 — Settings UI**: tabs, built-in group, user group, add/edit/remove/override/reset, live preview, persistence across restart, preview reactivity
  6. **Cross-cutting**: file handler + table + fenced-div combined (a `.md` file with both a table and a fenced div, opened via double-click, renders both correctly in preview)
  7. **Storage-revoked degradation**: with `storage` capability revoked, built-in styles still render; user styles don't persist (no crash)

  **Test strategy** (deterministic, no real LLM):
  - Seed document files via `window.__bos.fs.write` mock
  - Seed style registry via `window.__bos.storage.set` mock
  - Assert on rendered DOM (classes, text content, element structure, inline styles)
  - For file-handler tests: call `GET /api/file-handlers?mime=…` or assert via the Files app DOM

- [ ] T142 [P] Update `item-agentic-text-editor/quickstart.md` — add a v3 section with manual validation steps for US9/US10/US11 (file-handler double-click, table rendering, custom styles authoring + preview) and the e2e run command

**Checkpoint**: Full v3 e2e suite complete

---

## Phase 99: Docs & Polish

**Purpose**: The item's documentation reflects the v3 changes. Type safety and linting pass.

- [ ] T143 [P] Update `docs/usage/Editor/editor.md` — (a) extend the "Opening files from the Files app" section to cover `.md` (opens in Preview) and `.txt` (opens in Edit) in addition to `.html`; (b) add a new "Custom styles" section: how to author `::: {custom-style="Name"} … :::` in a document, how to manage styles in Settings → Custom Styles, the built-in styles (Note/Info/Warning/Tip), user-defined styles, the neutral fallback for unknown names, nesting, and the fact that edit mode shows raw source
- [ ] T144 [P] Update `docs/dev/Editor/file-handling.md` — update the `fileHandlers` manifest example to include `text/markdown` and `text/plain` entries (`default:true`, no `paramShape`); rewrite the paragraph that says "this item deliberately claims only HTML" → now claims specific base types (`text/html`, `text/markdown`, `text/plain`) and still not the whole `text/` family
- [ ] T145 [P] Create `docs/dev/Editor/markdown-rendering.md` — the v3 renderer architecture: the GFM-table algorithm (recognition, cell splitting, alignment, list nesting), the fenced_div parse (attribute extraction, recursion for nesting, `effectiveCss` resolution, inline style emission, fence-first ordering that keeps code-block delimiters literal), the style-registry architecture (built-ins in code, KV persistence shape, `effectiveCss` three-way resolution, `customStylesVersion` reactivity), and the design decision to extend the hand-rolled parser rather than introduce remark/unified (ADR-1). This supersedes the "swap this module for a richer renderer" note in `markdown.ts`.
- [ ] T146 [P] Run typecheck: `npx tsc --noEmit --strict --jsx react-jsx --target ES2020 --module esnext --moduleResolution bundler --skipLibCheck --lib dom,dom.iterable,esnext --types node,react,react-dom data/user-apps/items/agentic-text-editor/app/src/main.tsx` — fix all type errors
- [ ] T147 [P] Run lint: `npm run lint` in the item's staging directory — fix all lint errors
- [ ] T148 [P] Verify the app renders correctly at small (800px) and large (1920px) window sizes with the new Settings tabs and Custom Styles panel (no overflow, scroll works)

**Checkpoint**: v3 complete — docs updated, type-safe, lint-clean

---

## Dependencies & Execution Order

### Phase Dependencies

- **Phase 93 (Setup)**: No dependencies — can start immediately. T093 and T094 are [P] (different files).
- **Phase 94 (US9 File Handlers)**: **No dependency on Phase 93** — the manifest edit is independent. Can start immediately. T100 is the only implementation task; T095–T099 are all [P] (tests).
- **Phase 95 (US10 Tables)**: **No dependency on Phase 93** — the table recognizer is independent of the style registry. Can start immediately. T109 and T110 are sequential (T110 styles depend on T109's class structure). T101–T108 are all [P] (tests).
- **Phase 96 (US11 Renderer)**: **Depends on Phase 93** (T119 calls `effectiveCss` from `config/custom-styles.ts`). T119 and T120 are sequential (T120 styles depend on T119's class structure). T111–T118 are all [P] (tests).
- **Phase 97 (US11 Settings UI)**: **Depends on Phase 93** (the settings components call `effectiveCss`, `getBuiltinNames`, `getUserStyles`) and **Phase 96** (the settings UI manages the same registry the renderer reads). T132 must precede T133 (the tab container must exist before the tab content). T133–T138 are largely [P] among themselves (different component files) but all depend on T132. T139 depends on T094 (calls `loadCustomStyles`/`saveCustomStyles`). T140 depends on T139 (reads `customStylesVersion`).
- **Phase 98 (E2E Suite)**: Depends on Phases 94+95+96+97 (tests the integrated behavior).
- **Phase 99 (Docs & Polish)**: Depends on all prior phases.

### Parallel Opportunities

- **Phase 94, 95, and 93** can all start **simultaneously** (different files, no shared state)
- T095–T099 are [P] (all e2e tests)
- T101–T108 are [P] (all e2e tests)
- T111–T118 are [P] (all e2e/unit tests)
- T121–T131 are [P] (all e2e tests)
- T133–T138 are [P] among themselves (different component files, all under `settings/`)
- T143–T145 are [P] (different doc files)
- T146, T147, T148 are [P] (independent checks)

### Critical Path

```
Phase 93 (T093, T094)
    └──→ Phase 96 (T119, T120)
            └──→ Phase 97 (T132 → T133–T140)
                    └──→ Phase 98 (T141)
                            └──→ Phase 99 (T143–T148)
```

Phase 94 (US9) and Phase 95 (US10) are **off the critical path** — they can run in parallel with the above.

---

## Implementation Strategy

### Recommended Order (single developer)

1. **Phase 94** (US9) — the manifest edit is trivial; do it first to unblock file-handler e2e tests
2. **Phase 93** (Setup) — types + style registry
3. **Phase 95** (US10) — table recognizer + styles
4. **Phase 96** (US11 renderer) — fenced_div recognizer + container styles
5. **Phase 97** (US11 settings UI) — tabs + Custom Styles surface
6. **Phase 98** (E2E suite) — full v3 coverage
7. **Phase 99** (Docs & polish)

### Parallel Team Strategy

- **Developer A**: Phase 94 → 95 (file handlers + tables — independent of the style registry)
- **Developer B**: Phase 93 → 96 → 97 (style registry → fenced_div renderer → settings UI — the critical path)
- **Integration**: Phase 98 → 99 (both developers)

---

## Notes

- [P] tasks = different files, no dependencies
- [Story] label maps task to specific user story for traceability
- The e2e tests mock the broker (`window.__bos.*`) and seed document content — they do NOT drive a real LLM run
- `config/custom-styles.ts` is the single source of truth for the style registry — no other module resolves name→CSS
- `formats/markdown.ts` is the single source of truth for the preview renderer — its two new block passes (table, fenced_div) are the only rendering changes
- The fence-first ordering in `renderMarkdown` (code → table → fenced_div) is what makes "a `:::` inside a ``` fence is literal" hold by construction
- `customStylesVersion` is the single reactivity mechanism that makes Settings style edits propagate to open previews
- The `data-style` attribute on fenced-div containers carries the raw style name (for e2e assertions); the CSS class uses a sanitized name
