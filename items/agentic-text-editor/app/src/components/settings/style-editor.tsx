"use client";

// The Custom Styles editor form (v3): name + CSS declaration block.
//
// Controlled by the panel — the draft lives up there because the live-preview
// column (style-preview.tsx) restyles from the same draft on every keystroke.
// Built-in names are fixed (FR-029): the name input is disabled and a note says
// why; only the CSS is editable. The action buttons (Remove / Reset to default)
// are supplied by the panel, which owns the store dispatches.

import type { ReactNode } from "react";
import { Eye, Lock } from "lucide-react";

export function StyleEditor({
  name,
  css,
  builtin,
  isNew,
  nameError,
  onNameChange,
  onCssChange,
  actions,
}: {
  name: string;
  css: string;
  builtin: boolean;
  isNew: boolean;
  nameError: string | null;
  onNameChange: (name: string) => void;
  onCssChange: (css: string) => void;
  /** Remove / Reset-to-default buttons, rendered under the form. */
  actions: ReactNode;
}) {
  return (
    <div className="ate-cs-form">
      {builtin && (
        <div className="ate-cs-readonly-note">
          <Lock size={14} strokeWidth={1.9} />
          <div>
            Built-in names are fixed — you can <b>override this style’s CSS</b> (and reset it), but you can’t rename
            or remove it.
          </div>
        </div>
      )}

      <div className="ate-cs-field">
        <label htmlFor="ate-cs-name">Name</label>
        <input
          id="ate-cs-name"
          className={`ate-input ate-input-mono${nameError ? " ate-input-error" : ""}`}
          value={name}
          disabled={builtin}
          placeholder="e.g. PinkBox"
          autoFocus={isNew}
          onChange={(e) => onNameChange(e.target.value)}
          data-testid="ate-cs-name"
        />
        {nameError && (
          <div className="ate-cs-field-error" data-testid="ate-cs-name-error">
            {nameError}
          </div>
        )}
      </div>

      <div className="ate-cs-field">
        <label htmlFor="ate-cs-css">
          CSS <span className="ate-cs-field-hint">declaration block — no surrounding braces</span>
        </label>
        <textarea
          id="ate-cs-css"
          className="ate-cs-area"
          value={css}
          spellCheck={false}
          placeholder="background: #dbeafe; border: 1px solid #93c5fd; padding: 10px 14px; border-radius: 6px;"
          onChange={(e) => onCssChange(e.target.value)}
          data-testid="ate-cs-css"
        />
      </div>

      {actions}

      <div className="ate-cs-note">
        <Eye size={13} strokeWidth={1.9} />
        Live preview on the right updates as you type.
      </div>
    </div>
  );
}
