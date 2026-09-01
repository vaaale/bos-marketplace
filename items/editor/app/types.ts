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

/** A message in the global (one per app instance) chat transcript. */
export interface ChatMessage {
  id: string;
  role: ChatRole;
  content: string;
  /** Epoch ms. */
  timestamp: number;
  /** Set when the message was about one specific document. */
  relatedDocumentId?: string;
  /** True while the agent is still streaming into this message. */
  streaming?: boolean;
  /** Tool calls the agent made as part of this turn (shown as small chips). */
  toolCalls?: { name: string; summary: string }[];
  /** Set when the turn failed; rendered in the error style. */
  error?: boolean;
}

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

/** Snapshot persisted to the app's key/value store so state survives restarts. */
export interface PersistedState {
  version: 1;
  documents: EditorDocument[];
  activeDocumentId: string | null;
  viewMode: ViewMode;
  splitPercent: number;
  messages: ChatMessage[];
  settings: EditorSettings;
  conversationId: string | null;
}
