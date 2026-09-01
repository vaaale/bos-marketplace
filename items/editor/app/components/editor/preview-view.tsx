"use client";

// Preview mode (T016). The HTML comes from the document's own format handler,
// which escapes every byte of user content before emitting markup — nothing
// unescaped reaches this component. Colours and fonts come from the `--ate-*`
// custom properties, so T042–T045 need no code here.

import { useMemo } from "react";
import type { FormatHandler } from "../../types";

export function PreviewView({ content, format }: { content: string; format: FormatHandler }) {
  const html = useMemo(() => format.render(content), [content, format]);

  if (!content.trim()) {
    return (
      <div className="ate-preview" data-testid="ate-preview">
        <p style={{ color: "rgba(255,255,255,0.3)" }}>This document is empty.</p>
      </div>
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
