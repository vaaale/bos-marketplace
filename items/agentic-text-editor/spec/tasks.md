# Tasks: Agentic Text Editor

**Input**: Design documents from `/user-specs/agentic-text-editor/`

**Prerequisites**: spec.md, plan.md, ui-mockup.html

**Tests**: Playwright e2e tests (see T022)

## Format: `[ID] [P?] [Story] Description`

- **[P]**: Can run in parallel (different files, no dependencies)
- **[Story]**: Which user story this task belongs to
- Include exact file paths in descriptions

## Phase 1: Setup (Shared Infrastructure)

**Purpose**: Project initialization and basic structure

- [x] T001 Create `data/user-apps/items/agentic-text-editor/` directory structure
- [x] T002 Create `app.json` with id "agentic-text-editor", name "Editor", icon "PenTool", default size 1200x700, singleton true
- [x] T003 [P] Create `types.ts` with Document, Tab, ChatMessage, EditorSettings, FormatHandler interfaces
- [x] T004 [P] Create `state/document-store.ts` with Zustand store for documents, tabs, chat, settings

## Phase 2: Foundational (Blocking Prerequisites)

**Purpose**: Core infrastructure that MUST be complete before ANY user story can be implemented

**⚠️ CRITICAL**: No user story work can begin until this phase is complete

- [x] T005 Create `services/file-service.ts` with `openFile(path)`, `saveFile(doc)`, `saveAll()`, `createDocument(filename?)` using VFS API
- [x] T006 [P] Create `services/format-service.ts` with format handler registry (register, getByExtension, getActive)
- [x] T007 [P] Create default markdown format handler (renders basic markdown to HTML)
- [x] T008 [P] Create default plaintext format handler (no rendering, raw text only)
- [x] T009 [P] Create `config/editor-config.ts` with config namespace registration for fontFamily, fontSize, headingColors, etc.
- [x] T010 [P] Create `tools/assistant-tools.ts` with Tier 1 tool declarations (agentic_editor_open_file, create_document, save_document, save_all, add_content, modify_content, remove_content, set_active_document, list_documents, get_active_document, get_document_content, search_document)
- [x] T011 Register format service and assistant tools in capabilities registry

**Checkpoint**: Foundation ready — all services, formats, config, and tool declarations in place.

## Phase 3: User Story 1 - Open and edit a document manually (Priority: P1) 🎯 MVP

**Goal**: User can open files, edit content, toggle between Edit/Preview modes, and save files.

**Independent Test**: Open app → click Open → select a markdown file → edit in text mode → toggle to preview → verify rendered output → click Save → verify file persisted.

### Implementation for User Story 1

- [x] T012 [P] [US1] Create `components/resizer.tsx` — draggable pane divider with violet hover, col-resize cursor, clamped 25-60% range
- [ ] T013 [P] [US1] Create `components/editor/toolbar.tsx` — Open button (folder icon), Save button (floppy icon), Edit/Preview pill toggle
- [ ] T014 [P] [US1] Create `components/editor/tab-bar.tsx` — horizontal scrollable tab list with active/inactive states, close button (X on hover), amber unsaved dot
- [ ] T015 [P] [US1] Create `components/editor/edit-view.tsx` — monospace textarea with line numbers, placeholder text, line number sync on scroll
- [ ] T016 [P] [US1] Create `components/editor/preview-view.tsx` — rendered markdown with styled h1/h2 (purple borders), code blocks (dark bg), lists, bold/italic
- [ ] T017 [P] [US1] Create `components/editor/status-bar.tsx` — filename, change status (amber when dirty), cursor position (Ln/Col), encoding, format
- [ ] T018 [US1] Create `components/chat/chat-header.tsx` — "Chat with Agent" title, green status dot
- [ ] T019 [US1] [US1] Create `components/chat/chat-messages.tsx` — scrollable message list, user (right/violet), agent (left/light), timestamps, empty state
- [ ] T020 [US1] Create `components/chat/chat-input.tsx` — text input with focus violet border, send button (arrow, violet bg)
- [ ] T021 [US1] Create main `index.tsx` — two-pane layout with resizer, wire all components together, connect to document store

## Phase 4: User Story 2 - Agent edits a document via chat (Priority: P1)

**Goal**: User can ask the agent to add, modify, or remove content, and changes appear live in the document.

**Independent Test**: Open file → ask agent "add a paragraph about X" → verify content appears immediately → toggle to preview → verify rendered output.

### Implementation for User Story 2

- [ ] T022 [US2] Implement `agentic_editor_add_content` tool handler — appends content to active document's internal buffer
- [ ] T023 [US2] Implement `agentic_editor_modify_content` tool handler — find and replace text in document
- [ ] T024 [US2] Implement `agentic_editor_remove_content` tool handler — find and remove text from document
- [ ] T025 [US2] Wire agent context injection — pass open tabs, active doc, content preview to agent system prompt
- [ ] T026 [US2] Add "agent edited this document" visual indicator in status bar (brief flash)
- [ ] T027 [US2] Handle edge case: agent edits closed document → open it first, then edit

## Phase 5: User Story 3 - Agent opens/saves/creates files (Priority: P1)

**Goal**: Agent can open, save, create, and search files via assistant tool calls.

**Independent Test**: Ask agent "open file /docs/notes.md" → verify tab opens → ask "create draft" → verify untitled tab → ask "save all" → verify files persisted.

### Implementation for User Story 3

- [ ] T028 [US3] Implement `agentic_editor_open_file` tool handler — opens file via VFS, creates new tab
- [ ] T029 [US3] Implement `agentic_editor_create_document` tool handler — creates new untitled document
- [ ] T030 [US3] Implement `agentic_editor_save_document` tool handler — saves active document to VFS
- [ ] T031 [US3] Implement `agentic_editor_save_all` tool handler — saves all dirty documents
- [ ] T032 [US3] Implement `agentic_editor_search_document` tool handler — searches doc content, returns line numbers + context
- [ ] T033 [US3] Implement `agentic_editor_list_documents` tool handler — returns list of open docs with state
- [ ] T034 [US3] Implement `agentic_editor_get_active_document` tool handler — returns active doc info + preview
- [ ] T035 [US3] Implement `agentic_editor_get_document_content` tool handler — returns full content of doc
- [ ] T036 [US3] Implement `agentic_editor_set_active_document` tool handler — switches active tab

## Phase 6: User Story 4 - Multiple documents and tab management (Priority: P2)

**Goal**: User can work with multiple documents, switch tabs, and the chat operates on the active document.

**Independent Test**: Open 3 files → switch tabs → verify content changes → ask agent about specific tab content → verify agent targets correct doc.

### Implementation for User Story 4

- [ ] T037 [US4] Add tab close logic with "Save changes?" dialog for unsaved tabs
- [ ] T038 [US4] Update chat context when tab switches — update active document reference in system prompt
- [ ] T039 [US4] Add tab scroll behavior — auto-scroll tab bar when many tabs open
- [ ] T040 [US4] Handle concurrent edits: user typing + agent editing → last write wins to internal buffer

## Phase 7: User Story 5 - User-configurable appearance settings (Priority: P2)

**Goal**: User can configure fonts, sizes, and colors through the app's settings.

**Independent Test**: Open settings → change font to monospace, size to 14 → verify editor reflects change → change heading color → verify preview reflects new color.

### Implementation for User Story 5

- [ ] T041 [US5] Wire config namespace to editor settings — load on mount, save on change
- [ ] T042 [US5] Apply fontFamily setting to edit-view and preview-view
- [ ] T043 [US5] Apply fontSize setting to edit-view and preview-view
- [ ] T044 [US5] Apply headingColors setting to preview-view (h1, h2 colors)
- [ ] T045 [US5] Apply linkColor, codeBlockBackground, codeBlockForeground to preview-view
- [ ] T046 [US5] Persist settings across app restarts (config namespace handles this)

## Phase 8: Polish & Cross-Cutting Concerns

**Purpose**: Improvements that affect multiple user stories

- [ ] T047 [P] Add Playwright e2e test file `e2e/agentic-text-editor.spec.ts` — test core workflows
- [ ] T048 [P] Run `npx tsc --noEmit` and `npm run lint` — fix all errors
- [ ] T049 [P] Verify app renders correctly at small (800px) and large (1920px) window sizes
- [ ] T050 [P] Verify tab switching is instant with no layout shift
- [ ] T051 [P] Verify status bar updates immediately on save/change
- [ ] T052 [P] Create `quickstart.md` validation guide

## Dependencies & Execution Order

### Phase Dependencies

- **Setup (Phase 1)**: No dependencies — can start immediately
- **Foundational (Phase 2)**: Depends on Setup completion — BLOCKS all user stories
- **User Stories (Phase 3+)**: All depend on Foundational phase completion
  - Stories 1-3 can proceed in parallel (if team capacity allows)
  - Story 4 depends on Story 1 (tab management)
  - Story 5 depends on Foundational (config namespace)
- **Polish (Phase 8)**: Depends on all desired user stories being complete

### User Story Dependencies

- **User Story 1 (P1)**: Can start after Foundational — no dependencies on other stories
- **User Story 2 (P1)**: Can start after Foundational — may integrate with US1 but should be independently testable
- **User Story 3 (P1)**: Can start after Foundational — may integrate with US1/US2 but should be independently testable
- **User Story 4 (P2)**: Depends on US1 tab management being complete
- **User Story 5 (P2)**: Depends on config namespace from Phase 2

### Within Each User Story

- Services before components
- Components before wiring in `index.tsx`
- Tool handlers before integration tests
- Story complete before moving to next priority

### Parallel Opportunities

- All Setup tasks marked [P] can run in parallel
- All Foundational tasks marked [P] can run in parallel (within Phase 2)
- Once Foundational is done:
  - Developer A: User Story 1 (UI components)
  - Developer B: User Story 2 (agent editing tools)
  - Developer C: User Story 3 (file operation tools)
- All Polish tasks marked [P] can run in parallel

## Parallel Example: Phase 2

```bash
# Launch all Foundational tasks together:
Task: "Create file-service.ts with VFS open/save operations"
Task: "Create format-service.ts with handler registry"
Task: "Create markdown format handler"
Task: "Create plaintext format handler"
Task: "Create editor-config.ts with config namespace"
Task: "Create assistant-tools.ts with tool declarations"
Task: "Register services and tools in capabilities registry"
```

## Implementation Strategy

### MVP First (User Story 1 Only)

1. Complete Phase 1: Setup
2. Complete Phase 2: Foundational
3. Complete Phase 3: User Story 1
4. **STOP and VALIDATE**: Test User Story 1 independently
5. Verify: Open file → edit → toggle preview → save → file persisted

### Incremental Delivery

1. Complete Setup + Foundational → Foundation ready
2. Add User Story 1 → Test independently → Deploy/Demo (MVP!)
3. Add User Story 2 → Test independently → Agent can edit documents
4. Add User Story 3 → Test independently → Agent can manage files
5. Add User Story 4 → Test independently → Multi-tab workflow works
6. Add User Story 5 → Test independently → Settings persist
7. Add Polish → Final validation

### Parallel Team Strategy

With multiple developers:

1. Team completes Setup + Foundational together
2. Once Foundational is done:
   - Developer A: User Story 1 (UI components, main layout)
   - Developer B: User Story 2 (agent editing tools, context injection)
   - Developer C: User Story 3 (file operation tools, search)
3. After US1-3 complete:
   - Developer A: User Story 4 (tab management polish)
   - Developer B: User Story 5 (settings integration)
4. Team completes Polish together

### Notes

- [P] tasks = different files, no dependencies
- Each user story should be independently completable and testable
- Verify tests fail before implementing (TDD approach for e2e tests)
- Commit after each task or logical group
- Stop at any checkpoint to validate story independently
- Use `ui-mockup.html` as visual reference for styling
- Follow BOS style guide: dark-only, opacity palette, inline Tailwind, lucide-react
