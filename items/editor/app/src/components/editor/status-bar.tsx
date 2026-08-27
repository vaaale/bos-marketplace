"use client";

// Status bar (T017 / T026 / T051): filename, change status, and — briefly after
// an agent tool touches the buffer — a flash saying so, since an edit the user
// did not type needs to be attributable.

import { useEffect, useState } from "react";
import { Sparkles } from "lucide-react";
import type { CursorPosition, EditorDocument, FormatHandler } from "../../types";

const FLASH_MS = 2500;

export function StatusBar({
  doc,
  format,
  dirty,
  cursor,
  agentEdit,
}: {
  doc: EditorDocument | undefined;
  format: FormatHandler;
  dirty: boolean;
  cursor: CursorPosition;
  agentEdit: { documentId: string; at: number; summary: string } | null;
}) {
  // The flash is DERIVED from the store's `lastAgentEdit` rather than copied
  // into state: the only thing this component owns is "that edit's flash has
  // run its course", which a timer records asynchronously. Setting the flash
  // itself in an effect would be a cascading render for no gain.
  const edit = agentEdit && doc && agentEdit.documentId === doc.id ? agentEdit : null;
  const [dismissedAt, setDismissedAt] = useState<number | null>(null);
  const flash = edit && dismissedAt !== edit.at ? edit.summary : null;

  useEffect(() => {
    if (!edit) return;
    // Clamped rather than skipped, so an edit that is already older than the
    // flash window still dismisses itself instead of sticking.
    const remaining = Math.max(0, FLASH_MS - (Date.now() - edit.at));
    const timer = setTimeout(() => setDismissedAt(edit.at), remaining);
    return () => clearTimeout(timer);
  }, [edit]);

  return (
    <div className="ate-status-bar" data-testid="ate-status-bar">
      <div className="ate-status-left">
        <span className="ate-status-name">{doc ? doc.filename : "No document"}</span>
        <span aria-hidden="true">•</span>
        {doc && dirty ? (
          <span className="ate-status-dirty" data-testid="ate-status-change">
            <span className="ate-tab-dot" />
            Unsaved changes
          </span>
        ) : (
          <span data-testid="ate-status-change">{doc ? "No changes" : "Open or create a document"}</span>
        )}
        {flash && (
          <span className="ate-status-flash" data-testid="ate-agent-edit-flash">
            <Sparkles size={10} strokeWidth={2.2} />
            Agent {flash}
          </span>
        )}
      </div>
      <div className="ate-status-right">
        <span>
          Ln {cursor.line}, Col {cursor.column}
        </span>
        <span>UTF-8</span>
        <span>{format.name}</span>
      </div>
    </div>
  );
}
