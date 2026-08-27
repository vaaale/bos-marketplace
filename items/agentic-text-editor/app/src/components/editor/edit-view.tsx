"use client";

// Edit mode (T015): a monospace textarea with a gutter of line numbers.
//
// The textarea is CONTROLLED from the store, which is what makes an agent edit
// appear under the user's cursor the moment the tool handler runs (SC-002) —
// and what makes concurrent edits last-write-wins on one buffer (T040).
//
// The gutter is a separate element scrolled in lockstep with the textarea; both
// use the same font metrics from the `--ate-*` custom properties, so a font or
// size change (T042/T043) keeps them aligned automatically.

import { useEffect, useMemo, useRef } from "react";
import type { CursorPosition, FormatHandler } from "../../types";

export function EditView({
  documentId,
  content,
  format,
  onChange,
  onCursorChange,
}: {
  documentId: string;
  content: string;
  format: FormatHandler;
  onChange: (next: string) => void;
  onCursorChange: (cursor: CursorPosition) => void;
}) {
  const textareaRef = useRef<HTMLTextAreaElement | null>(null);
  const gutterRef = useRef<HTMLDivElement | null>(null);

  const lineNumbers = useMemo(() => {
    const count = content.length === 0 ? 1 : content.split("\n").length;
    let out = "";
    for (let i = 1; i <= count; i++) out += `${i}\n`;
    return out;
  }, [content]);

  // Switching tabs should start at the top of the new document rather than
  // inheriting the previous one's scroll offset.
  useEffect(() => {
    if (textareaRef.current) textareaRef.current.scrollTop = 0;
    if (gutterRef.current) gutterRef.current.scrollTop = 0;
  }, [documentId]);

  const reportCursor = (): void => {
    const el = textareaRef.current;
    if (!el) return;
    const before = el.value.slice(0, el.selectionStart);
    const lines = before.split("\n");
    onCursorChange({ line: lines.length, column: lines[lines.length - 1].length + 1 });
  };

  return (
    <div className="ate-edit">
      <div className="ate-line-numbers" ref={gutterRef} aria-hidden="true">
        {lineNumbers}
      </div>
      <textarea
        ref={textareaRef}
        className="ate-textarea"
        data-testid="ate-editor-textarea"
        aria-label="Document content"
        spellCheck={format.editorHints?.spellcheck ?? false}
        placeholder="Start writing, or ask the agent on the right to draft something…"
        value={content}
        style={{ tabSize: format.editorHints?.tabSize ?? 2 }}
        onChange={(e) => {
          onChange(e.target.value);
          reportCursor();
        }}
        onKeyUp={reportCursor}
        onClick={reportCursor}
        onSelect={reportCursor}
        onScroll={(e) => {
          if (gutterRef.current) gutterRef.current.scrollTop = e.currentTarget.scrollTop;
        }}
      />
    </div>
  );
}
