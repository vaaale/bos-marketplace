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

// Mermaid (v5, FR-036) rides on the inline path as a second, ASYNCHRONOUS pass:
// `render()` emits a ```mermaid fence as the escaped code block it is, and
// `upgradeMermaidBlocks` swaps each one for its diagram once mermaid has laid it
// out. The invariant above is therefore unchanged — what `render()` produces is
// still markup the handler built — and the code block is what the user keeps if
// a diagram never renders. See services/mermaid.ts.
//
// WHY THE INLINE PANE IS WRITTEN IMPERATIVELY, not with dangerouslySetInnerHTML.
// That prop takes a NEW object (`{ __html }`) on every render, so React commits
// it on every re-render — re-setting innerHTML even when the string is
// identical, which silently threw away every diagram this component had already
// swapped in. The effect that owns the diagrams did not re-run (its `html`
// dependency had not changed), so the preview reverted to code blocks and
// stayed there. Writing the markup and upgrading it from ONE effect makes that
// impossible: the subtree has a single owner, and the two steps cannot be
// re-ordered by a render that has nothing to do with either.

import { useEffect, useLayoutEffect, useMemo, useRef } from "react";
import { useEditorStore } from "../../state/document-store";
import { upgradeMermaidBlocks } from "../../services/mermaid";
import type { FormatHandler } from "../../types";

export function PreviewView({ content, format }: { content: string; format: FormatHandler }) {
  // The markdown handler resolves fenced-div styles against the custom-style
  // registry at render time (v3, FR-028). The registry is a module cache, not
  // React state, so this version counter — bumped by every style CRUD in the
  // store — is what makes saving a style in Settings re-render an open preview
  // immediately (FR-029): it only needs to be in the memo's deps.
  const customStylesVersion = useEditorStore((s) => s.customStylesVersion);

  // One decision, made once: what the handler asked for, degraded to the inline
  // path whenever the document path cannot actually be honoured (no
  // `renderDocument`, or one that throws or hands back something that is not a
  // string). The inline branch always escapes, so falling back is safe by
  // construction — the worst it can do is show the source it could not render.
  const { html, isDocument } = useMemo(() => {
    if (format.previewMode === "document" && typeof format.renderDocument === "function") {
      try {
        const doc = format.renderDocument(content);
        if (typeof doc === "string") return { html: doc, isDocument: true };
      } catch {
        /* fall through to the escaped inline rendering */
      }
    }
    return { html: format.render(content), isDocument: false };
    // customStylesVersion is a deliberate cache-buster, not a read value:
    // render() resolves styles from a module cache the linter cannot see.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [content, format, customStylesVersion]);

  // The inline pane. React renders it empty; everything inside it is ours.
  const inlineRef = useRef<HTMLDivElement>(null);

  // Before paint, so the rendered markdown appears in the same frame it would
  // have with dangerouslySetInnerHTML — no flash of an empty pane.
  useLayoutEffect(() => {
    const el = inlineRef.current;
    if (isDocument || !el) return;
    // Safe: `format.render` HTML-escapes all content and only emits the element
    // set the handler itself constructs (see services/formats/).
    el.innerHTML = html;
  }, [html, isDocument]);

  // Then the diagrams, asynchronously. Cancelled on re-render: a diagram that
  // finishes laying out after the user has typed on belongs to markup that is
  // no longer on screen, and the node it would replace is already detached.
  useEffect(() => {
    const el = inlineRef.current;
    if (isDocument || !el) return;
    let cancelled = false;
    void upgradeMermaidBlocks(el, () => cancelled);
    return () => {
      cancelled = true;
    };
  }, [html, isDocument]);

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

  // No children and no dangerouslySetInnerHTML: the layout effect above fills
  // this element, so React has nothing here to reconcile — and therefore nothing
  // to overwrite behind the mermaid pass's back.
  return <div ref={inlineRef} className="ate-preview" data-testid="ate-preview" />;
}
