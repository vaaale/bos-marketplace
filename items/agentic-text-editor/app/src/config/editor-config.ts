// The editor's config namespace (T009 / T041 / T046).
//
// BOS's own `src/lib/config/registry.ts` namespaces are for BUILT-IN surfaces —
// an installed app cannot register into them without changing BOS source. So
// this module is the app's equivalent: one declarative field list that drives
// the in-app Settings panel, plus load/save against the per-app key/value store
// the `storage` capability provides. Persistence across restarts (FR-019) is
// therefore handled here, not by the caller.

import type { CSSProperties } from "react";
import { storageGet, storageSet } from "../services/bos";
import type { EditorSettings } from "../types";

export const CONFIG_NAMESPACE = "agentic-text-editor.appearance";

export const DEFAULT_SETTINGS: EditorSettings = {
  fontFamily: "'SF Mono', 'Fira Code', 'JetBrains Mono', Consolas, monospace",
  fontSize: 13,
  h1Color: "#f5f5f5",
  h2Color: "#d0d0d0",
  h3Color: "#c4b5fd",
  linkColor: "#a78bfa",
  codeBlockBackground: "rgba(0,0,0,0.25)",
  codeBlockForeground: "#c8d0dc",
  textColor: "#c8d0dc",
};

export type SettingsFieldKind = "select" | "number" | "color";

export interface SettingsField {
  key: keyof EditorSettings;
  label: string;
  kind: SettingsFieldKind;
  /** For "select". */
  options?: { value: string; label: string }[];
  /** For "number". */
  min?: number;
  max?: number;
  help?: string;
}

export const FONT_FAMILIES: { value: string; label: string }[] = [
  { value: "'SF Mono', 'Fira Code', 'JetBrains Mono', Consolas, monospace", label: "Monospace" },
  { value: "-apple-system, BlinkMacSystemFont, 'Segoe UI', Roboto, sans-serif", label: "System sans" },
  { value: "Georgia, 'Times New Roman', serif", label: "Serif" },
  { value: "'Geist Sans', 'Inter', system-ui, sans-serif", label: "Geist Sans" },
];

/** The field list the Settings panel renders. Adding a setting is one entry. */
export const SETTINGS_FIELDS: SettingsField[] = [
  { key: "fontFamily", label: "Font family", kind: "select", options: FONT_FAMILIES },
  { key: "fontSize", label: "Font size", kind: "number", min: 9, max: 28, help: "px" },
  { key: "textColor", label: "Body text", kind: "color" },
  { key: "h1Color", label: "Heading 1", kind: "color" },
  { key: "h2Color", label: "Heading 2", kind: "color" },
  { key: "h3Color", label: "Heading 3", kind: "color" },
  { key: "linkColor", label: "Links", kind: "color" },
  { key: "codeBlockBackground", label: "Code background", kind: "color" },
  { key: "codeBlockForeground", label: "Code text", kind: "color" },
];

function coerce(raw: unknown): EditorSettings {
  const src = (raw ?? {}) as Partial<EditorSettings>;
  const out = { ...DEFAULT_SETTINGS };
  for (const field of SETTINGS_FIELDS) {
    const value = src[field.key];
    if (field.kind === "number") {
      if (typeof value === "number" && Number.isFinite(value)) {
        out.fontSize = Math.min(field.max ?? 28, Math.max(field.min ?? 9, Math.round(value)));
      }
    } else if (typeof value === "string" && value.trim()) {
      (out[field.key] as string) = value;
    }
  }
  return out;
}

/** Read the persisted settings, falling back to the defaults. */
export async function loadSettings(): Promise<EditorSettings> {
  const raw = await storageGet(CONFIG_NAMESPACE);
  if (!raw) return { ...DEFAULT_SETTINGS };
  try {
    return coerce(JSON.parse(raw));
  } catch {
    return { ...DEFAULT_SETTINGS };
  }
}

/** Persist the settings. Called on every change from the Settings panel. */
export async function saveSettings(settings: EditorSettings): Promise<void> {
  await storageSet(CONFIG_NAMESPACE, JSON.stringify(coerce(settings)));
}

/**
 * Settings expressed as CSS custom properties. Both the edit view and the
 * preview view mount them on their root element, so a change is reflected in
 * both modes immediately (T042–T045) without re-rendering the whole app.
 */
export function settingsToCssVars(settings: EditorSettings): CSSProperties {
  return {
    ["--ate-font-family" as string]: settings.fontFamily,
    ["--ate-font-size" as string]: `${settings.fontSize}px`,
    ["--ate-text" as string]: settings.textColor,
    ["--ate-h1" as string]: settings.h1Color,
    ["--ate-h2" as string]: settings.h2Color,
    ["--ate-h3" as string]: settings.h3Color,
    ["--ate-link" as string]: settings.linkColor,
    ["--ate-code-bg" as string]: settings.codeBlockBackground,
    ["--ate-code-fg" as string]: settings.codeBlockForeground,
  } as CSSProperties;
}
