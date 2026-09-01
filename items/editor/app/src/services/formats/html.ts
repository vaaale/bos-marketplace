// HTML handler (v3, FR-017).
//
// The point of the format registry is that a new format is ONE module plus one
// `register()` call — this is that module for HTML, and nothing in the editor,
// the store, the tab bar or the assistant tools changed to accommodate it.
//
// HTML is the first format whose preview is the content ITSELF rather than
// markup derived from it, which is why `previewMode` exists: markdown renders a
// tree the handler built (safe to inject), whereas an HTML document must be
// handed to a sandboxed iframe unaltered. See `renderDocument` below and
// components/editor/preview-view.tsx.
//
// Edit mode needs nothing special: the same monospace textarea every format
// uses already shows the raw source, which for HTML is exactly right.

import type { FormatHandler } from "../../types";

function escapeHtml(s: string): string {
  return s
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;");
}

export const htmlHandler: FormatHandler = {
  id: "html",
  name: "HTML",
  extensions: [".html", ".htm"],
  supportsPreview: true,
  previewMode: "document",

  /**
   * The INLINE rendering, kept honest: if anything ever previews this format
   * without honouring `previewMode` it gets escaped source in a `<pre>`, not
   * live markup injected into the app's own document. The real preview is
   * `renderDocument`.
   */
  render(content: string): string {
    return `<pre class="ate-plaintext">${escapeHtml(content)}</pre>`;
  },

  /**
   * The buffer, verbatim — deliberately not the file on disk.
   *
   * The preview pane feeds this to `<iframe srcdoc>`, so the rendered page is
   * always the CURRENT buffer: typing in Edit mode and flipping to Preview
   * shows unsaved edits, and an agent tool call that rewrites the buffer is
   * visible on the next render without a save (SC-002). Containment is the
   * iframe's sandbox — no same-origin access, so the page cannot reach the
   * editor, the BOS SDK, or the user's files.
   */
  renderDocument(content: string): string {
    return content;
  },

  editorHints: { tabSize: 2, spellcheck: false },
};
