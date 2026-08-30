// Shared types for the Agentic Text Editor (T003).
//
// Everything the app knows about is described here: the documents it holds in
// its internal buffer, the tabs that show them, the global chat transcript, the
// pluggable format handlers, and the user's appearance settings.

/** A document open in the editor — either loaded from the VFS or brand new. */
export interface EditorDocument {
  /** Stable, app-local id (also what the assistant tools address). */
  id: string;
  /** Display name, e.g. "notes.md". */
  filename: string;
  /** Absolute VFS path, or null for an untitled document never saved to disk. */
  path: string | null;
  /** The INTERNAL BUFFER. Never written to disk until an explicit save. */
  content: string;
  /** The content as it exists on disk. `content !== savedContent` ⇒ dirty. */
  savedContent: string;
  /** Id of the format handler that renders/edits this document. */
  formatId: string;
  /** Epoch ms of the last successful save, or null if never saved. */
  lastSaved: number | null;
  createdAt: number;
}

/** UI representation of a document in the left pane. */
export interface Tab {
  documentId: string;
  visibleName: string;
  index: number;
  isActive: boolean;
  isDirty: boolean;
}

export type ChatRole = "user" | "agent" | "system";

// ---------------------------------------------------------------- v2 chat
//
// v2 no longer keeps its own copy of the transcript: the conversation files are
// SERVER-owned (`/Documents/Chats/<id>.json`) and the app renders from them.
// The two types below mirror the on-disk contract in BOS's
// `src/lib/assistant/messages.ts` — restated here because an installed app is
// bundled standalone and cannot import BOS source.

/** One tool call recorded on an assistant message. */
export interface ToolCallRef {
  id: string;
  type: "function";
  function: { name: string; arguments: string };
}

/** A message as it is persisted in a conversation file. */
export interface TranscriptMessage {
  id: string;
  role: "user" | "assistant" | "tool";
  content?: string;
  /** Every tool the assistant invoked that turn — editor tools AND all others. */
  toolCalls?: ToolCallRef[];
  /** role:"tool" only — the assistant tool call this message answers. */
  toolCallId?: string;
  /** role:"assistant" only — the model's thinking, not rendered by this app. */
  reasoning?: string;
  /** role:"assistant" only — the turn failed and `content` is the error. */
  error?: boolean;
}

/** What the chat pane actually renders. Derived, never persisted. */
export interface ChatMessage {
  id: string;
  role: ChatRole;
  content: string;
  /** Epoch ms — only known for messages this session observed live. */
  timestamp?: number;
  /** True while the agent is still streaming into this message. */
  streaming?: boolean;
  /** Every tool call to show in this reply's tool row (FR-025). */
  toolCalls?: ToolCallRef[];
  /** Call ids still executing, so their chips can render a "running" state. */
  runningCallIds?: string[];
  /** Set when the turn failed; rendered in the error style. */
  error?: boolean;
}

/** An agent the user can pick in the chat header (FR-023). */
export interface AgentInfo {
  id: string;
  name: string;
  description?: string;
  /** "primary" for the Main Assistant; whatever BOS reports otherwise. */
  type?: string;
}

/** A conversation THIS APP started. The transcript itself lives server-side. */
export interface AppConversation {
  /** App-minted, always `ate-…` — which is what makes the list app-scoped. */
  id: string;
  /** Derived locally from the first user message; "New conversation" until then. */
  title: string;
  /** The agent this conversation is bound to. */
  agentId: string;
  createdAt: number;
  lastActiveAt: number;
}

/**
 * The app-scoped chat index persisted under the "chat-state" key.
 *
 * Deliberately an INDEX ONLY: no message content is ever written here. The real
 * transcripts are server-owned files this app re-reads on demand.
 */
export interface ChatPersistence {
  version: 2;
  conversations: AppConversation[];
  activeConversationId: string | null;
  selectedAgentId: string;
}

export type ToolChipVariant = "editor" | "other";

/** How one tool call renders in a reply's tool row (FR-025). */
export interface ToolChip {
  /** `agentic_editor_*` → "editor" (violet); everything else → "other" (gray). */
  variant: ToolChipVariant;
  label: string;
  icon: ToolChipIcon;
}

export type ToolChipIcon =
  | "pencil"
  | "text-cursor"
  | "eraser"
  | "file-text"
  | "file-plus"
  | "save"
  | "search"
  | "list"
  | "globe"
  | "brain"
  | "terminal"
  | "wrench";

/**
 * A pluggable document format (FR-017). Adding e.g. HTML or YAML support means
 * writing ONE module that exports a handler and registering it — no core change.
 */
export interface FormatHandler {
  id: string;
  name: string;
  /** Lower-case extensions WITH the dot, e.g. [".md", ".markdown"]. */
  extensions: string[];
  /** True when the Edit/Preview toggle should offer a rendered preview. */
  supportsPreview: boolean;
  /** Render the buffer to an HTML string for preview mode. Must escape input. */
  render(content: string): string;
  /** Optional per-format tweaks for edit mode (e.g. tab size). */
  editorHints?: { tabSize?: number; spellcheck?: boolean };
}

export type ViewMode = "edit" | "preview";

/** User-configurable appearance settings (US5), persisted via the config namespace. */
export interface EditorSettings {
  fontFamily: string;
  fontSize: number;
  h1Color: string;
  h2Color: string;
  h3Color: string;
  linkColor: string;
  codeBlockBackground: string;
  codeBlockForeground: string;
  textColor: string;
}

/** Cursor position shown in the status bar. */
export interface CursorPosition {
  line: number;
  column: number;
}

/** JSON-schema-ish parameter block for an assistant tool declaration. */
export interface ToolParameters {
  type: "object";
  properties: Record<string, { type: string; description: string; enum?: string[] }>;
  required?: string[];
}

/** A tool the app offers to the assistant for the duration of a run. */
export interface ToolDeclaration {
  name: string;
  description: string;
  parameters: ToolParameters;
}

/** Handler for one declared tool. Returns the string result sent to the model. */
export type ToolHandler = (args: Record<string, unknown>) => Promise<string> | string;

/**
 * Snapshot persisted to the app's key/value store so state survives restarts.
 *
 * v2 dropped `messages` and `conversationId`: the transcript is server-owned and
 * the conversation index lives under its own "chat-state" key. A v1 snapshot is
 * still readable — its extra fields are ignored, except `conversationId`, which
 * is migrated into the v2 conversation index once (see chat-store).
 */
export interface PersistedState {
  version: 2;
  documents: EditorDocument[];
  activeDocumentId: string | null;
  viewMode: ViewMode;
  splitPercent: number;
  settings: EditorSettings;
  /** v1 only — read on migration, never written. */
  conversationId?: string | null;
}
