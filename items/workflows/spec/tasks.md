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

## Phase 14: Scope-add — US10-US15 (node trajectory, correct routing, live state, dry run, timeouts)

**Goal**: the six capabilities added on top of the shipped engine — the per-node
agent-debug trajectory panel (US10), structured/safe branch routing (US11),
ephemeral tool fidelity + structured fan-out handoff (US12), observable live
run state (US13), dry-run/fixture mode (US14), and per-step/per-run timeouts
with documented latency (US15).

**Independent Test**: see each user story's own "Independent Test" in `spec.md`.

### Service facet

- [x] T068 [US13] NEW `services/engine/run-state.js` — the single `RunState`/`StepRuntimeState` projection (status/attempt/maxAttempts/currentAction/subAgents/outputs/agentTrace), the append-only event log with monotonic `seq`, `eventsSince`/`subscribe(since)`, `replayRunState(persisted)`, and the process-wide run registry (FR-036/FR-026/FR-028)
- [x] T069 [US13] `services/http-bridge.js` — `GET /run/<runId>[?since=][&workflowId=]` on the worker's already-bound port, serving that projection (live, with a persisted-log fallback)
- [x] T070 [US13] `services/runs.js` — fold every scheduler event into the RunState, persist the extended run record (`schemaVersion: 2`, `agent.*` events, `selected`, `finalState`, `warnings`), and replay a persisted run through the same reducer
- [x] T071 [US13] `services/handlers.js` — `workflow_status`/`workflow_run_get` return the POPULATED per-step map (+ `?since` tailing), never `steps: {}`
- [x] T072 [US11] `services/engine/router.js` — structured `select_branch` signal only (tool call → structured output → strict JSON envelope); invalid/missing → retry-loop → FAIL (FR-029/FR-030); Option A gating helpers `buildCandidateIndex`/`selectionAllows`/`selectionRejects` (FR-031)
- [x] T073 [US11] `services/engine/scheduler.js` — Option A ready-set (dependency edges released for every dependent; only declared candidate leaves gated), explicit `step.skip` for unselected leaves, and the zero-executed-leaves guard → `workflow.branch.skipped` + `completed_with_warnings` (FR-031/FR-032)
- [x] T074 [US11] `services/engine/validate.js` — candidate-topology structural errors: unreachable candidate leaf, and a node ambiguously both a gated leaf and a shared dependency (FR-033)
- [x] T075 [US12] `services/engine/executor.js` — forward the node's full declared `tools` + `deferredTools` + `skills` to the delegate's ephemeral spec, and inject the per-node `select_branch` tool for routing nodes (FR-034/FR-029)
- [x] T076 [US10] `services/engine/executor.js` — emit `agent.prompt`/`agent.reasoning`/`agent.tool_call`/`agent.response`/`agent.action` from the delegate stream, consuming both the historical and the enriched (`tool_result`/`reasoning_delta`/`done.text`) event shapes (FR-028)
- [x] T077 [US12] `services/engine/executor.js` — render fan-out outputs as first-class structured upstream context so a "research → merge" handoff needs no file I/O (FR-035)
- [x] T078 [US13] `services/engine/scheduler.js` — research fan-out emits `agent.sub_agent` transitions (pending → running → completed/failed) per entry (FR-022/FR-036)
- [x] T079 [US14] `services/engine/executor.js` + `scheduler.js` + `tools.js` + `handlers.js` — opt-in `dryRun`/`fixtures` on `workflow_run`: fixture-designated nodes (including a whole research fan-out, one sub-agent via `<nodeId>#<index>`, or a routing node's selection signal) short-circuit with no delegation (FR-037)
- [x] T080 [US15] `services/engine/scheduler.js` — per-step timeout (non-retryable, `reason: "step-timeout"`) and per-run deadline (halt + failed), both from the workflow config with safe defaults (FR-038)

### App facet

- [x] T081 [US10] NEW `app/src/components/TrajectoryPanel.tsx` — the node-scoped agent-debug panel (identity, "currently", retry line, executed prompt, reasoning, tool calls with in/out + ok/error/inflight, sub-agents · fan-out, agent response / "generating…", lifecycle events, output / artifact), matching `mockup.html`
- [x] T082 [US10] NEW `app/src/lib/trajectory.ts` — the node-scoped projection of the run detail (lifecycle rows with timestamps + durations, identity fields); one code path for live and historical
- [x] T083 [US10] `app/src/components/RunView.tsx` — node click + selection ring, the resizable divider (260-680px pointer drag), live tailing via the `window.__bos` broker → `GET /run/<runId>?since=` with a `workflow_status` fallback, and REMOVAL of the per-step status list (FR-027)
- [x] T084 [US10] `app/src/components/DetailView.tsx` — the same panel + divider over the historical replay, driven by `workflow_run_get`
- [x] T085 [US11] `app/src/components/StatusPill.tsx` + `Graph.tsx` + `styles.css` — the 5th run status `completed_with_warnings`, the `skipped` node status, and the panel styles

### Tests + docs

- [x] T086 [P] Unit tests: `run-state.test.js` (NEW), `http-bridge.test.js` (NEW), and extensions to `router`/`scheduler`/`validate`/`executor`/`handlers`/`runs`/`tools` — run individually with `node --test <file>` and a timeout
- [x] T087 [P] E2e: `e2e/002-workflows-node-trajectory-and-routing.spec.ts` — trajectory panel (live + historical, click/switch/resize/dismiss), Option A routing, `completed_with_warnings`, declared-tool fidelity, live per-step + per-sub-agent + agentTrace, dry run in seconds, per-step timeout
- [x] T088 [P] E2e: update `e2e/001-...spec.ts` — US7 routing now uses the structured signal (via dry-run fixtures) and asserts `skipped`; the US45 UI test asserts the per-step list is GONE and inspects a node via the panel instead
- [x] T089 [P] `skills/workflow-manager/SKILL.md` — research-as-default for parallel investigation + realistic latency table, the structured-selection/Option A/topology rules, dry-run usage, timeouts, ephemeral tool fidelity
- [x] T090 [P] `docs/usage.md`, `docs/tool-reference.md`, `docs/dev/architecture.md` — trajectory panel, latency, dry-run examples, the new tool inputs/outputs, and the engine's new modules

---

## Phase 15: Scope-Add 002 — Event-System Integration (US16-18, FR-039-051)

**Spec**: `item-workflows/spec.md` US16-18 | **Design**: `design.md` §9-19 | **Plan**: `plan.md` (scope-add addendum) | **Platform dep**: `/Specs/user-specs/core-platform/037-event-namespace-relaxation/spec.md`

**Delegation split**: Phase 15-A = `dev_delegate` (bos-core, 037). Phases 15-B..F = `agent_delegate` (contentOnly) → `app_build` (existing item id `workflows`).

**Path note**: `run-state.js` (not `store.js`) for run-record provenance; `http-bridge.js` (not `vfs.js`) for loopback HTTP helpers — per plan path-correction.

### Phase 15-A: 037 Platform Change (bos-core) 🎯 Gate for US16

**Goal**: Remove the 034 namespace-ownership check on handler registration so any component can subscribe to any event type (user decision: no restriction on event subscription). This is the platform prerequisite for US16's non-owned subscription.

**Independent Test**: A service with id `workflows` calls `register()` with eventType `com.bos.other-svc.thing` (no grant) — registration succeeds (no `namespace-not-owned` error). The ack-ownership test still passes (cross-handler ack rejected).

- [ ] T091 Remove the `ownsNamespace` rejection block from `register()` in `src/lib/events/api.ts` (the `if (!ownsNamespace(...)) throw new EventsApiError("namespace-not-owned")` guard). Remove the `resolveGrantedNamespaces()` helper if it's now dead code (037 FR-005). The `ownsNamespace()` function in `types.ts` may stay as dead code or be removed (037 FR-006 — either acceptable).
- [ ] T092 [P] Find and flip the 034 test that asserts `namespace-not-owned` — locate it in `tests/events/` (search for `namespace-not-owned` or `ownsNamespace`). Change the assertion to expect registration success. KEEP the ack-ownership test unchanged (037 SC-003, `ack-forbidden` still thrown for cross-handler ack).
- [ ] T093 [P] Check `e2e/034-event-notification-system.spec.ts` for any namespace-rejection assertion — if present, flip to expect success. If absent, no change needed (037 SC-004: no other 034 e2e test should break).
- [ ] T094 Sweep `tests/events/` and `e2e/` for any other test that depends on the `namespace-not-owned` rejection path (search for `namespace-not-owned`, `ownsNamespace`, `resolveGrantedNamespaces`). If found, update them. This is 037's "confirm no other test depends on the gate" step.

**Checkpoint**: 037 complete. `dev_git_status` shows the bos-core changes on `bos/002-workflow-event-integration`. US16's non-owned-subscription e2e will now pass. US17/US18 are unblocked regardless.

---

### Phase 15-B: Item — Event Node + Discovery Tool (US17 + US18, 037-independent)

**Goal**: The two 037-independent capabilities: (US18) a new `event` node output type that emits a configurable 034 event, and (US17) the `workflow_event_types` tool for event-type discovery. These can be built and tested BEFORE 037 lands (emit has no platform gate — ADR-13).

**Independent Test US18**: Author a workflow with a single `event` node (type `com.bos.workflows.test.hello`, static payload `{"msg":"hi"}`); run it via `workflow_run`; confirm the event appears in the 034 system with correct type, source (`appId: "workflows"`), and payload. Node completes.

**Independent Test US17**: Call `workflow_event_types`; confirm it returns the list of registered event types (matching `GET /api/events/handlers` output). Empty list if no handlers registered (not an error).

- [ ] T095 [P] [US18] Add `"event"` to the `outputType` union in `services/engine/node-model.js`. Add the `EmitEventNodeConfig` shape: `{ eventType: string, payload: { mode: "static", value: object } | { mode: "template", text: string, fallback?: any } }`. Validate on load: `eventType` matches `^[a-z0-9]+(\.[a-z0-9_-]+)+$`; `payload` is one of the two modes.
- [ ] T096 [P] [US17] Add `workflow_event_types` to the tool declarations in `services/tools.js` — name `workflow_event_types`, description "Returns the list of event types currently registered in the BOS event system, for use when authoring workflow triggers", input schema `{}` (no params, per design §16.6). This is the 13th tool (FR-002 says "at minimum" — adding is compliant).
- [ ] T097 [US18] Implement the `event` output-type branch in `services/engine/executor.js`. On entering a node with `outputType: "event"`: (a) resolve the payload — if `mode: "static"`, use `value` as-is; if `mode: "template"`, parse `{{nodeId.field}}` placeholders from `text` and resolve each via dot-path lookup in `run.outputs[nodeId]` (design §13.3 algorithm); (b) build the emit body: `{ type, source: { appId: "workflows" }, payload: { resolvedPayload, _wf: { workflowId, runId, nodeId } } }`; (c) loopback `POST /api/events` (reuse `http-bridge.js` origin + fetch); (d) on 2xx → node completes with `outputs[nodeId] = { emitted: true, eventId }`; on HTTP error → node fails with the error body (design §13.4, FR-047). The `event` node is NOT an agent step — no LLM call, no `agentSource` requirement.
- [ ] T098 [P] [US17] Implement the `workflow_event_types` handler in `services/handlers.js`. Call loopback `GET /api/events/handlers` (reuse `http-bridge.js`); parse the grouped response; map to `[{ type, handlerCount, displayName }]` where `handlerCount = ui.length + headless.length` and `displayName` is the first handler's display name (or `null` if none). Return the array. On HTTP error → tool error (NFR-002). On empty registry → return `[]` (not an error, FR-045).
- [ ] T099 [US18] Add FR-048 validation rules to `services/engine/validate.js`: (a) all `triggers` array entries (if present) match the event-type pattern; (b) all `event` node configs have `eventType` under `com.bos.workflows.*` (item policy, ADR-14); (c) all `{{nodeId.field}}` template references in `event` node payloads refer to nodes that exist in the workflow graph. Add alongside existing US11 topology checks.
- [ ] T100 [P] [US18] Write unit tests for the event node in `services/__tests__/`: node-model (valid/invalid EmitEventNodeConfig, outputType union includes "event"), executor (static payload emit, template resolution with `{{nodeId.field}}`, unresolved → null, fallback, JSON-parse failure → node fail, emit HTTP error → node fail), validate (FR-048b eventType under com.bos.workflows.*, FR-048c template refs exist).
- [ ] T101 [P] [US17] Write unit test for the `workflow_event_types` handler in `services/__tests__/`: mock the loopback `GET /api/events/handlers` response; verify the mapping (type, handlerCount, displayName); verify empty registry → `[]`; verify HTTP error → tool error.

**Checkpoint**: US17 + US18 functional. `workflow_event_types` returns registered types; an `event` node emits correctly. Testable WITHOUT 037 active.

---

### Phase 15-C: Item — Event-Triggered Runs (US16, gated on 037)

**Goal**: The inbound direction — a workflow with a `triggers` array starts a new run when a matching event is emitted to the 034 system. The service subscribes to the union of all trigger types via `handler_declare` and handles dispatch by firing a run with provenance + eventContext injection.

**⚠️ Depends on Phase 15-A (037 active)**: The non-owned-subscription test asserts `namespace-not-owned` is absent — only passes once 037 is in place.

**Independent Test**: Create a workflow with `triggers: ["com.bos.test.workflow-trigger"]`; emit that event via `emit_event`; confirm a new run starts with `startSource: "event"`, `triggerEventId`/`triggerEventType` set, and the event payload available as `eventContext` in the first node's input. Non-matching event → no run.

- [ ] T102 [US16] Create `services/events.js` — the event-integration module. Implement: (a) `deriveTriggerUnion(workflows)` — reads the `triggers` array from each workflow JSON, returns `Set<string>` of distinct event types; (b) `reconcileSubscriptions(workflows, ipcPost)` — compute the target set, diff against currently-subscribed set (tracked in module-level `Set`); for each new type: `ipcPost({ type: "handler_declare", payload: { handlerId: "workflows:" + eventType, eventType, mode: "headless" } })`; for each removed type: loopback `POST /api/events/unregister { eventType, handlerId }` (design §10/§12.2); idempotent.
- [ ] T103 [US16] In `services/events.js`, implement `handleEventDispatch(payload, startRun, ack)` — the `event_dispatch` handler. On receipt: (a) look up the workflow(s) whose `triggers` include `payload.eventType`; (b) for each matching workflow, call `startRun({ workflowId, startSource: "event", triggerEventId: payload.eventId, triggerEventType: payload.eventType, eventContext: payload.event.payload })` (FR-008 fire-and-poll); (c) immediately loopback `POST /api/events/<eventId>/ack { handlerId, callerId: "workflows" }` (NFR-007 — ack on run-start, not run-completion); (d) log structured events (NFR-005). Concurrent runs of the same workflow are valid (FR-043).
- [ ] T104 [US16] Wire the event integration into the service lifecycle: in `services/index.js`, on `initialized` — call `events.reconcileSubscriptions()`. Add `case "event_dispatch"` to the IPC switch → `events.handleEventDispatch`. In `services/handlers.js`, after every `workflow_create`/`workflow_modify`/`workflow_delete` VFS write — call `events.reconcileSubscriptions()` (union may have changed). (Design §13.1, FR-040.)
- [ ] T105 [US16] Add run provenance fields to `services/engine/run-state.js`: `startSource` ("user" | "tool" | "event"), `triggerEventId`, `triggerEventType`, `eventContext`. Persist in the run record JSON. In the root-node input assembly (design §11, ADR-10): when `startSource === "event"` and `eventContext` is non-null, append a structured `eventContext` block to the assembled input for root nodes.
- [ ] T106 [P] [US16] Write unit tests for `services/events.js` in `services/__tests__/`: `deriveTriggerUnion` (empty, single, multiple workflows with overlapping/non-overlapping triggers); `reconcileSubscriptions` (initial subscribe, add new type, remove type, idempotent re-declare, `enabled` preservation); `handleEventDispatch` (matching → run starts with provenance + eventContext, non-matching → no run, concurrent → two independent runs, ack called correctly, ack failure → logged but run continues). Mock `ipcPost` and loopback `fetch`.

**Checkpoint**: US16 functional (with 037 active). A workflow with `triggers` starts a run on matching event emission, with provenance and eventContext. Non-matching events are ignored. Concurrent runs are independent.

---

### Phase 15-D: Item UI (FR-049)

**Goal**: The workflow editor gains: (a) a Triggers configuration section, (b) an event node config form, (c) run provenance display in the trajectory panel.

**Depends on**: Phase 15-B + 15-C.

- [ ] T107 [P] [US16] Add a "Triggers" tab/section to the workflow editor in `app/src/components/DetailView.tsx` (or `RunView.tsx`). UI: chips/tags for each trigger event type with remove (×) buttons. An "Add trigger" input: free-text field OR a "Browse" button that calls `workflow_event_types` (via the existing service RPC path) and shows a dropdown of registered types. On add/remove: persists via `workflow_modify`. Visual: matches existing dark theme + tab pattern.
- [ ] T108 [P] [US18] Add an event node config form to the node editor in `app/src/components/` (shown when `outputType: "event"`). Fields: (a) Event type — text input, live-validated against `com.bos.workflows.*`; (b) Payload — mode toggle ("Static JSON" / "Template"): Static = JSON textarea; Template = text input with `{{nodeId.field}}` syntax + hint/dropdown of upstream node IDs. Saves to the node's `config` field.
- [ ] T109 [US16] Add a run provenance block to the trajectory panel in `app/src/components/TrajectoryPanel.tsx`. When `startSource === "event"`: show trigger event type, event id (truncated), and a reference to the source event. For non-event runs: show `startSource` minimally.

**Checkpoint**: FR-049 complete. The user can configure triggers (with browse) and author event nodes via the UI. Run provenance is visible.

---

### Phase 15-E: Docs + Skill (FR-050)

**Goal**: Document the event-system integration for developers, end users, and the assistant.

**Depends on**: Phases 15-B, C, D.

- [ ] T110 [P] Update `skills/workflow-manager/SKILL.md`: add sections for (a) event-triggered workflows — `workflow_event_types` usage, `triggers` array configuration, re-entrancy semantics; (b) emit-event nodes — configuration (type + payload template), the `com.bos.workflows.*` namespace policy, and the cycle warning; (c) `workflow_event_types` in the tool table.
- [ ] T111 [P] Update `docs/dev/architecture.md` (and `contribution.md` if needed): document the 034 integration — trigger union + `reconcileSubscriptions`, `handler_declare`/`event_dispatch` wire shapes, `event` node executor, `eventContext` injection (ADR-10), and the 037 platform change's impact. Add the emit→trigger cycle risk to "Known pitfalls".
- [ ] T112 [P] Update `docs/usage.md` (and `tool-reference.md`): document the end-user workflow for event-triggered runs ("To make a workflow start automatically when [event] happens: open Triggers tab, add the type"). Document the `event` node for power users. Add `workflow_event_types` to the tool reference.

**Checkpoint**: FR-050 complete. Docs + skill in sync with implemented behavior.

---

### Phase 15-F: E2E Tests + Converge

**Goal**: Playwright e2e for US16/17/18 + FR-049 UI, plus the full converge cycle.

**Depends on**: All prior phases.

- [ ] T113 [P] [US16] E2E in `e2e/003-workflow-event-integration.spec.ts`: (a) create a workflow with `triggers: ["com.bos.e2e.workflow-trigger"]`; (b) emit via `POST /api/events`; (c) poll `workflow_status` until run starts; (d) assert `startSource: "event"`, `triggerEventId` matches, `triggerEventType` matches; (e) assert event payload in `eventContext`; (f) emit non-matching type; (g) assert no new run (SC-027); (h) emit two matching events rapidly; (i) assert two independent runs (SC-028).
- [ ] T114 [P] [US17] E2E (same file): (a) call `workflow_event_types`; (b) assert returned list includes registered types; (c) assert shape `[{ type, handlerCount, displayName }]`; (d) if no handlers → assert `[]`.
- [ ] T115 [P] [US18] E2E (same file): (a) author a workflow with a single `event` node (type `com.bos.e2e.workflow-emitted`, static payload); (b) run via `workflow_run`; (c) poll until complete; (d) assert event appears via `GET /api/events` with correct type, `source.appId: "workflows"`, `_wf` provenance; (e) test template payload `{{nodeId.field}}` → resolved; (f) test unresolvable ref → `null` (emit still succeeds, SC-026).
- [ ] T116 [P] [FR-049] E2E (same file): (a) open workflow editor; (b) navigate to Triggers tab; (c) add trigger via free-text; (d) add via Browse dropdown; (e) remove a trigger; (f) save + reload — triggers persist; (g) create an event node; (h) configure type + payload; (i) save — persists; (j) open an event-triggered run; (k) assert trajectory panel shows provenance block.
- [ ] T117 Run `buildstudio_run_tests` on `item-workflows` — full e2e suite including 001 regression + 002 e2e (T113-T116) + 034 e2e (possibly modified by T092/T093). All must pass.
- [ ] T118 Analyze + converge: compare built item against spec.md US16-18 + 037 spec. Check FR-039..051, NFR-007..009, SC-024..028, 037 SC-001..004. Record discrepancies. Update spec status. Cross-reference 034 FR-023 as superseded by 037.

**Checkpoint**: Scope-add 002 fully converged. Event-system integration (US16-18) + 037 platform change complete, tested, documented. User Promotes from Active ▾ menu.

---

## Dependencies & Execution Order (scope-add 002)

### Phase Dependencies

- **Phase 15-A (037)**: No dependencies. BLOCKS Phase 15-C (US16).
- **Phase 15-B (US17+US18)**: No dependencies on 037. Can run in parallel with 15-A.
- **Phase 15-C (US16)**: Depends on 15-A (037 active).
- **Phase 15-D (UI)**: Depends on 15-B + 15-C.
- **Phase 15-E (Docs)**: Depends on 15-B + C + D.
- **Phase 15-F (E2E + Converge)**: Depends on all prior.

### Parallel Opportunities

- **T091-T094 (037)**: T092 and T093 are [P]. T094 depends on T091.
- **T095-T101 (US17+18)**: T095, T096, T098 are [P] (different files). T097 depends on T095. T099 depends on T095. T100, T101 are [P].
- **T102-T106 (US16)**: T102→T103 sequential (same file). T104 depends on T102+T103. T105 is [P] with T104. T106 is [P].
- **T107-T109 (UI)**: T107, T108 are [P]. T109 depends on T107.
- **T110-T112 (Docs)**: All [P].
- **T113-T116 (E2E)**: All [P] (different test blocks in same file).

### Build Order Summary

```
Phase 15-A (037)  ──────────────────────────┐
                                            │ gates
Phase 15-B (US17+18) ──┐                    │
                        │                    ▼
                        └──► Phase 15-C (US16) ───► Phase 15-D (UI)
                                                       │
                                                       ▼
                                                  Phase 15-E (Docs)
                                                       │
                                                       ▼
                                                  Phase 15-F (E2E + Converge)
```

---

## Notes (scope-add 002)

- T091-T118 = 28 tasks for the scope-add (continuing from T090).
- 037 is a separate spec (`user-specs/core-platform/037-...`) but shares the feature branch — promotes with the item.
- The 034 spec's FR-023 is superseded by 037 — record at converge (T118).
- The `event` node is the cheapest possible node type (no LLM, no agent) — pure I/O.
- Template resolution follows design §13.3 exactly.
- The cycle warning (US18 emitting an event that triggers the same workflow) is documented but NOT guarded — user's responsibility.
