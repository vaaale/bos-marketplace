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

**Event-system integration (scope-add, 2026-09-02)**: The Workflow Manager integrates with the 034 event-notification system in two directions. **Inbound**: a workflow MAY declare a `triggers` array of event types; the service subscribes to the union via the 034 headless-handler channel (`handler_declare` over worker IPC, 034 ADR-3) and starts a fire-and-poll run on each matching event. **Outbound**: a new `event` node output type emits a configurable event into the 034 system, making workflows first-class event producers. A `workflow_event_types` tool exposes registered event types so the assistant can author trigger subscriptions without guessing. **Platform dependency**: This feature requires a 034 platform change — removing the namespace-ownership check on handler registration (034 FR-023) so that any component can subscribe to any event type. See `user-specs/core-platform/037-event-namespace-relaxation` (specify). The headless-handler channel itself (`handler_declare` over worker IPC) and the emit API are already implemented and unchanged.

**Runs-table scope-add (2026-09-09)**: The workflow detail view's historical runs are surfaced as a **datetime-sorted table** (most recent first) with a per-run **checkbox**, a **select-all** header toggle, and a **bulk delete** of the selected runs (their persisted run logs + per-step outcomes; the workflow definition is untouched). A `workflow_run_delete` service tool provides agent-side parity. See User Story 19 / FR-052–055.

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
4. **Given** the task is "run N investigations in parallel and feed them to a synthesis step," **When** the assistant builds the workflow, **Then** the skill steers it to use the native **research** output type (the recommended primitive for this pattern), not a manual delegate fan-out with file handoff, and it documents the realistic latency difference (research ≫ faster than serial delegate fan-out).

### User Story 10 - Node Trajectory Panel (Priority: P2)

Opening a workflow run — a live run or a selected historical run — and clicking any node on the graph opens a panel docked to the **right** of the graph, with a **horizontally resizable** width (a draggable divider between graph and panel), showing that node's **execution trajectory**: its ordered lifecycle events (start / retry / running / complete / fail / cancel / skip) with timestamps and durations, its current/final outcome, and its output/artifact (and, for routing nodes, the candidate sub-agent it selected) — and, critically, **what the node's agent is actually doing**: the executed prompt/instructions, the agent's reasoning (where exposed), every **tool call** (name, arguments, and return value with success/error status), and the agent's **response generation**. The panel is a **debugging surface**: it lets the user inspect exactly what each agent in the graph was doing and why, for both live and finished runs. The redundant per-step status list that currently sits below the graph is **removed** — per-step status is instead surfaced by the graph's node coloring plus this on-demand, per-node trajectory panel.

**Why this priority**: Today the only per-node detail is a flat status list that merely mirrors the graph's node colors, so it cannot answer "what actually happened *inside* this step" (retries, timing, error, output). A trajectory panel gives per-node, event-level visibility for both live and finished runs, replacing a redundant list with a more powerful on-demand inspection surface. Crucially, it exposes **what the agent inside a node is actually doing** — the executed prompt, its tool calls and their arguments/results, its reasoning, and its response — which is what makes a workflow node **debuggable**: you can see not just that `transform` failed, but *what prompt it ran, which tools it called with what inputs, and what it was trying to produce* when it did. It builds directly on the run-persistence already delivered by US6/FR-015/FR-017.

**Independent Test**: Open a live run and click a node — confirm the right-side resizable panel shows that node's lifecycle events in order (timestamps + durations), its status, and its output, updating live while it runs. Separately, select a historical run, click a node, and confirm the same panel shows the replayed trajectory (a neutral/never-ran node shows "no events"). Confirm the per-step status list is gone. Testable in isolation.

**Acceptance Scenarios**:

1. **Given** a live run is open, **When** the user clicks a node on the graph, **Then** a trajectory panel opens to the right of the graph showing that node's ordered lifecycle events (with timestamps and durations), its current status, and its output.
2. **Given** the trajectory panel is open, **When** the user drags the divider, **Then** the panel's width resizes horizontally and the graph reflows to fill the remaining space.
3. **Given** the trajectory panel is open, **When** the user clicks a different node, **Then** the panel updates to that node's trajectory; the panel can be dismissed and re-opened by clicking a node.
4. **Given** a historical run is selected, **When** the user clicks a node, **Then** the trajectory panel shows that node's trajectory replayed from the persisted run log, and a neutral/never-ran node is shown as having no events.
5. **Given** a node's agent executed one or more tool calls, **When** the user opens its trajectory, **Then** the panel shows each tool call with its name, arguments, and return value/result, and a success/error status for the call.
6. **Given** a node is an agent (statically-defined or Ephemeral), **When** the user opens its trajectory, **Then** the panel shows the prompt/instructions that were executed — the assembled task plus the upstream context fed into it.
7. **Given** a node is live and its agent is currently executing, **When** the user opens its trajectory, **Then** the panel shows the agent's activity in real time — thinking/reasoning (where exposed), in-flight tool calls, and the streaming response.
8. **Given** the run view is rendered, **When** it previously showed a per-step status list below the graph, **Then** that list is no longer shown — per-step status is conveyed by the graph's node colors and the node trajectory panel.
9. **Given** a Research node is executing, **When** the user opens its trajectory, **Then** the panel shows **per-sub-agent status** (pending/running/completed/failed) so the user can see which fan-out sub-agent is the straggler, and a short **current-action** string for any in-progress step.

### User Story 11 - Branch Routing Is Correct, Structured, and Safe (Priority: P1)

A routing node's selection is a **structured, machine-readable signal** (not free-form prose), the DAG rule for how a selection propagates is precise, and a run that selects a branch which then executes **zero** leaves is never silently reported as successful. This fixes the reported failure where an agent's prose ("I'll select the alarm branch") produced the wrong recorded selection (`quiet`), a shared intermediate step (`render`) blocked all downstream nodes, and the run still ended `completed` with no terminal action.

**Why this priority**: This is the single biggest blocker in the field evaluation — a silent `completed` that skipped the terminal action (no dashboard, no alert) is the most dangerous failure mode. Dynamic routing is the feature's headline value (US7); it only delivers that value if selection is deterministic, propagates correctly through shared steps, and is guarded against silent no-ops.

**Independent Test**: Author a workflow `A → B(candidates: X, Y)` where a shared step `S` also depends on `B` and sits before the leaves. Run it; confirm the routing node selects via a structured signal, `S` runs regardless of selection, the selected leaf runs, and the unselected leaf is neutral. Separately, author a workflow whose selected leaf is unreachable and confirm the run reports a `workflow.branch.skipped` warning rather than `completed`. Testable in isolation.

**Acceptance Scenarios**:

1. **Given** a routing node completes and its agent emits a **structured** selection of a candidate, **When** the run proceeds, **Then** the run records that exact candidate as selected — never a different one inferred from prose — and the run delegates accordingly.
2. **Given** a routing node's agent emits no valid structured selection, **When** the run continues, **Then** the selection is retried (retry-loop); if it still cannot be resolved, the node **fails** rather than defaulting to an arbitrary candidate.
3. **Given** a workflow with a shared step `S` that depends on a routing node `B` but is **not** one of `B`'s candidate leaves, **When** `B` completes, **Then** `S` runs normally (it is gated only by its own dependencies), and a candidate leaf runs only if its routing node selected it.
4. **Given** a routing node selects a branch, but the selected path results in **zero** executed leaves (e.g. the leaf is unreachable), **When** the run ends, **Then** the run is **not** marked `completed` — it emits a `workflow.branch.skipped` event and reports a final state of `completed_with_warnings` (or fails), so the silent no-op is surfaced.
5. **Given** a workflow with malformed candidate topology (e.g. a candidate leaf that is unreachable from its routing node, or a node ambiguously both a shared dependency and a gated leaf), **When** the user runs `workflow_validate`, **Then** the validation reports the structural problem.

### User Story 12 - Ephemeral Agents Actually Get Their Declared Tools (Priority: P1)

An ephemeral-agent node's declared tool list is genuinely granted to the spawned agent, so a node that lists `file_read`/`file_write` (or any listed tool) has those tools available — including deferred tools reachable via `find_tools`. This fixes the reported gap where cluster agents listed the VFS file tools, could not find them, got empty `find_tools`/`find_agent` results, and had to fall back to `run_command` heredocs.

**Why this priority**: The natural "parallel research → merge" handoff is write-a-file / read-a-file. Forcing `run_command` for file I/O is clunky and reintroduces the heredoc JSON-parse risk the user was actively fighting. Tool fidelity is a correctness bug: the declared allowlist must mean what it says.

**Independent Test**: Author an ephemeral-agent node with `tools: ["file_read", "file_write"]`; run it; confirm the agent can call `file_write`/`file_read` directly (not via `run_command`) and that `find_tools` returns the listed deferred tools when requested. Testable in isolation.

**Acceptance Scenarios**:

1. **Given** an ephemeral-agent node declares `file_read` and `file_write` in its tool list, **When** the agent executes, **Then** both tools are available to it and `find_tools` does not return empty for them.
2. **Given** an ephemeral-agent node declares a set of tools, **When** the agent is spawned, **Then** the spawned agent's effective tool set matches the declared allowlist (no silent drop, no substitution).
3. **Given** the user hands off data between a fan-out and a merge step, **When** the steps are authorable without file I/O, **Then** the research/delegate step outputs are consumable as first-class structured data by the dependent step (no mandatory file handoff).

### User Story 13 - Live Run Progress Is Observable (Priority: P1)

`workflow_status` and `workflow_run_get` return a **populated live per-step state** (status, attempt count, and a short current-action string per in-progress step) and, for Research nodes, **per-sub-agent status** — so a long run is not a black box and the user/agent can tell which of N parallel agents is the straggler. This same live state is the single source of truth consumed by both the app trajectory panel (US10) and the tools.

**Why this priority**: The evaluation reported `workflow_status` returning `steps: {}` with only an event log — no per-step live state, no per-sub-agent progress — forcing filesystem polling to gauge a 30–60 min run. Live, structured progress is what makes fire-and-poll (FR-008) actually usable.

**Independent Test**: Start a multi-branch run; poll `workflow_status`; confirm each in-progress step returns status + attempt + a short current-action string, and a Research node returns per-sub-agent status identifying the slowest sub-agent. Testable in isolation.

**Acceptance Scenarios**:

1. **Given** a run is in progress, **When** the caller polls `workflow_status` (or `workflow_run_get`), **Then** the response includes a populated per-step map — for each step: status, attempt count, and a short current-action string while in progress — not an empty `steps: {}`.
2. **Given** a Research node is fanning out multiple sub-agents, **When** the caller polls live status, **Then** each sub-agent's status (pending/running/completed/failed) is exposed, so the straggler is identifiable.
3. **Given** the live per-step state changes, **When** the app's trajectory panel (US10/US10-9) or the tools read it, **Then** both reflect the same current state (single source of truth).

### User Story 14 - Fast Iteration Without Full Execution (Priority: P2)

`workflow_run` supports a **dry-run / fixture mode** that substitutes canned sub-agent outputs for designated nodes, so the user can validate the DAG, branch routing, and leaf steps in seconds instead of a full 30–60 min research run.

**Why this priority**: The evaluation burned significant wall-clock on full runs just to confirm one branch-routing behavior. A dry-run mode would have surfaced the routing bug (US11) on the first attempt. This is an iteration-cost fix that compounds with the routing fix.

**Independent Test**: Author a workflow with a research node; run it in dry-run mode with a canned research output injected; confirm the downstream merge and branch-routing execute in seconds against the fixture and the leaves are reached. Testable in isolation.

**Acceptance Scenarios**:

1. **Given** a `workflow_run` call with dry-run/fixture mode and a canned output for a designated node, **When** the run executes, **Then** that node's real execution is skipped and the fixture output is used by its dependents.
2. **Given** a workflow with branch routing, **When** it is run in dry-run mode, **Then** the DAG, selection, and leaf reachability are evaluated without performing the real (slow) research, completing in seconds.
3. **Given** a non-dry-run `workflow_run`, **When** it executes, **Then** real sub-agent execution occurs (the fixture mode is opt-in and does not change default behavior).

### User Story 15 - Stuck Agents Fail Fast, and Latency Is Documented (Priority: P2)

The engine enforces a **per-step** and a **per-run** timeout (configurable on the Workflow, with sensible defaults) so a stuck agent fails fast instead of silently consuming an hour, and the skill/docs state realistic latency for delegate vs research steps.

**Why this priority**: A parallel fan-out's wall-clock is dominated by the slowest of N agents, and a single hung agent can consume an hour with no signal. Timeouts give a fail-fast guarantee; latency documentation sets correct expectations (the native research type is materially faster than serial delegate fan-out).

**Independent Test**: Author a workflow with a step timeout shorter than a node's expected duration; run it; confirm the timed-out step is marked failed with a timeout reason and the run does not hang indefinitely. Testable in isolation.

**Acceptance Scenarios**:

1. **Given** a step exceeds its configured per-step timeout, **When** the timeout elapses, **Then** the step is marked failed with a timeout reason and the scheduler proceeds (or halts per the workflow's on-failure policy) — it does not hang.
2. **Given** a whole run exceeds its configured per-run timeout, **When** the timeout elapses, **Then** the run is marked failed/timed-out and halted.
3. **Given** the Workflow entity has a default retry/timeout config, **When** the user does not override it, **Then** sensible defaults apply so an unconfigured run still fails fast.
4. **Given** the skill/docs are read, **When** the user chooses between a delegate fan-out and a research node for parallel work, **Then** the guidance states the realistic relative latency and recommends research for parallel investigations feeding a synthesis step.

---

### User Story 16 - Event-Triggered Workflow Runs (Priority: P1)

A workflow MAY declare a `triggers` array of 034 event types in its JSON. The service subscribes to the union of all trigger event types across all workflows via the 034 headless-handler channel (`handler_declare` over worker IPC). When a matching event is emitted to the 034 system, the service starts a new fire-and-poll run for that workflow, with the event payload injected as input context and trigger provenance recorded in the run.

**Why this priority**: This is the core of making workflows reactive — a workflow can now start automatically in response to system events (a new email, a completed task, a health warning) without any agent or user intervention. It closes the loop between the 034 event system and the workflow engine, making workflows first-class participants in the event-driven architecture.

**Independent Test**: Create a workflow with `triggers: ["com.bos.test.workflow-trigger"]`; emit that event type via `emit_event`; confirm a new run starts for the workflow with trigger provenance (event id + type, `startSource: "event"`) and the event payload available as input context. Testable in isolation.

**Acceptance Scenarios**:

1. **Given** a workflow declares `triggers: ["com.bos.gsuite.email.received"]`, **When** an event of that exact type is emitted to the 034 system, **Then** the service starts a new fire-and-poll run for that workflow with `startSource: "event"` and the triggering event's id and type recorded in the run's provenance.
2. **Given** a workflow declares `triggers: ["com.bos.gsuite.email.received"]`, **When** an event of a different type is emitted, **Then** no run is started for that workflow.
3. **Given** a matching event is emitted and a run is started, **When** the first node of the workflow executes, **Then** the event payload is available as an `eventContext` input field — the workflow can use the triggering event's data in its execution.
4. **Given** a workflow is already running and a matching event arrives, **When** the event is dispatched, **Then** a new, independent run is started — concurrent runs of the same workflow are valid (no coalesce, no queue).
5. **Given** the service restarts, **When** it initializes, **Then** it re-derives the union of trigger event types from the current set of workflows and re-declares its headless handlers — no separate subscription store is needed.

---

### User Story 17 - Event-Type Discovery Tool (Priority: P1)

The service declares a `workflow_event_types` tool that returns the list of event types currently registered in the 034 event system, so the assistant can discover which event types are available and choose one when authoring a workflow's `triggers` array — without guessing or hard-coding type strings.

**Why this priority**: Without a way to list available event types, the assistant cannot reliably author event-triggered workflows. The user would have to know the exact dot-separated type string to type into the `triggers` array — a friction that defeats the purpose of agent-assisted workflow building.

**Independent Test**: Call `workflow_event_types`; confirm it returns a non-empty list of event type strings matching those registered in the 034 event system (verifiable via `GET /api/events/handlers`). Testable in isolation.

**Acceptance Scenarios**:

1. **Given** the 034 event system has registered handlers for at least one event type, **When** the assistant calls `workflow_event_types`, **Then** the tool returns the list of registered event types with their display names (where available).
2. **Given** the assistant is authoring a workflow with event triggers, **When** it calls `workflow_event_types`, **Then** it can select a returned type string and place it in the workflow's `triggers` array, and the resulting workflow will be triggered correctly.
3. **Given** no event handlers are registered in the 034 system, **When** the assistant calls `workflow_event_types`, **Then** the tool returns an empty list (not an error).

---

### User Story 18 - Emit-Event Node Type (Priority: P2)

A new node output type `event` emits a configurable event to the 034 event system when executed. The node's config specifies the event type (under the workflow service's owned namespace) and an optional payload — either a static JSON object or a template with `{{nodeId.field}}` placeholders resolved from upstream node outputs. The node completes after the emit call returns.

**Why this priority**: This makes workflows first-class event *producers*, not just consumers. A workflow that completes an analysis can emit a `com.bos.workflows.analysis.complete` event that triggers *another* workflow — enabling event-driven workflow chains without a central orchestrator. It also lets workflows signal completion to other BOS components (e.g., notify the assistant, trigger a GSuite action).

**Independent Test**: Author a workflow with a single `event` node configured to emit `com.bos.workflows.test.hello` with a static payload; run the workflow; confirm the event appears in the 034 event system (visible in Event Viewer or via `query_events`) with the correct type, source, and payload. Testable in isolation.

**Acceptance Scenarios**:

1. **Given** a workflow has an `event` node configured with type `com.bos.workflows.analysis.complete` and a static payload, **When** the node executes, **Then** an event is emitted to the 034 system with that type, the workflow service as source, and the configured payload — and the node completes.
2. **Given** an `event` node's payload template references an upstream node's output (e.g. `{{research_1.summary}}`), **When** the node executes after the upstream node completes, **Then** the emitted event's payload has the placeholder resolved to the actual upstream output value.
3. **Given** an `event` node's payload template references a node that was never run (neutral/skipped), **When** the node executes, **Then** the placeholder resolves to `null` (or the template's fallback value if one is specified) — the emit does not fail.
4. **Given** an `event` node is configured with a type outside the workflow service's owned namespace (e.g. `com.bos.gsuite.email.sent`), **When** `workflow_validate` is called, **Then** the validation reports an error — the service cannot emit into a namespace it doesn't own.

---

### User Story 19 - Historical Runs Table with Selection and Bulk Delete (Priority: P2)

The workflow detail view presents a workflow's historical runs as a **table** — one row per run — **sorted by datetime (most recent first)**. Each row carries a **checkbox**; a **select-all** checkbox in the table header toggles every row at once. With one or more runs selected, a **delete** action removes the selected runs (their persisted run logs + per-step outcomes) from the real VFS, leaving the workflow definition itself untouched. Deleting a run is also reachable by the assistant through a `workflow_run_delete` tool for agent-side parity.

**Why this priority**: US6/FR-015/FR-017 already persist runs and give a run selector + replay, but the historical surface is a picker, not a manageable list — there is no way to see runs at a glance in chronological order or to clean up old runs. A datetime-sorted, selectable table with bulk delete makes the run history inspectable *and* manageable from the UI, and the delete tool keeps the tool surface complete (FR-014's "every lifecycle operation is tool-reachable" principle, extended to run history).

**Independent Test**: In the app, open a workflow with several completed runs; confirm they appear as a table sorted newest-first by datetime; check one or more rows, use the header checkbox to select all, click delete, and confirm the selected run logs are removed from the real VFS (and the rows disappear) while the workflow definition remains. Separately, call `workflow_run_delete` for a run id and confirm the run log is removed. Testable in isolation.

**Acceptance Scenarios**:

1. **Given** a workflow has several historical runs, **When** the user opens its detail view, **Then** the runs are shown as a table with one row per run, sorted by datetime (most recent first), showing at minimum the run's datetime, run id, and final state.
2. **Given** the runs table is shown, **When** the user clicks a row's checkbox, **Then** that run is selected/deselected (toggle) without affecting other rows.
3. **Given** the runs table is shown, **When** the user clicks the header (select-all) checkbox, **Then** all rows in the table are selected; clicking it again deselects all (toggle).
4. **Given** one or more runs are selected, **When** the user invokes delete, **Then** the selected runs' persisted run logs (+ per-step outcomes) are removed from the real VFS, the workflow definition is unchanged, and the removed rows no longer appear.
5. **Given** no runs are selected, **When** the user attempts to delete, **Then** no run is deleted (the action is a no-op or clearly disabled).
6. **Given** the assistant calls `workflow_run_delete` with one or more run ids, **When** the service processes it, **Then** the corresponding run logs are removed from the real VFS and the result (deleted count / errors) is returned.

---

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
- **FR-015**: Each workflow run MUST be persisted as a first-class run entity (with its execution-log events — including agent-execution events per FR-028 — and per-step final outcomes) to the real VFS, so completed runs remain inspectable and auditable after execution.
- **FR-016**: The service MUST declare `workflow_run_list` (list historical runs for a workflow) and `workflow_run_get` (read a specific run's details, per-step outcomes, and event log) so historical run inspection is achievable via tools without requiring the UI.
- **FR-024**: The `workflow_list` tool MUST return, per workflow, its `workflow_id`, a `status` field (`running` or `idle`), and a `run_id` when the workflow is running — so an agent can poll the workflow's live status via `workflow_status`/`workflow_run_get` without requiring the UI.
- **FR-017**: The app MUST provide a run selector on the workflow detail view listing that workflow's historical runs, and MUST render the graph + event stream replayed from a selected run's persisted log (per-step outcomes: executed/completed, failed, cancelled, neutral), distinct from the live run view.
- **FR-018**: A node MUST be able to declare a list of candidate sub-agents for dynamic routing; when the node's agent executes it MUST select the appropriate candidate(s) as its last action — exactly one in the single-choice case, several in the parallel case — with the selection enforced by a retry-loop on invalid or missing selection. The selection MUST be a **structured, machine-readable signal** (FR-029); the engine MUST NOT infer a candidate from free-form prose.
- **FR-019**: A node with exactly one child MUST delegate to it automatically, without requiring a choice action.
- **FR-020**: Parallel execution MUST be supported as scheduling semantics: independent ready branches and Research-node fan-out run concurrently up to the workflow's `maxConcurrentSteps` cap, independent of node type.
- **FR-021**: Nodes MUST be configurable as ephemeral agents — a task description plus a configurable tool list and skill list — used when no existing BOS agent matches the task; an ephemeral node may run alone or in parallel with others.
- **FR-022**: A Research node type MUST fan out multiple sub-agents and run them in parallel, collecting their outputs. It MUST track and expose **per-sub-agent status** (pending/running/completed/failed) so the in-flight straggler is identifiable (FR-036).
- **FR-023**: The app MUST ship a Workflow Manager skill that instructs the assistant to build, execute, and retrieve workflows (including historical-run inspection) via the workflow tools. The skill MUST recommend the native **research** output type as the default for "run N investigations in parallel and feed them to a synthesis step" (noting it sidesteps the file-tool handoff and is materially faster than serial delegate fan-out), MUST state realistic relative latency for delegate vs research steps, and MUST show how to use the dry-run/fixture mode (FR-037) to validate routing quickly.
- **FR-025**: In a workflow run view (live) and when a historical run is selected, clicking any node on the graph MUST open a trajectory panel docked to the **right** of the graph, with a **horizontally resizable** width via a draggable divider (the graph reflows to fill the remaining space). The panel MUST be dismissible and MUST re-open/update when another node is clicked.
- **FR-026**: The trajectory panel MUST show, for the selected node: its identity (name, agent source, output type); its current (live) or final (historical) status; the **ordered lifecycle events for that node** projected from the run's persisted event log (`step.start` / `step.retry` (with attempt number) / `step.running` / `step.complete` / `step.fail` (with error) / `step.cancel` / `step.skip`) with timestamps and durations; and the node's output/artifact (and, for a routing node, the candidate sub-agent it selected). A neutral/never-ran node MUST be shown as having no events. In addition to the lifecycle events and output, the panel MUST show the node's **agent execution trace** so the user can debug what the agent did: the **executed prompt/instructions** (the assembled task plus the upstream context fed into the node); the agent's **reasoning/thinking** (where the provider exposes it); each **tool call** — tool name, arguments, return value/result, and success/error status; and the agent's **response generation**. For a live run, the prompt, agent activity, and events MUST update in real time as the agent executes.
- **FR-027**: The app MUST NOT render a redundant per-step status list below the graph in the run view — per-step status is surfaced by the graph's node coloring plus the per-node trajectory panel (FR-025/FR-026).
- **FR-028**: The persisted run log MUST record agent-execution events in addition to step-level events — the executed prompt/instructions, the agent's reasoning/thinking (where exposed), each tool call (name, arguments, return value/result, and success/error status), and the response text — per node and per attempt, so a node's full agent activity is replayable for historical runs and streamable in real time for live runs.
- **FR-029**: A routing node's candidate selection MUST be captured as a structured, machine-readable signal — a `select_branch` tool call, or an equivalent structured output field naming the chosen candidate id(s) — that the engine reads deterministically. The engine MUST NOT parse free-form prose to guess a candidate. The signal MUST reference only candidate id(s) valid for that node.
- **FR-030**: If a routing node's agent produces no valid structured selection, the engine MUST retry (retry-loop, per FR-018); if it still cannot resolve a valid selection, the node MUST **fail** with a clear reason — the engine MUST NOT default to an arbitrary candidate or to a candidate different from the one the agent intended.
- **FR-031**: Selection propagation MUST follow this rule: a node that is declared a **candidate leaf** of a routing node is gated by that node's selection (it runs only if its routing node selected it; otherwise it is neutral/never-ran); **every other node is gated only by its own declared dependencies** and runs normally regardless of any unrelated selection. This MUST allow a shared (non-candidate) step to sit between a routing node and its leaves without blocking the downstream graph.
- **FR-032**: If a routing node selects a branch but the selected path results in **zero** executed leaves, the run MUST NOT report a plain `completed` — the engine MUST emit a `workflow.branch.skipped` event and set the run's final state to `completed_with_warnings` (or failed), so a silent no-op that skipped a terminal action is surfaced.
- **FR-033**: `workflow_validate` MUST check candidate topology: it MUST flag a candidate leaf that is unreachable from its routing node, and a node that is ambiguously both a shared dependency and a gated candidate leaf, as structural errors.
- **FR-034**: An ephemeral-agent node's declared tool list MUST be genuinely granted to the spawned agent — including deferred tools, which MUST be discoverable via `find_tools` — so that a node listing `file_read`/`file_write` (or any listed tool) actually has it. The spawned agent's effective tool set MUST match the declared allowlist (no silent drop or substitution).
- **FR-035**: Fan-out (research/delegate) step outputs MUST be consumable as first-class structured data by dependent steps, so a "parallel research → merge" handoff does not require file I/O; where an agent does use file tools, it MUST have them per FR-034.
- **FR-036**: `workflow_status` and `workflow_run_get` MUST return a populated live per-step map during a run — for each step, its status, attempt count, and a short current-action string while in progress (not an empty `steps: {}`); for a Research node, per-sub-agent status (pending/running/completed/failed). This live state MUST be the single source of truth also consumed by the app trajectory panel (FR-026).
- **FR-037**: `workflow_run` MUST support an opt-in dry-run/fixture mode that substitutes a canned output for designated nodes, skipping their real execution, so the DAG, branch routing, and leaf reachability can be validated without performing the real (slow) work. Default (non-dry-run) behavior is unchanged.
- **FR-038**: The engine MUST enforce a configurable **per-step** and **per-run** timeout (on the Workflow config, with sensible defaults) so a stuck agent fails fast: a step exceeding its timeout is marked failed with a timeout reason, and a run exceeding its timeout is halted — neither may hang indefinitely.
- **FR-039**: The workflow JSON schema MUST support an optional `triggers` field — an array of event type strings (dot-separated, matching the 034 pattern `^[a-z0-9]+(\.[a-z0-9_-]+)+$`). A workflow with an absent or empty `triggers` array is not event-triggered.
- **FR-040**: On service start and on any workflow create/modify/delete, the service MUST compute the union of all `triggers` event types across all workflows and (re-)declare headless handlers via `handler_declare` (034 ADR-3, over worker IPC) for each distinct event type. The service MUST NOT maintain a separate subscription store — the union is always re-derived from the current set of workflows.
- **FR-041**: When the 034 kernel dispatches an event whose type exactly matches a workflow's trigger (exact event-type match only — no payload filtering), the service MUST start a new fire-and-poll run (FR-008) for that workflow with trigger provenance: the triggering event's id and type, and a `startSource: "event"` marker in the run record.
- **FR-042**: The triggering event's payload MUST be injected into the run as an `eventContext` input field, made available to the workflow's first node(s) so the workflow can use the event data in its execution.
- **FR-043**: If a workflow triggered by an event is already running, the service MUST start a new, independent run — concurrent runs of the same workflow are valid (no coalesce, no queue).
- **FR-044**: The service MUST declare a `workflow_event_types` tool (via `tool_declare`) that returns the list of event types currently registered in the 034 event system, so the assistant can discover available event types when authoring a workflow's `triggers` array.
- **FR-045**: The `workflow_event_types` tool MUST return, per event type: the type string, the count of registered headless handlers for it, and a human-readable display name (where available from the handler registration). The tool MUST return an empty list (not an error) when no handlers are registered.
- **FR-046**: A new node output type `event` MUST be supported: when a node of this type executes, it emits an event to the 034 event system and completes. The node's config MUST specify: (a) the event type (dot-separated string), and (b) an optional payload — either a static JSON object, or a template string with `{{nodeId.field}}` placeholders resolved from upstream node outputs.
- **FR-047**: The event emitted by an `event` node MUST be sourced from the workflow service (`source.appId: "workflows"`), and MUST include the workflow id, run id, and node id in its payload for provenance.
- **FR-048**: `workflow_validate` MUST check: (a) that all `triggers` array entries are well-formed event type strings; (b) that all `event` node configs specify a valid event type under the workflow service's owned namespace (`com.bos.workflows.*`); and (c) that all `{{nodeId.field}}` template references in `event` node payloads refer to nodes that exist in the workflow graph.
- **FR-049**: The Workflow Manager app's workflow editor MUST allow the user to: (a) configure a workflow's `triggers` array (add/remove event type strings, with a "browse available types" action that calls `workflow_event_types`); and (b) author `event` nodes (event type field + payload template editor).
- **FR-050**: The Workflow Manager skill MUST document event-triggered workflows and emit-event nodes: how to use `workflow_event_types` to discover event types, how to set a workflow's `triggers` array, and how to configure an `event` node (type + payload template with `{{nodeId.field}}` placeholders).
- **FR-051**: The service MUST be able to subscribe to any event type via `handler_declare` without declaring `eventNamespaces` in its `service.json`. This depends on the 034 platform change (037-event-namespace-relaxation) which removes the namespace-ownership check on handler registration.
- **FR-052**: The app MUST present a workflow's historical runs as a table (one row per run) on the workflow detail view, sorted by datetime in descending order (most recent first). Each row MUST show at minimum the run's datetime, run id, and final state. This table is the primary historical-run surface — it supersedes the plain run selector of FR-017 as the listing, while the selected-run replay of FR-017 is retained.
- **FR-053**: Each run row MUST carry a checkbox to select/deselect that run (toggle), and the table header MUST carry a select-all checkbox that selects all rows when checked and deselects all when unchecked (toggle).
- **FR-054**: With one or more runs selected, a delete action MUST remove the selected runs' persisted run logs (+ per-step outcomes) from the real VFS, MUST leave the workflow definition unchanged, and MUST update the table (removed rows disappear). With no runs selected, delete MUST be a no-op (or disabled).
- **FR-055**: The service MUST declare a `workflow_run_delete` tool (via `tool_declare`) that deletes one or more runs by run id, removing their persisted run logs (+ per-step outcomes) from the real VFS and returning a result (deleted count and any per-run errors). The tool MUST be gated exactly like the other workflow tools (FR-010).

### Non-Functional Requirements

- **NFR-001**: A workflow tool invocation MUST return a result within 30 seconds by default (per 039 R10) without leaking pending waits or crashing BOS. **`workflow_run` is an exception — it is an asynchronous, fire-and-poll operation**: it MUST return a `runId` immediately (well within 30s) and MUST NOT block until the workflow completes; the caller MUST poll `workflow_status` (or `workflow_run_get`) for progress and final state. Long-running workflows therefore do not violate this timeout.
- **NFR-002**: Tool-execution errors inside the service MUST be reported to the assistant as tool errors without crashing BOS (per 039 FR-007).
- **NFR-003**: The service MUST bind a configurable port defaulting to `0` (OS-assigned, non-colliding) per marketplace service conventions.
- **NFR-004**: All storage reads/writes MUST go through the real-VFS loopback bridge; the service MUST NOT write to a host path under `dataDir()/system/` derived from its own config dir.
- **NFR-005**: No error path MAY be swallowed without logging; key events (tool_declare received, tool registered, tool_call dispatched/resolved, schema-rejected, timeout, worker-exit cleanup) MUST emit structured logs via the service's log channel.
- **NFR-006**: The dry-run/fixture mode (FR-037) MUST NOT invoke real sub-agents or the network for a fixture-designated node and MUST complete the evaluated path in a small fraction of the real run time, so it is usable for rapid iteration.
- **NFR-007**: Event-triggered runs MUST have the same fire-and-poll semantics as agent-initiated runs (FR-008) — the 034 handler ack is returned immediately upon starting the run, not upon its completion. A long-running workflow does not block the event from being marked `processed`.
- **NFR-008**: The `event` node's emit call MUST return within the 30s tool-invocation timeout (NFR-001) — the 034 kernel's emit is an O(1) shard append, not a handler-completion wait.
- **NFR-009**: The `workflow_event_types` tool MUST return its result within 30 seconds (NFR-001); it reads from the 034 handler registry (in-memory, no disk I/O on the hot path).

## Key Entities *(include if feature involves data)*

- **Workflow**: A user-authored multi-step graph — id, name, version, nodes, dependencies, config (max concurrency, default retry/timeout), and an optional `triggers` array (event type strings that start a run when emitted to the 034 event system; absent or empty = not event-triggered). Persisted as JSON at the real VFS `/Workflows/<id>-workflow.json`.
- **WorkflowTool**: A native tool the service declares via `tool_declare` — name, description, input JSON-schema, mapped into the `AssistantTool` registry.
- **ExecutionEvent / StepRuntimeState**: Streamed events and per-step runtime status during a workflow run, used for progress reporting and cancellation. `StepRuntimeState` includes the step's status, attempt count, a short **current-action** string while in progress, and — for a Research node — **per-sub-agent status** (pending/running/completed/failed). It is the single source of truth consumed by both the app trajectory panel and `workflow_status`/`workflow_run_get`.
- **Run**: A single execution of a workflow — id (`runId`), workflow id, start/end timestamp, final state (completed/failed/cancelled), per-step outcomes, and the persisted event log. Stored at the real VFS under `/Workflows/.runs/<workflowId>/<runId>.json` (or equivalent real-VFS run-log location), never a host path.
- **Node**: A workflow node with two orthogonal axes — (1) **agent source**: an existing statically-defined BOS agent, or an **Ephemeral agent** (task description + configurable tool list + configurable skill list, used when no existing agent matches the task); (2) **output type**: delegate (sub-agent output), tool (single tool call), research (parallel fan-out), ag-ui (A2UI/UI artifact), or **event** (emit a configurable 034 event and complete). A node MAY declare candidate sub-agents (its branch leaves) for dynamic routing, and MAY itself be a **candidate leaf** gated by another node's selection. Parallel execution is a scheduling property (independent ready branches run concurrently up to `maxConcurrentSteps`), orthogonal to both axes.
- **Selection**: The routing node's structured candidate selection — a first-class run-state token `selected[nodeId] = [candidateId, …]` captured from the node's `select_branch` signal / structured output (FR-029). It gates the routing node's candidate leaves (FR-031) and is recorded in the run log for replay.
- **EventTrigger**: A workflow's subscription to a 034 event type — the `triggers` array in the workflow JSON. The service derives the union of all trigger types across all workflows and declares headless handlers for each (FR-040). No separate subscription store; the triggers array in the workflow JSON is the single source of truth.
- **EmitEventNodeConfig**: The configuration for an `event` output-type node — the event type string (must be under `com.bos.workflows.*`), and a payload spec: either a static JSON object, or a template string with `{{nodeId.field}}` placeholders resolved from upstream node outputs at execution time (FR-046/FR-047).
- **Run provenance (extended)**: In addition to the existing run fields, an event-triggered run records `startSource: "event"`, `triggerEventId` (the 034 event's id), and `triggerEventType` (the event type string) — so a run's origin is auditable (FR-041).

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
- **SC-015**: Clicking a node in the live run view or a selected historical run opens the right-side, horizontally-resizable trajectory panel for that node; switching nodes updates the panel; the panel is dismissible; and the previously-redundant per-step status list is no longer rendered.
- **SC-016**: The trajectory panel's per-node lifecycle events match the run's persisted event log with 100% fidelity (event order, timestamps, durations, retry attempts, error text, final outcome, and output/artifact), and update live while a node is executing.
- **SC-017**: For any node whose agent executed, the trajectory panel reproduces that agent's activity with 100% fidelity from the persisted run log — the executed prompt, reasoning (where exposed), every tool call with its arguments, return value, and status, and the response — and reflects it live while the node is executing.
- **SC-018**: The recorded candidate selection exactly equals the routing node's structured selection signal (no prose inference, no wrong default); an invalid or missing selection is retried and then fails the node rather than defaulting.
- **SC-019**: A shared (non-candidate) step that depends on a routing node but is not one of its leaves runs normally regardless of the selection; the selected leaf runs and the unselected leaf is neutral — so a shared step between the branch point and the leaves does not block the downstream graph.
- **SC-020**: A run whose selected branch executes zero leaves emits a `workflow.branch.skipped` event and a non-plain-`completed` final state in 100% of such cases — there are no silent no-ops that skip a terminal action.
- **SC-021**: 100% of the tools declared on an ephemeral-agent node are available to the spawned agent (including deferred tools via `find_tools`); no declared tool is silently dropped or substituted.
- **SC-022**: During a long run, `workflow_status` returns a populated per-step map (status + attempt + current-action string) and per-sub-agent status for Research nodes, so progress and the straggler are observable without polling the filesystem.
- **SC-023**: Dry-run/fixture mode validates the DAG, branch routing, and leaf reachability in seconds (no real research performed), and a stuck step or run fails fast via the per-step/per-run timeout rather than hanging indefinitely.
- **SC-024**: A workflow with a `triggers` array containing a matching event type starts a new run within 5 seconds of the event being emitted to the 034 system — no manual intervention or agent call required.
- **SC-025**: `workflow_event_types` returns a list matching the registered handlers in the 034 event system with 100% accuracy (no missing types, no phantom types).
- **SC-026**: An `event` node emits exactly one 034 event per execution, with the correct type, source (`appId: "workflows"`), and payload (static or template-resolved), verifiable via `query_events`.
- **SC-027**: A workflow with event triggers is not triggered by events of a non-matching type — zero false-positive runs in 100% of non-matching event emissions.
- **SC-028**: Concurrent event-triggered runs of the same workflow execute independently — no coalesce, no queue, no run suppression.
- **SC-029**: A workflow's historical runs appear in the detail view as a datetime-sorted (descending) table with per-row checkboxes and a header select-all toggle, and bulk delete of the selected runs removes exactly those runs' logs from the real VFS without altering the workflow definition.
- **SC-030**: `workflow_run_delete` removes the requested runs' logs from the real VFS with 100% accuracy (only the named runs are removed) and returns a correct deleted count / error result.

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
- **A node's trajectory is a derived projection, not new storage**: it is the node-scoped, ordered slice of the run's persisted event log + per-step outcomes + outputs (per US6/FR-015/ADR-8 run persistence). It is available in the live run view (updating in real time) and in a selected historical run (replayed from the persisted log). The run log records agent-execution events (executed prompt, reasoning where exposed, per tool call name/args/result/status, and response text) in addition to step-level events (FR-028) — this is a richer event vocabulary, not a new store. The redundant per-step status list below the graph is removed in favor of the graph's node coloring + the on-demand trajectory panel (FR-027), which doubles as the per-node agent **debugging surface**.
- **Selection is a structured signal, not prose**: a routing node selects a candidate via a `select_branch` tool call or an equivalent structured output field (FR-029); the engine never parses free-form prose to infer a candidate, and never defaults to an arbitrary one (FR-030).
- **Routing model (user-approved Option A — general selection propagation)**: only nodes declared as a **candidate leaf** of a routing node are gated by that node's selection; every other node is gated only by its own declared dependencies (FR-031). This is what lets a shared step (e.g. a `render` that all branches need) sit between the branch point and the leaves without blocking the downstream graph. A selected path that executes zero leaves is a guarded, surfaced warning — never a silent `completed` (FR-032).
- **One live state, two consumers**: the run's live per-step state (status / attempt / current-action / per-sub-agent status) is produced once by the engine and consumed by both the app trajectory panel (FR-026) and the `workflow_status`/`workflow_run_get` tools (FR-036) — no divergence between what the UI shows and what the agent sees.
- **Research/delegate outputs are first-class structured data** consumable downstream (FR-035), so a "parallel research → merge" handoff does not require file I/O; file tools remain available to agents that declare them (FR-034).
- **Ephemeral tool-granting is implemented in the service's agent-spawn path** (FR-034/FR-035). If, at implement time, the root cause of a declared tool not resolving is in BOS ephemeral-agent tool resolution (platform) rather than the service's spawn config, that portion is escalated as a scoped `bos-core` fix — the service cannot grant a tool the platform will not resolve to the spawned agent. To be diagnosed by the Developer against code.
- **Dry-run/fixture mode and per-step/per-run timeouts are service-side engine features** (FR-037/FR-038): because the service owns the whole engine, it can short-circuit a designated node's execution to inject a canned output, and it enforces timeouts on its own scheduler. Neither requires a BOS-source change. The Workflow entity already carries a default retry/timeout config; the engine now enforces it.
- **034 event system is implemented and available**: spec 034 (event-notification-system) is converged and promoted. The workflow service uses its headless-handler channel (`handler_declare` over worker IPC, 034 ADR-3) to subscribe to trigger event types, and the loopback `POST /api/events` endpoint to emit events from `event` nodes. No BOS-source change is required.
- **No namespace restriction on subscription (platform change 037)**: the 034 namespace-ownership check on handler registration (034 FR-023, `ownsNamespace` in `src/lib/events/api.ts`) is removed as part of this feature's platform dependency (037-event-namespace-relaxation). Any component can subscribe to any event type — the single-container trust model makes per-namespace access control unnecessary. The service's `handler_declare` for any trigger type is accepted without a prior grant.
- **Emission namespace (workflow-item policy, not platform restriction)**: `event` nodes emit into the service's own namespace (`com.bos.workflows.*`) by default — this is a workflow-item provenance policy (the `source.appId: "workflows"` makes the origin clear in the Event Viewer), not a platform restriction. The 034 platform imposes no emission namespace check; the workflow item's `workflow_validate` enforces it for clarity (FR-048b).
- **`workflow_event_types` reads the 034 handler registry**: the tool calls `GET /api/events/handlers` via the loopback bridge. This endpoint returns the grouped handler registry (in-memory, O(1) read) — no disk I/O on the hot path. The tool extracts the distinct event types from the grouped result.
- **Event-triggered runs are fire-and-poll**: the 034 handler ack (returned to the kernel when the run is *started*, not when it completes) keeps the event's processing model intact — a long-running workflow does not hold the event in "processing" indefinitely (NFR-007). This is consistent with 034's design: handlers ack on completion of *their* work, and starting a run is the handler's work.
