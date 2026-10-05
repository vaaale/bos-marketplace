// Mermaid diagrams in the markdown preview (v5, FR-036).
//
// WHY THIS IS NOT IN THE RENDERER. `services/formats/markdown.ts` is a
// synchronous string builder, and mermaid's `render()` is async — it parses the
// diagram, lays it out and measures text. So the markdown pass keeps emitting
// the fence as what it is (`<pre data-lang="mermaid"><code>…</code></pre>`,
// escaped like every other code block) and this module UPGRADES those blocks in
// the DOM afterwards. Two consequences worth keeping:
//
//   * the renderer's contract is untouched — `render()` output is still escaped
//     markup it built itself, so nothing about the inline-preview invariant
//     changes (see preview-view.tsx);
//   * the code block IS the fallback. If mermaid fails to load, or the diagram
//     never renders, the user sees their source — never a blank gap.
//
// WHY INJECTING THE SVG IS SAFE. Mermaid is initialized with
// `securityLevel: "strict"`: HTML labels are off and its output is sanitized by
// mermaid's own DOMPurify pass before it hands back the string. This is the one
// place in the preview where markup not built by a format handler is injected,
// and it is injected because an SVG is the whole point of a diagram.

/** What one diagram source rendered to. An error is a result, not an exception —
 *  a half-typed diagram is the normal state of a document being written. */
export type DiagramResult = { ok: true; svg: string } | { ok: false; message: string };

/** Keyed by diagram source. Re-rendering a document (a keystroke, a tab switch,
 *  a style change) must not re-lay-out every diagram in it — and must not
 *  re-render the one the user is still typing, either, which is why failures
 *  are cached too. Source text is the whole of the input, so it is the key. */
const cache = new Map<string, DiagramResult>();

/** Bounded so a long editing session cannot grow it without limit: every
 *  keystroke inside a fence produces one more distinct source string. */
const MAX_CACHED = 200;

let mermaidModule: Promise<typeof import("mermaid").default> | null = null;
let idCounter = 0;

function loadMermaid(): Promise<typeof import("mermaid").default> {
  mermaidModule ??= import("mermaid").then(({ default: mermaid }) => {
    mermaid.initialize({
      startOnLoad: false,
      // The preview pane is dark; "default" would draw black-on-white boxes.
      theme: "dark",
      // See the header: this is what makes the returned SVG safe to inject.
      securityLevel: "strict",
      fontFamily: "inherit",
    });
    return mermaid;
  });
  return mermaidModule;
}

/**
 * Mermaid renders into a detached element it appends to the document, and on a
 * parse error it throws BEFORE cleaning that element up — so a document being
 * typed into leaves one orphan per keystroke, each carrying mermaid's own error
 * graphic, at the end of the page.
 */
function removeOrphan(id: string): void {
  for (const candidate of [id, `d${id}`]) {
    document.getElementById(candidate)?.remove();
  }
}

/** Render one diagram source, through the cache. Never throws. */
export async function renderDiagram(code: string): Promise<DiagramResult> {
  const cached = cache.get(code);
  if (cached) return cached;

  let result: DiagramResult;
  const id = `ate-mermaid-${++idCounter}`;
  try {
    const mermaid = await loadMermaid();
    const { svg } = await mermaid.render(id, code);
    result = { ok: true, svg };
  } catch (err) {
    result = { ok: false, message: (err as Error)?.message || String(err) };
  } finally {
    removeOrphan(id);
  }

  if (cache.size >= MAX_CACHED) cache.clear();
  cache.set(code, result);
  return result;
}

/** The rendered diagram, as it goes into the preview. */
function diagramFigure(svg: string): HTMLElement {
  const figure = document.createElement("figure");
  figure.className = "ate-mermaid";
  figure.dataset.testid = "ate-mermaid";
  figure.innerHTML = svg;
  return figure;
}

/**
 * The failure rendering: mermaid's reason, then the source, verbatim.
 *
 * Built with DOM nodes rather than an HTML string on purpose — `textContent`
 * cannot be made to inject markup, and the two things going in here are a
 * library's error text and the user's unescaped source.
 */
function errorFigure(message: string, code: string): HTMLElement {
  const figure = document.createElement("figure");
  figure.className = "ate-mermaid-error";
  figure.dataset.testid = "ate-mermaid-error";

  const reason = document.createElement("p");
  reason.className = "ate-mermaid-error-msg";
  reason.textContent = message.trim() || "Mermaid could not render this diagram.";

  const pre = document.createElement("pre");
  const codeEl = document.createElement("code");
  codeEl.textContent = code;
  pre.append(codeEl);

  figure.append(reason, pre);
  return figure;
}

/**
 * Replace every ```mermaid code block under `root` with its diagram.
 *
 * `isCancelled` is checked before each DOM write: the pane re-renders on every
 * keystroke, so by the time a diagram is laid out its block may belong to a
 * document that is no longer on screen.
 */
export async function upgradeMermaidBlocks(root: HTMLElement, isCancelled: () => boolean): Promise<void> {
  const blocks = Array.from(root.querySelectorAll<HTMLElement>('pre[data-lang="mermaid"]'));
  if (blocks.length === 0) return;

  for (const block of blocks) {
    // The source, exactly as typed: the renderer escaped it into the <code>,
    // and textContent gives it back unescaped.
    const code = block.textContent ?? "";
    if (!code.trim()) continue;

    const result = await renderDiagram(code);
    if (isCancelled() || !block.isConnected) return;

    block.replaceWith(result.ok ? diagramFigure(result.svg) : errorFigure(result.message, code));
  }
}
