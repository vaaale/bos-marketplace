"use client";

// The Custom Styles list view (v3, FR-029): a Built-in group (lock — names
// can't be removed, CSS can be overridden) and a Your-styles group (add, edit,
// remove freely; dashed empty-state when none). The remove confirmation is
// LIST-level (the mockup's confirm-strip): at most one row is confirming at a
// time, and switching rows or leaving the list cancels it.

import { useState } from "react";
import { Lock, Palette, Sparkles } from "lucide-react";
import { effectiveCss, getBuiltinNames, getUserStyles, isOverridden } from "../../config/custom-styles";
import { useEditorStore } from "../../state/document-store";
import { StyleRow } from "./style-row";

export function StyleList({ onEdit }: { onEdit: (name: string) => void }) {
  /** Name of the user style awaiting remove confirmation, if any. */
  const [confirmRemove, setConfirmRemove] = useState<string | null>(null);

  const builtinNames = getBuiltinNames();
  const userStyles = getUserStyles();
  const userNames = Object.keys(userStyles).sort((a, b) => a.localeCompare(b));

  const remove = (name: string): void => {
    useEditorStore.getState().removeStyle(name);
    setConfirmRemove(null);
  };

  return (
    <div data-testid="ate-cs-list">
      <div className="ate-cs-group">
        <div className="ate-cs-group-label">
          <Lock size={13} strokeWidth={1.9} />
          Built-in styles
          <span className="ate-cs-group-hint">shipped — can’t be removed, but their CSS can be overridden</span>
        </div>
        <div className="ate-cs-rows" data-testid="ate-cs-builtin-rows">
          {builtinNames.map((name) => (
            <StyleRow
              key={name}
              name={name}
              css={effectiveCss(name)}
              builtin
              modified={isOverridden(name)}
              confirming={false}
              onEdit={() => onEdit(name)}
            />
          ))}
        </div>
      </div>

      <div className="ate-cs-group">
        <div className="ate-cs-group-label">
          <Sparkles size={13} strokeWidth={1.9} />
          Your styles
          <span className="ate-cs-group-hint">add, edit, and remove freely</span>
        </div>
        {userNames.length > 0 ? (
          <div className="ate-cs-rows" data-testid="ate-cs-user-rows">
            {userNames.map((name) => (
              <StyleRow
                key={name}
                name={name}
                css={userStyles[name]}
                builtin={false}
                modified={false}
                confirming={confirmRemove === name}
                onEdit={() => onEdit(name)}
                onRequestRemove={() => setConfirmRemove(name)}
                onConfirmRemove={() => remove(name)}
                onCancelRemove={() => setConfirmRemove(null)}
              />
            ))}
          </div>
        ) : (
          <div className="ate-cs-empty" data-testid="ate-cs-empty">
            <Palette size={18} strokeWidth={1.7} />
            <b>No custom styles yet.</b>
            <br />
            Create one to style your own callouts — they persist across restarts.
          </div>
        )}
      </div>
    </div>
  );
}
