// The app's single state store (T004).
//
// Holds the documents (their INTERNAL BUFFERS), the tab selection, the global
// chat transcript, and the appearance settings. Both the user's keystrokes and
// the agent's tool calls write through the same `setContent` action, so a
// concurrent edit is simply last-write-wins on one buffer (T040) and an agent
// edit shows up in the left pane on the next render (SC-002).
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
import { getForFilename } from "../services/format-service";
import { DEFAULT_SETTINGS, loadSettings, saveSettings } from "../config/editor-config";
import { storageGet, storageSet } from "../services/bos";
import type {
  ChatMessage,
  ChatRole,
  CursorPosition,
  EditorDocument,
  EditorSettings,
  PersistedState,
  Tab,
  ViewMode,
} from "../types";

const STATE_KEY = "agentic-text-editor.state";
const PERSIST_DEBOUNCE_MS = 400;

export interface EditorState {
  documents: EditorDocument[];
  activeDocumentId: string | null;
  viewMode: ViewMode;
  splitPercent: number;
  cursor: CursorPosition;
  messages: ChatMessage[];
  settings: EditorSettings;
  conversationId: string | null;
  /** Set briefly after an agent tool changed a buffer (T026). */
  lastAgentEdit: { documentId: string; at: number; summary: string } | null;
  /** True while an assistant run for this app's chat is in flight. */
  agentBusy: boolean;
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

  // chat -----------------------------------------------------------------
  addMessage(message: Omit<ChatMessage, "id" | "timestamp"> & Partial<Pick<ChatMessage, "id" | "timestamp">>): ChatMessage;
  appendToMessage(id: string, delta: string): void;
  updateMessage(id: string, patch: Partial<ChatMessage>): void;
  clearMessages(): void;
  setAgentBusy(busy: boolean): void;
  setConversationId(id: string): void;

  // settings -------------------------------------------------------------
  updateSettings(patch: Partial<EditorSettings>): void;

  // lifecycle ------------------------------------------------------------
  hydrate(): Promise<void>;
}

let messageCounter = 0;
function newMessageId(): string {
  messageCounter += 1;
  return `msg-${Date.now().toString(36)}-${messageCounter}`;
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
  messages: [],
  settings: { ...DEFAULT_SETTINGS },
  conversationId: null,
  lastAgentEdit: null,
  agentBusy: false,
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

  // ---------------------------------------------------------------- chat

  addMessage(message) {
    const full: ChatMessage = {
      id: message.id ?? newMessageId(),
      timestamp: message.timestamp ?? Date.now(),
      role: message.role as ChatRole,
      content: message.content,
      relatedDocumentId: message.relatedDocumentId,
      streaming: message.streaming,
      toolCalls: message.toolCalls,
      error: message.error,
    };
    set((s) => ({ messages: [...s.messages, full] }));
    return full;
  },

  appendToMessage(id, delta) {
    set((s) => ({
      messages: s.messages.map((m) => (m.id === id ? { ...m, content: m.content + delta } : m)),
    }));
  },

  updateMessage(id, patch) {
    set((s) => ({ messages: s.messages.map((m) => (m.id === id ? { ...m, ...patch } : m)) }));
  },

  clearMessages() {
    set({ messages: [] });
  },

  setAgentBusy(busy) {
    set({ agentBusy: busy });
  },

  setConversationId(id) {
    set({ conversationId: id });
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
    let snapshot: Partial<PersistedState> = {};
    if (raw) {
      try {
        snapshot = JSON.parse(raw) as Partial<PersistedState>;
      } catch {
        snapshot = {};
      }
    }
    const documents = Array.isArray(snapshot.documents) ? snapshot.documents.filter(isDocument) : [];
    const activeDocumentId =
      typeof snapshot.activeDocumentId === "string" && documents.some((d) => d.id === snapshot.activeDocumentId)
        ? snapshot.activeDocumentId
        : (documents[0]?.id ?? null);
    set({
      documents,
      activeDocumentId,
      viewMode: snapshot.viewMode === "preview" ? "preview" : "edit",
      splitPercent: clampSplit(typeof snapshot.splitPercent === "number" ? snapshot.splitPercent : 45),
      messages: Array.isArray(snapshot.messages) ? snapshot.messages.filter(isMessage) : [],
      settings,
      conversationId: typeof snapshot.conversationId === "string" ? snapshot.conversationId : null,
      hydrated: true,
    });
  },
}));

function isDocument(value: unknown): value is EditorDocument {
  const d = value as EditorDocument | null;
  return !!d && typeof d.id === "string" && typeof d.content === "string" && typeof d.filename === "string";
}

function isMessage(value: unknown): value is ChatMessage {
  const m = value as ChatMessage | null;
  return !!m && typeof m.id === "string" && typeof m.content === "string" && typeof m.role === "string";
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
// FR-019/020/021: tabs, buffers, chat history and settings all survive an app
// restart. Debounced so a fast typist doesn't hammer the KV store, and the
// streaming flag is dropped so a snapshot taken mid-run doesn't restore a
// message that will never finish.

let persistTimer: ReturnType<typeof setTimeout> | null = null;

function snapshotOf(state: EditorState): PersistedState {
  return {
    version: 1,
    documents: state.documents,
    activeDocumentId: state.activeDocumentId,
    viewMode: state.viewMode,
    splitPercent: state.splitPercent,
    messages: state.messages.map((m) => ({ ...m, streaming: false })),
    settings: state.settings,
    conversationId: state.conversationId,
  };
}

/** Start persisting state changes. Returns an unsubscribe function. */
export function startPersistence(): () => void {
  const unsubscribe = useEditorStore.subscribe((state) => {
    if (!state.hydrated) return;
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

/** Flush immediately — used when the window is about to go away. */
export function flushPersistence(): void {
  const state = useEditorStore.getState();
  if (!state.hydrated) return;
  void storageSet(STATE_KEY, JSON.stringify(snapshotOf(state)));
}
