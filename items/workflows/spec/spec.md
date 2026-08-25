# Feature Specification: Workflow Manager Service Tools

**Feature Branch**: `bos/001-workflow-manager-service-tools` (per-project numbering under the Workflow Manager project)

**Created**: 2026-08-18

**Status**: Implemented & Promoted (2026-08-21)

**App Target**: marketplace-item

**Input**: User description: "The Workflow Manager App is not working according to the new architecture (Spec 039). I want you to rewrite it so that it's compliant and working as intended, including exposing the proper tools."

## Context

The Workflow Manager is an installed marketplace item (app id `workflows`) composed of an app facet (a UI that lists and drives workflows) and a background-service facet (a lifecycle-only worker). BOS spec 039 (`user-specs/app-infrastructure/039-service-tool-exposure`, bos-core, implemented) established the architecture by which a marketplace item's background service declares native, agent-callable tools: a service sets `deploymentMode: "tools"` on its manifest and emits `tool_declare` at startup; BOS registers those tools into the `AssistantTool` registry (via `serviceToolBridge`), validates invocations against their JSON-schemas, dispatches `tool_call` over worker IPC, and gates them exactly like built-in tools.

The current Workflow Manager item does not follow this architecture:

- The workflow tools live as BOS-source server tools (`src/lib/assistant/tools/server/workflows.ts` — `workflowTools()`) rather than being declared by the item's own service via `tool_declare`.
- The item's service is lifecycle-only (its `isWorkflowsServiceRunning()` state merely gates `workflow_run`); it does not opt into `deploymentMode: "tools"` and declares no tools.
- The app lists workflows by reading `/Workflows`, and the recurring marketplace VFS-path-mapping bug applies: content can land under `dataDir()/system/...` instead of the real VFS root `dataDir()/vfs/`, making workflows invisible to the user even though internal APIs agree — the reported "lists no workflows even though one exists" symptom.

This spec rewrites the Workflow Manager item so the workflow tools are exposed as service-declared native tools (039-compliant), the service persists workflows through the real VFS (loopback `/api/fs` bridge, the sanctioned path for unbundled worker-thread services), and the app lists workflows from the same real-VFS location.

**Engine pivot (user-approved)**: The BOS-source workflow engine (`src/lib/workflows/*` — `types.ts`, `runner.ts`, `store.ts`, `validate.ts`, `generate.ts`) and the `/api/workflows/*` routes are **retired**. The workflow engine is **fully re-implemented inside the Workflow Manager service** — a worker-thread service that owns the complete engine: node model (agent source + output type), dynamic routing, parallel scheduling, persistence, and execution. This gives the service total ownership of the workflow model and semantics without BOS-source constraints. The engine pivot therefore spans **both** a bos-core retirement (removing the old engine) and a marketplace-item re-implementation (the service owns the new engine).

**Node model — two orthogonal axes**: A node's **agent source** is either an existing statically-defined BOS agent or an Ephemeral agent (task + tools + skills). A node's **output type** is independent of its agent source — delegate (a sub-agent's output), tool (a single tool call), research (parallel fan-out), or ag-ui (an A2UI/UI artifact). Agent source and output type combine freely.

## User Scenarios & Testing *(mandatory)*

### User Story 1 - Workflow Tools Appear as Service-Declared Native Tools (Priority: P1)

The Workflow Manager's service declares the workflow tools (create, modify, run, status, cancel, export, validate) at startup via `tool_declare`, so they appear to the assistant as native, gated tools owned by the item — no BOS-source server tool registration in the loop.

**Why this priority**: This is the core of "compliant with Spec 039." Without it the item still relies on BOS-source server tools and is architecturally non-compliant. It delivers the headline value: the workflow surface becomes a marketplace-contributed native tool set.

**Independent Test**: Install the rewritten item; confirm the service starts in `deploymentMode: "tools"` mode; ask the assistant to call a workflow tool (e.g. `workflow_list`) by name; verify the tool executes through the service and returns a result. Testable in isolation.

**Acceptance Scenarios**:

1. **Given** the rewritten Workflow Manager item is installed and its service starts, **When** the service emits `tool_declare` for each workflow tool, **Then** the tools appear in the assistant's tool registry with a name, description, and JSON-schema, and are discoverable by the assistant.
2. **Given** a workflow tool is registered, **When** the assistant calls it with valid input, **Then** the service executes the workflow operation and returns a result to the assistant.
3. **Given** a workflow tool's schema requires a field, **When** the assistant calls it without that field, **Then** BOS rejects the call with a schema-validation error and does not dispatch it.

---

### User Story 2 - Service Tools Respect Tool Gating and Lifecycle (Priority: P2)

The service-declared workflow tools are governed by the same allowlist/deferred gating as built-in tools, and disappear from the registry when the service is stopped or the item is uninstalled.

**Why this priority**: Security/trust. A marketplace item gaining the ability to run workflows on the user's behalf must respect the user's tool-permission model, exactly per 039 US2.

**Independent Test**: With a restrictive tool-gate config, verify a workflow tool is not auto-executed; stop the service and verify the tools disappear. Testable in isolation.

**Acceptance Scenarios**:

1. **Given** a tool-gate config that defers or blocks a workflow tool, **When** the service declares it, **Then** BOS does not execute it without approval.
2. **Given** a service-declared workflow tool, **When** the service is stopped or the item uninstalled, **Then** the tool disappears from the registry and the assistant can no longer call it.

---

### User Story 3 - Workflows Are Listed and Managed from the Real VFS (Priority: P2)

The Workflow Manager app lists workflows that live in the user's real VFS `/Workflows` folder (the same location the workflow engine reads and writes), so workflows created by the engine or placed by the user are visible in the app, and workflows created in the app are visible to the engine and Files app.

**Why this priority**: This fixes the reported "lists no workflows" bug and is the correctness guarantee that content persists where the user can see it. It is required for the item to be "working as intended."

**Independent Test**: Create a workflow through the app; confirm the workflow JSON appears under the real VFS `/Workflows/` (visible in Files) and is listed again by the app on reload; confirm the workflow engine can read it. Testable in isolation.

**Acceptance Scenarios**:

1. **Given** a workflow JSON exists at the real VFS `/Workflows/<id>-workflow.json`, **When** the app lists workflows, **Then** the workflow is shown.
2. **Given** the user creates a workflow in the app, **When** the workflow is persisted, **Then** it is written to the real VFS `/Workflows/` root and appears in Files and in the engine's `listWorkflows()`.
3. **Given** a workflow was previously stranded in a legacy non-VFS location (e.g. under `dataDir()/system/`), **When** the rewritten service initializes, **Then** it recovers/migrates that workflow into the real VFS (additive-only, archiving rather than deleting the legacy copy).

---

### User Story 4 - Workflows Are Shown as a Graph with Branching (Priority: P2)

The Workflow Manager app renders each workflow as an interactive graph — nodes are steps, edges are dependencies — so users can see branching/parallel structure at a glance and navigate/author branching workflows, exactly as the previous UI did.

**Why this priority**: The graph visualization is a first-class, previously-available capability the user explicitly wants retained. Workflows are DAGs whose branches run concurrently; losing the graph view would regress the product. It sits alongside the real-VFS listing as core app functionality.

**Independent Test**: Open a workflow with multiple branches (parallel steps) in the app; confirm it renders as a node-edge graph showing the branches and dependencies, and that branching steps can be navigated/edited. Testable in isolation.

**Acceptance Scenarios**:

1. **Given** a workflow with steps and dependencies, **When** the user opens it in the app, **Then** it renders as a graph with nodes (steps) and edges (dependencies).
2. **Given** a workflow with branching (parallel) steps, **When** the user views it, **Then** the graph shows the branches and their concurrent structure.
3. **Given** a branching workflow, **When** the user navigates or edits it, **Then** they can select/author individual branch steps and their dependencies without losing the branching structure.
4. **Given** a workflow is running, **When** the user views it in the app, **Then** the graph highlights the active (currently-executing) step and updates live as steps complete, so execution progress is visible at a glance.

---

### User Story 5 - Workflow Execution Runs Through the Service (Priority: P3)

Running a workflow is gated by the service being in a healthy running state, and the run streams step events back so the app and assistant see progress and results.

**Why this priority**: Ensures the service remains the execution authority for workflows, consistent with the existing `workflow_run` gating (`isWorkflowsServiceRunning()`), and keeps the item coherent end-to-end.

**Independent Test**: Start the service, run a workflow via the app or a tool, observe step events stream; stop the service and verify a run attempt is refused with a clear message. Testable in isolation.

**Acceptance Scenarios**:

1. **Given** the service is running, **When** a user runs a workflow, **Then** step events stream and the final state (completed/failed/cancelled) is reported.
2. **Given** the service is stopped, **When** a user attempts to run a workflow, **Then** BOS returns a clear error that the Workflows service is not running.
3. **Given** a running workflow is cancelled, **When** the user cancels it, **Then** in-progress steps are marked cancelled and the scheduler halts.
4. **Given** a workflow is running, **When** the user observes the run view, **Then** the graph renders the active step highlighted in real time and reflects each step's live status (pending/running/completed/failed/cancelled).

---

### User Story 6 - Historical Runs Are Inspectable (Priority: P2)

Workflow runs are persisted as first-class entities so that, after a run completes, the user (or assistant via tools) can reopen a historical run and inspect exactly what happened — each step's outcome (executed/completed, failed, cancelled, or neutral/never-ran) and the event stream — replayed from the persisted run log.

**Why this priority**: A run's live graph state currently only exists while it is executing; once done it disappears, so there is no way to answer "why did `transform` retry 3×" or "which step failed" after the fact. Persisting runs makes execution inspectable and auditable, and is the missing historical half of the run concept already introduced by ADR-8 (`runId` + execution log).

**Independent Test**: Run a workflow, wait for it to finish, then open the workflow's run list and select the completed run; confirm the graph replays each step's final outcome from the run log and the event stream is shown. Testable in isolation.

**Acceptance Scenarios**:

1. **Given** a workflow has completed one or more runs, **When** the user opens the workflow and views its run list, **Then** the historical runs are shown with id, timestamp, and final state.
2. **Given** a historical run is selected, **When** the user inspects it, **Then** each step node on the graph reflects its outcome from that run (executed/completed, failed, cancelled, or neutral — never ran, e.g. downstream of a failure).
3. **Given** a historical run is selected, **When** the user inspects it, **Then** the run's event stream (step start/complete/fail/retry/cancel) is shown replayed from the persisted run log.
4. **Given** a run is still executing, **When** the user opens its run view, **Then** the live graph updates in real time; once complete, the run remains available in history for later inspection.

---

### User Story 7 - Dynamic Routing to Sub-Agents (Priority: P1)

A workflow node MAY declare a list of candidate sub-agents it can delegate to. When the node's agent executes, it selects the appropriate candidate(s) as its last action — exactly one in the non-parallel (single-choice) case, or several in parallel where the task fans out — with the selection enforced by a retry-loop on invalid/missing selection. A node with exactly one child delegates to it automatically, with no choice step required.

**Why this priority**: The retired BOS engine bound each step to a static `agentId`; it could not express "choose between Finance / Construction / Shipping / Other at run time." Dynamic routing is where the real user value lives — the workflow adapts mid-run based on information gathered by earlier nodes (e.g. the company's business type).

**Independent Test**: Build a workflow whose node has multiple candidate sub-agents; run it; confirm the node's agent selects the appropriate candidate(s) as its last action and the run proceeds along the chosen path(s); confirm an invalid/missing selection is retried. Testable in isolation.

**Acceptance Scenarios**:

1. **Given** a node declares a list of candidate sub-agents, **When** the node's agent executes, **Then** it selects the appropriate candidate(s) as its last action — exactly one in the single-choice case, several in the parallel case — and the run delegates accordingly.
2. **Given** a node's agent fails to select a valid candidate, **When** the run continues, **Then** the selection is retried until a valid choice is made (retry-loop), not silently defaulted.
3. **Given** a node has exactly one child, **When** it completes, **Then** delegation to that child happens automatically without requiring a choice action.
4. **Given** a node is a parallel/Research node, **When** it routes, **Then** it may delegate to multiple candidates concurrently.

---

### User Story 8 - Parallel Execution and Ephemeral Agents (Priority: P1)

Two orthogonal capabilities:

1. **Parallel execution** — independent ready branches and Research-node fan-out run concurrently up to the workflow's `maxConcurrentSteps` cap. This is scheduling semantics, independent of node type.
2. **Ephemeral agents** — a node MAY be configured as an ephemeral agent (a task description plus a configurable tool list and skill list) when no existing BOS agent perfectly matches the task — the common case. This is node configuration, orthogonal to parallel execution; an ephemeral node may run alone or in parallel with others.

**Why this priority**: Parallel execution is essential for a multi-agent system — a sustainability analysis with several independent questions should fan out research agents rather than serialize them. Ephemeral agents make the workflow self-sufficient when no dedicated agent exists.

**Independent Test**: Build a workflow with multiple independent Research children; run it; confirm the parallel branches execute concurrently (up to the concurrency cap). Separately, configure an ephemeral-agent node with a task + tools + skills and confirm it executes. Testable in isolation.

**Acceptance Scenarios**:

1. **Given** a workflow has multiple independent ready branches, **When** the run dispatches, **Then** they execute concurrently up to the workflow's `maxConcurrentSteps` cap.
2. **Given** a workflow builder detects independent questions, **When** it generates the workflow, **Then** it creates Research-type children and assigns them to run in parallel.
3. **Given** a Research node, **When** it runs, **Then** multiple sub-agents are spawned in parallel and their outputs are collected.
4. **Given** no existing BOS agent matches a node's task, **When** the workflow is built, **Then** the node is configured as an ephemeral agent with a task, tool list, and skill list.

---

### User Story 9 - Workflow Manager Skill for the Assistant (Priority: P2)

The Workflow Manager app ships a skill that instructs the assistant on how to use it — building workflows, executing them, retrieving results, and inspecting historical runs — so the workflow tools are used correctly and the workflow-builder agent produces well-formed workflows.

**Why this priority**: The workflow tools are agent-facing; a bundled skill makes them discoverable and correctly used, which is what makes the "build a complex workflow from a one-line trigger" experience work.

**Independent Test**: Load the Workflow Manager skill; confirm it instructs the assistant to build, execute, and retrieve workflows via the workflow tools; build a workflow from a natural-language trigger. Testable in isolation.

**Acceptance Scenarios**:

1. **Given** the Workflow Manager is installed, **When** the assistant needs to build a workflow, **Then** it can load the bundled skill and follow its instructions.
2. **Given** the skill is loaded, **When** the assistant builds a complex workflow, **Then** it creates well-formed ephemeral/Research nodes with candidate sub-agents and required tools/skills.
3. **Given** the skill is loaded, **When** the assistant runs a workflow, **Then** it can execute, retrieve results, and inspect historical runs via the workflow tools.

## Requirements *(mandatory)*

### Functional Requirements

- **FR-001**: The Workflow Manager service MUST set `deploymentMode: "tools"` on its manifest and emit `tool_declare` for each workflow tool at startup.
- **FR-002**: The service MUST declare at minimum the following workflow tools, each with a name, description, and input JSON-schema: list/create/read/modify/run/status/run_list/run_get/cancel/delete/export/validate workflows (the 039-compliant native-tool surface replacing the current BOS-source `workflowTools()` set).
- **FR-003**: Each declared tool MUST validate its arguments against its input JSON-schema before executing (per 039 FR-004); invalid calls MUST be rejected without dispatch.
- **FR-004**: The service MUST persist workflows to the real VFS `/Workflows/` root via the loopback `/api/fs` bridge (the sanctioned unbundled-worker-thread path), so workflows are visible in Files and to the workflow engine.
- **FR-005**: On initialization, the service MUST detect workflows stranded in legacy non-VFS locations and migrate them into the real VFS `/Workflows/` additively (copying/archiving, never deleting the legacy copy).
- **FR-006**: The app MUST list workflows by reading the real VFS `/Workflows/` root through the service, showing workflows created by the engine, by other tools, or placed by the user.
- **FR-007**: Workflow execution MUST be gated on the service being in a running state; a run attempt while the service is stopped MUST return a clear error.
- **FR-008**: A workflow run MUST be an asynchronous, fire-and-poll operation: `workflow_run` returns a `runId` immediately and does not block for the run's completion; the caller MUST poll `workflow_status` (or `workflow_run_get`) for progress and final state. Step events (start/complete/fail/retry/cancel) stream to the app so it observes live progress and final state.
- **FR-009**: Cancelling a running workflow MUST mark in-progress steps cancelled and halt the scheduler.
- **FR-010**: Service-declared workflow tools MUST be gated by the existing tool-gating model (allowlist, deferred approval) exactly like built-in tools (per 039 FR-005).
- **FR-011**: Stopping or uninstalling the service MUST remove its declared tools from the registry, so no stale tool call to a stopped service is possible (per 039 FR-006).
- **FR-012**: The app MUST render each workflow as an interactive graph — nodes are steps, edges are dependencies — and MUST support branching workflows (parallel steps that run concurrently), including navigating and authoring individual branch steps without losing the branching structure.
- **FR-013**: During a workflow run, the graph view MUST highlight the active (currently-executing) step and reflect each step's live status (pending/running/completed/failed/cancelled), updating in real time as execution progresses.
- **FR-014**: The workflow surface MUST be fully controllable through the service-declared tools — building (create), modifying (modify), executing (run), stopping (cancel), plus read/status/delete/export/validate — such that every workflow lifecycle operation is achievable via tools without requiring the UI.
- **FR-015**: Each workflow run MUST be persisted as a first-class run entity (with its execution-log events and per-step final outcomes) to the real VFS, so completed runs remain inspectable and auditable after execution.
- **FR-016**: The service MUST declare `workflow_run_list` (list historical runs for a workflow) and `workflow_run_get` (read a specific run's details, per-step outcomes, and event log) so historical run inspection is achievable via tools without requiring the UI.
- **FR-024**: The `workflow_list` tool MUST return, per workflow, its `workflow_id`, a `status` field (`running` or `idle`), and a `run_id` when the workflow is running — so an agent can poll the workflow's live status via `workflow_status`/`workflow_run_get` without requiring the UI.
- **FR-017**: The app MUST provide a run selector on the workflow detail view listing that workflow's historical runs, and MUST render the graph + event stream replayed from a selected run's persisted log (per-step outcomes: executed/completed, failed, cancelled, neutral), distinct from the live run view.
- **FR-018**: A node MUST be able to declare a list of candidate sub-agents for dynamic routing; when the node's agent executes it MUST select the appropriate candidate(s) as its last action — exactly one in the single-choice case, several in the parallel case — with the selection enforced by a retry-loop on invalid or missing selection.
- **FR-019**: A node with exactly one child MUST delegate to it automatically, without requiring a choice action.
- **FR-020**: Parallel execution MUST be supported as scheduling semantics: independent ready branches and Research-node fan-out run concurrently up to the workflow's `maxConcurrentSteps` cap, independent of node type.
- **FR-021**: Nodes MUST be configurable as ephemeral agents — a task description plus a configurable tool list and skill list — used when no existing BOS agent matches the task; an ephemeral node may run alone or in parallel with others.
- **FR-022**: A Research node type MUST fan out multiple sub-agents and run them in parallel, collecting their outputs.
- **FR-023**: The app MUST ship a Workflow Manager skill that instructs the assistant to build, execute, and retrieve workflows (including historical-run inspection) via the workflow tools.

### Non-Functional Requirements

- **NFR-001**: A workflow tool invocation MUST return a result within 30 seconds by default (per 039 R10) without leaking pending waits or crashing BOS. **`workflow_run` is an exception — it is an asynchronous, fire-and-poll operation**: it MUST return a `runId` immediately (well within 30s) and MUST NOT block until the workflow completes; the caller MUST poll `workflow_status` (or `workflow_run_get`) for progress and final state. Long-running workflows therefore do not violate this timeout.
- **NFR-002**: Tool-execution errors inside the service MUST be reported to the assistant as tool errors without crashing BOS (per 039 FR-007).
- **NFR-003**: The service MUST bind a configurable port defaulting to `0` (OS-assigned, non-colliding) per marketplace service conventions.
- **NFR-004**: All storage reads/writes MUST go through the real-VFS loopback bridge; the service MUST NOT write to a host path under `dataDir()/system/` derived from its own config dir.
- **NFR-005**: No error path MAY be swallowed without logging; key events (tool_declare received, tool registered, tool_call dispatched/resolved, schema-rejected, timeout, worker-exit cleanup) MUST emit structured logs via the service's log channel.

## Key Entities *(include if feature involves data)*

- **Workflow**: A user-authored multi-step graph — id, name, version, nodes, dependencies, config (max concurrency, default retry/timeout). Persisted as JSON at the real VFS `/Workflows/<id>-workflow.json`.
- **WorkflowTool**: A native tool the service declares via `tool_declare` — name, description, input JSON-schema, mapped into the `AssistantTool` registry.
- **ExecutionEvent / StepRuntimeState**: Streamed events and per-step runtime status during a workflow run, used for progress reporting and cancellation.
- **Run**: A single execution of a workflow — id (`runId`), workflow id, start/end timestamp, final state (completed/failed/cancelled), per-step outcomes, and the persisted event log. Stored at the real VFS under `/Workflows/.runs/<workflowId>/<runId>.json` (or equivalent real-VFS run-log location), never a host path.
- **Node**: A workflow node with two orthogonal axes — (1) **agent source**: an existing statically-defined BOS agent, or an **Ephemeral agent** (task description + configurable tool list + configurable skill list, used when no existing agent matches the task); (2) **output type**: delegate (sub-agent output), tool (single tool call), research (parallel fan-out), or ag-ui (A2UI/UI artifact). A node may declare candidate sub-agents for dynamic routing. Parallel execution is a scheduling property (independent ready branches run concurrently up to `maxConcurrentSteps`), orthogonal to both axes.

## Success Criteria *(mandatory)*

### Measurable Outcomes

- **SC-001**: After installing the rewritten item, all workflow tools are visible to the assistant immediately upon service start — no manual registration step.
- **SC-002**: 100% of valid workflow-tool invocations against a healthy service return a result without error.
- **SC-003**: A workflow created in the app, via the engine, or placed by the user under `/Workflows/` is listed by the app in 100% of cases (no invisible-content mismatch between app, engine, and Files).
- **SC-004**: Service-declared workflow tools are gated by the same rules as built-in tools — no tool auto-executes when the user's gate config requires approval.
- **SC-005**: Stopping or uninstalling the service removes its workflow tools from the registry immediately, such that no stale tool call to a stopped service is possible.
- **SC-006**: A workflow run is asynchronous and fire-and-poll: `workflow_run` returns a `runId` immediately, and the caller polls `workflow_status`/`workflow_run_get` to observe progress and a final state (completed/failed/cancelled) for every executed workflow.
- **SC-007**: During a workflow run, the graph highlights the active step live and reflects per-step status, matching the streamed execution events.
- **SC-008**: Every workflow lifecycle operation (build/modify/run/stop) is achievable via the service-declared tools without requiring the UI.
- **SC-009**: Every completed run is persisted to the real VFS and inspectable via both the app run selector and the `workflow_run_list`/`workflow_run_get` tools.
- **SC-010**: A historical run's graph replays each step's final outcome from the persisted run log with 100% fidelity, distinct from live-run state.
- **SC-011**: A node with multiple candidate sub-agents delegates to the appropriate candidate(s) chosen by its agent as the last action, with retry enforcement on invalid/missing selection.
- **SC-012**: Independent workflow branches and Research-node fan-out execute in parallel up to `maxConcurrentSteps`, with no serialization of independent steps.
- **SC-013**: The assistant can load the Workflow Manager skill and correctly build, execute, and retrieve workflows via the workflow tools.
- **SC-014**: An agent can poll a workflow's live status via `workflow_list` (which returns `workflow_id`, `status` running/idle, and `run_id` when running) followed by `workflow_status`/`workflow_run_get` for detail.

## Assumptions

- ~~The workflow execution engine stays in BOS source~~ — **REVERSED (user-approved)**: the BOS workflow engine (`src/lib/workflows/*` + `/api/workflows/*` routes) is **retired** and the workflow engine is **fully re-implemented inside the Workflow Manager service**. The worker thread owns the complete engine: node/step types, dynamic routing, parallel scheduling, persistence, execution. The service exposes it as 039-compliant service-declared tools.
- The service may reuse the existing `workflowTools()` tool definitions (names/descriptions/schemas) as the source of truth for what it declares, so the native tool surface is behaviorally identical to the current server tools (where the tool still exists).
- BOS source already implements 039 (service-tool-bridge, worker IPC, `deploymentMode` validation, gating fixes). The bos-core scope here is the **retirement** of the old engine (`src/lib/workflows/*` + `/api/workflows/*` routes), replaced by the service-owned engine.
- Workflows persist as JSON files under `/Workflows/` (VFS); run logs under `/Workflows/.runs/` — both real VFS, matching the service-owned engine's store.
- Migration is additive-only and idempotent: stranded workflows are copied into the real VFS (skipping any that already exist) and the legacy location is archived (renamed), never deleted.
- The Workflow Manager app retains the graph view and branching capability from the previous UI: workflows render as an interactive node-edge graph, and branching (parallel) steps are supported for viewing and authoring.
- Per user approval, the built-in `workflowTools()` server tools (`src/lib/assistant/tools/server/workflows.ts` + its registry registration) are **retired** via a scoped `bos-core` delegation so the service-declared tools are not shadowed. This relaxes the earlier "no BOS source change" assumption; the workflow execution engine itself stays untouched.
- The workflow tool surface is the complete control plane: every lifecycle operation (build/modify/run/stop) is achievable through the service-declared tools, with the app UI as a parallel surface rather than a requirement. The graph view additionally surfaces live execution state (active-step highlight) during runs.
- Runs are persisted as first-class entities to the real VFS (run id, timestamps, final state, per-step outcomes, event log), enabling historical run inspection. The `workflow_run_list`/`workflow_run_get` tools extend the tool surface so historical introspection is tool-reachable; the run selector on the detail view replays a selected run's graph from its persisted log.
- The workflow engine is **fully re-implemented inside the Workflow Manager service** (user-approved): BOS's `src/lib/workflows/*` and `/api/workflows/*` routes are **retired**, and the worker owns the complete engine — node model (agent source + output type), dynamic routing, parallel scheduling (up to `maxConcurrentSteps`), persistence, and execution. This reverses the earlier "engine stays in BOS source" assumption (ADR-1). The feature is therefore **bos-core + marketplace-item**: a bos-core retirement of the old engine, plus a marketplace-item re-implementation as a service.
- **Node axes are orthogonal**: agent source (statically-defined agent | Ephemeral agent) is independent of output type (delegate | tool | research | ag-ui); any combination is valid (e.g. an Ephemeral agent node with research output, or a static-agent node with tool output).
