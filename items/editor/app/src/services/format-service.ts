// Document format registry (T006 / T011, FR-017).
//
// The rest of the app never imports a handler directly — it asks the registry.
// That is what makes formats pluggable: supporting HTML or YAML is one new
// module plus one `register()` call, with no change to the editor, the preview,
// the store, or the assistant tools (SC-007).

import type { FormatHandler } from "../types";
import { htmlHandler } from "./formats/html";
import { markdownHandler } from "./formats/markdown";
import { plaintextHandler } from "./formats/plaintext";

const handlers = new Map<string, FormatHandler>();
/** Extension (with dot, lower-case) → handler id. */
const byExtension = new Map<string, string>();

/** Register (or replace) a format handler. Later registrations win. */
export function register(handler: FormatHandler): void {
  handlers.set(handler.id, handler);
  for (const ext of handler.extensions) {
    if (ext) byExtension.set(ext.toLowerCase(), handler.id);
  }
}

/** Every registered handler, in registration order. */
export function list(): FormatHandler[] {
  return [...handlers.values()];
}

/** A handler by id, or the fallback when the id is unknown. */
export function get(id: string | undefined): FormatHandler {
  return (id ? handlers.get(id) : undefined) ?? plaintextHandler;
}

/** A handler by file extension (".md"), or the fallback. */
export function getByExtension(ext: string): FormatHandler {
  return get(byExtension.get(ext.toLowerCase()));
}

/** The extension of a filename including the dot, or "" when it has none. */
export function extensionOf(filename: string): string {
  const dot = filename.lastIndexOf(".");
  return dot > 0 ? filename.slice(dot).toLowerCase() : "";
}

/** The handler that should own a given filename. */
export function getForFilename(filename: string): FormatHandler {
  return getByExtension(extensionOf(filename));
}

/**
 * The id of the handler a filename resolves to — the DERIVED form of a
 * document's `formatId`.
 *
 * `EditorDocument.formatId` is a *cache* of this, never an independent choice:
 * every place that sets it (open, create, save-as, rename) calls straight
 * through here. That matters when the registry gains a format, which is exactly
 * what v3 did with HTML: a `.html` document persisted by an older build carries
 * a stale `"plaintext"` id, and re-deriving it from the filename is what makes
 * the new handler take effect. See the store's hydration path.
 */
export function formatIdFor(filename: string): string {
  return getForFilename(filename).id;
}

/** Render a document's buffer to preview HTML using its own handler. */
export function render(formatId: string, content: string): string {
  return get(formatId).render(content);
}

// The defaults that ship with the app. Later registrations win a contested
// extension, so the order is: plaintext (the catch-all fallback), then the
// formats that claim specific extensions. None of these three overlap.
register(plaintextHandler);
register(markdownHandler);
register(htmlHandler);
