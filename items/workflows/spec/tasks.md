# Tasks: Workflow Manager — Service-Owned Workflow Engine (Engine Pivot)

**Input**: Design documents from `/Specs/user-specs/workflow-manager/001-workflow-manager-service-tools/` (spec.md, design.md, plan.md, mockup.html)

**Prerequisites**: plan.md (required), spec.md (required — US1..US9, FR-001..024, NFR-001..005, SC-001..014)

**Tests**: Unit tests (per service module) **and Playwright e2e tests for EVERY user story** are **explicitly in scope** (user instruction: "include writing unit tests and e2e tests", extended to "the tasks must include writing e2e tests"). **Thorough documentation — usage AND dev — is a first-class deliverable** (user instruction).

**Organization**: Tasks are grouped by user story to enable independent implementation and testing. This is a **dual-scope** feature — a `bos-core` retirement (foundational, on the active feature branch `bos/042-workflow-manager-service`) + a `marketplace-item` re-implementation (service-owned engine under `data/user-apps/items/workflows/`, delivered via `app_build`).

**User stories (from spec.md)**: US1 tool surface (P1) · US2 gating/lifecycle (P2) · US3 real-VFS management (P2) · US4 graph UI (P2) · US5 execution via service (P3) · US6 historical runs (P2) · US7 dynamic routing (P1) · US8 parallel + ephemeral (P1) · US9 skill (P2).

## Format: `[ID] [P?] [Story] Description`

- **[P]**: Can run in parallel (different files, no dependencies)
- **[Story]**: Which user story this task belongs to (e.g., US1, US2, US3)
- Include exact file paths in descriptions

---

## Phase 1: Setup (Shared Infrastructure)

**Purpose**: Project initialization and basic structure — the item skeleton and the bos-core retirement baseline.

- [x] T001 Create the marketplace-item skeleton at `data/user-apps/items/workflows/` with `services/`, `app/`, `config/`, `skills/`, `docs/` subfolders per `target-marketplace-item.md`
- [x] T002 [P] Author `services/service.json` — `deploymentMode: "tools"`, entry `index.js`, configSchema (`port` default `0`, `host` default `127.0.0.1`, `maxConcurrentSteps`)
- [x] T003 [P] Author `config/workflows.json` — `{ "port": 0, "host": "127.0.0.1", "maxConcurrentSteps": 5 }`
- [x] T004 [P] Create the bos-core retirement baseline: snapshot current `src/lib/workflows/*` + `/api/workflows/*` behavior for reference before deletion

---

## Phase 2: Foundational (Blocking Prerequisites)

**Purpose**: Core infrastructure that MUST be complete before ANY user story can be implemented.

**⚠️ CRITICAL**: The **bos-core retirement** is the foundational blocker — it must land first so the service-owned engine can become the single authority without shadowing. No user story work can begin until this phase is complete.

- [x] T005 Bos-core retirement: delete `src/lib/workflows/types.ts`, `runner.ts`, `store.ts`, `validate.ts`, `generate.ts` (whole old engine — user-approved pivot)
- [x] T006 [P] Bos-core retirement: delete `/api/workflows/` routes — `route.ts`, `run/route.ts`, `status/route.ts`, `cancel/route.ts`, `generate/route.ts`, `validate/route.ts`
- [x] T007 [P] Bos-core retirement: delete `src/lib/assistant/tools/server/workflows.ts` (the `workflowTools()` set) — no longer shadows service tools
- [x] T008 Bos-core retirement: remove `workflowTools` import + spread from `src/lib/assistant/registry.ts`
- [x] T009 [P] Bos-core retirement: delete `src/components/agent/WorkflowActions.tsx` and remove its `<WorkflowActions/>` usage from `src/components/agent/CopilotProvider.tsx`
- [x] T010 [P] Bos-core retirement: remove the 7 static `workflow_*` capability entries from `src/lib/agent/capabilities-registry.ts`
- [x] T011 [P] Service foundation: implement `services/vfs.js` — loopback `/api/fs` bridge helpers (ADR-2, real VFS, never host paths)
- [x] T012 [P] Service foundation: implement `services/engine/node-model.js` — orthogonal node axes (agent source: static/ephemeral × output type: delegate/tool/research/ag-ui)
- [x] T013 [P] Service foundation: implement `services/engine/validate.js` — DAG acyclicity + node schema validation (re-implemented from retired engine)
- [x] T014 Service foundation: implement `services/engine/store.js` — workflow + run CRUD over loopback `/api/fs`
- [x] T015 [P] Service foundation: implement `services/index.js` — worker entry: lifecycle + `tool_declare` + worker-IPC + migration bootstrap + structured log channel (NFR-005)

**Checkpoint**: Foundation ready — the bos-core retirement has landed, the service skeleton + node model + validation + store + vfs are in place. User story implementation can now begin.

---

## Phase 3: User Story 1 — 039-Compliant Tool Surface (Priority: P1) 🎯 MVP

**Goal**: The workflow tools are exposed as service-declared native tools (039), replacing the retired server tools — the assistant can list/create/read/modify/run/status/cancel/delete/export/validate workflows (FR-001/002/003).

**Independent Test**: Launch the service; confirm 12 tools are declared (`workflow_list/create/read/modify/run/status/cancel/delete/export/validate/run_list/run_get`); a workflow can be created, listed, read, and deleted via the tools without the UI.

### Tests for User Story 1 (unit + e2e, in scope) ⚠️

> **NOTE: Write these FIRST, ensure they FAIL before implementation**

- [x] T016 [P] [US1] Unit test for tool declarations + schemas in `<item>/services/__tests__/tools.test.js`
- [x] T017 [P] [US1] Unit test for tool handlers in `<item>/services/__tests__/handlers.test.js`
- [x] T018 [P] [US1] E2E test for the tool surface end-to-end — create/list/read/delete a workflow via the service tools — in `e2e/001-workflow-manager-service-tools.spec.ts`

### Implementation for User Story 1

- [x] T019 [P] [US1] Implement `services/tools.js` — 12 tool declarations + input JSON-schemas (FR-002/014/016/024)
- [x] T020 [US1] Implement `services/handlers.js` — tool handlers wired to the engine (create/read/modify/delete/export/validate/run/status/cancel/list/run_list/run_get) (depends on T019, T014)
- [x] T021 [US1] Implement `workflow_list` returning `workflow_id`, `status` (running/idle), `run_id` when running (FR-024) in `services/handlers.js`
- [x] T022 [US1] Add validation + error handling for all 12 tool handlers (per 039 R10, no leaked pending waits) + structured logs for `tool_call dispatched/resolved/schema-rejected/timeout` (NFR-005)

**Checkpoint**: US1 fully functional — the assistant can control workflows end-to-end via the 12 tools, independent of the UI.

---

## Phase 4: User Story 2 — Service Tools Respect Tool Gating and Lifecycle (Priority: P2)

**Goal**: Service-declared workflow tools are governed by the same tool-gating model as built-in tools (allowlist, deferred approval per 039 FR-005), and stop/uninstall removes the declared tools from the registry (per 039 FR-006). The service never auto-executes a gated tool without approval, and no stale tool call to a stopped service is possible (FR-010/011).

**Independent Test**: With a restrictive tool-gate config, verify a workflow tool is not auto-executed without approval; stop the service and verify the tools disappear from the registry and are no longer callable. Testable in isolation.

### Tests for User Story 2 (unit + e2e, in scope) ⚠️

> **NOTE: Write these FIRST, ensure they FAIL before implementation**

- [x] T018a [P] [US2] Unit test for tool gating — a gated workflow tool is not auto-executed without approval (per 039 FR-005) — in `<item>/services/__tests__/tools.test.js`
- [x] T018b [P] [US2] Unit test for lifecycle cleanup — stopping/uninstalling the service removes declared tools from the registry (per 039 FR-006) — in `<item>/services/__tests__/handlers.test.js`
- [x] T018c [P] [US2] E2E test for tool gating + lifecycle — with a restrictive gate config a workflow tool is deferred; stopping the service removes the tools — in `e2e/001-workflow-manager-service-tools.spec.ts`

### Implementation for User Story 2

- [x] T018d [P] [US2] Implement 039 tool-gating wiring — ensure service-declared workflow tools respect the allowlist/deferred-approval model exactly like built-in tools (FR-010)
- [x] T018e [US2] Implement registry-cleanup on stop/uninstall — service teardown removes its declared tools from the registry (FR-011), no stale tool call to a stopped service
- [x] T018f [US2] Wire lifecycle hooks — `tool_declare` on start, tool-registry removal on stop/uninstall, gating respected end-to-end

**Checkpoint**: US1 + US2 — workflow tools are gated like built-in tools, disappear on stop/uninstall, and are never auto-executed without approval.

---

## Phase 5: User Story 5 — Workflow Execution Runs Through the Service (Fire-and-Poll) (Priority: P3)

**Goal**: `workflow_run` is asynchronous fire-and-poll (returns `runId` immediately, ADR-8); `workflow_status`/`workflow_run_get` report live progress; `workflow_list` exposes running state for agent polling (FR-024). Execution runs through the service (US5).

**Independent Test**: Run a workflow via `workflow_run`; confirm it returns a `runId` in <1s (not blocking); poll `workflow_status` to observe progress; cancel it; confirm `workflow_list` reflects `running` → `idle`.

### Tests for User Story 5 (unit + e2e, in scope) ⚠️

- [x] T023 [P] [US5] Unit test for executor (delegate contract) in `<item>/services/__tests__/executor.test.js`
- [x] T024 [P] [US5] E2E test for the fire-and-poll run contract — `workflow_run` returns a `runId` immediately, `workflow_status` reports progress, `workflow_cancel` flips `running` → `idle` — in `e2e/001-workflow-manager-service-tools.spec.ts`

### Implementation for User Story 5

- [x] T025 [P] [US5] Implement `services/engine/executor.js` — loopback `POST /api/subagents/delegate` per node (ADR-1), NDJSON, fire-and-poll `runId` (depends on T011)
- [x] T026 [US5] Implement run-state tracking + `workflow_status`/`workflow_run_get` live status in `services/engine/store.js` + `services/runs.js` (depends on T025)
- [x] T027 [US5] Implement cancellation (Option (b)): worker aborts its in-flight delegate fetch; inner-loop linked-abort settles `cancelled` — no bos-core delegate-route change (depends on T025)

**Checkpoint**: US1 + US2 + US5 — workflows can be run asynchronously, polled, and cancelled via tools.

---

## Phase 6: User Story 3 — Workflows Listed/Managed from Real VFS + Historical Runs (Priority: P2)

**Goal**: Workflows persist to real VFS `/Workflows/` via loopback `/api/fs` (ADR-2, never host paths); the app lists/manages workflows from the same real-VFS location (US3); each run is a first-class persisted entity (`/Workflows/.runs/<workflowId>/<runId>.json`) — historical replay via `workflow_run_list`/`workflow_run_get` (US6/FR-015/016/017).

**Independent Test**: Create + run a workflow; confirm the workflow JSON + run log exist in the real VFS; list + read the historical run via `workflow_run_list`/`workflow_run_get`; delete a workflow and confirm its run log is removed.

### Tests for User Story 3 (unit + e2e, in scope) ⚠️

- [x] T028 [P] [US3] Unit test for vfs bridge in `<item>/services/__tests__/vfs.test.js`
- [x] T029 [P] [US3] Unit test for run persistence in `<item>/services/__tests__/runs.test.js`
- [x] T030 [P] [US3] Unit test for migration (additive, idempotent) in `<item>/services/__tests__/migration.test.js`
- [x] T031 [P] [US3] E2E test for real-VFS persistence + historical-run access via tools — create/run, verify workflow JSON + run log persist, `workflow_run_list`/`workflow_run_get` return the run — in `e2e/001-workflow-manager-service-tools.spec.ts`

### Implementation for User Story 3

- [x] T032 [P] [US3] Implement `services/runs.js` — run entity persistence + `workflow_run_list`/`workflow_run_get` (US6, FR-016) (depends on T014, T026)
- [x] T033 [US3] Implement `services/migration.js` — additive legacy-workflow migration (ADR-5, copy + archive, never delete) (depends on T014)
- [x] T034 [US3] Wire real-VFS workflow + run storage into `handlers.js` (create/read/delete/export read/write `/Workflows/*`) (depends on T032)

**Checkpoint**: US1 + US2 + US5 + US3 — workflows and runs persist to the real VFS, historical runs are tool-reachable.

---

## Phase 7: User Story 7 — Dynamic Routing to Sub-Agents (Priority: P1)

**Goal**: A node may declare candidate sub-agents; the node's agent selects the appropriate candidate(s) as its last action — exactly one in the single-choice case, several in the parallel case — with retry-loop enforcement (US7/FR-018); single-child nodes delegate automatically (FR-019).

**Independent Test**: Build a workflow whose node has multiple candidate sub-agents; run it; confirm the node's agent selects a valid candidate as its last action and the run proceeds; confirm invalid/missing selection is retried (retry-loop).

### Tests for User Story 7 (unit + e2e, in scope) ⚠️

- [x] T035 [P] [US7] Unit test for dynamic router (candidate selection + retry-loop) in `<item>/services/__tests__/router.test.js`
- [x] T036 [P] [US7] E2E test for dynamic routing — a node with candidate sub-agents selects one and the run proceeds along the chosen path; invalid selection is retried — in `e2e/001-workflow-manager-service-tools.spec.ts`

### Implementation for User Story 7

- [x] T037 [P] [US7] Implement `services/engine/router.js` — dynamic routing: candidate selection as last action, retry-loop enforcement, auto-delegate for single child (depends on T012, T025)
- [x] T038 [US7] Wire router into the scheduler for multi-candidate nodes (depends on T037)
- [x] T039 [US7] Add validation for `candidateAgents[]` in `validate.js` (must exist, must be resolvable)

**Checkpoint**: US1+2+5+3+7 — workflows can dynamically route to the appropriate sub-agent at run time.

---

## Phase 8: User Story 8 — Parallel Execution + Ephemeral Agents (Priority: P1)

**Goal**: Independent ready branches + Research-node fan-out run concurrently up to `maxConcurrentSteps` (scheduling semantics, FR-020); nodes are configurable as ephemeral agents (task + tools + skills) when no existing BOS agent matches (FR-021); Research output type fans out sub-agents in parallel (FR-022).

**Independent Test**: Build a workflow with multiple independent Research children; run it; confirm parallel branches execute concurrently (up to the cap) rather than serially. Configure an ephemeral-agent node (task + tools + skills); confirm it executes.

### Tests for User Story 8 (unit + e2e, in scope) ⚠️

- [x] T040 [P] [US8] Unit test for scheduler (ready-set, concurrency cap, research fan-out) in `<item>/services/__tests__/scheduler.test.js`
- [x] T041 [P] [US8] Unit test for node model (agent source × output type) in `<item>/services/__tests__/node-model.test.js`
- [x] T042 [P] [US8] E2E test for parallel execution + ephemeral agents — independent branches run concurrently (up to the cap), an ephemeral-agent node executes — in `e2e/001-workflow-manager-service-tools.spec.ts`

### Implementation for User Story 8

- [x] T043 [P] [US8] Implement `services/engine/scheduler.js` — DAG scheduler: ready-set, `maxConcurrentSteps` cap, research fan-out (depends on T012, T038)
- [x] T044 [US8] Implement research output type — fan out multiple sub-agents in parallel, collect outputs (depends on T043)
- [x] T045 [US8] Implement ephemeral agent node execution — task + tools + skills via the delegate route (ADR-1, open item #3: skill scoping) (depends on T043)

**Checkpoint**: US1+2+5+3+7+8 — workflows can route dynamically AND run branches/sub-agents in parallel, with ephemeral-agent nodes.

---

## Phase 9: User Story 4 + 5 — Graph UI with Active-Step Highlight (Priority: P2/P3)

**Goal**: The app renders each workflow as an interactive graph (nodes + dependency edges, branching support) — FR-012; during a run the graph highlights the active step + live per-step status (pending/running/completed/failed/cancelled) — FR-013. The UI is a parallel surface to the tools (FR-014). App lists workflows from the real VFS (US4).

**Independent Test**: Open the app; see the list of workflows from the real VFS; open one to see the graph; run it and confirm the active step highlights + per-step statuses update live; cancel and confirm the graph reflects it.

### Tests for User Story 4+5 (e2e, in scope) ⚠️

- [x] T046 [P] [US45] E2E test for graph views (list/detail/run + active-step highlight) in `e2e/001-workflow-manager-service-tools.spec.ts`
- [x] T047 [P] [US45] E2E test for service-stopped banner + empty state in `e2e/001-workflow-manager-service-tools.spec.ts`

### Implementation for User Story 4+5

- [x] T048 [P] [US45] Build the app facet `app/src/main.tsx` — list view (from real VFS), service pill, stopped banner, empty state (mockup-driven, `mockup.html` is the binding UI contract)
- [x] T049 [US45] Implement the graph view in `app/src/` — nodes + dependency edges, branching, active-step highlight + live per-step status (FR-012/013) (depends on T048)
- [x] T050 [US45] Add tool-affordance labels on primary action buttons (`workflow_run`/`workflow_cancel`/`workflow_create`/etc.) per FR-014 (depends on T048)

**Checkpoint**: US1+2+5+3+7+8+45 — the graph UI works end-to-end, mirroring the tool surface.

---

## Phase 10: User Story 6 — Historical-Run Inspection (Priority: P2)

**Goal**: The app provides a run selector on the detail view; an opened historical run renders each step's final outcome (executed/completed/failed/cancelled/neutral) from the persisted run log + replays the event stream (US6/FR-017). The mockup's historical-runs UI is the binding contract.

**Independent Test**: Run a workflow to completion; reopen it via the run selector; confirm the graph reflects each step's final outcome from the run log and the event stream replays from the log.

### Tests for User Story 6 (e2e, in scope) ⚠️

- [x] T051 [P] [US6] E2E test for historical-run replay (run selector → graph outcomes + replayed event stream) in `e2e/001-workflow-manager-service-tools.spec.ts`

### Implementation for User Story 6

- [x] T052 [P] [US6] Implement run selector in the detail view `app/src/` (lists historical runs with id/timestamp/state) (depends on T048, T032)
- [x] T053 [US6] Implement historical-run graph replay — per-step final outcome from the run log, distinct from live state; replayed event stream (depends on T052)

**Checkpoint**: US1+2+5+3+7+8+45+6 — historical runs are inspectable in the app, replaying from the persisted log.

---

## Phase 11: User Story 9 — Workflow Manager Skill (Priority: P2)

**Goal**: The app ships a skill instructing the assistant how to build/execute/retrieve workflows via the workflow tools (US9/FR-023).

**Independent Test**: Load the Workflow Manager skill; confirm it instructs building/executing/retrieving workflows via the tools; build a workflow from a natural-language trigger.

### Tests for User Story 9 (e2e, in scope) ⚠️

- [x] T054 [P] [US9] E2E test for the skill — load the Workflow Manager skill, build a workflow from a natural-language trigger, execute and retrieve results — in `e2e/001-workflow-manager-service-tools.spec.ts`

### Implementation for User Story 9

- [x] T055 [P] [US9] Author `skills/workflow-manager/SKILL.md` — instructions for building workflows (ephemeral/Research nodes, candidate agents, required tools/skills), executing, retrieving results, historical-run inspection (depends on T019, T020)
- [x] T056 [US9] Wire the skill into the item so the assistant can load it (per `target-marketplace-item.md` skill bundling)

**Checkpoint**: US1+2+5+3+7+8+45+6+9 — the assistant can build/execute/retrieve workflows guided by the bundled skill.

---

## Phase 12: Documentation (Usage + Dev — first-class deliverable) 📚

**Purpose**: Thorough, accurate documentation for BOTH end users (usage) and developers (dev/architecture). Written against the implemented code and the binding mockup. All docs live under the item's `docs/` subfolder (created in T001) except the bos-core architecture doc.

### Usage Documentation

- [x] T057 [P] Author `docs/usage.md` — end-user guide: what Workflow Manager does, how to build a workflow from a natural-language trigger (with the sustainability-analysis example), the graph views (list/detail/run), historical-run inspection, the service pill + stopped banner, and the bundled skill
- [x] T058 [P] Author `docs/tool-reference.md` — the 12 tools (names, descriptions, input schemas, fire-and-poll contract, FR-024 `workflow_list` live status + `run_id`), with worked examples of a full build→run→poll→cancel→inspect loop

### Development Documentation

- [x] T059 [P] Author `docs/dev/architecture.md` — the service-owned engine: node model (agent source × output type), scheduler (ready-set, `maxConcurrentSteps`, research fan-out), router (dynamic routing + retry-loop), executor (loopback `/api/subagents/delegate` contract, ADR-1), storage layout (real VFS `/Workflows/` + `/Workflows/.runs/`), cancellation (Option (b))
- [x] T060 [P] Author `docs/dev/contribution.md` — how to extend: adding a tool, adding a node output type, adding a candidate agent, the 039 service-declared-tool contract, unit + e2e test conventions, and the bos-core retirement rationale
- [x] T061 [P] Bos-core doc update: update `docs/dev/architecture-overview.md` §14 (workflows subsystem) to record the retirement — docs/spec drift tracking per constitution

**Checkpoint**: Documentation complete — usage + dev docs written against the implemented code and the mockup.

---

## Phase 13: Polish & Cross-Cutting Concerns

**Purpose**: Improvements that affect multiple user stories + final assembly.

- [x] T062 [P] Wire `workflow_create` generation path — confirm whether generation uses the delegate route (ephemeral planner) or the workflow-builder agent constructs directly (open item #2); implement chosen path in `engine/generate.js` + unit test for `engine/generate.js` in `<item>/services/__tests__/generate.test.js`
- [x] T063 [P] Resolve ephemeral-node skill scoping (open item #3) — fold skills into task text if the delegate route can't scope per-node skills
- [x] T064 [P] Confirm + finalize the 5 net-new tool names/schemas (`list`/`read`/`delete`/`run_list`/`run_get`) (open item #4)
- [x] T065 [P] Document capability grants (`services:read`, `fs:read`) for the app in the usage doc + settings note (open item #5)
- [x] T066 Run the FULL e2e suite (all stories) + all unit tests; fix failures; verify service restart + migration (ADR-5) + cancelled-run settling
- [x] T067 Final assembly: `app_build` the item; verify `workflow_list` live status + run_id (FR-024), service-stopped banner, graph views, and docs are packaged with the item

---

## Dependencies & Execution Order

### Phase Dependencies

- **Setup (Phase 1)**: No dependencies — can start immediately
- **Foundational (Phase 2)**: Depends on Setup; **BLOCKS all user stories** (the bos-core retirement must land so the service owns the surface without shadowing)
- **User Stories (Phase 3+)**: All depend on Foundational
- **Documentation (Phase 12)**: Depends on the implemented user stories (docs must be written against the code + mockup)
- **Polish (Phase 13)**: Depends on all user stories + documentation

### User Story Dependencies

- **US1 (P1)**: After Foundational — tool surface (no dependencies on other stories)
- **US2 (P2)**: After US1 — gating/lifecycle (depends on T019/T020)
- **US5 (P3)**: After US1 — fire-and-poll run (depends on executor T025)
- **US3 (P2)**: After US1/US5 — real-VFS management + runs (depends on store T014, executor T025)
- **US7 (P1)**: After US5 — dynamic routing (depends on router T037)
- **US8 (P1)**: After US7 — parallel execution + ephemeral agents (depends on scheduler T043)
- **US4+5 (P2/P3)**: After US1 — graph UI (depends on app T048)
- **US6 (P2)**: After US4+5 — historical-run inspection (depends on T048, T032)
- **US9 (P2)**: After US1 — skill (depends on T019/T020)

### Within Each User Story

- Tests (unit + e2e, in scope) MUST be written and FAIL before implementation
- Node model → scheduler/router → executor → handlers
- Core engine before integration
- Story complete before moving to next priority

### Parallel Opportunities

- All Setup + Foundational [P] tasks can run in parallel (bos-core retirement files are disjoint from service files)
- Once Foundational completes, US1/US3/US9 can start in parallel (US1 is the MVP)
- Tests within a story marked [P] run in parallel
- All 5 documentation tasks (T057..T061) are [P] and can run in parallel once the code is implemented
- Different user stories can be worked on in parallel by different team members

---

## Parallel Example: User Story 1

```bash
# Launch all tests for US1 together:
Task: "Unit test for tool declarations + schemas in tools.test.js"
Task: "Unit test for tool handlers in handlers.test.js"
Task: "E2E test for the tool surface (create/list/read/delete) in e2e/001-workflow-manager-service-tools.spec.ts"

# Launch the 12-tool surface:
Task: "Implement services/tools.js — 12 tool declarations + JSON schemas"
Task: "Implement workflow_list with live status (FR-024)"
```

---

## Implementation Strategy

### MVP First (User Story 1 Only)

1. Complete Phase 1: Setup
2. Complete Phase 2: Foundational (**CRITICAL** — bos-core retirement + service skeleton)
3. Complete Phase 3: User Story 1 (tool surface)
4. **STOP and VALIDATE**: Test US1 independently (12 tools work via the service)
5. Deploy/demo if ready

### Incremental Delivery

1. Setup + Foundational → Foundation ready (old engine retired, service skeleton + node model + store in place)
2. US1 (tool surface) → Test → MVP
3. US2 (gating/lifecycle) → Test → tools gated + removed on stop
4. US5 (fire-and-poll run) → Test → poll workflows via tools
5. US3 (real-VFS persistence + historical runs) → Test → data survives + replayable
6. US7 (dynamic routing) → Test → workflows adapt mid-run
7. US8 (parallel execution + ephemeral agents) → Test → branches/sub-agents run concurrently
8. US4+5 (graph UI) → Test → graph with active-step highlight
9. US6 (historical-run inspection) → Test → replay from log
10. US9 (skill) → Test → assistant builds/executes via the skill
11. Documentation (usage + dev) → Test → accurate, code-matching docs
12. Each story adds value without breaking previous stories

### Parallel Team Strategy

With multiple developers:

1. Team completes Setup + Foundational together
2. Once Foundational is done:
   - Developer A: US1 (tool surface) → US2 (gating/lifecycle)
   - Developer B: US3 (persistence + runs) → US9 (skill)
   - Developer C: US7 (routing) → US8 (parallel)
   - Developer D: US4+5 (graph UI) → US6 (historical replay)
3. Documentation tasks run in parallel once the code is implemented
4. Stories complete and integrate independently

---

## Notes

- [P] tasks = different files, no dependencies
- [Story] label maps task to specific user story for traceability
- Each user story is independently completable and testable, with its OWN unit + e2e tests
- Verify tests fail before implementing
- Commit after each task or logical group
- The bos-core retirement (T005..T010) is on the active feature branch `bos/042-workflow-manager-service`; the marketplace item is built via `app_build` (no branch needed)
- The mockup (`mockup.html`) is the binding UI contract for US4+5 and US6 — the app must match it
- **E2e tests are required for EVERY user story** — US1 (tool surface), US2 (gating/lifecycle), US3 (persistence + historical), US5 (fire-and-poll), US7 (routing), US8 (parallel + ephemeral), US45 (graph UI), US6 (historical replay), US9 (skill) — all in `e2e/001-workflow-manager-service-tools.spec.ts`
- **Documentation (usage + dev) is a first-class deliverable** — written against the implemented code, not the pre-implementation design
- Docs drift (T061) + spec/code drift tracking per constitution
- **NFR-005 structured logging** is covered in T015 (log channel) + T022 (tool_call dispatch/resolve/schema-rejected/timeout logs)

---

# §9 Scope-add (US10–US15) — Tasks

**Input**: `design.md` §9 (ADRs 10–14), `plan.md` §9 (file/module delta + delegation split), `spec.md` US10–US15 (FR-025..038, SC-015..023), `mockup.html` (binding UI contract for US10).

**Delegation split** (two mechanisms, never conflated):
- **Item work** (service facet US10–15 + app facet US10 + skill/docs) → `agent_delegate` (`contentOnly:true`) → `app_build` (no branch).
- **Bos-core patch** (ADR-12: `runner.ts` + `discovery.ts` + delegate `onEvent`) → `dev_delegate` on the active feature branch `bos/001-workflow-manager-service`.

**Blocking prerequisites** (do these first):
- **T068** — `engine/run-state.js` (ADR-13 SOT) — US10/11/13 all project from it.
- **T070–T072** — the ADR-12 bos-core patch — US12 (item side) and US10 event fidelity depend on it being promoted before the item re-install.

**Continuation numbering**: T068+ (base tasks T001–T067 are complete). [P] = different files, no dependencies. Exact paths: item = `data/user-apps/items/workflows/` (`<item>` below); bos-core = `src/...`.

---

## Phase 14: Foundational (scope-add blockers)

**Purpose**: The single source of truth for live run state + the platform fix that makes declared tools real. Everything else depends on these.

- [ ] T068 [P] Implement `<item>/services/engine/run-state.js` — `RunState`/`StepRuntimeState` SOT (ADR-13): in-memory `runId → RunState` map, append-only event log (monotonic seq) covering step events + `agent.*` + `workflow.branch.skipped`, live-read, `subscribe(since)` tail, and a `GET /run/<runId>` (+`?since=`) HTTP endpoint on the worker's already-bound port (ADR-11). This is the one canonical live state consumed by the tools AND the app (US13/US10). (Depends on base T014 store, T025 executor.)
- [ ] T068a [P] [—] Unit test for `run-state.js` in `<item>/services/__tests__/run-state.test.js` — append/replay determinism, `subscribe(since)` tail, live-read, `StepRuntimeState` shape (status/attempt/currentAction/subAgents/outputs), no divergence between projected live state and replayed historical state (ADR-13, SC-016/022).
- [ ] T068b [P] [—] Unit test for the run-log extended schema in `<item>/services/__tests__/runs-extended.test.js` — an `agent.prompt`/`agent.tool_call`/`agent.tool_result`/`agent.response`/`agent.select_branch`/`workflow.branch.skipped` event round-trips through `<item>/services/runs.js` persistence and re-projects to the same state (FR-028, ADR-13).

**Checkpoint (T069): the ADR-12 bos-core patch — platform fix (dev_delegate, feature branch `bos/001-workflow-manager-service`).** Prerequisite for US12 item-side and US10 event fidelity. Promote before the item re-install.

- [ ] T069 [P] [US12] **bos-core**: modify `src/lib/agent/subagents/runner.ts` (`runLocalHeadless`) — build the ephemeral agent's gate from the in-memory agent object (NOT `getAgent`); honor a declared `deferredTools` set (stop forcing `deferred = new Set()`); route declared frontend-execution tools (e.g. `file_read`/`file_write`) through a server-side VFS bridge so a headless ephemeral agent genuinely has them (ADR-12, FR-034). Scope the edit to the ephemeral-agent branch; keep named-agent behavior byte-identical.
- [ ] T069a [P] [US12] **bos-core**: modify `src/lib/assistant/tools/server/discovery.ts` — `find_tools`/`find_agent` resolve an ephemeral agent's gate from the in-run agent object (returns its declared deferred tools, not `[]`) (ADR-12, SC-021).
- [ ] T069b [P] [US10] **bos-core**: modify `src/app/api/subagents/delegate/route.ts` `onEvent` — emit `tool_result` (name + result + ok/error), `reasoning_delta`, and final-text events, in addition to the existing `tool_call`/`done` (ADR-13 stream enrichment, US10 fidelity, FR-028). Confirm the agent loop already computes a per-call ok/error for server tools (open item #2) so this is a forward, not a re-implementation.
- [ ] T069c [P] [US12/US10] **bos-core unit tests**: (1) a NAMED agent's `find_tools`/tool gate is byte-identical to pre-patch (regression guard — open item #1); (2) an EPHEMERAL agent's `find_tools` returns its declared deferred tools (FR-034/SC-021); (3) the delegate `onEvent` emits `tool_result` (name+result+ok) + final text. (open item #1 blast-radius mitigation.)
- [ ] T069d [P] **bos-core docs**: note the headless ephemeral tool-granting behavior + the enriched delegate `onEvent` stream in `src/.../docs` (dev/architecture note) (constitution VI).

**Checkpoint**: SOT (`run-state.js`) + the ADR-12 platform patch are in place. User-story work can proceed; the patch must be **promoted before the item re-install** (T094).

---

## Phase 15: US11 — Branch Routing Correct, Structured, and Safe (P1) 🎯

**Goal**: selection is a structured signal (never prose); Option A selection propagation (shared steps run by their own deps; only declared candidate leaves are gated); a selected branch with zero executed leaves is never a silent `completed`; `workflow_validate` checks candidate topology (FR-029..033, SC-018..020).

**Independent Test**: Author `A → B(candidates: X, Y)` with a shared step `S` also depending on `B` before the leaves. Run; confirm `B` selects via `select_branch`, `S` runs regardless, the selected leaf runs, the unselected leaf is neutral. Separately, make the selected leaf unreachable and confirm a `workflow.branch.skipped` warning rather than `completed`.

### Tests (unit + e2e) ⚠️

- [ ] T070 [P] [US11] Unit test — Option A gating: a shared (non-candidate) step depending on a routing node runs regardless of selection; the selected leaf runs; the unselected leaf is `step.skip` (reason: branch-not-selected) — in `<item>/services/__tests__/router.test.js` (SC-019).
- [ ] T071 [P] [US11] Unit test — structured selection: a valid `select_branch` call sets `selected[nodeId]`; a missing/invalid selection retries (retry-loop) then FAILS the node (never defaults); the recorded selection exactly equals the structured signal — in `<item>/services/__tests__/router.test.js` (SC-018, FR-029/030).
- [ ] T072 [P] [US11] Unit test — zero-leaf guard: a routing node whose selected branch executes zero leaves emits `workflow.branch.skipped` + a non-plain-`completed` final state; and `validate.js` flags an unreachable candidate leaf + an ambiguous shared+leaf node — in `<item>/services/__tests__/scheduler.test.js` + `<item>/services/__tests__/validate.test.js` (SC-020, FR-032/033).
- [ ] T073 [P] [US11] E2E test — `A → B(candidates:X,Y)`, shared `S` before the leaves: selected leaf runs, unselected neutral, `S` runs; unreachable-leaf variant raises `workflow.branch.skipped` (not `completed`) — in `e2e/001-workflow-manager-service-tools.spec.ts`.

### Implementation

- [ ] T074 [US11] Implement `select_branch` — declare the `select_branch` tool into routing-node ephemeral specs in `<item>/services/engine/executor.js`; read the structured `{ selected:[candidateId] }` in `<item>/services/engine/router.js`; retry-then-fail on invalid (FR-029/030) (depends on T068).
- [ ] T075 [US11] Implement Option A gating in `<item>/services/engine/scheduler.js` — a node is ready when (a) all declared deps satisfied AND (b) if it is a declared candidate leaf of routing node R, `selected[R]` must contain it; otherwise gated by deps only; unselected leaves → `step.skip` (reason: branch-not-selected) (FR-031) (depends on T074).
- [ ] T076 [US11] Implement the zero-executed-leaves guard in `<item>/services/engine/scheduler.js` — on completion, per routing node, if the selected branch ran zero leaves emit `workflow.branch.skipped` + set final state `completed_with_warnings`/failed (FR-032) (depends on T075).
- [ ] T077 [US11] Add candidate-topology checks to `<item>/services/engine/validate.js` — flag an unreachable candidate leaf and an ambiguously shared+leaf node as structural errors (FR-033) (depends on T075).

**Checkpoint**: US11 — routing is deterministic, shared steps flow, and a silent no-op is surfaced.

---

## Phase 16: US12 — Ephemeral Agents Get Their Declared Tools (P1)

**Goal**: the declared tool allowlist is genuinely granted to a spawned ephemeral agent (incl. deferred tools via `find_tools`); fan-out outputs are first-class structured data so no file handoff is required (FR-034/035, SC-021). (The platform half is T069/T069a.)

**Independent Test**: Author an ephemeral node with `tools:["file_read","file_write"]`; run it; confirm the agent can call them directly (not via `run_command`) and `find_tools` returns them. Separately, confirm a research→merge handoff works with no file I/O.

### Tests (unit + e2e) ⚠️

- [ ] T078 [P] [US12] Unit test — `executor.js` forwards the node's full declared `tools` + a `deferredTools` list (+ skills, open item #3) to the delegate route, so the spawned agent's effective tool set matches the declaration — in `<item>/services/__tests__/executor.test.js` (FR-034/035).
- [ ] T079 [P] [US12] E2E test — an ephemeral node listing `file_read`/`file_write` calls them directly (no `run_command` fallback); a research→merge fan-out handoff consumes structured `outputs` with no file I/O — in `e2e/001-workflow-manager-service-tools.spec.ts` (SC-021). (Requires T069 promoted.)

### Implementation

- [ ] T080 [US12] Modify `<item>/services/engine/executor.js` — forward declared `tools` + `deferredTools` + skills to the `/api/subagents/delegate` ephemeral spec (FR-034) (depends on T069 platform patch).
- [ ] T081 [US12] Ensure research/delegate fan-out `outputs` are stored as first-class structured data in `<item>/services/engine/run-state.js` (`StepRuntimeState.outputs`) and consumed by dependent nodes (FR-035) (depends on T068, T044 research fan-out).

**Checkpoint**: US12 — a declared tool means what it says; the parallel→merge handoff needs no file I/O.

---

## Phase 17: US13 — Live Run Progress Is Observable (P1)

**Goal**: `workflow_status`/`workflow_run_get` return a populated per-step map (status + attempt + current-action string) and per-sub-agent status for research nodes; the same live state feeds the app trajectory panel (FR-036, SC-022). (The SOT is T068.)

**Independent Test**: Start a multi-branch run; poll `workflow_status`; confirm each in-progress step returns status + attempt + a current-action string, and a research node returns per-sub-agent status identifying the straggler.

### Tests (unit + e2e) ⚠️

- [ ] T082 [P] [US13] Unit test — `workflow_status`/`workflow_run_get` return a populated per-step map (NOT `steps:{}`): status + attempt + current-action while in progress; per-sub-agent status for a research node — in `<item>/services/__tests__/handlers.test.js` (SC-022, FR-036).
- [ ] T083 [P] [US13] E2E test — live `workflow_status` reflects the same per-step state the app trajectory panel reads (single source of truth; no divergence) — in `e2e/001-workflow-manager-service-tools.spec.ts` (FR-036, ADR-13).

### Implementation

- [ ] T084 [US13] Modify `<item>/services/handlers.js` — `workflow_status`/`workflow_run_get` read `run-state.js` and return the populated per-step map (status/attempt/currentAction) + per-sub-agent status for research nodes (FR-036) (depends on T068).
- [ ] T085 [US13] Modify `<item>/services/engine/executor.js` + `<item>/services/engine/scheduler.js` — update `StepRuntimeState.currentAction` and `subAgents` status transitions (pending→running→completed/failed) as the run progresses, appending to the event log (FR-036) (depends on T068).

**Checkpoint**: US13 — a long run is no longer a black box, via both tools and the UI.

---

## Phase 18: US10 — Node Trajectory Panel (agent-debug surface) (P2)

**Goal**: clicking a node (live or historical run) opens the right-side, horizontally-resizable panel showing the node's agent trace — executed prompt, reasoning, every tool call (name/args/result/status), sub-agent fan-out status, current-action, agent response, lifecycle events, output/artifact — replayed from the run log; the redundant per-step status list is removed (FR-025/026/027, SC-015/016/017). The mockup is the binding UI contract.

**Independent Test**: Open a live run; click a node; confirm the right-side resizable panel shows the executed prompt, tool calls (name/args/result/status), sub-agent fan-out, current-action, and response, updating live. Select a historical run; click a node; confirm the replayed trajectory; a neutral node shows "no events"; confirm the per-step status list is gone and the divider resizes.

### Tests (e2e) ⚠️

- [ ] T086 [P] [US10] E2E test — Run view: click a node → right-side resizable trajectory panel shows node identity + executed prompt + reasoning + tool calls (name/in/out/ok-error) + sub-agent fan-out + current-action + response + lifecycle events + output; drag the divider resizes (graph reflows); click another node switches; X dismisses — in `e2e/001-workflow-manager-service-tools.spec.ts` (SC-015, mockup contract).
- [ ] T087 [P] [US10] E2E test — History view: select a run, click a node → replayed agent trace from the persisted log with 100% fidelity (prompt/reasoning/tool calls/response); a neutral/never-ran node shows "no events"; the removed per-step status list is absent (FR-027, SC-016/017) — in `e2e/001-workflow-manager-service-tools.spec.ts`.

### Implementation

- [ ] T088 [US10] Implement `<item>/app/src/components/TrajectoryPanel.tsx` — the node-scoped projection of `run-state.js` (mockup §9.9 mapping): identity + status chip, "currently" current-action line, "retrying N/M" line, executed prompt, reasoning (only when present), tool calls (name/in/out/ok-error/inflight), sub-agent fan-out, agent response (or "generating…"), lifecycle events, output/artifact (FR-025/026) (depends on T068, T085).
- [ ] T089 [US10] Wire the panel into `<item>/app/src/` Run + History views — node click handler on the graph (selection ring), the right-docked resizable divider (pointer-drag, 260–680px), live state via `window.__bos` → service `GET /run/<runId>?since=` (ADR-11) with `workflow_status` poll fallback, and historical replay from `workflow_run_get` (FR-025/026) (depends on T088, T068).
- [ ] T090 [US10] Remove the redundant per-step status list from `<item>/app/src/` (FR-027) + add the 5th status chip `completed_with_warnings` to the run/history status-pill set (SC-020, open item #3) (depends on T089).

**Checkpoint**: US10 — each node is debuggable (what its agent did, live and historical), matching the mockup.

---

## Phase 19: US14 — Fast Iteration via Dry-Run/Fixture (P2)

**Goal**: `workflow_run` supports an opt-in dry-run/fixture mode that substitutes canned sub-agent outputs for designated nodes, validating DAG/routing/leaves in seconds (FR-037, NFR-006, SC-023). (Scheduler short-circuit — ADR-14, no `src/` change.)

**Independent Test**: Run a workflow with a research node in dry-run mode with a canned research output; confirm the downstream merge + branch routing execute in seconds against the fixture and the leaves are reached; confirm default (non-dry-run) is unchanged.

### Tests (unit + e2e) ⚠️

- [ ] T091 [P] [US14] Unit test — dry-run short-circuit: a fixture-designated node skips the real delegate call, substitutes the canned `outputs`, and still emits a plausible `StepRuntimeState` through the SAME event-append path (replay indistinguishable, ADR-13, open item #5); the `select_branch` signal can be fixture-able so routing evaluates deterministically — in `<item>/services/__tests__/scheduler.test.js` (NFR-006, SC-023).
- [ ] T092 [P] [US14] E2E test — `workflow_run` with `dryRun`/`fixtures` validates DAG + routing + leaf reachability in seconds (no real research); default run is unchanged — in `e2e/001-workflow-manager-service-tools.spec.ts`.

### Implementation

- [ ] T093 [US14] Add opt-in `dryRun`/`fixtures` input to `workflow_run` in `<item>/services/tools.js` + `<item>/services/handlers.js`; implement the per-node short-circuit (canned `outputs` injection, no delegate call) in `<item>/services/engine/scheduler.js`/`executor.js` (FR-037, ADR-14) (depends on T068).

**Checkpoint**: US14 — DAG/routing/leaf behavior is testable in seconds.

---

## Phase 20: US15 — Fail-Fast Timeouts + Latency Docs (P2)

**Goal**: the engine enforces a configurable per-step and per-run timeout so a stuck agent fails fast (step → failed w/ timeout reason; run → failed/timed-out + halted); the skill/docs state realistic relative latency and recommend research for parallel investigations (FR-038, SC-023, FR-023 extended).

**Independent Test**: Author a workflow with a step timeout shorter than a node's expected duration; run it; confirm the timed-out step is marked failed with a timeout reason and the run does not hang; confirm the whole-run timeout halts a long run.

### Tests (unit) ⚠️

- [ ] T094 [P] [US15] Unit test — per-step timeout marks a stuck node failed (timeout reason) and the scheduler proceeds/halts per the on-failure policy; per-run timeout halts the whole run; sensible defaults apply when unconfigured — in `<item>/services/__tests__/scheduler.test.js` (FR-038, SC-023).

### Implementation

- [ ] T095 [US15] Enforce per-step + per-run timeouts in `<item>/services/engine/scheduler.js` — wrap each node's delegate call in a per-step deadline (step → failed w/ timeout reason) and a per-run deadline (run → failed/timed-out + halted), reading the Workflow config's default retry/timeout (FR-038) (depends on T068).
- [ ] T096 [US15] Update `<item>/skills/workflow-manager/SKILL.md` + `<item>/docs/usage.md` — recommend the native **research** output type as the default for "run N investigations in parallel → synthesis" (noting it sidesteps the file-tool gap + is materially faster than serial delegate fan-out); state realistic delegate-vs-research latency; document dry-run usage (FR-023 extended, US14/US15) (depends on T093).

**Checkpoint**: US15 — stuck agents fail fast; the skill steers toward research and dry-run.

---

## Phase 21: Scope-add Polish, Full Validation & Assembly

**Purpose**: Final integration, full suite, and install.

- [ ] T097 [P] Wire the `agent.*` events end-to-end — `executor.js` consumes the enriched delegate `onEvent` (T069b) and emits `agent.prompt`/`agent.tool_call`/`agent.tool_result`/`agent.reasoning`/`agent.response` into `run-state.js` (worker-owned: prompt + select_branch; platform-forwarded: reasoning + per-tool result + response) (FR-028) (depends on T068, T069b).
- [ ] T098 [P] Run the FULL e2e suite (all base + scope-add stories) + all unit tests (incl. the ADR-12 named-agent regression guard, open item #1); fix failures.
- [ ] T099 Final assembly — `app_build` the item (service facet US10–15 + app facet US10 + skill/docs); **requires the T069/T069a/T069b bos-core patch PROMOTED first** (US12). Verify: trajectory panel (live + historical, mockup contract), Option A routing + `completed_with_warnings`, ephemeral tool fidelity, live `workflow_status` per-step + per-sub-agent, dry-run in seconds, fail-fast timeouts.

**Checkpoint**: Scope-add complete — the node is debuggable, routing is safe, tools are real, progress is live, iteration is fast, and nothing hangs.

---

## Scope-add Dependencies & Execution Order

### Phase Dependencies

- **Phase 14 (Foundational, T068 + T069)**: BLOCKS all scope-add user stories. `run-state.js` (T068) is the SOT; the ADR-12 bos-core patch (T069/T069a/T069b) is prerequisite for US12 item-side + US10 event fidelity.
- **US11 (Phase 15)**: depends on T068 + T074 (select_branch).
- **US12 (Phase 16)**: item-side depends on T069 (patch) + T068; `outputs` handoff depends on T044.
- **US13 (Phase 17)**: depends on T068.
- **US10 (Phase 18)**: depends on T068 + T085 (live-state updates) + T088; the bos-core patch (T069b) feeds its event fidelity.
- **US14 (Phase 19)**: depends on T068.
- **US15 (Phase 20)**: depends on T068.
- **Polish (Phase 21)**: depends on all; T099 `app_build` requires the bos-core patch promoted.

### Priority Order (P1 → P2)

- **P1 (MVP of the scope-add)**: US11 (routing) + US12 (tool fidelity) + US13 (live progress) — the three correctness/observability fixes from the evaluation.
- **P2**: US10 (trajectory panel UI) + US14 (dry-run) + US15 (timeouts + docs).
- **Ordering note**: build the P1 service-side work (US11/12/13) first (they share `run-state.js` + the scheduler/executor/router), then US10 (the panel that consumes the SOT), then US14/US15. The app-side US10 work can proceed in parallel with US14/US15 once `run-state.js` + T085 exist.

### Parallel Opportunities

- T068 / T068a / T068b (SOT + its tests) can run in parallel.
- The T069 bos-core patch (T069/T069a/T069b/T069c/T069d) is fully [P] (disjoint files) and runs on a **separate branch/delegation** (dev_delegate) — independent of the item work.
- Within US11/US13/US14/US15, the unit tests are [P] and the `scheduler.js`/`router.js`/`validate.js`/`executor.js`/`handlers.js` edits are largely sequential per file but parallel across files.
- US10 app-side (T088/T089/T090) is disjoint from the service facet and parallelizable with US14/US15.

### Two-delegation build order (for `implement`)

1. **dev_delegate** the ADR-12 bos-core patch (T069, T069a, T069b, T069c, T069d) on `bos/001-workflow-manager-service` → promote.
2. **agent_delegate (`contentOnly:true`)** the item scope-add (T068, T070–T081, T084–T097) → **app_build** (T099).
3. Run full validation (T098) + converge.

---

## Scope-add Notes

- **ADR-13 SOT is the linchpin** — US10/11/13 all project from `run-state.js` (T068); get it right first.
- **ADR-12 is the only new `src/` surface** (T069/T069a) + the delegate `onEvent` enrichment (T069b); blast-radius mitigated by the named-agent regression guard (T069c, open item #1).
- **The mockup is the binding contract for US10** (T086/T087/T088) — the app must match `mockup.html` exactly.
- **`completed_with_warnings`** is a NEW run final-state (SC-020) — the app's 5th status chip (T090) + `workflow_status` surfacing the `workflow.branch.skipped` event (T084).
- **App reachability** (ADR-11, open item #4): the app needs `services:read` granted (Settings → Apps) to read `GET /run/<runId>`; `workflow_status` poll is the fallback (T089).
