"use client";

// The Settings panel (US5; restructured in v3 for US11/FR-029).
//
// v3 turned the single-scroll dialog into two tabs (ADR-4): **Appearance** is
// the existing content, verbatim — it still renders itself from SETTINGS_FIELDS
// in the config namespace, so adding a setting is one entry in editor-config.ts,
// and every change is applied and persisted immediately (SC-005). **Custom
// Styles** is the v3 registry surface (components/settings/), managing the
// named styles pandoc fenced divs resolve against.

import { useState } from "react";
import { Layers, Palette, RotateCcw, Settings2, X } from "lucide-react";
import { DEFAULT_SETTINGS, SETTINGS_FIELDS, type SettingsField } from "../config/editor-config";
import { CustomStylesPanel } from "./settings/custom-styles-panel";
import type { EditorSettings } from "../types";

/** `<input type="color">` only accepts #rrggbb, so rgba() values get a text box. */
function isHex(value: string): boolean {
  return /^#[0-9a-f]{6}$/i.test(value.trim());
}

function Field({
  field,
  settings,
  onChange,
}: {
  field: SettingsField;
  settings: EditorSettings;
  onChange: (patch: Partial<EditorSettings>) => void;
}) {
  const value = settings[field.key];

  if (field.kind === "select") {
    return (
      <select
        className="ate-select"
        value={String(value)}
        onChange={(e) => onChange({ [field.key]: e.target.value } as Partial<EditorSettings>)}
        data-testid={`ate-setting-${field.key}`}
      >
        {(field.options ?? []).map((opt) => (
          <option key={opt.value} value={opt.value}>
            {opt.label}
          </option>
        ))}
      </select>
    );
  }

  if (field.kind === "number") {
    return (
      <input
        className="ate-input"
        type="number"
        min={field.min}
        max={field.max}
        value={Number(value)}
        onChange={(e) => {
          const n = Number(e.target.value);
          if (Number.isFinite(n)) onChange({ [field.key]: n } as Partial<EditorSettings>);
        }}
        data-testid={`ate-setting-${field.key}`}
      />
    );
  }

  const text = String(value);
  return (
    <div className="ate-color-row">
      <input
        type="color"
        value={isHex(text) ? text : "#000000"}
        onChange={(e) => onChange({ [field.key]: e.target.value } as Partial<EditorSettings>)}
        aria-label={`${field.label} colour picker`}
      />
      <input
        className="ate-input"
        value={text}
        onChange={(e) => onChange({ [field.key]: e.target.value } as Partial<EditorSettings>)}
        data-testid={`ate-setting-${field.key}`}
      />
    </div>
  );
}

type SettingsTab = "appearance" | "styles";

export function SettingsPanel({
  settings,
  onChange,
  onClose,
}: {
  settings: EditorSettings;
  onChange: (patch: Partial<EditorSettings>) => void;
  onClose: () => void;
}) {
  const [tab, setTab] = useState<SettingsTab>("appearance");
  const typography = SETTINGS_FIELDS.filter((f) => f.kind !== "color");
  const colours = SETTINGS_FIELDS.filter((f) => f.kind === "color");

  return (
    <div className="ate-scrim" role="dialog" aria-modal="true" aria-label="Editor settings" data-testid="ate-settings-panel">
      <div className="ate-dialog" style={{ width: "min(880px, 94vw)", maxHeight: "90%" }}>
        <div className="ate-dialog-header">
          <Settings2 size={14} strokeWidth={1.9} />
          <h3>Editor settings</h3>
          {tab === "appearance" && (
            <button
              type="button"
              className="ate-btn"
              onClick={() => onChange({ ...DEFAULT_SETTINGS })}
              aria-label="Reset to defaults"
              data-testid="ate-settings-reset"
            >
              <RotateCcw size={13} strokeWidth={1.9} />
              Reset to defaults
            </button>
          )}
          <button className="ate-btn-icon" onClick={onClose} aria-label="Close settings">
            <X size={14} strokeWidth={2} />
          </button>
        </div>

        <div className="ate-settings-tabs" role="tablist" aria-label="Settings sections">
          <button
            type="button"
            role="tab"
            aria-selected={tab === "appearance"}
            className={`ate-settings-tab${tab === "appearance" ? " ate-settings-tab-active" : ""}`}
            onClick={() => setTab("appearance")}
            data-testid="ate-settings-tab-appearance"
          >
            <Palette size={14} strokeWidth={1.9} />
            Appearance
          </button>
          <button
            type="button"
            role="tab"
            aria-selected={tab === "styles"}
            className={`ate-settings-tab${tab === "styles" ? " ate-settings-tab-active" : ""}`}
            onClick={() => setTab("styles")}
            data-testid="ate-settings-tab-styles"
          >
            <Layers size={14} strokeWidth={1.9} />
            Custom Styles
          </button>
        </div>

        <div className="ate-dialog-body">
          {tab === "appearance" ? (
            <>
              <div className="ate-settings-group">
                <h4>Typography</h4>
                {typography.map((field) => (
                  <div className="ate-field" key={field.key}>
                    <label>
                      {field.label}
                      {field.help ? ` (${field.help})` : ""}
                    </label>
                    <Field field={field} settings={settings} onChange={onChange} />
                  </div>
                ))}
              </div>

              <div className="ate-settings-group">
                <h4>Colours</h4>
                {colours.map((field) => (
                  <div className="ate-field" key={field.key}>
                    <label>{field.label}</label>
                    <Field field={field} settings={settings} onChange={onChange} />
                  </div>
                ))}
              </div>

              <div className="ate-note">
                Changes apply immediately to both edit and preview modes, and are kept across restarts.
              </div>
            </>
          ) : (
            <CustomStylesPanel />
          )}
        </div>

        <div className="ate-dialog-footer">
          <button type="button" className="ate-btn ate-btn-primary" onClick={onClose} data-testid="ate-settings-done">
            Done
          </button>
        </div>
      </div>
    </div>
  );
}
