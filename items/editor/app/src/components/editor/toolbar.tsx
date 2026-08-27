"use client";

// Editor toolbar (T013): Open, Save, New, the Edit/Preview pill toggle, and the
// Settings entry point.

import { FilePlus2, FolderOpen, Save, Settings2 } from "lucide-react";
import type { ViewMode } from "../../types";

export function Toolbar({
  viewMode,
  canSave,
  saving,
  previewSupported,
  onOpen,
  onSave,
  onNew,
  onSettings,
  onModeChange,
}: {
  viewMode: ViewMode;
  canSave: boolean;
  saving: boolean;
  previewSupported: boolean;
  onOpen: () => void;
  onSave: () => void;
  onNew: () => void;
  onSettings: () => void;
  onModeChange: (mode: ViewMode) => void;
}) {
  return (
    <div className="ate-toolbar">
      <div className="ate-toolbar-group">
        <button className="ate-btn" onClick={onOpen} data-testid="ate-open">
          <FolderOpen size={13} strokeWidth={1.9} />
          Open
        </button>
        <button className="ate-btn" onClick={onSave} disabled={!canSave || saving} data-testid="ate-save">
          <Save size={13} strokeWidth={1.9} />
          {saving ? "Saving…" : "Save"}
        </button>
        <button className="ate-btn" onClick={onNew} data-testid="ate-new">
          <FilePlus2 size={13} strokeWidth={1.9} />
          New
        </button>
      </div>

      <div className="ate-mode-toggle" role="group" aria-label="View mode">
        <button
          className={`ate-mode-btn${viewMode === "edit" ? " ate-active" : ""}`}
          aria-pressed={viewMode === "edit"}
          onClick={() => onModeChange("edit")}
          data-testid="ate-mode-edit"
        >
          Edit
        </button>
        <button
          className={`ate-mode-btn${viewMode === "preview" ? " ate-active" : ""}`}
          aria-pressed={viewMode === "preview"}
          onClick={() => onModeChange("preview")}
          title={previewSupported ? undefined : "This format has no rich preview — the raw text is shown."}
          data-testid="ate-mode-preview"
        >
          Preview
        </button>
      </div>

      <div className="ate-toolbar-group">
        <button className="ate-btn-icon" onClick={onSettings} aria-label="Editor settings" data-testid="ate-settings">
          <Settings2 size={15} strokeWidth={1.9} />
        </button>
      </div>
    </div>
  );
}
