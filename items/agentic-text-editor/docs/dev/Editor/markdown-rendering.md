# Editor — markdown rendering: tables, fenced divs and the style registry

How the Editor item (`agentic-text-editor`) renders Markdown in preview mode,
as of v3 (FR-027/FR-028/FR-029). This page covers the renderer's architecture,
the two v3 block passes (GFM tables and pandoc fenced divs), and the
custom-style registry those fenced divs resolve against, plus the v5 Mermaid
pass. File handling and the launch contract are `file-handling.md`; the agent's five style tools over this
same registry are `agent-tools.md`; the end-user view is `docs/usage/Editor/`.

Layout of the relevant source:

```
app/src/
├── services/formats/markdown.ts    # the renderer — one module, no dependencies
├── services/mermaid.ts             # the async ```mermaid upgrade pass (v5)
├── config/custom-styles.ts         # the style registry (built-ins + KV persistence)
├── state/document-store.ts         # style CRUD actions + customStylesVersion
├── components/editor/preview-view.tsx  # injects render() output; version in memo deps
└── components/settings/            # Settings → Custom Styles surface
```

## 1. The renderer is a hand-rolled string builder — on purpose

`renderMarkdown(content)` in `services/formats/markdown.ts` is a dependency-free
CommonMark-subset **string builder**: a line loop with a paragraph/list/quote
state machine plus an escape-first `renderInline` pass. It emits an HTML string
that `preview-view.tsx` injects via `dangerouslySetInnerHTML`, under one
invariant the whole app leans on: **`render()` output is always escaped markup
the handler built itself — safe to inject by construction.**

v3 kept that architecture (design ADR-1). The spec's assumed mechanism —
`remark-gfm` + `remark-directive` in a `react-markdown` pipeline — was rejected
against the actual stack: the item has no `package.json`, bundles to a single
esbuild IIFE, and its `FormatHandler.render(): string` contract is what the
preview pane and the registry are built around. Tables and fenced divs are
therefore **two bounded block recognizers added to the existing line loop**,
not a new pipeline. The behaviour FR-027/FR-028 pin is met; only the plumbing
differs from the spec's assumption.

> An earlier note in `markdown.ts` said "adding a richer renderer later means
> swapping this one module". That is still true — the registry is what the rest
> of the app talks to, and a future swap to a real `react-markdown` pipeline
> remains a one-module change — but this page, not that note, is now the
> renderer's architecture document.

### Recognizer order is load-bearing

Inside the line loop the block checks run in a fixed order:

```
fenced code  →  GFM table  →  fenced div  →  blockquote → hr → heading → list → paragraph
```

The fenced-code branch runs **first** and consumes its whole ``` block before
any other logic sees the lines. That single ordering choice is what makes two
edge cases hold *by construction*, with no special-casing:

- a `|` inside a code fence is literal — never a table row;
- a `:::` inside a code fence is literal — never a fenced-div boundary.

## 2. The GFM table pass (FR-027)

**Recognition.** A line is a table-header candidate when it contains an
*unescaped* pipe (and, if it reads as another block opener — heading, list
item, quote — only when it starts with a pipe itself). It becomes a table when
the **next** line is a valid delimiter row: only `|`, `:`, `-` and whitespace,
at least one pipe (so a bare `---` stays a horizontal rule), every cell
matching `:?-+:?`, and the **same cell count as the header** (GFM's rule; a
mismatch means "not a table" and the lines fall through to paragraph text).

**Alignment.** Each delimiter cell sets its column: `:---` → left, `:---:` →
center, `---:` → right, plain `---` → none. Alignment is emitted as
`style="text-align:…"` on every `<th>`/`<td>` in that column.

**Cell splitting** is on unescaped pipes only: `\|` is a literal `|` and never
splits a column. One leading/trailing boundary pipe is dropped, so
`| a | b |` and `a | b` both yield two cells. Body rows are consumed until a
blank or pipe-less line, and are normalized to the header's column count
(extra cells dropped, missing cells empty — GFM behaviour).

**Cell rendering.** Every cell goes through the existing `renderInline`, so
bold, inline code and links inside cells render — and stay escaped. One nuance:
`renderInline` escapes `<`, which would show a literal `<br>` as text, but GFM
documents use `<br>` for line breaks *within* a cell. So the cell renderer
parks code spans, swaps `<br>`/`<br/>` for a placeholder, and restores it as a
real `<br />` after `renderInline` — which also means a `<br>` inside
backticks stays literal, as it should.

**Placement.** A standalone table flushes any open paragraph/list/quote first
(the existing `flushAll`), which is what makes "table immediately after a
paragraph, no blank line" work with no special case. The non-trivial sub-case
is a **table indented under a list item**: the list model emits one closed
`<li>` per line, so when a table is recognized while a list is open and its
header line is indented, the just-emitted `<li>` is re-opened and the
`<table>` folded inside it — the table renders *inside* the item, not after
the list.

**Emitted shape** (asserted by the e2e suite):

```html
<table>
  <thead><tr><th style="text-align:left">…</th>…</tr></thead>
  <tbody><tr><td style="text-align:left">…</td>…</tr>…</tbody>
</table>
```

Edit mode is untouched: the monospace textarea always shows raw source, so the
pipe table appears unmodified (US10.5). Table visuals live in `styles.css`
under `.ate-preview table/th/td`.

## 3. The fenced-div pass (FR-028)

Pandoc's `fenced_div` extension, recognized after the fence and table checks:

```markdown
::: {custom-style="Note"}     ← or the class form: ::: {.Note}
Any markdown at all.
:::
```

**Attribute parsing.** The opening line must match `:::` + a `{…}` attribute
block. Inside it, `custom-style="Name"` (single or double quotes) wins; failing
that, the first `.Class` token is the name. Full pandoc attribute lists
(`{#id .class key="value"}`) are tolerated — unknown keys are ignored, and no
input throws. No recognizable name degrades to "unknown" → the neutral style.

**Collection and nesting.** Inner lines are collected until the matching
closing `:::` line, with two collectors' rules: an inner opening `::: {…}`
increments depth (so nested divs close correctly), and lines inside an inner
``` fence are skipped for delimiter purposes (so a `:::` in code inside a div
is still literal). A missing closer means the rest of the document is inside
the div — **content is never dropped**. The inner text is then rendered by
recursion — `renderMarkdown(innerText)` — which is why nesting is free: a
fenced div inside a fenced div is just markdown inside markdown.

**Emission.**

```html
<div class="custom-style custom-style--Note" data-style="Note" style="…escaped CSS…">
  …recursively rendered inner markdown…
</div>
```

- The class-suffix name is sanitized to `[A-Za-z0-9_-]` so an odd name cannot
  break the class attribute; `data-style` carries the raw (HTML-escaped) name
  for testability.
- The `style` attribute is the registry's resolved CSS with a minimal neutral
  base **prepended** (the `boxCss` helper — an empty or partial style still
  shows a box) and the style's declarations appended so they win. The value is
  escaped (`&`, `<`, `"`) before embedding: CSS is not HTML, so the only
  injection surface is breaking out of the attribute, and that is closed off
  (design ADR-3). The shared `.custom-style` class in `styles.css` carries only
  what every container has regardless of style (margin, radius, overflow).

Both passes emit fully-escaped markup, so the preview pane's "safe to inject"
invariant holds unchanged — no `FormatHandler` interface change, no
`PreviewView` rendering-path change.

## 4. The style registry (`config/custom-styles.ts`)

The single source of truth for name → CSS. Mirrors `editor-config.ts`
(declarative defaults + load/save against the per-app KV store), with one
structural difference driven by the consumer: `effectiveCss(name)` is called
from inside a synchronous render, so the persisted half lives in a
**module-level cache** — `loadCustomStyles()` fills it during the store's
`hydrate()` (before the first preview renders), `saveCustomStyles()` keeps it
current on every edit, and a render never blocks on storage.

**Built-ins ship in code**: `BUILTIN_STYLES` = `Note`, `Info`, `Warning`,
`Tip` (spec Q3 — `RuleBox` was the spec's illustrative example, deliberately
not shipped). Because the names come from code, not the store, they are
structurally non-removable (FR-029); only their CSS can be overridden.

**Persistence shape**, under the KV key
`agentic-text-editor.custom-styles` (design ADR-2):

```ts
interface CustomStylesPersistence {
  version: 1;
  user:      Record<string, string>;  // user styles: name → css, freely managed
  overrides: Record<string, string>;  // built-in name → css (CSS-only override)
}
```

**Resolution** — `effectiveCss(name)`, three ways:

1. built-in name → `overrides[name] ?? BUILTIN_STYLES[name].css`;
2. else a user style → `user[name]`;
3. else → `NEUTRAL_STYLE.css` (always a CSS string — the container is never
   empty and the renderer never throws).

Every affordance in the Settings surface falls out of this one function: the
"modified" pill is `overrides[name] != null`, "Reset to default" deletes the
override, the "Your styles" group is the keys of `user`, and the neutral
fallback is the else-branch. The agent's `agentic_editor_*_style` tools (v4)
read the same four predicates and dispatch the same store actions — there is one
writer path, not a UI one and an agent one (`agent-tools.md` §4).

**Degradation.** If the `storage` capability is revoked,
`services/bos.ts`'s `storageGet`/`storageSet` fall back to localStorage /
no-op. Built-ins are in code so they always render; user styles simply stop
persisting across restarts. Nothing throws.

## 5. Reactivity: `customStylesVersion`

The registry cache is not React state, so a style edit needs one reactive
signal. `state/document-store.ts` holds `customStylesVersion: number`; every
style action (`addStyle`, `updateStyle`, `removeStyle`, `overrideBuiltIn`,
`resetBuiltIn`) writes through `saveCustomStyles` and bumps it.
`preview-view.tsx` subscribes to the counter and includes it in its render
memo's dependency array — that is the whole mechanism behind FR-029's "takes
effect in the preview immediately on save": Settings saves a style → version
bumps → any open preview re-runs `render()` → the fenced divs resolve the new
CSS. The Settings list re-reads the registry off the same subscription.

## 6. Mermaid (v5, FR-036)

A ```` ```mermaid ```` fence renders as a diagram. The renderer does **not** know
about it: the fence pass already emits `<pre data-lang="mermaid"><code>…</code></pre>`,
escaped like any other code block, and `services/mermaid.ts` upgrades those nodes
in the DOM afterwards. Mermaid's `render()` is async — it parses, lays out and
measures text — and this renderer is a synchronous string builder, so the two
cannot be one pass.

```
format.render(content)            # sync, escaped — unchanged
  → preview-view useLayoutEffect  # writes the markup into the pane
  → preview-view useEffect        # upgradeMermaidBlocks(pane)
        → import("mermaid")       # once, lazily: no diagram, no load
        → mermaid.render(id, src) # per block, memoised by SOURCE TEXT
        → block.replaceWith(<figure class="ate-mermaid">…svg…</figure>)
```

Four things make it behave:

- **The code block is the fallback.** If mermaid never loads or never finishes,
  the user is looking at their own source. Nothing is hidden pending a render.
- **A failure is a result, not an exception.** A half-typed diagram is the normal
  state of a document being written, so `renderDiagram` returns
  `{ok: false, message}` and the pane shows mermaid's reason above the source
  (`.ate-mermaid-error`). Both outcomes are cached, keyed by the source text —
  otherwise every keystroke inside a fence re-lays-out every diagram on the page.
- **Mermaid leaves orphans behind.** It renders into a detached element it
  appends to the document and, on a parse error, throws before removing it —
  one stray node per keystroke, each carrying its own error graphic, at the end
  of the page. `removeOrphan` runs in a `finally`.
- **`securityLevel: "strict"`**, which is what makes injecting the returned SVG
  acceptable: HTML labels are off and mermaid sanitises its own output. This is
  the one place in the preview where markup not built by a format handler is
  injected.

### The trap: React re-applies `dangerouslySetInnerHTML`

The inline pane used to be `<div dangerouslySetInnerHTML={{ __html: html }} />`.
That prop is a **new object on every render**, so React commits it on every
re-render — re-setting `innerHTML` even when the string is byte-identical. Every
diagram already swapped into the pane was silently thrown away, and the effect
that would have put them back did not re-run, because its `html` dependency had
not changed. The symptom was precise and misleading: diagrams rendered when a
document was opened by hand, and never when the same document was restored from
the persisted snapshot (where a second render follows hydration).

So the inline pane is now written imperatively — `useLayoutEffect` sets
`innerHTML` (before paint, so there is no empty frame), `useEffect` upgrades the
diagrams, and the element React renders has no children and no
`dangerouslySetInnerHTML` at all. One owner for that subtree. **Do not reintroduce
the prop**: any DOM the preview grows after render would start disappearing again,
intermittently.

### Cost

Mermaid is a BOS dependency, so esbuild bundles it from BOS's `node_modules` with
no per-app install — but the app build is `format: "iife"`, which cannot code-split,
so the whole library lands in `bundle.js`: **292 KB → 3.6 MB**, and app open goes
from ~690 ms to ~1.0 s on loopback. The `import("mermaid")` is still lazy in the
sense that matters for *execution* (esbuild defers the module factory, so a
document with no diagram never runs it); what is paid upfront is parse. Splitting
it out would mean emitting ESM from BOS's app build (`src/lib/apps/build.ts`) —
a BOS-wide change, not an item one.

## 7. Extending

- **A new built-in style** is one entry in `BUILTIN_STYLES` (plus
  `BUILTIN_ORDER` for the Settings list). It is immediately renderable,
  overridable and resettable — from Settings AND from the agent's style tools —
  with no other module changes.
- **Another async block upgrade** (KaTeX, say) follows the mermaid shape: leave
  the renderer emitting an escaped block, and upgrade those nodes from the
  preview's effect. Keep the original block as the fallback.
- **A new block construct** in the renderer is another recognizer in the line
  loop. Keep it *after* the fenced-code check (that ordering is the literalness
  guarantee) and make it emit escaped markup only.
- **Swapping the renderer wholesale** (e.g. to a `react-markdown` pipeline) is
  still a one-module change from the registry's point of view — but it now has
  to reproduce the table pass, the fenced-div pass and the `effectiveCss`
  integration this page describes.
