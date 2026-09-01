# Implementation Plan: Agentic Text Editor — v2 (Agent & Conversation Management + Full Tool-Call Visibility)

**Branch**: `agentic-text-editor` | **Date**: 2026-08-27 | **Spec**: `item-agentic-text-editor/spec.md` | **Design**: `item-agentic-text-editor/design.md`

**Input**: Feature specification (v2 scope-add) + reviewed `design.md` (verdict: Ready for plan).

> **Baseline note**: v1 (document tabs, embedded chat, `agentic_editor_*` surface tools, single global conversation) is already installed and working. This plan covers **only the v2 delta** (FR-023 / FR-024 / FR-025 → US6 / US7 / US8). The v1 file tree, services, and editor components are unchanged unless noted here.

## Summary

v2 adds three features to the installed Agentic Text Editor marketplace app:

1. **Agent selector (FR-023 / US6)** — a dropdown in the chat header listing the registered BOS assistant agents (Main Assistant + user-defined), routing messages to the selected one, persisting across restarts.
2. **Conversation management (FR-024 / US7, rewritten FR-009)** — a "New conversation" control and a dropdown to select among existing conversations. Each conversation keeps its own transcript and is bound to the agent that ran it. The list is app-scoped (only conversations this app started).
3. **Full tool-call visibility (FR-025 / US8)** — the reply's tool row now renders **every** tool call the agent made that turn: `agentic_editor_*` chips keep their existing violet styling, all other tools render in neutral gray (same pill shape).

**Key architectural property**: all v2 work stays inside the item's sandboxed-iframe IIFE. The chat is driven through the existing `window.__bos.assistant` broker (feature 040) + `window.__bos.fs.read` for transcripts + `window.__bos.storage` for the app-scoped index. **No BOS source change, no new route, no new broker method, no service facet.**

## Technical Context

**Language/Version**: TypeScript 5.x, React 18 (marketplace app IIFE bundle)

**Primary Dependencies**:
- `window.__bos.assistant` broker — `listAgents`, `startRun`, `onRunEvent`, `postToolResult`, `getActiveRun`, `cancelRun` (feature 040, `src/components/apps/assistant-broker.ts`)
- `window.__bos.fs.read` — read `/Documents/Chats/<id>.json` transcripts
- `window.__bos.storage.get/set` — app-scoped KV store (`data/app-storage/agentic-text-editor.json`)
- zustand (state), lucide-react (icons) — same as v1

**Storage**:
- App-scoped conversation index (ids, agentId, active flag, timestamps) → app KV store
- Transcripts → server-owned at `/Documents/Chats/<id>.json` (item reads, never writes)
- Editor settings → app KV store (v1, unchanged)
- Document buffers → in-memory (v1, unchanged)

**Testing**: Extend `e2e/agentic-text-editor.spec.ts` with v2 scenarios (agent switch, conversation new/switch, tool-row dual-color). Unit-style checks for `tool-chip.ts` prefix rule and `run-projector.ts` dedup.

**Target Platform**: BrowserOS marketplace app — sandboxed-iframe IIFE (separate JS context; no `@/` imports, no `registerAppSurfaceTools`, no `AssistantChatV2` module access)

**Project Type**: Marketplace app (not built-in)

**Performance Goals**:
- Agent dropdown renders instantly (local catalog from `listAgents`)
- Conversation switch < 500ms (transcript `fs.read`)
- Live tool chips appear as the run progresses (driven by `onRunEvent` stream)
- Agent switch is synchronous (no network round-trip beyond the next `startRun`)

**Constraints**:
- IIFE bundle: no `@/` BOS module imports; all BOS interaction via `window.__bos`
- BOS dark-only opacity palette, inline Tailwind, lucide-react icons
- No external UI libraries
- `agentic_editor_*` surface tools unchanged — they ride `startRun.surfaceTools` as before
- The item renders its own chat from the broker event/message model (does not mount the BOS chat component) — required for FR-025's custom dual-color chips

**Scale/Scope**: Single app window. Unlimited tabs. 1–5 typical conversations per session. Agent catalog is small (Main Assistant + user-defined).

## Constitution Check

*GATE: Must pass before implementation. Re-check after implementation.*

- **Dark-only theme**: All new UI (dropdowns, chips, header controls) uses the BOS opacity palette. Violet accent for agent/active states, neutral gray for non-editor tool chips. No light mode. ✓
- **Marketplace app anatomy**: New files live under `app/src/`. `app.json` is the only manifest change (adding `capabilities`). No `services/` facet. ✓
- **No external UI libraries**: Dropdowns are hand-rolled (consistent with v1's approach). Only lucide-react for icons. ✓
- **SSR/hydration**: New components are `"use client"`. No client-only initial state that would break hydration. ✓
- **OS state via selectors**: App-scoped conversation index uses `window.__bos.storage` (the sanctioned per-app KV channel), not a direct VFS write. ✓
- **Tool registration**: `agentic_editor_*` surface tools unchanged (ride `startRun.surfaceTools`). No new tools added in v2. ✓
- **Config namespace**: Editor settings unchanged (v1). Agent selection and active conversation are app-scoped state, not global config — correctly stored in the app KV store, not the config namespace. ✓
- **No BOS source change**: The design's central property. All required BOS primitives (broker methods, `fs.read`, `storage`, agent catalog endpoint, `toolCalls[]` on persisted messages) already exist. ✓

**No violations. No Complexity Tracking entry required.**

## Project Structure

### Documentation (this feature)

```text
item-agentic-text-editor/
├── spec.md              # Feature specification (v2 scope added)
├── plan.md              # This file (v2 plan)
├── design.md            # Architecture design (v2, reviewed)
├── tasks.md             # Task list (v2 delta — generated next)
├── ui-mockup.html       # Interactive HTML mockup (v2, updated in place)
└── quickstart.md        # Validation guide (v1 + v2)
```

### Source Code — v2 delta (marketplace item)

All paths are under the item root (`data/user-apps/items/agentic-text-editor/`). The `app/` facet is the esbuild IIFE project. V1 files are unchanged unless marked.

```text
app/
├── app.json                              # MODIFY — add "capabilities": ["assistant", "storage", "fs:read"]
├── types.ts                              # MODIFY — add AgentInfo, AppConversation, ChatPersistence, ToolChip types
└── src/
    ├── main.tsx                          # unchanged (v1)
    ├── assistant/                        # NEW — v2 assistant client + chat state
    │   ├── client.ts                     # NEW — typed wrapper over window.__bos.assistant + fs.read
    │   ├── run-projector.ts              # NEW — folds run events into render model (settled + live + tool status)
    │   ├── chat-store.ts                 # NEW — zustand store: conversations[], activeId, selectedAgentId, catalog
    │   └── tool-chip.ts                  # NEW — toolName → {variant, icon, label} (prefix rule + dual-color)
    └── components/
        ├── chat/
        │   ├── chat-header.tsx           # MODIFY — compose: status dot + agent-selector (left) · spacer · new-conv btn + conversation-selector (right)
        │   ├── agent-selector.tsx        # NEW — FR-023 agent dropdown
        │   ├── conversation-selector.tsx # NEW — FR-024 conversation dropdown (app-scoped, most-recent first)
        │   ├── tool-row.tsx              # NEW — FR-025 renders a reply's full toolCalls[] as dual-color chips
        │   ├── chat-messages.tsx         # MODIFY — render the ACTIVE conversation's transcript; empty-state toggle
        │   ├── message-bubble.tsx        # MODIFY — render <ToolRow> (all toolCalls, dual-color) under agent replies
        │   └── chat-input.tsx            # MODIFY — send through client.startRun({conversationId: active, agentId: selectedAgentId, surfaceTools})
        └── editor/                       # unchanged (v1)
```

**Structure Decision**: All v2 code is additive or a targeted modification of existing chat components. The new `app/src/assistant/` module encapsulates the broker contract so no component touches `window.__bos` directly. `tool-chip.ts` is the single source of truth for the dual-color rule. `chat-store.ts` is the single source of truth for the app-scoped conversation index.

## Design Notes

> Full architectural detail, ADRs, integration points, and risk analysis live in `design.md`. The notes below capture the decisions that drive task breakdown.

### ADR-1 — Drive the assistant through the `window.__bos` broker, not main-bundle modules

A marketplace app is a sandboxed-iframe IIFE in a separate JS context. It cannot import or share `registerAppSurfaceTools` / `AssistantChatV2` / `run-client` (all main-bundle module scope). The only channel into the assistant is the `window.__bos.assistant` broker (feature 040). This is origin-independent (works for `local` and `marketplace` origins alike) and requires zero BOS changes.

**Implication for tasks**: All assistant interaction goes through `client.ts` (a thin typed wrapper). No component or store accesses `window.__bos.assistant` directly.

### ADR-2 — App-scoped conversation index, keyed by app-minted ids (RESOLVED A2)

The item mints conversation ids (e.g. `ate-<timestamp><rand>`) and persists `{ conversations[], activeConversationId, selectedAgentId }` to the app KV store. The real transcript for each id lives server-owned at `/Documents/Chats/<id>.json`. The item never enumerates the chats directory — so the dropdown shows only app-started conversations by construction.

**Known side effect (accepted)**: App-minted ids physically live in the shared `/Documents/Chats/` directory and **will appear in the global BOS chat list** under the chosen agent. This is acceptable per A2 (the app's own dropdown is app-scoped; the global list is a separate surface). The `ate-` prefix makes editor conversations identifiable in the global list.

### ADR-3 — The agent dropdown re-binds the active conversation's agent (RESOLVED A1)

`selectedAgentId` **is** the active conversation's `agentId`, kept in sync. Selecting an agent updates the active conversation's `agentId` (mirroring BOS's own `setConversationAgent` in `AgentSelector.tsx`). Switching conversations updates the dropdown to that conversation's agent. "New conversation" copies the current `selectedAgentId` into the fresh conversation. The transcript is unaffected by a re-bind (it is server-owned and keyed by `conversationId`, which is stable).

### ADR-4 — Surface tools are visible to any selected agent (no per-agent config needed)

`agentic_editor_*` are non-registry (surface) tools. The agent's tool allowlist/gate (`gate.registryIds`) only filters **registry** tools. Surface tools are pushed unconditionally in `visibleTools()`. So **any** selected agent can call `agentic_editor_*` without adding them to the agent's allowlist. No per-agent configuration is needed.

**Caveat (noted in design.md risk #3)**: a locked-down agent's system prompt won't *encourage* editor edits, but the tools remain callable.

### ADR-5 — Declare `[assistant, storage, fs:read]` in `app.json`

Broker methods and `fs.read` require capability grants. On install, `resolveCapabilities` seeds the grant from the manifest's declared `capabilities`. Declaring all three in `app.json` makes the item work out of the box. If a user revokes `assistant` (or `storage`) in Settings → Apps, the item must **degrade gracefully** (show the "assistant unavailable" empty state, skip persistence) rather than throw.

**Note (S4)**: `storage` is absent from the Settings `VALID_CAPS` list (documented drift) — it is seeded at install from the manifest but not user-toggleable. The design does not rely on a user-facing `storage` toggle.

### ADR-6 — Render tool chips from the persisted `message.toolCalls[]` (FR-025)

The assistant message carries `toolCalls[]` for **all** tools it invoked that turn (`ChatMessage.toolCalls: ToolCallRef[]` in `src/lib/assistant/messages.ts`), persisted by the agent loop before execution. The item renders **all** of them in the reply's tool row, coloring by name:
- `name.startsWith("agentic_editor_")` → **editor variant** (violet chip, unchanged from v1)
- anything else → **other variant** (neutral gray, same pill shape, per RESOLVED A3)

The persisted `ToolCallRef` is `{ id, type: "function", function: { name, arguments } }` — there is **no `execution` field** in the transcript. So replay coloring **must** use name-prefix membership (`tool-chip.ts`), not a data field. The live stream does carry `execution: "frontend"` on `tool_call` events, but the single rule for both live and replay is: **`agentic_editor_*` prefix = editor variant**.

### State model

```ts
// app/src/assistant/chat-store.ts (zustand)
interface AppConversation {
  id: string;              // app-minted, e.g. "ate-1719000000-a3f2"
  title: string;           // derived from first user message, or "New conversation"
  agentId: string;         // the agent this conversation is bound to (ADR-3)
  createdAt: number;
  lastActiveAt: number;
}

interface ChatState {
  conversations: AppConversation[];   // app-scoped index only (ADR-2) — NO message bodies
  activeConversationId: string | null;
  selectedAgentId: string;           // = active conversation's agentId (ADR-3)
  agents: AgentInfo[];               // catalog from listAgents()
  // per-conversation transcript (loaded on demand, not persisted by the item)
  transcripts: Record<string, ChatMessage[]>;
  // live run state
  activeRunId: string | null;
  streamingMessage: ChatMessage | null;
  liveToolStatus: Map<string, { name: string; status: 'running' | 'done' }>;
}
```

Message **content is never persisted by the item** — it lives in the real conversation files and is re-read via `fs.read` on conversation open. The item's store is a thin index + live run projection.

### Tool-row rendering: live vs. finalized (S1 + S2)

- **Live**: `run-projector.ts` consumes `onRunEvent` events. `tool_call` events populate `liveToolStatus` (a `Map<callId, {name, status}>`). The tool row renders these chips as the agent works, colored by the prefix rule.
- **Finalized**: when the `message` event lands (carrying the complete `toolCalls[]`), the projector replaces the live tool row with the authoritative row from the message. Dedup is by `callId` (message `toolCalls[].id` matches the `tool_call` event's `callId`).
- **Replay** (conversation open): `fs.read` the transcript → render each assistant message's `toolCalls[]` directly. No live state.

### Error / empty states

| State | Trigger | Behavior |
|-------|---------|----------|
| No conversations yet | `conversations[]` is empty | Show empty-state (mockup: "No messages yet"). Agent selector still visible. |
| Agent catalog load failure | `listAgents()` rejects (assistant not granted, network) | Show "Assistant unavailable" in the header; chat input disabled. |
| `assistant` capability revoked | Broker call rejects with "Capability not granted" | Show "Assistant unavailable" state; editor pane unaffected. |
| Transcript read failure | `fs.read` on a conversation file fails (corrupt, deleted) | Show "Conversation not found" in the message area; remove the stale entry from `conversations[]`. |
| Live run 409 | `startRun` returns `{ activeRunId }` (a run is already active for this conversation) | Re-attach via `onRunEvent(activeRunId)` instead of starting a new run. |

## Complexity Tracking

No complexity violations. v2 is an additive delta to an existing single marketplace app — no new facets, no BOS source changes, no new subsystems.
