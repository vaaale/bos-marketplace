"use client";

// Preview mode (T016, extended in v3 for document formats).
//
// Two rendering paths, chosen by the format handler itself:
//
//   previewMode "inline" (default) — the HTML comes from the handler's
//   `render()`, which escapes every byte of user content before emitting
//   markup, so nothing unescaped reaches this component's innerHTML. Colours
//   and fonts come from the `--ate-*` custom properties (T042–T045).
//
//   previewMode "document" — the buffer IS a document (HTML). Injecting it
//   inline would both mangle it (the app's own stylesheet would style it) and
//   hand it the editor's origin, so it goes into a SANDBOXED iframe via
//   `srcdoc` instead. `sandbox="allow-scripts"` without `allow-same-origin`
//   gives the frame a throwaway opaque origin: scripts in the previewed page
//   run — otherwise the preview would lie about what the file does — but they
//   cannot touch the editor, the BOS SDK, or the user's files.
//
// `srcdoc` (rather than pointing the frame at the file's URL) is what makes the
// preview live: the frame is fed the unsaved buffer, so it re-renders as the
// user types or an agent tool rewrites the document.

import { useMemo } from "react";
import type { FormatHandler } from "../../types";

export function PreviewView({ content, format }: { content: string; format: FormatHandler }) {
  const isDocument = format.previewMode === "document" && typeof format.renderDocument === "function";
  const html = useMemo(
    () => (isDocument ? format.renderDocument!(content) : format.render(content)),
    [content, format, isDocument],
  );

  if (!content.trim()) {
    return (
      <div className="ate-preview" data-testid="ate-preview">
        <p style={{ color: "rgba(255,255,255,0.3)" }}>This document is empty.</p>
      </div>
    );
  }

  if (isDocument) {
    return (
      <iframe
        className="ate-preview-frame"
        data-testid="ate-preview-frame"
        title={`Preview of ${format.name} document`}
        // No allow-same-origin: the previewed page gets an opaque origin and so
        // has no reach back into the editor. See the note at the top.
        sandbox="allow-scripts"
        srcDoc={html}
      />
    );
  }

  return (
    <div
      className="ate-preview"
      data-testid="ate-preview"
      // Safe: `format.render` HTML-escapes all content and only emits the
      // element set the handler itself constructs (see services/formats/).
      dangerouslySetInnerHTML={{ __html: html }}
    />
  );
}
