// The app's capability registration (T011).
//
// Two registries are wired up here, once, at startup:
//
//   * FORMATS — `services/format-service` owns the pluggable handler map and
//     self-registers the two defaults (markdown, plaintext) when imported.
//     Importing it HERE, from the one module the app entry always loads, is what
//     guarantees a handler is present before any document is restored from the
//     persisted snapshot. Adding a format later is one module plus one
//     `registerFormat()` call — no change to the editor, store or tools (FR-017,
//     SC-007), which is why `registerFormat` is re-exported rather than making
//     callers reach into the service.
//
//   * ASSISTANT TOOLS — the `agentic_editor_*` declarations (twelve for
//     documents, five for the custom-style registry) are handed to BOS as the
//     run's `surfaceTools` when the chat starts a turn, which is how an
//     app-owned tool surface is registered with assistant v2 (the server merges
//     them into the run's tool table as `execution: "frontend"` and dispatches
//     calls back over the event stream). `assistant-tools.ts` composes both
//     modules into the one list and map asserted below.
//
//     Deliberately NOT added to BOS's own `src/lib/agent/capabilities-registry.ts`:
//     an agent's `tools` allowlist is a persisted snapshot of the registry taken
//     when that agent was created, and a capability that IS in the registry but
//     NOT in the allowlist is hidden from the model (`visibleTools` in
//     src/lib/assistant/tools.ts). Adding these ids to BOS source would
//     therefore hide the editor's own tools from every already-existing agent
//     until the user re-ticked every one of those boxes in Settings — and would make a
//     marketplace app require a BOS build to work, which is the opposite of what
//     installing one is for. Tools outside the registry bypass the allowlist, so
//     the surface-tool route gives this app its Tier 1 behaviour with no BOS
//     source change.

import { list as listFormats, register as registerFormat } from "../services/format-service";
import { TOOL_DECLARATIONS, TOOL_HANDLERS } from "./assistant-tools";
import type { FormatHandler, ToolDeclaration } from "../types";

export { registerFormat };

export interface RegistrationSummary {
  formats: FormatHandler[];
  tools: ToolDeclaration[];
}

let summary: RegistrationSummary | null = null;

/**
 * Idempotent startup registration. Also asserts that every declared tool has a
 * handler: a declaration without one would be advertised to the model and then
 * fail at call time, and a run only finds out by hanging on the missing result.
 * Failing loudly at startup is the cheaper place to notice.
 */
export function registerAppCapabilities(): RegistrationSummary {
  if (summary) return summary;

  const missing = TOOL_DECLARATIONS.filter((d) => typeof TOOL_HANDLERS[d.name] !== "function").map((d) => d.name);
  if (missing.length > 0) {
    throw new Error(`Agentic Text Editor: declared tools have no handler: ${missing.join(", ")}`);
  }
  const orphaned = Object.keys(TOOL_HANDLERS).filter((name) => !TOOL_DECLARATIONS.some((d) => d.name === name));
  if (orphaned.length > 0) {
    throw new Error(`Agentic Text Editor: handlers have no declaration: ${orphaned.join(", ")}`);
  }

  summary = { formats: listFormats(), tools: TOOL_DECLARATIONS };
  return summary;
}
