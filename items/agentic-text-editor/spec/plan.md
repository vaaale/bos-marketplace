# Implementation Plan: Agentic Text Editor — v3 (File Handlers · GFM Tables · Pandoc Fenced-Div Custom Styles)

**Branch**: `bos/editor-md-handlers-custom` | **Date**: 2026-09-11 | **Spec**: `item-agentic-text-editor/spec.md` | **Design**: `item-agentic-text-editor/design.md` (v3)

**Input**: Feature specification (v3 scope: FR-026 → FR-029 / US9 → US11 / SC-011 → SC-013) + the reviewed v3 `design.md`.

> **Baseline note**: v1 (document tabs, embedded chat, `agentic_editor_*` surface tools) and v2 (agent/conversation management, full tool-call visibility) are installed and working. This plan covers **only the v3 delta**. The v1 file tree, format registry, `file-service`, v2's `assistant/` + chat components, and `services/launch.ts` / `main.tsx` launch effect are **unchanged** unless explicitly listed.

## Summary

v3 adds three orthogonal capabilities to the installed Agentic Text Editor marketplace app:

1. **File-handler registration (FR-026 / US9)** — the Editor declares `text/markdown` and `text/plain` in its `app.json` `fileHandlers` (with `default: true`), so double-clicking a `.md`/`.txt` file in the Files app opens the Editor directly, and "Open with Editor" appears for `.md`/`.txt`/`.html`. Pure manifest edit — no launch-code change (the existing `launch.ts` + `main.tsx` effect already handles `{path, action}`).

2. **GFM table rendering (FR-027 / US10)** — a table recognizer is added to the hand-rolled `formats/markdown.ts` string builder (after the existing fenced-code check). GFM pipe tables render as `<table>`/`<thead>`/`<tbody>` with alignment, escaped pipes, inline markdown in cells, and list nesting.

3. **Pandoc fenced-div custom styles (FR-028 / FR-029 / US11)** — a `fenced_div` recognizer in `markdown.ts` + a **style registry** (`config/custom-styles.ts`: built-in Note/Info/Warning/Tip in code, user styles + built-in overrides persisted to the app KV store, `effectiveCss(name)` resolution, unknown → neutral fallback). The Settings panel gains a **Custom Styles** tab (mockup.html is the binding UI contract).

**Key architectural property** (from design.md §0/ADR-1): the renderer is a hand-rolled, dependency-free CommonMark-subset string builder — **not** `react-markdown`/`remark`/`unified`. v3 extends that parser with two bounded block passes rather than introducing new dependencies. No BOS source change, no new capability, no new service facet.

## Technical Context

**Language/Version**: TypeScript 5.x, React 18 (marketplace app IIFE bundle)

**Primary Dependencies**:
- `window.__bos.storage.get/set` — app-scoped KV store (`data/app-storage/agentic-text-editor.json`) — now also holds the style registry
- `window.__bos.fs.read` — read document files (v1, unchanged)
- `window.__bos.assistant` broker (v2, unchanged)
- zustand (state), lucide-react (icons) — same as v1/v2
- **No new npm packages** — v3 extends the existing hand-rolled parser; no `remark-gfm`/`remark-directive`/`unified`

**Storage**:
- Style registry (user styles + built-in CSS overrides) → app KV store, key `agentic-text-editor.custom-styles`
- Editor appearance settings → app KV store (v1, unchanged)
- Conversation index → app KV store (v2, unchanged)
- Document buffers → in-memory (v1, unchanged)

**Testing**: Extend `e2e/agentic-text-editor.spec.ts` with v3 scenarios:
- US9: double-click `.md` → Editor opens in Preview; double-click `.txt` → Editor opens in Edit; "Open with Editor" appears for `.md`/`.txt`/`.html`
- US10: GFM table with header/body; aligned table (`:---`/`:---:`/`---:`); escaped pipe (`\|`); inline markdown in cell; table nested in list item (the hardest sub-case)
- US11: `::: {custom-style="Note"}` renders built-in Note style; `::: {.Note}` class form; `::: {custom-style="RuleBox"}` (unknown) → neutral container, content preserved; nested fenced divs; user-defined style from Settings renders + persists; `:::` inside a fenced code block is literal

**Target Platform**: BrowserOS marketplace app — sandboxed-iframe IIFE (separate JS context; no `@/` imports)

**Project Type**: Marketplace app (not built-in)

**Performance Goals**:
- File-handler registration is boot-time (BOS registry) — no runtime cost in the item
- Table + fenced_div recognition is O(n) over document lines (same as the existing parser)
- Style registry load is a single KV-store read at `hydrate()`; `effectiveCss` is an O(1) map lookup per fenced div
- Settings Custom Styles live preview updates on keystroke (in-memory, no network)

**Constraints**:
- IIFE bundle: no `@/` BOS module imports; no new npm packages
- BOS dark-only opacity palette, `ate-*` CSS classes
- `renderMarkdown` output is always escaped HTML safe to inject (existing invariant, preserved)
- `FormatHandler.render(): string` contract unchanged
- `storage` capability already declared — no capability change needed
- Built-in style names (Note/Info/Warning/Tip) are not removable; CSS is overridable

**Scale/Scope**: Single app window. Unlimited tabs. Style registry is small (4 built-ins + user styles). Document sizes are typical user files (not 100MB).

## Constitution Check

*GATE: Must pass before implementation. Re-check after implementation.*

- **Dark-only theme**: All new UI (Custom Styles tab, swatch rows, style editor, live preview) uses the BOS opacity palette. Violet accent for active/selected states. No light mode. ✓
- **Marketplace app anatomy**: New files live under `app/src/`. `app.json` is the only manifest change (adding two `fileHandlers` entries). No `services/` facet. ✓
- **No external UI libraries**: Custom Styles UI is hand-rolled (consistent with v1/v2). Only lucide-react for icons. ✓
- **SSR/hydration**: New components are `"use client"`. No client-only initial state that would break hydration. ✓
- **OS state via selectors**: Style registry uses `window.__bos.storage` (the sanctioned per-app KV channel). ✓
- **Tool registration**: No new `agentic_editor_*` tools in v3. ✓
- **Config namespace**: Style registry is app-scoped (KV store), not a global config namespace. ✓
- **No BOS source change**: All required mechanisms (036 registry, `withFileParams`, storage broker, format-registry contract) already exist. ✓
- **Dependency-free IIFE**: v3 adds no new npm packages (ADR-1). ✓

**No violations. No Complexity Tracking entry required.**

## Project Structure

### Documentation (this feature)

```text
item-agentic-text-editor/
├── spec.md              # Feature specification (v3 scope added)
├── plan.md              # This file (v3 plan)
├── design.md            # Architecture design (v3)
├── tasks.md             # Task list (v3 delta — generated next)
├── mockup.html          # Interactive HTML mockup (v3 Custom Styles UI + document proof)
├── ui-mockup.html       # Interactive HTML mockup (v2 two-pane editor + chat — unchanged)
├── quickstart.md        # Validation guide (v1 + v2 + v3)
└── test-results.md      # e2e results
```

### Source Code — v3 delta (marketplace item)

All paths are under the item root (`data/user-apps/items/agentic-text-editor/`). The `app/` facet is the esbuild IIFE project.

```text
app/
├── app.json                              # MODIFY — add text/markdown + text/plain fileHandlers (default:true)
├── src/
│   ├── config/
│   │   └── custom-styles.ts             # NEW — BUILTIN_STYLES, NEUTRAL_STYLE, STYLE_KEY,
│   │                                    #       load/save, effectiveCss(name), module-level cache
│   ├── services/formats/
│   │   └── markdown.ts                  # MODIFY — GFM-table block + fenced_div block in renderMarkdown
│   ├── state/
│   │   └── document-store.ts            # MODIFY — load registry in hydrate(); CRUD actions;
│   │                                    #       customStylesVersion for preview reactivity
│   ├── components/
│   │   ├── settings-panel.tsx           # MODIFY — single-scroll dialog → Appearance / Custom Styles tabs
│   │   └── settings/                    # NEW — Custom Styles surface (mockup.html is the contract)
│   │       ├── custom-styles-panel.tsx  #   list-view ↔ editor-view swap
│   │       ├── style-list.tsx           #   built-in group + user group
│   │       ├── style-row.tsx            #   swatch + name + pill + actions
│   │       ├── style-editor.tsx         #   name input + CSS textarea + form actions
│   │       └── style-preview.tsx        #   live-preview box + neutral fallback box
│   ├── styles.css                       # MODIFY — table / callout / custom-styles UI (ate-* classes)
│   └── types.ts                         # MODIFY — NamedStyle + CustomStylesPersistence
└── docs/
    ├── usage/Editor/editor.md           # MODIFY — .md/.txt opening + custom styles usage section
    └── dev/Editor/
        ├── file-handling.md             # MODIFY — manifest example now lists md/txt; fix HTML-only prose
        └── markdown-rendering.md        # NEW — table + fenced_div parsing + style-registry architecture
```

**Structure Decision**: All v3 code is additive or a targeted modification of existing modules. `config/custom-styles.ts` is the single source of truth for the style registry (mirrors `config/editor-config.ts`). `formats/markdown.ts` is the single source of truth for the preview renderer (its two new block passes are the only rendering change). The `settings/` subdirectory encapsulates the Custom Styles surface so `settings-panel.tsx` stays a thin tab container.

## Design Notes

> Full architectural detail, ADRs, integration points, and risk analysis live in `design.md`. The notes below capture the decisions that drive task breakdown.

### ADR-1 — Extend the hand-rolled parser; do NOT introduce remark/unified

The spec's mechanism assumption (remark-gfm + remark-directive) was explicitly flagged "confirm against the actual stack." The design confirmed the renderer is a dependency-free string builder, so v3 extends it with two bounded block passes (GFM table + fenced_div). The `render(): string` contract and the "output is always safe to inject" invariant are preserved. A future swap to a real `react-markdown` pipeline remains a one-module change.

**Implication for tasks**: The two new recognizers are the core implementation work. All other v3 changes (manifest, registry, settings UI) are independent of which parser is used.

### ADR-2 — Style registry: built-ins in code + user styles & overrides in KV store

Two maps — `user` (freely add/remove/rename) and `overrides` (built-in name→css, CSS-only) — persisted under `STYLE_KEY` as `{ version, user, overrides }`, merged over the code-shipped `BUILTIN_STYLES`. `effectiveCss(name)`: built-in → `overrides[name] ?? BUILTIN_STYLES[name].css`; else → `user[name]`; else → `NEUTRAL`. The mockup's every affordance (modified pill, Reset to default, neutral fallback) falls out directly from this one function.

### ADR-3 — Inline `style` attribute on the fenced-div container

The renderer produces an HTML string; CSS reaches the container via an inline `style="…"` attribute (the mockup's `boxStyle` pattern: neutral base prepended, user declarations appended so they win). Dependency-free, per-node, trivially correct for nesting. User CSS is escaped (`"`/`&`/`<`) when embedded — CSS is not HTML, so no markup-injection surface.

### ADR-4 — Settings becomes two tabs (Appearance / Custom Styles)

The v3 mockup is a tabbed modal. The existing single-scroll Appearance content moves verbatim into the Appearance tab (no behavior change). The Custom Styles tab is the new surface. This is the only change to the existing settings surface.

### ADR-5 — `default:true` for `text/markdown` + `text/plain`; no `paramShape`

The only other installed app declaring `fileHandlers` is the built-in `html-viewer` (claims `text/html` only). With `default:true` on the two new entries, the Editor becomes the uncontested double-click handler for both. No `paramShape` — an iframe app's `src` is always its own `manifest.url`; the OS never supplies a `url`. The existing `text/html` entry is left as-is.

### File-handler launch path (FR-026) — already built, reused as-is

`IframeApp.withFileParams` appends `bosFilePath`/`bosFileAction` to the iframe URL → `services/launch.ts` parses `{path, action}` at import time → `main.tsx`'s launch effect (gated on hydration) reads the file via `fs.read` and sets view mode: **Preview** for previewable formats (`.md` → markdown, `supportsPreview: true`), **Edit** otherwise (`.txt` → plaintext, `supportsPreview: false`). No launch code changes needed.

### Style registry reactivity (FR-029)

`document-store.ts` loads the registry in `hydrate()` and bumps `customStylesVersion` on every style CRUD. `PreviewView` includes `customStylesVersion` in its render `useMemo` deps, so saving a style in Settings re-renders any open preview immediately.

### Graceful degradation

If `storage` is revoked, `services/bos.ts` `storageGet`/`storageSet` fall back to localStorage/no-op. Built-in styles are in code, so they always render; user styles simply don't persist across restarts. Nothing throws.

## Complexity Tracking

No complexity violations. v3 is an additive delta to an existing single marketplace app — no new facets, no BOS source changes, no new dependencies.
