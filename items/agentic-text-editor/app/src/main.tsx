"use client";

// Agentic Text Editor — app entry (T021, v2).
//
// Two panes: the left pane edits documents, the right pane talks to the
// BrowserOS assistant, and BOTH write to the same internal buffers. That is the
// whole design — there is no separate "agent copy" of a document to reconcile,
// so an agent edit is visible the instant its tool handler returns (SC-002) and
// a simultaneous keystroke is simply the later write (T040).
//
// Two stores, one per pane, because they answer to different owners: documents
// are this app's (buffers it holds, files it writes), while the chat is a view
// onto conversations BrowserOS owns. The chat pane's transcript therefore never
// depends on which tab is frontmost — it is the active CONVERSATION, global
// across tabs.
//
// This file owns only what genuinely belongs to the shell: which dialog is up,
// the save/save-as/confirm flows, and the app-lifecycle wiring (hydrate,
// persist, window title, and — v3 — honouring an open-file launch). Everything
// else lives in the stores, the services or the components.

import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { createRoot } from "react-dom/client";
import { FilePlus2, FolderOpen, Loader2 } from "lucide-react";

import "./styles.css";

import { ChatHeader } from "./components/chat/chat-header";
import { ChatInput } from "./components/chat/chat-input";
import { ChatMessages } from "./components/chat/chat-messages";
import { ConfirmDialog } from "./components/confirm-dialog";
import { EditView } from "./components/editor/edit-view";
import { PreviewView } from "./components/editor/preview-view";
import { StatusBar } from "./components/editor/status-bar";
import { TabBar } from "./components/editor/tab-bar";
import { Toolbar } from "./components/editor/toolbar";
import { OpenDialog } from "./components/open-dialog";
import { Resizer } from "./components/resizer";
import { SettingsPanel } from "./components/settings-panel";
import { chatMessagesFor, conversationsByRecency, useChatStore } from "./assistant/chat-store";
import { settingsToCssVars } from "./config/editor-config";
import { notify, setWindowTitle } from "./services/bos";
import { basename, dirname, isDirty, normalizePath } from "./services/file-service";
import { get as getFormat } from "./services/format-service";
import { takeFileLaunch } from "./services/launch";
import { flushPersistence, startPersistence, tabsFrom, useEditorStore } from "./state/document-store";
import { registerAppCapabilities } from "./tools/registry";
import type { EditorDocument } from "./types";

/** What to do once a save-as completes — the flow that prompted it continues. */
type AfterSave = "none" | "close" | "open-file";

type Dialog =
  | { type: "open" }
  | { type: "save-as"; documentId: string; after: AfterSave }
  | { type: "confirm-close"; documentId: string }
  | { type: "confirm-open" }
  | null;

const DEFAULT_DIRECTORY = "/Documents";

function App() {
  // ---------------------------------------------------------------- store
  const documents = useEditorStore((s) => s.documents);
  const activeDocumentId = useEditorStore((s) => s.activeDocumentId);
  const viewMode = useEditorStore((s) => s.viewMode);
  const splitPercent = useEditorStore((s) => s.splitPercent);
  const cursor = useEditorStore((s) => s.cursor);
  const settings = useEditorStore((s) => s.settings);
  const lastAgentEdit = useEditorStore((s) => s.lastAgentEdit);
  const hydrated = useEditorStore((s) => s.hydrated);

  // ---------------------------------------------------------------- chat
  const chat = useChatStore();
  const messages = useMemo(() => chatMessagesFor(chat), [chat]);
  const conversations = useMemo(() => conversationsByRecency(chat.conversations), [chat.conversations]);
  // The ONE thing that disables the chat header's controls. The store sets it
  // only after the catalog read has failed every retry, so "not loaded yet"
  // never reads as "unavailable" — that conflation is what left the agent
  // picker, the new-conversation button and the conversation picker inert.
  const assistantUnavailable = chat.assistantError;

  const [dialog, setDialog] = useState<Dialog>(null);
  const [settingsOpen, setSettingsOpen] = useState(false);
  const [saving, setSaving] = useState(false);

  /** The two-pane container — the resizer measures it to turn an x into a %. */
  const containerRef = useRef<HTMLDivElement | null>(null);

  const tabs = useMemo(() => tabsFrom(documents, activeDocumentId), [documents, activeDocumentId]);
  const activeDoc: EditorDocument | undefined = useMemo(
    () => documents.find((d) => d.id === activeDocumentId),
    [documents, activeDocumentId],
  );
  const activeFormat = useMemo(() => getFormat(activeDoc?.formatId), [activeDoc?.formatId]);
  const activeDirty = activeDoc ? isDirty(activeDoc) : false;

  // ---------------------------------------------------------------- lifecycle

  useEffect(() => {
    registerAppCapabilities();
    void useEditorStore.getState().hydrate();
    void useChatStore.getState().init();
    const stop = startPersistence();
    const flush = (): void => flushPersistence();
    window.addEventListener("pagehide", flush);
    return () => {
      flush();
      window.removeEventListener("pagehide", flush);
      stop();
    };
  }, []);

  // The window title carries the document and its unsaved state, so a minimised
  // editor with pending agent edits still says so.
  useEffect(() => {
    if (!hydrated) return;
    const label = activeDoc ? `${activeDirty ? "• " : ""}${activeDoc.filename} — Editor` : "Editor";
    void setWindowTitle(label);
  }, [activeDoc, activeDirty, hydrated]);

  // ---------------------------------------------------------------- helpers

  /** Report a failure where the user is already looking: the chat transcript.
   *  These are the app's own notices, not part of the server-owned conversation,
   *  so they live and die with this session. */
  const reportError = useCallback((message: string) => {
    useChatStore.getState().notice(message, true);
  }, []);

  // A file handed to us by the OS (v3). BOS puts it in the iframe's query
  // string when the app is launched from Files' "Open with" menu; the params
  // were parsed at import time, so all that is left is to act on them.
  //
  // Gated on `hydrate()` having finished: hydration REPLACES the document list
  // with the persisted snapshot, so a tab opened before it lands would be
  // silently thrown away. Waiting also means the de-duplication below sees the
  // restored tabs and can focus an already-open one (the store's `openPath`
  // matches on path) instead of opening the same file twice.
  useEffect(() => {
    if (!hydrated) return;
    const launch = takeFileLaunch();
    if (!launch) return;
    const path = normalizePath(launch.path);
    void useEditorStore
      .getState()
      // Reads the file through the SDK bridge (`window.__bos.fs.read`) — the
      // same path the Open dialog uses, so nothing here is launch-specific.
      .openPath(path)
      .then((doc) => {
        // "edit" opens the source; "open" previews it. A format with no rich
        // preview (a .txt, say) falls back to Edit rather than showing the user
        // a preview pane that is just their own text again.
        const previewable = getFormat(doc.formatId).supportsPreview;
        useEditorStore.getState().setViewMode(launch.action === "edit" || !previewable ? "edit" : "preview");
      })
      .catch((err: Error) => reportError(`Could not open ${path}: ${err.message}`));
  }, [hydrated, reportError]);

  const saveDocument = useCallback(
    async (documentId: string, after: AfterSave): Promise<void> => {
      const store = useEditorStore.getState();
      const doc = store.getDocument(documentId);
      if (!doc) return;
      // A never-saved document has nowhere to go — ask, then resume this flow.
      if (!doc.path) {
        setDialog({ type: "save-as", documentId, after });
        return;
      }
      setSaving(true);
      try {
        await store.saveDocument(documentId);
        void notify(`Saved ${doc.filename}`);
        if (after === "close") store.closeDocument(documentId);
        setDialog(after === "open-file" ? { type: "open" } : null);
      } catch (err) {
        reportError(`Could not save ${doc.filename}: ${(err as Error).message}`);
        setDialog(null);
      } finally {
        setSaving(false);
      }
    },
    [reportError],
  );

  const openPath = useCallback(
    async (path: string): Promise<void> => {
      setDialog(null);
      try {
        await useEditorStore.getState().openPath(path);
      } catch (err) {
        reportError(`Could not open ${path}: ${(err as Error).message}`);
      }
    },
    [reportError],
  );

  // ---------------------------------------------------------------- commands

  /** Open: FR-005, plus the spec's "unsaved changes?" gate before leaving. */
  const requestOpen = useCallback(() => {
    setDialog(activeDoc && activeDirty ? { type: "confirm-open" } : { type: "open" });
  }, [activeDoc, activeDirty]);

  const requestSave = useCallback(() => {
    if (activeDoc) void saveDocument(activeDoc.id, "none");
  }, [activeDoc, saveDocument]);

  const requestNew = useCallback(() => {
    useEditorStore.getState().createDocument();
  }, []);

  /** Close: FR-022 — never discard a buffer (the agent's work included) silently. */
  const requestClose = useCallback((documentId: string) => {
    const store = useEditorStore.getState();
    const doc = store.getDocument(documentId);
    if (doc && isDirty(doc)) setDialog({ type: "confirm-close", documentId });
    else store.closeDocument(documentId);
  }, []);

  // Ctrl/Cmd+S saves — expected of anything that calls itself an editor.
  useEffect(() => {
    const onKeyDown = (e: KeyboardEvent): void => {
      if ((e.metaKey || e.ctrlKey) && e.key.toLowerCase() === "s") {
        e.preventDefault();
        requestSave();
      }
    };
    window.addEventListener("keydown", onKeyDown);
    return () => window.removeEventListener("keydown", onKeyDown);
  }, [requestSave]);

  // ---------------------------------------------------------------- render

  if (!hydrated) {
    return (
      <div className="ate-app">
        <div className="ate-empty" data-testid="ate-loading">
          <Loader2 size={22} strokeWidth={1.6} className="ate-typing" />
          <h3>Restoring your documents…</h3>
        </div>
      </div>
    );
  }

  const dialogDoc = dialog && "documentId" in dialog ? documents.find((d) => d.id === dialog.documentId) : undefined;

  return (
    <div className="ate-app" style={settingsToCssVars(settings)} ref={containerRef}>
      {/* ------------------------------------------------------ editor pane */}
      <div className="ate-editor-pane" style={{ width: `${splitPercent}%` }} data-testid="ate-editor-pane">
        <Toolbar
          viewMode={viewMode}
          canSave={!!activeDoc}
          saving={saving}
          previewSupported={activeFormat.supportsPreview}
          onOpen={requestOpen}
          onSave={requestSave}
          onNew={requestNew}
          onSettings={() => setSettingsOpen(true)}
          onModeChange={(mode) => useEditorStore.getState().setViewMode(mode)}
        />

        <TabBar
          tabs={tabs}
          onSelect={(id) => useEditorStore.getState().setActiveDocument(id)}
          onClose={requestClose}
          onNew={requestNew}
        />

        <div className="ate-editor-body">
          {!activeDoc ? (
            <div className="ate-empty" data-testid="ate-editor-empty">
              <FolderOpen size={26} strokeWidth={1.5} />
              <h3>No document open</h3>
              <p>
                Open a file from your BrowserOS files, start a new one, or just ask the agent on the right to draft
                something.
              </p>
              <div style={{ display: "flex", gap: 8, marginTop: 4 }}>
                <button className="ate-btn" onClick={requestOpen}>
                  <FolderOpen size={13} strokeWidth={1.9} />
                  Open a file
                </button>
                <button className="ate-btn" onClick={requestNew}>
                  <FilePlus2 size={13} strokeWidth={1.9} />
                  New document
                </button>
              </div>
            </div>
          ) : viewMode === "edit" ? (
            <EditView
              documentId={activeDoc.id}
              content={activeDoc.content}
              format={activeFormat}
              onChange={(next) => useEditorStore.getState().setContent(activeDoc.id, next, "user")}
              onCursorChange={(next) => useEditorStore.getState().setCursor(next)}
            />
          ) : (
            <PreviewView content={activeDoc.content} format={activeFormat} />
          )}
        </div>

        <StatusBar
          doc={activeDoc}
          format={activeFormat}
          dirty={activeDirty}
          cursor={cursor}
          agentEdit={lastAgentEdit}
        />
      </div>

      <Resizer containerRef={containerRef} onResize={(pct) => useEditorStore.getState().setSplitPercent(pct)} />

      {/* -------------------------------------------------------- chat pane */}
      <div className="ate-chat-pane" data-testid="ate-chat-pane">
        <ChatHeader
          busy={chat.busy}
          agents={chat.agents}
          selectedAgentId={chat.selectedAgentId}
          conversations={conversations}
          activeConversationId={chat.activeConversationId}
          disabled={!!assistantUnavailable}
          onSelectAgent={(agentId) => chat.selectAgent(agentId)}
          onNewConversation={() => chat.createConversation()}
          onSelectConversation={(id) => void chat.selectConversation(id)}
          onStop={() => void chat.stop()}
        />
        <ChatMessages
          messages={messages}
          conversationId={chat.activeConversationId}
          loading={chat.loadingTranscript}
          unavailable={assistantUnavailable}
          transcriptError={chat.transcriptError}
          retrying={chat.assistantRetrying}
          onRetry={() => void chat.retryAssistant()}
        />
        <ChatInput
          busy={chat.busy}
          disabled={!!assistantUnavailable}
          onSend={(text) => void chat.send(text)}
        />
      </div>

      {/* ---------------------------------------------------------- dialogs */}
      {dialog?.type === "open" && (
        <OpenDialog
          mode="open"
          title="Open a document"
          initialDirectory={activeDoc?.path ? dirname(activeDoc.path) : DEFAULT_DIRECTORY}
          onCancel={() => setDialog(null)}
          onConfirm={(path) => void openPath(path)}
        />
      )}

      {dialog?.type === "save-as" && (
        <OpenDialog
          mode="save"
          title={`Save “${dialogDoc?.filename ?? "document"}” as`}
          initialDirectory={dialogDoc?.path ? dirname(dialogDoc.path) : DEFAULT_DIRECTORY}
          initialFilename={dialogDoc?.filename ?? "untitled.md"}
          onCancel={() => setDialog(null)}
          onConfirm={(path) => {
            const { documentId, after } = dialog;
            setSaving(true);
            void useEditorStore
              .getState()
              .saveDocument(documentId, path)
              .then(() => {
                void notify(`Saved ${basename(path)}`);
                if (after === "close") useEditorStore.getState().closeDocument(documentId);
                setDialog(after === "open-file" ? { type: "open" } : null);
              })
              .catch((err: Error) => {
                reportError(`Could not save to ${path}: ${err.message}`);
                setDialog(null);
              })
              .finally(() => setSaving(false));
          }}
        />
      )}

      {dialog?.type === "confirm-close" && (
        <ConfirmDialog
          title="Save changes?"
          message={`“${dialogDoc?.filename ?? "This document"}” has unsaved changes. Save them before closing the tab?`}
          confirmLabel="Save and close"
          discardLabel="Discard"
          onConfirm={() => void saveDocument(dialog.documentId, "close")}
          onDiscard={() => {
            useEditorStore.getState().closeDocument(dialog.documentId);
            setDialog(null);
          }}
          onCancel={() => setDialog(null)}
        />
      )}

      {dialog?.type === "confirm-open" && (
        <ConfirmDialog
          title="Save changes?"
          message={`“${activeDoc?.filename ?? "This document"}” has unsaved changes. Save them before opening another file?`}
          confirmLabel="Save"
          discardLabel="Don't save"
          onConfirm={() => {
            if (activeDoc) void saveDocument(activeDoc.id, "open-file");
          }}
          onDiscard={() => setDialog({ type: "open" })}
          onCancel={() => setDialog(null)}
        />
      )}

      {settingsOpen && (
        <SettingsPanel
          settings={settings}
          onChange={(patch) => useEditorStore.getState().updateSettings(patch)}
          onClose={() => setSettingsOpen(false)}
        />
      )}
    </div>
  );
}

const rootEl = document.getElementById("root");
if (rootEl) createRoot(rootEl).render(<App />);
