# Tasks: Agentic Text Editor — v2 (Agent & Conversation Management + Full Tool-Call Visibility)

**Input**: Design documents from `item-agentic-text-editor/`

**Prerequisites**: spec.md (v2 scope), plan.md, design.md, ui-mockup.html (UI contract)

**Tests**: Full Playwright e2e tests in `e2e/agentic-text-editor.spec.ts` (extended for v2). Unit-style tests for `tool-chip.ts` prefix rule and `run-projector.ts` dedup logic.

## Format: `[ID] [P?] [Story] Description`

- **[P]**: Can run in parallel (different files, no dependencies)
- **[Story]**: Which user story this task belongs to
- Include exact file paths in descriptions

> **Baseline**: v1 (T001–T052 in the original tasks.md) is complete and installed. Tasks below are the **v2 delta only**, numbered T053+.

---

## Phase 53: v2 Setup (Shared Infrastructure)

**Purpose**: Types, broker client wrapper, and capability manifest — the foundation all v2 stories depend on

- [ ] T053 [P] Add v2 types to `app/types.ts`: `AgentInfo { id, name, description }`, `AppConversation { id, title, agentId, createdAt, lastActiveAt }`, `ChatPersistence { conversations: AppConversation[], activeConversationId: string|null, selectedAgentId: string }`, `ToolChip { variant: 'editor'|'other', label: string, icon?: string }`
- [ ] T054 Create `app/src/assistant/client.ts` — thin typed wrapper over `window.__bos.assistant` (methods: `listAgents()`, `startRun({conversationId, agentId, message, surfaceTools, attachments?})`, `onRunEvent(runId, callback)`, `postToolResult(runId, callId, result)`, `getActiveRun(conversationId)`, `cancelRun(runId)`) + `readTranscript(conversationId)` via `window.__bos.fs.read('/Documents/Chats/<id>.json')` returning parsed `ChatMessage[]`. Centralizes the broker contract; no other module touches `window.__bos` directly.
- [ ] T055 [P] Update `app/app.json` — add `"capabilities": ["assistant", "storage", "fs:read"]` to the manifest

**Checkpoint**: Foundation ready — types defined, broker client available, capabilities declared

---

## Phase 54: User Story 6 - Agent Selector (Priority: P1)

**Goal**: User can pick which registered agent drives the chat from a dropdown in the chat header. Selection persists across restarts.

**Independent Test**: Open app → open agent dropdown → confirm registered agents listed with active marked → select different agent → send message → confirm routed to that agent.

### Tests for User Story 6 ⚠️

- [ ] T056 [P] [US6] E2E test in `e2e/agentic-text-editor.spec.ts`: "agent selector lists registered agents" — open app, click agent dropdown, assert menu shows "Main Assistant" with active mark; assert at least one other agent visible (or menu shows only Main Assistant if no user-defined agents exist)
- [ ] T057 [P] [US6] E2E test: "selecting an agent updates the header label" — open dropdown, select a non-default agent, assert header label updates to the selected agent name
- [ ] T058 [P] [US6] E2E test: "agent selection persists across app restart" — select agent B, close and reopen app, assert agent B is still selected in the header

### Implementation for User Story 6

- [ ] T059 [US6] Create `app/src/components/chat/agent-selector.tsx` — dropdown component: trigger button (violet `sparkles` icon + agent name label + `chevron-down`), menu (labeled "Agents", one item per agent with icon + name, active item marked with `check` icon + violet highlight). Props: `agents: AgentInfo[]`, `selectedAgentId: string`, `onSelect(agentId)`. Styling per mockup `.selector` + `.dropdown-menu.agent-menu`.
- [ ] T060 [US6] Create `app/src/assistant/chat-store.ts` — Zustand store: state `{ conversations, activeConversationId, selectedAgentId, agents, transcripts, activeRunId, streamingMessage, liveToolStatus }`; actions: `loadAgents()`, `selectAgent(agentId)`, `loadConversations()`, `createConversation()`, `selectConversation(id)`, `loadTranscript(id)`, `startRun(message)`, `attachRun(runId)`, `postToolResult(runId, callId, result)`, `clearLiveState()`. Persists `ChatPersistence` shape to `window.__bos.storage.set('chat-state', ...)` on every mutation. Hydrates from storage on init.
- [ ] T061 [US6] Modify `app/src/components/chat/chat-header.tsx` — replace the static "Chat with Agent" title with: `[status-dot] [agent-selector] [flex-spacer] [new-conv-btn] [conversation-selector]`. The agent-selector is wired to `chat-store.selectedAgentId` + `selectAgent()`.

**Checkpoint**: Agent selector functional — user can switch agents, selection persists

---

## Phase 55: User Story 7 - Conversation Management (Priority: P1)

**Goal**: User can start a new conversation and switch among existing ones. Each keeps its transcript + agent binding. App-scoped list. Persists across restarts.

**Independent Test**: Open app → send message → click "New conversation" → empty state → send another message → open conversation dropdown → both listed → select first → transcript + agent restored.

### Tests for User Story 7 ⚠️

- [ ] T062 [P] [US7] E2E test: "new conversation shows empty state" — click new-conversation button, assert empty-state visible ("No messages yet"), assert conversation dropdown no longer marks the previous conversation as active
- [ ] T063 [P] [US7] E2E test: "conversation dropdown lists existing conversations most-recent-first" — seed two conversations (via storage mock or two sends), open dropdown, assert order is most-recent-first, assert active one is marked
- [ ] T064 [P] [US7] E2E test: "selecting a conversation restores its transcript" — switch to conversation B, send a unique message, switch back to A, assert A's transcript is shown (not B's), assert B's message is not visible
- [ ] T065 [P] [US7] E2E test: "conversation + agent persist across app restart" — send message in conversation A with agent B, close and reopen app, assert conversation A is active with agent B selected in the header and A's transcript visible
- [ ] T066 [P] [US7] E2E test: "chat is global across tabs" — open two document tabs, switch to tab 2, assert the same active conversation is shown in the chat pane (transcript unchanged by tab switch)
- [ ] T067 [P] [US7] E2E test: "new conversation inherits the currently selected agent" — select agent B, click new conversation, assert the new conversation's agent is B (verify by the agent selector showing B)

### Implementation for User Story 7

- [ ] T068 [US7] Create `app/src/components/chat/conversation-selector.tsx` — dropdown: trigger button (muted `messages-square` icon + conversation title label + `chevron-down`), menu (labeled "Conversations", most-recent-first, each item shows `message-square` icon + title + sub-line `<agentName> · <relativeTime>`, active marked with `check`). Props: `conversations: AppConversation[]`, `activeId: string|null`, `agents: AgentInfo[]` (for sub-line), `onSelect(id)`. Styling per mockup `.dropdown-menu.conv-menu`.
- [ ] T069 [US7] Modify `app/src/components/chat/chat-header.tsx` — add: new-conversation icon button (`plus` icon, tooltip "New conversation", wired to `chat-store.createConversation()`) + `conversation-selector` (wired to `chat-store.conversations` + `selectConversation()`), anchored right after the flex spacer.
- [ ] T070 [US7] Modify `app/src/components/chat/chat-messages.tsx` — render the **active conversation's** transcript from `chat-store.transcripts[activeConversationId]`. When the active conversation has no messages, show the empty-state (mockup: `message-square` icon, "No messages yet", helper text). When switching conversations, re-read the transcript via `chat-store.loadTranscript(id)` (which calls `client.readTranscript(id)`).
- [ ] T071 [US7] Modify `app/src/components/chat/chat-input.tsx` — on send: call `chat-store.startRun(message)` which invokes `client.startRun({ conversationId: activeConversationId, agentId: selectedAgentId, message, surfaceTools: editorToolDeclarations })`. If `startRun` returns an `activeRunId` (409 — run already active), re-attach via `attachRun` instead.
- [ ] T072 [US7] Implement conversation lifecycle in `chat-store.ts` actions: `createConversation()` — mint id `ate-<Date.now()>-<rand4>`, create `{ id, title: "New conversation", agentId: selectedAgentId, createdAt, lastActiveAt }`, push to `conversations[]`, set `activeConversationId`, persist. `selectConversation(id)` — set `activeConversationId`, set `selectedAgentId` = that conversation's `agentId`, load transcript, persist. `loadConversations()` — hydrate from `window.__bos.storage.get('chat-state')` on app mount.

**Checkpoint**: Conversation management fully functional — new/switch/persist, global across tabs, per-conversation agent binding

---

## Phase 56: User Story 8 - Full Tool-Call Visibility (Priority: P2)

**Goal**: Every tool call the agent makes is rendered in the reply's tool row. `agentic_editor_*` chips keep their existing violet styling; all other tools render in neutral gray.

**Independent Test**: Ask agent something that triggers a non-editor tool (e.g. "search the web for…") → assert the reply's tool row shows that tool in gray, alongside any editor tools in violet.

### Tests for User Story 8 ⚠️

- [ ] T073 [P] [US8] E2E test: "editor tool chips render in violet" — mock a reply with `toolCalls: [{function: {name: "agentic_editor_add_content"}}]`, assert the chip has class `tool-chip editor` (violet styling)
- [ ] T074 [P] [US8] E2E test: "non-editor tool chips render in gray" — mock a reply with `toolCalls: [{function: {name: "web_search"}}]`, assert the chip has class `tool-chip other` (neutral gray styling)
- [ ] T075 [P] [US8] E2E test: "mixed tool row shows both colors" — mock a reply with `toolCalls: [{name: "agentic_editor_modify_content"}, {name: "read_file"}, {name: "memory_search"}]`, assert 1 editor chip + 2 other chips in the same `.tool-row`
- [ ] T076 [P] [US8] E2E test: "tool row renders on conversation replay (load from transcript)" — seed a transcript file via `fs.write` mock with an assistant message carrying `toolCalls[]`, open that conversation, assert the tool row renders with correct colors (no live run needed)
- [ ] T077 [P] [US8] Unit test in `e2e/agentic-text-editor.spec.ts` (or co-located `app/src/assistant/__tests__/tool-chip.test.ts`): `tool-chip.ts` prefix rule — `getToolChip("agentic_editor_open_file")` returns `{variant: "editor"}`; `getToolChip("web_search")` returns `{variant: "other"}`; `getToolChip("read_file")` returns `{variant: "other"}`

### Implementation for User Story 8

- [ ] T078 [US8] Create `app/src/assistant/tool-chip.ts` — `getToolChip(toolName: string): ToolChip`. Rule: `toolName.startsWith("agentic_editor_")` → `{ variant: "editor", label: prettified(toolName), icon: "pencil" }`. Otherwise → `{ variant: "other", label: prettified(toolName), icon: "wrench" }`. `prettified` converts `snake_case` to `lowercase words` (e.g. `agentic_editor_add_content` → "add content", `web_search` → "web search"). This is the **single source of truth** for the dual-color rule.
- [ ] T079 [US8] Create `app/src/components/chat/tool-row.tsx` — `<ToolRow toolCalls: ToolCallRef[] />` component. Maps each `toolCall.function.name` through `getToolChip()` and renders a `<span className={\`tool-chip ${chip.variant}\`}>` with the chip's icon + label. Layout: `display: flex; flex-wrap: wrap; gap: 5px;` (matching mockup `.tool-row`).
- [ ] T080 [US8] Modify `app/src/components/chat/message-bubble.tsx` — for agent messages that have `toolCalls[]` (length > 0), render `<ToolRow toolCalls={message.toolCalls} />` between the message bubble and the timestamp. This **replaces** the v1 editor-only chip row. Styling must match the mockup: `.tool-chip.editor` (violet: `background: rgba(139,92,246,0.16); border: 1px solid rgba(139,92,246,0.35); color: #c4b5fd`) and `.tool-chip.other` (gray: `background: rgba(255,255,255,0.06); border: 1px solid rgba(255,255,255,0.16); color: rgba(255,255,255,0.55)`).
- [ ] T081 [US8] Create `app/src/assistant/run-projector.ts` — folds a run's `onRunEvent` events into the live render model consumed by `chat-store.ts`. Handles: `text_delta` (append to `streamingMessage`), `tool_call` (add to `liveToolStatus` map keyed by `callId`), `tool_result` (mark `liveToolStatus[callId].status = "done"`), `message` (finalize: replace `streamingMessage` with the settled message, clear `liveToolStatus`, dedupe by `message.id` against existing transcript). Exposes: `project(events, state) → newState` or a class with `feed(event)`.
- [ ] T082 [US8] Wire live tool row in `chat-messages.tsx` — while a run is active (`chat-store.activeRunId` is set), render a live agent bubble with `streamingMessage` text + a `<ToolRow>` fed from `liveToolStatus` (only entries with `status !== "pending"`). When the `message` event finalizes, the live bubble transitions to the settled message (with its full `toolCalls[]` via T080's `<ToolRow>`).

**Checkpoint**: Full tool-call visibility — dual-color chips render for all tools, both live and on replay

---

## Phase 57: Error States & Graceful Degradation

**Purpose**: The app must not throw when capabilities are missing or reads fail

- [ ] T083 [P] Implement "Assistant unavailable" state: if `listAgents()` rejects (capability not granted or network error), show a clear message in the chat pane replacing the input area. Editor pane unaffected. No crash.
- [ ] T084 [P] Implement "Conversation not found" state: if `readTranscript(id)` fails (file deleted/corrupt), show "Conversation not found" in the message area, remove the stale entry from `conversations[]`, and auto-activate the next most-recent conversation (or show empty state if none remain).
- [ ] T085 [P] Implement `startRun` 409 handling: if the response includes an `activeRunId`, call `attachRun(activeRunId)` instead of treating it as an error. (Covers: user opens a conversation while a run is still in-flight.)

---

## Phase 58: E2E Test Suite — v2 Full Coverage

**Purpose**: The complete e2e test file covers all v2 user stories end-to-end, including the cross-cutting scenarios

- [x] T086 Create `e2e/v2.spec.ts` (dedicated v2 suite, 9 tests) covering:
  1. **Shell integrity (regression)**: app renders two-pane layout, agent selector visible in header, conversation selector visible, new-conversation button visible
  2. **US6 — Agent selector**: dropdown opens, lists agents, selection updates label, persists across reload
  3. **US7 — Conversations**: new conversation creates empty state, dropdown lists conversations most-recent-first, switching restores transcript + agent, persists across reload, global across tabs
  4. **US8 — Tool row**: mocked transcript with mixed `toolCalls[]` renders dual-color chips; editor prefix = violet, non-editor = gray; live tool row appears during a (mocked) run and transitions to finalized
  5. **Cross-cutting**: agent switch + conversation switch interaction (select agent B in conv A → new conv → agent B is active); conversation with no messages shows empty state; capability-revoked state degrades gracefully
  6. **Persistence round-trip**: seed `app-storage` with a `chat-state` containing 2 conversations → open app → both appear in dropdown → select first → transcript loads → agent matches

  **Test strategy** (deterministic, no real LLM):
  - Use BOS's Playwright fixture to open the app window
  - Mock `window.__bos.assistant.listAgents` to return a fixed agent catalog
  - Mock `window.__bos.assistant.startRun` to return a fixed `runId` and emit scripted `onRunEvent` sequences (text_delta → tool_call → tool_result → message)
  - Mock `window.__bos.fs.read` to return pre-seeded transcript JSON
  - Mock `window.__bos.storage.get/set` for persistence assertions
  - Assert on DOM (classes, text content, element presence) per the mockup's CSS structure

- [ ] T087 [P] Add **v2 quickstart.md** section: manual validation steps for US6/US7/US8 (agent switch, conversation new/switch, tool-row dual-color) + the e2e run command. Extend the existing quickstart's "Known limitations" if any v2 limitation applies.

---

## Phase 59: Polish & Verification

- [ ] T088 [P] Run `npx tsc --noEmit --strict --jsx react-jsx --target ES2020 --module esnext --moduleResolution bundler --skipLibCheck --lib dom,dom.iterable,esnext --types node,react,react-dom data/user-apps/items/agentic-text-editor/app/src/main.tsx` — fix all type errors
- [ ] T089 [P] Run `npm run lint` — fix all lint errors
- [ ] T090 [P] Verify the app renders correctly at small (800px) and large (1920px) window sizes with the new header controls (no overflow, ellipsis works)
- [ ] T091 [P] Verify conversation switch is instant with no layout shift (transcript loads synchronously from in-memory cache after first read)
- [ ] T092 [P] Verify the agent dropdown and conversation dropdown menus close on outside click and Escape key

---

## Dependencies & Execution Order

### Phase Dependencies

- **Phase 53 (Setup)**: No dependencies — can start immediately
- **Phase 54 (US6 Agent Selector)**: Depends on Phase 53 — BLOCKS US7 (chat-store is shared)
- **Phase 55 (US7 Conversations)**: Depends on Phase 54 (chat-store, header layout)
- **Phase 56 (US8 Tool Row)**: Depends on Phase 53 (types, client) — can run **in parallel with Phase 55** if different files
- **Phase 57 (Error States)**: Depends on Phases 54+55 (needs chat-store + client wired)
- **Phase 58 (E2E Tests)**: Depends on Phases 54+55+56 (tests the integrated behavior)
- **Phase 59 (Polish)**: Depends on all prior phases

### Within Each Phase

- Tests are written FIRST (TDD) — they should fail before implementation
- `chat-store.ts` (T060) is the shared dependency for US6 + US7 — implement it in Phase 54, extend in Phase 55
- `tool-chip.ts` (T078) and `tool-row.tsx` (T079) are independent of the agent/conversation work — Phase 56 can proceed in parallel with Phase 55

### Parallel Opportunities

- T053, T055 are [P] (different files)
- T056, T057, T058 are [P] (all e2e tests, same file but different test cases — can be written together)
- T062–T067 are [P] (e2e tests)
- T073–T077 are [P] (e2e/unit tests)
- Phase 56 (T078–T082) can run in parallel with Phase 55 (T068–T072) — different files, no shared state until integration
- T083–T085 are [P] (independent error-state implementations)
- T088–T092 are [P] (polish checks)

---

## Implementation Strategy

### Recommended Order (single developer)

1. Phase 53 (Setup) → types + client + capabilities
2. Phase 54 (US6) → agent selector + chat-store + header
3. Phase 55 (US7) → conversation selector + lifecycle + messages
4. Phase 56 (US8) → tool-chip + tool-row + message-bubble + run-projector
5. Phase 57 (Error states)
6. Phase 58 (Full e2e suite)
7. Phase 59 (Polish + verify)

### Parallel Team Strategy

- **Developer A**: Phase 53 → 54 → 55 (agent + conversations, sequential — shared chat-store)
- **Developer B**: Phase 53 → 56 (tool row — independent files)
- **Integration**: Phase 57 → 58 → 59 (both developers)

---

## Notes

- [P] tasks = different files, no dependencies
- [Story] label maps task to specific user story for traceability
- The e2e tests mock the broker (`window.__bos.assistant.*`) and VFS (`window.__bos.fs.read`) — they do NOT drive a real LLM run (per the v1 quickstart's established pattern)
- `tool-chip.ts` is the single source of truth for the dual-color rule — no other module decides editor vs. other
- `chat-store.ts` is the single source of truth for the app-scoped conversation index — transcripts are read on demand, never persisted by the item
- The `ate-` conversation id prefix is intentional (ADR-2) — makes editor conversations identifiable in the global `/Documents/Chats/` listing
