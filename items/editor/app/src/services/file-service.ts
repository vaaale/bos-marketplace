// VFS file operations for the editor (T005).
//
// This module is the ONLY place that touches the file system. It builds and
// persists `EditorDocument`s; it never mutates the store — the store calls in
// here and applies the result, which keeps "what is on disk" and "what is in
// the buffer" cleanly separated (FR-012).

import { vfsList, vfsRead, vfsWrite } from "./bos";
import { getForFilename } from "./format-service";
import type { EditorDocument } from "../types";
import type { VfsEntry } from "../types-vfs";

/** The user's VFS root — paths in this app are always absolute from here. */
export const VFS_ROOT = "/";

let counter = 0;

/** App-local document id. Monotonic + random so ids are unique per instance. */
function newId(): string {
  counter += 1;
  return `doc-${Date.now().toString(36)}-${counter}-${Math.random().toString(36).slice(2, 7)}`;
}

export function basename(path: string): string {
  const clean = path.replace(/\/+$/, "");
  const slash = clean.lastIndexOf("/");
  return slash >= 0 ? clean.slice(slash + 1) : clean;
}

export function dirname(path: string): string {
  const clean = path.replace(/\/+$/, "");
  const slash = clean.lastIndexOf("/");
  if (slash <= 0) return "/";
  return clean.slice(0, slash);
}

/** Normalise a user- or agent-supplied path to an absolute VFS path. */
export function normalizePath(path: string): string {
  const trimmed = path.trim();
  if (!trimmed) return "";
  return trimmed.startsWith("/") ? trimmed.replace(/\/{2,}/g, "/") : `/${trimmed.replace(/\/{2,}/g, "/")}`;
}

/** List a directory, folders first then files, both alphabetical. */
export async function listDirectory(path: string): Promise<VfsEntry[]> {
  const entries = await vfsList(normalizePath(path) || VFS_ROOT);
  return [...entries].sort((a, b) => {
    if (a.type !== b.type) return a.type === "dir" ? -1 : 1;
    return a.name.localeCompare(b.name);
  });
}

/**
 * Read a file into a fresh document. The buffer and the on-disk snapshot start
 * equal, so a just-opened document is never dirty.
 */
export async function openFile(path: string): Promise<EditorDocument> {
  const abs = normalizePath(path);
  if (!abs) throw new Error("A file path is required.");
  const content = await vfsRead(abs);
  const filename = basename(abs);
  return {
    id: newId(),
    filename,
    path: abs,
    content,
    savedContent: content,
    formatId: getForFilename(filename).id,
    lastSaved: Date.now(),
    createdAt: Date.now(),
  };
}

/**
 * A new, untitled document. It has no path until it is first saved, which is
 * why `saveFile` requires one to be supplied for untitled documents.
 */
export function createDocument(filename?: string): EditorDocument {
  const name = (filename ?? "").trim() || "Untitled";
  return {
    id: newId(),
    filename: name,
    path: null,
    content: "",
    savedContent: "",
    formatId: getForFilename(name).id,
    lastSaved: null,
    createdAt: Date.now(),
  };
}

/**
 * Persist a document's buffer to disk. `targetPath` is required for a document
 * that has never been saved; for one loaded from disk it defaults to its own
 * path. Returns the document as it now exists on disk.
 */
export async function saveFile(doc: EditorDocument, targetPath?: string): Promise<EditorDocument> {
  const abs = normalizePath(targetPath ?? doc.path ?? "");
  if (!abs) {
    throw new Error(`"${doc.filename}" has never been saved — a target path is required.`);
  }
  await vfsWrite(abs, doc.content);
  return {
    ...doc,
    path: abs,
    filename: basename(abs),
    savedContent: doc.content,
    formatId: getForFilename(basename(abs)).id,
    lastSaved: Date.now(),
  };
}

export function isDirty(doc: EditorDocument): boolean {
  return doc.content !== doc.savedContent;
}

/**
 * Save every dirty document that already has a path. Untitled documents are
 * reported back rather than silently skipped — the caller decides what to do
 * with them (the UI prompts; the assistant tool says so in its result).
 */
export async function saveAll(
  docs: EditorDocument[],
): Promise<{ saved: EditorDocument[]; skipped: EditorDocument[]; failures: { doc: EditorDocument; error: string }[] }> {
  const saved: EditorDocument[] = [];
  const skipped: EditorDocument[] = [];
  const failures: { doc: EditorDocument; error: string }[] = [];
  for (const doc of docs) {
    if (!isDirty(doc)) continue;
    if (!doc.path) {
      skipped.push(doc);
      continue;
    }
    try {
      saved.push(await saveFile(doc));
    } catch (err) {
      failures.push({ doc, error: (err as Error).message });
    }
  }
  return { saved, skipped, failures };
}

/** Search a document's content, returning matching lines with context. */
export function searchContent(
  content: string,
  query: string,
  contextLines = 1,
): { line: number; text: string; context: string }[] {
  if (!query) return [];
  const needle = query.toLowerCase();
  const lines = content.split("\n");
  const hits: { line: number; text: string; context: string }[] = [];
  for (let i = 0; i < lines.length; i++) {
    if (!lines[i].toLowerCase().includes(needle)) continue;
    const from = Math.max(0, i - contextLines);
    const to = Math.min(lines.length, i + contextLines + 1);
    hits.push({ line: i + 1, text: lines[i], context: lines.slice(from, to).join("\n") });
  }
  return hits;
}
