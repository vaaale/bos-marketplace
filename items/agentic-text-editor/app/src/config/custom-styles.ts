// The custom-style registry (v3, FR-028/FR-029) — the single source of truth
// for name → CSS resolution.
//
// Mirrors `editor-config.ts`: declarative defaults in code plus load/save
// against the per-app key/value store the `storage` capability provides. The
// difference is the consumer: `effectiveCss` is called from inside the markdown
// handler's render pass, which is synchronous — so the persisted half of the
// registry lives in a module-level cache that `loadCustomStyles()` fills during
// hydration and `saveCustomStyles()` keeps current on every edit. A render can
// therefore never block on storage, and a render before hydration simply sees
// the built-ins (which is all a fresh profile has anyway).
//
// Built-in styles ship HERE, in code, never in the store — that is what makes
// their names structurally non-removable (FR-029): the store only ever carries
// the user's own styles and CSS-only overrides of built-in names (ADR-2).

import { storageGet, storageSet } from "../services/bos";
import type { CustomStylesPersistence, NamedStyle } from "../types";

/** The KV key, parallel to editor-config's CONFIG_NAMESPACE. */
export const STYLE_KEY = "agentic-text-editor.custom-styles";

// ---------------------------------------------------------------- built-ins
//
// The shipped set (spec Clarification Q3): Note, Info, Warning, Tip. Each CSS
// value is a plain declaration block — exactly what the Settings editor shows
// and what ends up (escaped) in the container's style attribute.

const NOTE_CSS = [
  "background: rgba(139,92,246,0.12);",
  "border: 1px solid rgba(139,92,246,0.38);",
  "border-left: 3px solid #8b5cf6;",
  "border-radius: 8px;",
  "padding: 12px 16px;",
  "color: #e0d6fc;",
].join("\n");

const INFO_CSS = [
  "background: rgba(56,189,248,0.10);",
  "border: 1px solid rgba(56,189,248,0.34);",
  "border-left: 3px solid #38bdf8;",
  "border-radius: 8px;",
  "padding: 12px 16px;",
  "color: #bae6fd;",
].join("\n");

const WARNING_CSS = [
  "background: rgba(245,158,11,0.12);",
  "border: 1px solid rgba(245,158,11,0.42);",
  "border-left: 3px solid #f59e0b;",
  "border-radius: 8px;",
  "padding: 12px 16px;",
  "color: #fde68a;",
].join("\n");

const TIP_CSS = [
  "background: rgba(16,185,129,0.10);",
  "border: 1px solid rgba(16,185,129,0.34);",
  "border-radius: 8px;",
  "padding: 12px 16px;",
  "color: #a7f3d0;",
].join("\n");

/** Display order for the Settings list. */
const BUILTIN_ORDER = ["Note", "Info", "Warning", "Tip"] as const;

/** The shipped styles, keyed by name. Names fixed; CSS overridable. */
export const BUILTIN_STYLES: Record<string, NamedStyle> = {
  Note: { name: "Note", css: NOTE_CSS, builtin: true },
  Info: { name: "Info", css: INFO_CSS, builtin: true },
  Warning: { name: "Warning", css: WARNING_CSS, builtin: true },
  Tip: { name: "Tip", css: TIP_CSS, builtin: true },
};

/**
 * The fallback for any name not in the registry (US11.3): the block still
 * renders, just neutrally — content is never dropped and nothing throws.
 */
export const NEUTRAL_STYLE: NamedStyle = {
  name: "__neutral__",
  css: [
    "background: rgba(255,255,255,0.04);",
    "border: 1px solid rgba(255,255,255,0.13);",
    "border-radius: 8px;",
    "padding: 12px 16px;",
    "color: #c8d0dc;",
  ].join("\n"),
  builtin: false,
};

// ---------------------------------------------------------------- the cache
//
// Filled by loadCustomStyles() at hydration; kept current by saveCustomStyles.
// Before either has run, renders resolve against the built-ins alone.

function emptyPersistence(): CustomStylesPersistence {
  return { version: 1, user: {}, overrides: {} };
}

let cache: CustomStylesPersistence = emptyPersistence();

function coerce(raw: unknown): CustomStylesPersistence {
  const src = (raw ?? {}) as Partial<CustomStylesPersistence>;
  const out = emptyPersistence();
  if (src.user && typeof src.user === "object") {
    for (const [name, css] of Object.entries(src.user)) {
      if (typeof css === "string" && name.trim() && !BUILTIN_STYLES[name]) out.user[name] = css;
    }
  }
  if (src.overrides && typeof src.overrides === "object") {
    for (const [name, css] of Object.entries(src.overrides)) {
      if (typeof css === "string" && BUILTIN_STYLES[name]) out.overrides[name] = css;
    }
  }
  return out;
}

/**
 * Read the persisted registry into the module cache. Storage degradation is
 * inherited from `services/bos.ts`: a revoked `storage` grant falls back to
 * localStorage / defaults, so built-ins always render and nothing throws — the
 * user's styles simply stop persisting across restarts.
 */
export async function loadCustomStyles(): Promise<CustomStylesPersistence> {
  const raw = await storageGet(STYLE_KEY);
  if (raw) {
    try {
      cache = coerce(JSON.parse(raw));
    } catch {
      cache = emptyPersistence();
    }
  }
  return cache;
}

/** Persist the registry and update the cache the renderer reads. */
export function saveCustomStyles(next: CustomStylesPersistence): void {
  cache = coerce(next);
  void storageSet(STYLE_KEY, JSON.stringify(cache));
}

/** The current registry state (the cache — call after hydration). */
export function getCustomStyles(): CustomStylesPersistence {
  return cache;
}

// ---------------------------------------------------------------- resolution

/**
 * Resolve a style name to its CSS (ADR-2's three-way resolution):
 *
 *   1. built-in name → the override when present, else the shipped default;
 *   2. user style    → the user's CSS;
 *   3. anything else → the neutral fallback (never empty, never throws).
 */
export function effectiveCss(name: string): string {
  const builtin = BUILTIN_STYLES[name];
  if (builtin) return cache.overrides[name] ?? builtin.css;
  const user = cache.user[name];
  if (typeof user === "string") return user;
  return NEUTRAL_STYLE.css;
}

// ---------------------------------------------------------------- UI helpers

/** Built-in names, in display order. */
export function getBuiltinNames(): string[] {
  return [...BUILTIN_ORDER];
}

/** The user's own styles: name → css. A copy — mutate via the store actions. */
export function getUserStyles(): Record<string, string> {
  return { ...cache.user };
}

export function isBuiltin(name: string): boolean {
  return !!BUILTIN_STYLES[name];
}

/** True when a built-in's CSS is currently overridden ("modified" pill). */
export function isOverridden(name: string): boolean {
  return cache.overrides[name] != null;
}

/** A built-in's shipped CSS, or null for non-built-in names. */
export function builtinDefaultCss(name: string): string | null {
  return BUILTIN_STYLES[name]?.css ?? null;
}

/** True when the name exists in the registry (built-in or user). */
export function styleExists(name: string): boolean {
  return !!BUILTIN_STYLES[name] || cache.user[name] != null;
}

// ---------------------------------------------------------------- boxStyle
//
// The mockup's `boxStyle`/`swatchStyle` pattern, shared by the renderer, the
// Settings swatches and the live preview so all three show the same thing: a
// minimal neutral base is PREPENDED (an empty or partial CSS still shows a
// box) and the style's declarations are APPENDED so they win.

const BASE_CSS = "background:rgba(255,255,255,0.05);border-radius:8px;padding:12px 16px;color:#e0e0e0;";

/** The full inline CSS for a styled container: neutral base + the style. */
export function boxCss(css: string): string {
  return BASE_CSS + css;
}

/** Drop one declaration (by property name) from a declaration block. */
function removeDecl(css: string, property: string): string {
  return css
    .split(";")
    .filter((decl) => decl.split(":")[0].trim().toLowerCase() !== property)
    .join(";");
}

/** The swatch variant: padding stripped so the style fits a 56×34 chip. */
export function swatchCss(css: string): string {
  return "background:rgba(255,255,255,0.05);border-radius:7px;" + removeDecl(css, "padding");
}
