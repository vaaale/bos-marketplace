"use client";

// One row in the Custom Styles list (v3): swatch · name · pill · actions.
//
// The swatch is a tiny live rendering of the style itself — the same
// `effectiveCss` value the document preview uses, with padding stripped so it
// fits the chip (`swatchCss`). Built-ins show a lock instead of a trash; a
// user-style remove swaps the actions for an inline confirm-strip (owned by
// the list, so only one row confirms at a time).

import { Check, Lock, Pencil, Trash2, X } from "lucide-react";
import { swatchCss } from "../../config/custom-styles";
import { CssBox } from "./style-preview";

export function StyleRow({
  name,
  css,
  builtin,
  modified,
  confirming,
  onEdit,
  onRequestRemove,
  onConfirmRemove,
  onCancelRemove,
}: {
  name: string;
  css: string;
  builtin: boolean;
  /** Built-ins only: true when the CSS is currently overridden. */
  modified: boolean;
  /** True while this row shows the inline remove confirm-strip. */
  confirming: boolean;
  onEdit: () => void;
  onRequestRemove?: () => void;
  onConfirmRemove?: () => void;
  onCancelRemove?: () => void;
}) {
  const pill = builtin ? (
    modified ? (
      <span className="ate-pill ate-pill-amber">modified</span>
    ) : (
      <span className="ate-pill ate-pill-gray">built-in</span>
    )
  ) : (
    <span className="ate-pill ate-pill-violet">user</span>
  );

  return (
    <div
      className={`ate-style-row${confirming ? " ate-style-row-confirming" : ""}`}
      onClick={confirming ? undefined : onEdit}
      role="button"
      tabIndex={0}
      onKeyDown={(e) => {
        if (!confirming && (e.key === "Enter" || e.key === " ")) {
          e.preventDefault();
          onEdit();
        }
      }}
      data-testid={`ate-style-row-${name}`}
    >
      <CssBox css={swatchCss(css)} className="ate-swatch">
        <span>Sample text</span>
      </CssBox>

      <div className="ate-sr-main">
        <div className="ate-sr-name">{name}</div>
        <div className="ate-sr-meta">
          {pill}
          <span className="ate-sr-desc">{builtin ? "pandoc fenced div" : "defined in Settings"}</span>
        </div>
      </div>

      {confirming ? (
        <div className="ate-confirm-strip" data-testid={`ate-style-confirm-${name}`}>
          Remove “{name}”?
          <button
            type="button"
            className="ate-btn ate-btn-danger"
            onClick={(e) => {
              e.stopPropagation();
              onConfirmRemove?.();
            }}
            data-testid={`ate-style-confirm-yes-${name}`}
          >
            <Check size={12} strokeWidth={2} />
            Remove
          </button>
          <button
            type="button"
            className="ate-btn-icon"
            aria-label="Cancel remove"
            onClick={(e) => {
              e.stopPropagation();
              onCancelRemove?.();
            }}
          >
            <X size={13} strokeWidth={2} />
          </button>
        </div>
      ) : (
        <div className="ate-sr-actions">
          {builtin && (
            <span className="ate-sr-lock" title="Built-in — cannot be removed" data-testid={`ate-style-lock-${name}`}>
              <Lock size={13} strokeWidth={1.9} />
            </span>
          )}
          <button
            type="button"
            className="ate-btn-icon"
            aria-label={builtin ? `Override CSS of ${name}` : `Edit ${name}`}
            title={builtin ? "Override CSS (built-in)" : "Edit"}
            onClick={(e) => {
              e.stopPropagation();
              onEdit();
            }}
            data-testid={`ate-style-edit-${name}`}
          >
            <Pencil size={13} strokeWidth={1.9} />
          </button>
          {!builtin && (
            <button
              type="button"
              className="ate-btn-icon ate-btn-icon-danger"
              aria-label={`Remove ${name}`}
              title="Remove"
              onClick={(e) => {
                e.stopPropagation();
                onRequestRemove?.();
              }}
              data-testid={`ate-style-remove-${name}`}
            >
              <Trash2 size={13} strokeWidth={1.9} />
            </button>
          )}
        </div>
      )}
    </div>
  );
}
