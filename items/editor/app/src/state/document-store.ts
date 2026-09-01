// The app's document state (T004).
//
// Holds the documents (their INTERNAL BUFFERS), the tab selection, and the
// appearance settings. Both the user's keystrokes and the agent's tool calls
// write through the same `setContent` action, so a concurrent edit is simply
// last-write-wins on one buffer (T040) and an agent edit shows up in the left
// pane on the next render (SC-002).
//
// The chat used to live here too. It does not any more (v2): transcripts are
// server-owned files and the conversation index is its own store, so this one
// is about documents and nothing else.
//
// Nothing here touches the file system: persistence to disk happens only when
// something explicitly calls the file service (FR-012).

import { create } from "zustand";
import {
  createDocument as makeDocument,
  isDirty,
  openFile,
  saveAll as saveAllFiles,
  saveFile,
} from "../services/file-service";
import { formatIdFor, getForFilename } from "../services/format-service";
import { DEFAULT_SETTINGS, loadSettings, saveSettings } from "../config/editor-config";
import { storageGet, storageSet } from "../services/bos";
import type {
  CursorPosition,
  EditorDocument,
  EditorSettings,
  PersistedState,
  Tab,
  ViewMode,
} from "../types";

/** The editor snapshot key. Exported because the chat store reads a v1
 *  snapshot once, to adopt the single conversation v1 owned. */
export const STATE_KEY = "agentic-text-editor.state";
const PERSIST_DEBOUNCE_MS = 50;
/** This app's id — the KV namespace `/api/app-storage` keys writes under. Only
 *  the unload beacon needs it; every other write goes through the SDK broker. */
const APP_ID = "agentic-text-editor";

export interface EditorState {
  documents: EditorDocument[];
  activeDocumentId: string | null;
  viewMode: ViewMode;
  splitPercent: number;
  cursor: CursorPosition;
  settings: EditorSettings;
  /** Set briefly after an agent tool changed a buffer (T026). */
  lastAgentEdit: { documentId: string; at: number; summary: string } | null;
  /** False until the persisted snapshot has been merged in. */
  hydrated: boolean;

  // documents ------------------------------------------------------------
  createDocument(filename?: string): EditorDocument;
  openPath(path: string): Promise<EditorDocument>;
  closeDocument(id: string): void;
  setActiveDocument(id: string): boolean;
  setContent(id: string, content: string, source: "user" | "agent", summary?: string): boolean;
  renameDocument(id: string, filename: string): void;
  saveDocument(id: string, targetPath?: string): Promise<EditorDocument>;
  saveAll(): Promise<{ saved: string[]; skipped: string[]; failures: string[] }>;
  getDocument(id: string | null | undefined): EditorDocument | undefined;
  getActiveDocument(): EditorDocument | undefined;

  // view -----------------------------------------------------------------
  setViewMode(mode: ViewMode): void;
  setSplitPercent(pct: number): void;
  setCursor(cursor: CursorPosition): void;

  // settings -------------------------------------------------------------
  updateSettings(patch: Partial<EditorSettings>): void;

  // lifecycle ------------------------------------------------------------
  hydrate(): Promise<void>;
}

/** Clamp the left pane to the 25–60% range the design calls for. */
export function clampSplit(pct: number): number {
  return Math.max(25, Math.min(60, pct));
}

export const useEditorStore = create<EditorState>((set, get) => ({
  documents: [],
  activeDocumentId: null,
  viewMode: "edit",
  splitPercent: 45,
  cursor: { line: 1, column: 1 },
  settings: { ...DEFAULT_SETTINGS },
  lastAgentEdit: null,
  hydrated: false,

  // ---------------------------------------------------------------- documents

  createDocument(filename) {
    const doc = makeDocument(filename);
    set((s) => ({ documents: [...s.documents, doc], activeDocumentId: doc.id }));
    return doc;
  },

  async openPath(path) {
    // Already open? Bring that tab to the front instead of opening a duplicate.
    const existing = get().documents.find((d) => d.path === path);
    if (existing) {
      set({ activeDocumentId: existing.id });
      return existing;
    }
    const doc = await openFile(path);
    set((s) => ({ documents: [...s.documents, doc], activeDocumentId: doc.id }));
    return doc;
  },

  closeDocument(id) {
    set((s) => {
      const index = s.documents.findIndex((d) => d.id === id);
      if (index === -1) return s;
      const documents = s.documents.filter((d) => d.id !== id);
      let activeDocumentId = s.activeDocumentId;
      if (activeDocumentId === id) {
        // Prefer the neighbour to the right, then the one to the left.
        const next = documents[index] ?? documents[index - 1] ?? null;
        activeDocumentId = next ? next.id : null;
      }
      return { ...s, documents, activeDocumentId };
    });
  },

  setActiveDocument(id) {
    if (!get().documents.some((d) => d.id === id)) return false;
    set({ activeDocumentId: id });
    return true;
  },

  setContent(id, content, source, summary) {
    let found = false;
    set((s) => {
      const documents = s.documents.map((d) => {
        if (d.id !== id) return d;
        found = true;
        return { ...d, content };
      });
      if (!found) return s;
      return {
        ...s,
        documents,
        lastAgentEdit:
          source === "agent" ? { documentId: id, at: Date.now(), summary: summary ?? "edited" } : s.lastAgentEdit,
      };
    });
    return found;
  },

  renameDocument(id, filename) {
    set((s) => ({
      documents: s.documents.map((d) =>
        d.id === id ? { ...d, filename, formatId: getForFilename(filename).id } : d,
      ),
    }));
  },

  async saveDocument(id, targetPath) {
    const doc = get().documents.find((d) => d.id === id);
    if (!doc) throw new Error(`No open document with id "${id}".`);
    const saved = await saveFile(doc, targetPath);
    // Re-read the buffer: the user (or the agent) may have typed while the
    // write was in flight, and those keystrokes must stay unsaved rather than
    // being clobbered by the snapshot we just wrote.
    set((s) => ({
      documents: s.documents.map((d) =>
        d.id === id
          ? {
              ...d,
              path: saved.path,
              filename: saved.filename,
              formatId: saved.formatId,
              savedContent: saved.savedContent,
              lastSaved: saved.lastSaved,
            }
          : d,
      ),
    }));
    return saved;
  },

  async saveAll() {
    const result = await saveAllFiles(get().documents);
    set((s) => ({
      documents: s.documents.map((d) => {
        const saved = result.saved.find((x) => x.id === d.id);
        return saved
          ? { ...d, path: saved.path, savedContent: saved.savedContent, lastSaved: saved.lastSaved }
          : d;
      }),
    }));
    return {
      saved: result.saved.map((d) => d.filename),
      skipped: result.skipped.map((d) => d.filename),
      failures: result.failures.map((f) => `${f.doc.filename}: ${f.error}`),
    };
  },

  getDocument(id) {
    if (!id) return undefined;
    return get().documents.find((d) => d.id === id);
  },

  getActiveDocument() {
    const { documents, activeDocumentId } = get();
    return documents.find((d) => d.id === activeDocumentId);
  },

  // ---------------------------------------------------------------- view

  setViewMode(mode) {
    set({ viewMode: mode });
  },
  setSplitPercent(pct) {
    set({ splitPercent: clampSplit(pct) });
  },
  setCursor(cursor) {
    set({ cursor });
  },

  // ---------------------------------------------------------------- settings

  updateSettings(patch) {
    const settings = { ...get().settings, ...patch };
    set({ settings });
    void saveSettings(settings);
  },

  // ---------------------------------------------------------------- lifecycle

  async hydrate() {
    if (get().hydrated) return;
    const [raw, settings] = await Promise.all([storageGet(STATE_KEY), loadSettings()]);
    // The KV store is the cross-profile source of truth, but its writes are
    // debounced — so the synchronous localStorage mirror can be newer (the
    // pagehide flush's KV call is routinely killed by the unload). Take
    // whichever of the two snapshots is fresher; see `fresherSnapshot`.
    const snapshot = fresherSnapshot(parseSnapshot(raw), readLocalSnapshot()) ?? {};
    const documents = documentsOf(snapshot);
    const activeDocumentId =
      typeof snapshot.activeDocumentId === "string" && documents.some((d) => d.id === snapshot.activeDocumentId)
        ? snapshot.activeDocumentId
        : (documents[0]?.id ?? null);
    set({
      documents,
      activeDocumentId,
      viewMode: snapshot.viewMode === "preview" ? "preview" : "edit",
      splitPercent: clampSplit(typeof snapshot.splitPercent === "number" ? snapshot.splitPercent : 45),
      settings,
      hydrated: true,
    });
  },
}));

function isDocument(value: unknown): value is EditorDocument {
  const d = value as EditorDocument | null;
  return !!d && typeof d.id === "string" && typeof d.content === "string" && typeof d.filename === "string";
}

// ------------------------------------------------------------------ selectors

/**
 * Tabs derived from the documents — the tab bar never holds its own state.
 *
 * Takes the two fields rather than the whole state so a component can subscribe
 * to `documents` and `activeDocumentId` and memoise the derived array. Passing
 * this to `useEditorStore()` directly would hand React a fresh array on every
 * snapshot read, which is exactly the "getSnapshot should be cached" loop.
 */
export function tabsFrom(documents: EditorDocument[], activeDocumentId: string | null): Tab[] {
  return documents.map((doc, index) => ({
    documentId: doc.id,
    visibleName: doc.filename,
    index,
    isActive: doc.id === activeDocumentId,
    isDirty: isDirty(doc),
  }));
}

export function selectTabs(state: EditorState): Tab[] {
  return tabsFrom(state.documents, state.activeDocumentId);
}

export { isDirty };

// ------------------------------------------------------------------ persistence
//
// FR-019/020: tabs, buffers and settings survive an app restart. Two writes per
// change: a synchronous localStorage mirror (always current, same profile only)
// and a debounced KV write (durable and cross-profile, but async — so it can be
// cut short by an unload). Hydration reads both and takes the fresher one. Chat
// history is NOT here — it is server-owned and re-read per conversation
// (FR-021, v2).

let persistTimer: ReturnType<typeof setTimeout> | null = null;

function snapshotOf(state: EditorState): PersistedState {
  return {
    version: 2,
    documents: state.documents,
    activeDocumentId: state.activeDocumentId,
    viewMode: state.viewMode,
    splitPercent: state.splitPercent,
    settings: state.settings,
  };
}

/**
 * Mirror the snapshot into localStorage, synchronously and undebounced.
 *
 * Why both stores: the KV write is async AND debounced, so the one that matters
 * most — the `pagehide` flush — is regularly aborted by the browser as the
 * document goes away, leaving the KV store a snapshot behind and losing the
 * user's tabs across a restart. `localStorage.setItem` completes before the
 * event handler returns, so this copy is always current for THIS profile. The
 * KV store keeps its job as the durable, cross-profile store.
 *
 * Same key, same shape as the KV entry (and as bos.ts's own storage fallback),
 * so whichever one hydrate reads it parses identically.
 */
function writeLocalSnapshot(snapshot: PersistedState): void {
  try {
    window.localStorage.setItem(STATE_KEY, JSON.stringify(snapshot));
  } catch {
    /* no localStorage (private mode, quota, a sandbox that denies it) — the KV
       store is still being written, so this is a lost cache, not lost state. */
  }
}

function parseSnapshot(raw: string | null): Partial<PersistedState> | null {
  if (!raw) return null;
  try {
    const parsed = JSON.parse(raw) as Partial<PersistedState> | null;
    return parsed && typeof parsed === "object" ? parsed : null;
  } catch {
    return null;
  }
}

function readLocalSnapshot(): Partial<PersistedState> | null {
  try {
    return parseSnapshot(window.localStorage.getItem(STATE_KEY));
  } catch {
    return null;
  }
}

/**
 * Re-derive a restored document's `formatId` from its filename.
 *
 * `formatId` is derived state that happens to be persisted alongside the
 * buffer, so a snapshot can only ever be as clever as the build that wrote it:
 * a `.html` tab saved before the HTML handler existed comes back pointing at
 * `"plaintext"`, and — because nothing else recomputes it — would stay there
 * forever, previewing as escaped source instead of a rendered page. Deriving it
 * again on the way in means adding a format is retroactive for documents that
 * are already open, which is the whole promise of the registry (FR-017).
 *
 * Safe to do unconditionally: the filename is the ONLY input to the format
 * anywhere in the app (open, create, save-as and rename all resolve the same
 * way), so this can never override a user's choice — there is no such choice.
 */
function withResolvedFormat(doc: EditorDocument): EditorDocument {
  const formatId = formatIdFor(doc.filename);
  return doc.formatId === formatId ? doc : { ...doc, formatId };
}

function documentsOf(snapshot: Partial<PersistedState> | null): EditorDocument[] {
  return snapshot && Array.isArray(snapshot.documents)
    ? snapshot.documents.filter(isDocument).map(withResolvedFormat)
    : [];
}

/** The most recent save recorded in a snapshot, or 0 if nothing was ever saved. */
function newestSave(documents: EditorDocument[]): number {
  return documents.reduce((max, d) => (typeof d.lastSaved === "number" && d.lastSaved > max ? d.lastSaved : max), 0);
}

/**
 * Choose between the KV snapshot and the localStorage mirror.
 *
 * More documents wins (a snapshot that predates opening a tab can only be
 * older); on a tie, the more recent `lastSaved` wins; on a full tie the KV
 * store wins, since it is the real store and the two are then equivalent.
 */
function fresherSnapshot(
  kv: Partial<PersistedState> | null,
  local: Partial<PersistedState> | null,
): Partial<PersistedState> | null {
  if (!local) return kv;
  if (!kv) return local;
  const kvDocs = documentsOf(kv);
  const localDocs = documentsOf(local);
  if (localDocs.length !== kvDocs.length) return localDocs.length > kvDocs.length ? local : kv;
  return newestSave(localDocs) > newestSave(kvDocs) ? local : kv;
}

/** Start persisting state changes. Returns an unsubscribe function. */
export function startPersistence(): () => void {
  const unsubscribe = useEditorStore.subscribe((state) => {
    if (!state.hydrated) return;
    // Synchronous mirror first: it must be current even if the tab dies before
    // the debounced KV write below ever fires.
    writeLocalSnapshot(snapshotOf(state));
    if (persistTimer) clearTimeout(persistTimer);
    persistTimer = setTimeout(() => {
      void storageSet(STATE_KEY, JSON.stringify(snapshotOf(useEditorStore.getState())));
    }, PERSIST_DEBOUNCE_MS);
  });
  return () => {
    if (persistTimer) clearTimeout(persistTimer);
    unsubscribe();
  };
}

/**
 * The unload-proof KV write: a same-origin `fetch` with `keepalive: true`.
 *
 * The ordinary path (`storageSet`) is a promise chain — await the SDK, then a
 * broker round trip or a plain fetch — and the browser cancels in-flight
 * requests as the document goes away, so the write that matters most, the one
 * on `pagehide`, routinely never reached the server. `keepalive` is the browser
 * API for precisely this case: the request outlives the document that issued
 * it, which is why beacons are written this way.
 *
 * It has to bypass the SDK: `keepalive` is a property of THIS fetch, and the
 * broker's postMessage hop (plus the parent's own fetch) cannot be flagged from
 * in here. That costs nothing while the item is served locally — the app is
 * same-origin with BOS — and the caller falls back to `storageSet` when this
 * returns false, which covers an opaque-origin serving.
 *
 * Body shape is the /api/app-storage contract: `{app, op, key, value}`.
 *
 * Returns false when the beacon was not attempted, so the caller can fall back.
 */
function keepaliveStorageSet(key: string, value: string): boolean {
  // `keepalive` bodies are capped at 64 KB by the fetch spec; over that the
  // request is rejected outright, so a big snapshot is better off on the normal
  // path (which at least sometimes survives) than on a beacon that cannot send.
  if (value.length > 60_000) return false;
  try {
    void fetch("/api/app-storage", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ app: APP_ID, op: "set", key, value }),
      keepalive: true,
      credentials: "same-origin",
    }).catch(() => {
      /* unloading — there is nobody left to retry or report to */
    });
    return true;
  } catch {
    return false;
  }
}

/** Flush immediately — used when the window is about to go away. */
export function flushPersistence(): void {
  const state = useEditorStore.getState();
  if (!state.hydrated) return;
  const snapshot = snapshotOf(state);
  const serialized = JSON.stringify(snapshot);
  // localStorage lands before we return (same profile only), and the KV write
  // goes out as a keepalive beacon so it survives the unload too.
  writeLocalSnapshot(snapshot);
  if (!keepaliveStorageSet(STATE_KEY, serialized)) {
    void storageSet(STATE_KEY, serialized);
  }
}
