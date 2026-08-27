// The dual-colour rule for the reply tool row (T078, FR-025).
//
// ONE prefix decides the colour, and it is decided here so nothing else has to
// know it: a tool this app implements (`agentic_editor_*`) is an EDITOR chip
// (violet, exactly as v1 rendered it), and anything else the agent called —
// a web search, a file read, a memory lookup, another app's surface tool — is
// an OTHER chip (neutral grey, same pill). That is the whole feature: the user
// sees everything the agent did, and can tell at a glance which of it touched
// their document.

import type { ToolChip, ToolChipIcon } from "../types";

/** The prefix every tool this app implements shares. */
export const EDITOR_TOOL_PREFIX = "agentic_editor_";

/** True when a tool call belongs to this app's own surface. */
export function isEditorToolName(name: string): boolean {
  return name.startsWith(EDITOR_TOOL_PREFIX);
}

/** Per-tool glyphs for this app's own tools — the mockup's chip icons. */
const EDITOR_ICONS: Record<string, ToolChipIcon> = {
  open_file: "file-text",
  create_document: "file-plus",
  save_document: "save",
  save_all: "save",
  add_content: "pencil",
  modify_content: "text-cursor",
  remove_content: "eraser",
  set_active_document: "list",
  list_documents: "list",
  get_active_document: "file-text",
  get_document_content: "file-text",
  search_document: "search",
};

/**
 * Glyphs for everybody else's tools, by keyword. Deliberately a guess with a
 * dull fallback: the colour carries the meaning, the icon is only decoration,
 * and a wrong glyph on an unknown tool is cheaper than no chip at all.
 */
const OTHER_ICON_RULES: { match: RegExp; icon: ToolChipIcon }[] = [
  { match: /web|browse|fetch|url|http/, icon: "globe" },
  // Before the generic search rule: `memory_search` is a memory tool that
  // happens to search, not a search tool that happens to be about memory.
  { match: /memory|remember|recall|knowledge|kb/, icon: "brain" },
  { match: /search|find|grep|query/, icon: "search" },
  { match: /file|read|write|doc|vfs|fs_/, icon: "file-text" },
  { match: /shell|bash|exec|command|terminal|run_/, icon: "terminal" },
  { match: /list|ls$/, icon: "list" },
];

/** `agentic_editor_add_content` → "add content"; `web_search` → "web search". */
export function prettifyToolName(name: string): string {
  const stripped = isEditorToolName(name) ? name.slice(EDITOR_TOOL_PREFIX.length) : name;
  const label = stripped.replace(/[_-]+/g, " ").trim().toLowerCase();
  return label || name;
}

/** How one tool call renders. The single source of truth for FR-025's colours. */
export function getToolChip(name: string): ToolChip {
  const toolName = typeof name === "string" ? name : "";
  if (isEditorToolName(toolName)) {
    const bare = toolName.slice(EDITOR_TOOL_PREFIX.length);
    return { variant: "editor", label: prettifyToolName(toolName), icon: EDITOR_ICONS[bare] ?? "pencil" };
  }
  const lowered = toolName.toLowerCase();
  const rule = OTHER_ICON_RULES.find((r) => r.match.test(lowered));
  return { variant: "other", label: prettifyToolName(toolName), icon: rule?.icon ?? "wrench" };
}
