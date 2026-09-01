// The tools this app offers the assistant (T010, T022–T024, T028–T036).
//
// Declarations + handlers live together so a tool can never be advertised
// without an implementation. The chat service hands the declarations to the
// assistant when it starts a run and dispatches `tool_call` events back here.
//
// Two conventions run through all of them:
//   * default-to-active — every editing/query tool takes an OPTIONAL
//     documentId and falls back to the active tab, because that is what the
//     user means by "this document";
//   * edits hit the internal buffer only — nothing here writes to disk except
//     the two explicit save tools (FR-012).

import { useEditorStore } from "../state/document-store";
import { isDirty, normalizePath, searchContent } from "../services/file-service";
import { get as getFormat } from "../services/format-service";
import type { EditorDocument, ToolDeclaration, ToolHandler } from "../types";

/** Prefix every tool shares — also how the chat service recognises its own. */
export const TOOL_PREFIX = "agentic_editor_";

/** How much of the active document rides along in the context block. */
export const CONTEXT_PREVIEW_CHARS = 2000;

// ------------------------------------------------------------------ helpers

function str(args: Record<string, unknown>, key: string): string | undefined {
  const v = args[key];
  return typeof v === "string" && v.trim() ? v : undefined;
}

function describe(doc: EditorDocument): Record<string, unknown> {
  const state = useEditorStore.getState();
  return {
    documentId: doc.id,
    filename: doc.filename,
    path: doc.path,
    format: getFormat(doc.formatId).name,
    isActive: state.activeDocumentId === doc.id,
    isDirty: isDirty(doc),
    characters: doc.content.length,
    lines: doc.content ? doc.content.split("\n").length : 0,
  };
}

function ok(payload: Record<string, unknown>): string {
  return JSON.stringify({ ok: true, ...payload });
}

function fail(message: string, extra?: Record<string, unknown>): string {
  return JSON.stringify({ ok: false, error: message, ...extra });
}

/** The open documents, described — used both as a tool result and in errors. */
function openDocuments(): Record<string, unknown>[] {
  return useEditorStore.getState().documents.map(describe);
}

/**
 * Resolve the document a call targets.
 *
 * Handles the edge case in the spec (T027): if the agent names a document that
 * is not open but looks like a VFS path, open it first rather than failing —
 * "edit /Documents/notes.md" should just work.
 */
async function resolveDocument(args: Record<string, unknown>, required = false): Promise<EditorDocument> {
  const state = useEditorStore.getState();
  const id = str(args, "documentId");

  if (!id) {
    if (required) throw new Error("documentId is required for this tool.");
    const active = state.getActiveDocument();
    if (!active) throw new Error("No document is open. Use agentic_editor_open_file or agentic_editor_create_document first.");
    return active;
  }

  const byId = state.documents.find((d) => d.id === id);
  if (byId) return byId;

  const byPath = state.documents.find((d) => d.path === normalizePath(id));
  if (byPath) return byPath;

  const byName = state.documents.filter((d) => d.filename === id);
  if (byName.length === 1) return byName[0];
  if (byName.length > 1) {
    throw new Error(`"${id}" matches ${byName.length} open documents — use the documentId from agentic_editor_list_documents.`);
  }

  if (id.includes("/") || /\.[a-z0-9]+$/i.test(id)) {
    // Not open, but it names a file — open it, then edit it.
    return await state.openPath(normalizePath(id));
  }

  throw new Error(
    `No open document matches "${id}". Open documents: ${
      state.documents.map((d) => `${d.filename} (${d.id})`).join(", ") || "none"
    }.`,
  );
}

/** Run a handler, turning any throw into a structured error result. */
function guarded(handler: ToolHandler): ToolHandler {
  return async (args) => {
    try {
      return await handler(args);
    } catch (err) {
      return fail((err as Error).message);
    }
  };
}

// ------------------------------------------------------------------ declarations

const OPTIONAL_DOC = {
  documentId: {
    type: "string",
    description: "Target document id (from agentic_editor_list_documents). Omit to use the active tab.",
  },
} as const;

export const TOOL_DECLARATIONS: ToolDeclaration[] = [
  // ---- file operations -------------------------------------------------
  {
    name: "agentic_editor_open_file",
    description:
      "Open a file from the BrowserOS VFS in a new editor tab and make it active. If the file is already open, brings that tab to the front. Paths are absolute from the user's VFS root, e.g. /Documents/notes.md.",
    parameters: {
      type: "object",
      properties: { path: { type: "string", description: "Absolute VFS path, e.g. /Documents/notes.md" } },
      required: ["path"],
    },
  },
  {
    name: "agentic_editor_create_document",
    description:
      "Create a new, empty document in a new tab. It exists only in memory until it is saved with agentic_editor_save_document (which then needs a path).",
    parameters: {
      type: "object",
      properties: {
        filename: { type: "string", description: 'Suggested filename, e.g. "draft.md". Defaults to "Untitled".' },
      },
    },
  },
  {
    name: "agentic_editor_save_document",
    description:
      "Write a document's buffer to disk. Defaults to the active tab. A document that has never been saved needs a `path`.",
    parameters: {
      type: "object",
      properties: {
        ...OPTIONAL_DOC,
        path: { type: "string", description: "Absolute VFS path to save to. Required for a never-saved document." },
      },
    },
  },
  {
    name: "agentic_editor_save_all",
    description: "Write every open document that has unsaved changes to disk. Never-saved documents are reported, not written.",
    parameters: { type: "object", properties: {} },
  },

  // ---- document editing ------------------------------------------------
  {
    name: "agentic_editor_add_content",
    description:
      "Append content to the end of a document's buffer. Use this for 'add a paragraph/section about X'. The change appears in the editor immediately but is NOT written to disk.",
    parameters: {
      type: "object",
      properties: {
        ...OPTIONAL_DOC,
        content: { type: "string", description: "The text to append." },
      },
      required: ["content"],
    },
  },
  {
    name: "agentic_editor_modify_content",
    description:
      "Replace text in a document's buffer. `find` must appear in the document; use agentic_editor_get_document_content first if unsure. Replaces the first occurrence unless `all` is true.",
    parameters: {
      type: "object",
      properties: {
        ...OPTIONAL_DOC,
        find: { type: "string", description: "The exact text to find." },
        replace: { type: "string", description: "The replacement text." },
        all: { type: "string", description: 'Set to "true" to replace every occurrence instead of just the first.' },
      },
      required: ["find", "replace"],
    },
  },
  {
    name: "agentic_editor_remove_content",
    description: "Remove text from a document's buffer. `find` must appear in the document.",
    parameters: {
      type: "object",
      properties: {
        ...OPTIONAL_DOC,
        find: { type: "string", description: "The exact text to find and remove." },
        all: { type: "string", description: 'Set to "true" to remove every occurrence instead of just the first.' },
      },
      required: ["find"],
    },
  },
  {
    name: "agentic_editor_set_active_document",
    description: "Switch the editor to a different open tab.",
    parameters: {
      type: "object",
      properties: { documentId: { type: "string", description: "Target document id." } },
      required: ["documentId"],
    },
  },

  // ---- document query --------------------------------------------------
  {
    name: "agentic_editor_list_documents",
    description: "List every open document with its id, filename, path, format and unsaved state.",
    parameters: { type: "object", properties: {} },
  },
  {
    name: "agentic_editor_get_active_document",
    description: `Return the active document's id, filename and the first ${CONTEXT_PREVIEW_CHARS} characters of its content.`,
    parameters: { type: "object", properties: {} },
  },
  {
    name: "agentic_editor_get_document_content",
    description: "Return the full current buffer of a document — including unsaved agent and user edits.",
    parameters: {
      type: "object",
      properties: { ...OPTIONAL_DOC },
    },
  },
  {
    name: "agentic_editor_search_document",
    description: "Search a document's buffer for a string. Returns matching line numbers with surrounding context.",
    parameters: {
      type: "object",
      properties: {
        ...OPTIONAL_DOC,
        query: { type: "string", description: "Text to search for (case-insensitive)." },
      },
      required: ["query"],
    },
  },
];

// ------------------------------------------------------------------ handlers

export const TOOL_HANDLERS: Record<string, ToolHandler> = {
  // ---- file operations (T028–T031) -------------------------------------
  agentic_editor_open_file: guarded(async (args) => {
    const path = str(args, "path");
    if (!path) return fail("A path is required.");
    const doc = await useEditorStore.getState().openPath(normalizePath(path));
    return ok({ opened: describe(doc), message: `Opened ${doc.filename} in a new tab.` });
  }),

  agentic_editor_create_document: guarded(async (args) => {
    const doc = useEditorStore.getState().createDocument(str(args, "filename"));
    return ok({
      created: describe(doc),
      message: `Created "${doc.filename}". It has no path yet — pass one to agentic_editor_save_document to write it to disk.`,
    });
  }),

  agentic_editor_save_document: guarded(async (args) => {
    const doc = await resolveDocument(args);
    const saved = await useEditorStore.getState().saveDocument(doc.id, str(args, "path"));
    return ok({ saved: describe(useEditorStore.getState().getDocument(doc.id) ?? saved), message: `Saved ${saved.path}.` });
  }),

  agentic_editor_save_all: guarded(async () => {
    const result = await useEditorStore.getState().saveAll();
    return ok({
      saved: result.saved,
      skippedBecauseNeverSaved: result.skipped,
      failures: result.failures,
      message:
        result.saved.length === 0 && result.skipped.length === 0 && result.failures.length === 0
          ? "Nothing to save — no document has unsaved changes."
          : `Saved ${result.saved.length} document(s).`,
    });
  }),

  // ---- editing (T022–T024) ---------------------------------------------
  agentic_editor_add_content: guarded(async (args) => {
    const content = typeof args.content === "string" ? args.content : "";
    if (!content) return fail("`content` is required and must not be empty.");
    const doc = await resolveDocument(args);
    // Keep a blank line between what was there and what we add, unless the
    // buffer is empty or already ends in one.
    const separator = doc.content.length === 0 ? "" : doc.content.endsWith("\n\n") ? "" : doc.content.endsWith("\n") ? "\n" : "\n\n";
    useEditorStore.getState().setContent(doc.id, doc.content + separator + content, "agent", "added content");
    return ok({ document: describe(useEditorStore.getState().getDocument(doc.id)!), message: `Appended ${content.length} characters to ${doc.filename}.` });
  }),

  agentic_editor_modify_content: guarded(async (args) => {
    const find = typeof args.find === "string" ? args.find : "";
    const replace = typeof args.replace === "string" ? args.replace : "";
    if (!find) return fail("`find` is required and must not be empty.");
    const doc = await resolveDocument(args);
    if (!doc.content.includes(find)) {
      return fail(`"${truncate(find, 80)}" does not appear in ${doc.filename}.`, {
        hint: "Call agentic_editor_get_document_content or agentic_editor_search_document to see the actual text.",
      });
    }
    const all = String(args.all ?? "").toLowerCase() === "true";
    const next = all ? doc.content.split(find).join(replace) : doc.content.replace(find, replace);
    const count = all ? doc.content.split(find).length - 1 : 1;
    useEditorStore.getState().setContent(doc.id, next, "agent", "modified content");
    return ok({
      document: describe(useEditorStore.getState().getDocument(doc.id)!),
      replacements: count,
      message: `Replaced ${count} occurrence(s) in ${doc.filename}.`,
    });
  }),

  agentic_editor_remove_content: guarded(async (args) => {
    const find = typeof args.find === "string" ? args.find : "";
    if (!find) return fail("`find` is required and must not be empty.");
    const doc = await resolveDocument(args);
    if (!doc.content.includes(find)) {
      return fail(`"${truncate(find, 80)}" does not appear in ${doc.filename}.`, {
        hint: "Call agentic_editor_get_document_content or agentic_editor_search_document to see the actual text.",
      });
    }
    const all = String(args.all ?? "").toLowerCase() === "true";
    const count = all ? doc.content.split(find).length - 1 : 1;
    const removed = all ? doc.content.split(find).join("") : doc.content.replace(find, "");
    // Collapse the run of blank lines a removal usually leaves behind.
    const next = removed.replace(/\n{3,}/g, "\n\n");
    useEditorStore.getState().setContent(doc.id, next, "agent", "removed content");
    return ok({
      document: describe(useEditorStore.getState().getDocument(doc.id)!),
      removals: count,
      message: `Removed ${count} occurrence(s) from ${doc.filename}.`,
    });
  }),

  agentic_editor_set_active_document: guarded(async (args) => {
    const doc = await resolveDocument(args, true);
    useEditorStore.getState().setActiveDocument(doc.id);
    return ok({ active: describe(doc), message: `${doc.filename} is now the active tab.` });
  }),

  // ---- query (T032–T035) ------------------------------------------------
  agentic_editor_list_documents: guarded(async () => {
    const documents = openDocuments();
    return ok({
      documents,
      activeDocumentId: useEditorStore.getState().activeDocumentId,
      message: documents.length ? `${documents.length} document(s) open.` : "No documents are open.",
    });
  }),

  agentic_editor_get_active_document: guarded(async () => {
    const doc = useEditorStore.getState().getActiveDocument();
    if (!doc) return fail("No document is open.");
    return ok({
      document: describe(doc),
      preview: truncate(doc.content, CONTEXT_PREVIEW_CHARS),
      truncated: doc.content.length > CONTEXT_PREVIEW_CHARS,
    });
  }),

  agentic_editor_get_document_content: guarded(async (args) => {
    const doc = await resolveDocument(args);
    return ok({ document: describe(doc), content: doc.content });
  }),

  agentic_editor_search_document: guarded(async (args) => {
    const query = str(args, "query");
    if (!query) return fail("`query` is required.");
    const doc = await resolveDocument(args);
    const matches = searchContent(doc.content, query);
    return ok({
      document: describe(doc),
      query,
      matchCount: matches.length,
      matches: matches.slice(0, 50),
      message: matches.length ? `${matches.length} match(es) in ${doc.filename}.` : `No match for "${query}" in ${doc.filename}.`,
    });
  }),
};

function truncate(s: string, max: number): string {
  return s.length <= max ? s : `${s.slice(0, max)}…`;
}

/** True when a tool_call belongs to this app. */
export function isEditorTool(name: string): boolean {
  return name.startsWith(TOOL_PREFIX);
}

/**
 * The context block prepended to every message the user sends (T025 / T038).
 *
 * It is regenerated per send, so a tab switch immediately changes what the
 * agent considers "this document" without any extra plumbing.
 */
export function buildAgentContext(): string {
  const state = useEditorStore.getState();
  const active = state.getActiveDocument();
  const lines: string[] = ["## Agentic Text Editor context"];

  if (state.documents.length === 0) {
    lines.push("No documents are open.");
  } else {
    lines.push("Open tabs:");
    for (const doc of state.documents) {
      const flags = [
        doc.id === state.activeDocumentId ? "ACTIVE" : null,
        isDirty(doc) ? "unsaved changes" : "saved",
      ].filter(Boolean);
      lines.push(
        `- ${doc.filename} — id: ${doc.id}; path: ${doc.path ?? "(never saved)"}; format: ${getFormat(doc.formatId).name}; ${flags.join(", ")}`,
      );
    }
  }

  if (active) {
    lines.push(
      "",
      `Active document (${active.filename}), first ${CONTEXT_PREVIEW_CHARS} characters:`,
      "```",
      truncate(active.content, CONTEXT_PREVIEW_CHARS) || "(empty)",
      "```",
    );
  }

  lines.push(
    "",
    "Edit documents with the agentic_editor_* tools. Requests without an explicit target refer to the ACTIVE document.",
    "Your edits go to the in-memory buffer and appear instantly; they reach disk only via agentic_editor_save_document / agentic_editor_save_all, so do not save unless asked.",
    "",
    "## User message",
  );
  return lines.join("\n");
}
