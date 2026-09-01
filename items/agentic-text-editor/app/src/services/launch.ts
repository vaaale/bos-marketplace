// The open-file launch contract (v3, BOS feature 036-file-type-handlers).
//
// When the user picks "Open with Editor" on a file, BOS launches this app as a
// FILE HANDLER. An iframe app has no other inbound channel — its `src` is
// always its own manifest URL and it may be running opaque-origin — so the OS
// appends the file to that URL:
//
//   ?bosFilePath=/Documents/report.html&bosFileAction=open|edit
//   [&bosFileTitle=report.html]
//
// (BOS builds these in `withFileParams`, src/components/apps/IframeApp.tsx. The
// `bos` prefix is the OS's guarantee that they never collide with a query param
// the app defines itself.)
//
// This module is PURE parsing: it reads the params once, at import time —
// i.e. before React renders — and hands back a plain descriptor. Reading them
// eagerly matters because the app is free to rewrite its own URL later; the
// launch request is a fact about how this window was opened, not a mutable
// piece of state. Acting on the descriptor (reading the file, opening a tab,
// choosing the view mode) belongs to the app shell, not here.

/** A file BOS asked this window to open when it launched. */
export interface FileLaunch {
  /** Absolute VFS path, e.g. "/Documents/report.html". */
  path: string;
  /** "edit" ⇒ open in Edit mode; "open" ⇒ open in Preview mode. */
  action: "open" | "edit";
  /** Basename the OS supplied, when it did. Advisory only — the app derives the
   *  filename from `path` so a missing or odd title can never rename a file. */
  title: string | null;
}

/**
 * Parse a launch request out of a query string, or null when there isn't one.
 *
 * BOTH params are required, exactly as on the OS side: `bosFilePath` alone is
 * not a handler launch (an app is allowed its own path-ish params), and an
 * `action` outside the contract's two values is not something to guess at.
 */
export function parseFileLaunch(search: string): FileLaunch | null {
  let params: URLSearchParams;
  try {
    params = new URLSearchParams(search);
  } catch {
    return null;
  }
  const path = params.get("bosFilePath");
  const action = params.get("bosFileAction");
  if (!path) return null;
  if (action !== "open" && action !== "edit") return null;
  return { path, action, title: params.get("bosFileTitle") || null };
}

/** Read once, at import time — see the note at the top of the file. */
let pending: FileLaunch | null =
  typeof window === "undefined" ? null : parseFileLaunch(window.location.search);

/** The launch request, without consuming it (for logging/diagnostics). */
export function peekFileLaunch(): FileLaunch | null {
  return pending;
}

/**
 * The launch request, consumed.
 *
 * One-shot on purpose: the params stay in the URL for the life of the frame, so
 * anything that ran twice off them — a remount, a StrictMode double effect —
 * would fight the user over the active tab and the view mode long after the
 * launch was honoured.
 */
export function takeFileLaunch(): FileLaunch | null {
  const launch = pending;
  pending = null;
  return launch;
}
