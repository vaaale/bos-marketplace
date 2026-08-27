"use client";

// The "Save changes?" prompt (T037, FR-022). Three-way by design: discarding a
// buffer the agent may have spent a whole turn writing must be a deliberate
// choice, and Cancel has to be able to back out of the close entirely.

import { AlertTriangle } from "lucide-react";

export function ConfirmDialog({
  title,
  message,
  confirmLabel,
  discardLabel,
  cancelLabel = "Cancel",
  onConfirm,
  onDiscard,
  onCancel,
}: {
  title: string;
  message: string;
  confirmLabel: string;
  discardLabel?: string;
  cancelLabel?: string;
  onConfirm: () => void;
  onDiscard?: () => void;
  onCancel: () => void;
}) {
  return (
    <div className="ate-scrim" role="dialog" aria-modal="true" aria-label={title} data-testid="ate-confirm-dialog">
      <div className="ate-dialog" style={{ width: 420 }}>
        <div className="ate-dialog-header">
          <AlertTriangle size={14} strokeWidth={1.9} color="#f59e0b" />
          <h3>{title}</h3>
        </div>
        <div className="ate-dialog-body">{message}</div>
        <div className="ate-dialog-footer">
          <button className="ate-btn" onClick={onCancel} data-testid="ate-confirm-cancel">
            {cancelLabel}
          </button>
          {discardLabel && onDiscard && (
            <button className="ate-btn ate-btn-danger" onClick={onDiscard} data-testid="ate-confirm-discard">
              {discardLabel}
            </button>
          )}
          <button className="ate-btn ate-btn-primary" onClick={onConfirm} data-testid="ate-confirm-accept">
            {confirmLabel}
          </button>
        </div>
      </div>
    </div>
  );
}
