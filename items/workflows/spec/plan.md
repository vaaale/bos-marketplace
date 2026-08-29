# Implementation Plan: Workflow Manager — Service-Owned Workflow Engine (Engine Pivot)

**Branch**: `bos/042-workflow-manager-service` (active) | **Date**: 2026-08-20 | **Spec**: `user-specs/workflow-manager/001-workflow-manager-service-tools/spec.md`

**Input**: Feature specification + `design.md` (REWRITTEN for the engine pivot — service-owned engine, verified by architect with source citations). This plan **references** `design.md` as the authoritative structural source; ADRs below are folded from `design.md` §6.

---

## Summary

The Workflow Manager is re-implemented as a **service-owned workflow engine**. The BOS-source engine (`src/lib/workflows/*` + `/api/workflows/*` routes) is **retired**, and the workflow engine is **fully re-implemented inside the Workflow Manager service** (a worker-thread `marketplace-item` service facet). The service owns the node model (agent source × output type), dynamic routing, parallel scheduling, persistence, and run state — exposing it to the assistant as **039-compliant service-declared native tools**, with the app facet as the graph UI.

The feature spans **two target shapes** (user-approved):

1. **`bos-core` retirement** — remove the old engine + routes + all dependents (ADR-7 expanded).
2. **`marketplace-item` re-implementation** — the item's service facet owns the new engine; app facet is the graph UI.

**Primary deliverables**:
- **Marketplace-item rewrite** — service facet (owns the engine, 12 tools) + app facet (graph UI, mockup-driven) + config + bundled skill.
- **Scoped `bos-core` retirement** — full retirement of `src/lib/workflows/*` + `/api/workflows/*` + `workflowTools()` + `WorkflowActions.tsx` + `CopilotProvider` + static `workflow_*` capabilities.

---

## Technical Context

**Language/Version**: Node.js worker-thread service (plain JS, unbundled — outside the `@/` graph); app facet TypeScript/TSX (React).

**Primary Dependencies**: BOS 039 service-tool contract (`serviceToolBridge`, `workerIpc`), loopback `/api/fs` (VFS bridge) + `/api/subagents/delegate` (node execution contract), `window.__bos` broker (app facet). No BOS-source imports from the worker.

**Storage**: Real VFS `/Workflows/` (workflow JSON) + `/Workflows/.runs/<workflowId>/<runId>.json` (run entities), reached exclusively via loopback `/api/fs` — never a host path under `dataDir()/system/` (ADR-2, NFR-004).

**Testing**: Unit tests for the service modules (engine/node-model, scheduler, router, validate, generate, store, executor, vfs, migration, runs, handlers, tools) + Playwright e2e for the app (list/detail/run views, historical-run replay, empty state, service-stopped banner). Per user instruction, tests (unit + e2e) are in scope.

**Target Platform**: BrowserOS marketplace item (app + service facets) + a scoped bos-core retirement.

**Project Type**: marketplace-item (app + service facets of one item) + bos-core retirement — dual scope by user approval.

**Performance Goals**: Every `tool_call` bounded well under the 30s kernel timeout (`TOOL_CALL_TIMEOUT_MS = 30_000`); `workflow_run` is **fire-and-poll** (returns `runId` in <1s; caller polls `workflow_status`/`workflow_run_get`) — ADR-8. Independent branches/Research fan-out run concurrently up to `maxConcurrentSteps`.

**Constraints**: Service worker cannot import BOS source; all storage via loopback `/api/fs`; node execution via loopback `/api/subagents/delegate` (ADR-1); cancellation via worker abort of the delegate fetch (Option (b), user-approved — no bos-core delegate-route change); origin resolved from `NEXT_PUBLIC_APP_ORIGIN`/`APP_ORIGIN` (no `BOS_PORT`) — ADR-6.

**Scale/Scope**: One marketplace item (12 tools, engine module tree, 3 app views) + retirement of the whole BOS workflow subsystem.

---

## Constitution Check

*GATE: Must pass before Phase 0 research. Re-check after design (done — design.md §2).*

| Principle | Compliance |
|---|---|
| **II. Server Authority & SSR Boundary** | Compiles. The service talks to BOS only over loopback HTTP (`/api/fs`, `/api/subagents/delegate`) + worker IPC. No direct Node/filesystem access to the VFS. Node execution runs on BOS's main thread via the loopback delegate route — the worker never imports `@/` code. |
| **IV. Minimize Blast Radius** | Compiles with a **scoped, user-approved exception**: the bos-core retirement touches `src/lib/workflows/*` (5 files) + `/api/workflows/*` (6 routes) + `src/lib/assistant/tools/server/workflows.ts` + `src/lib/assistant/registry.ts` + `src/components/agent/WorkflowActions.tsx` + `CopilotProvider.tsx` + `capabilities-registry.ts`. All on the active feature branch; the engine is *removed*, not rewritten in place. |
| **V. The VFS Is Not the Source** | Compiles — the core correctness fix. Workflows + run logs persist to real VFS via loopback `/api/fs`; never a host path. |
| **VI. Specs & Docs Stay in Sync** | Compiles. `docs/dev/architecture-overview.md` §14 documents the workflows subsystem and must be updated to reflect the retirement (flagged for implement). `services.md` §15 already documents the `deploymentMode: "tools"` contract. |
| **VII. Respect Boundaries** | Compiles. Item files stay under `data/user-apps/items/workflows/`; the bos-core retirement is scoped and feature-branch-isolated. |

No complexity-tracking violations. The bos-core retirement is the deliberate, user-approved exception (recorded in spec.md Assumptions + design.md §2).

---

## Project Structure

### Documentation (this feature)

```text
specs/user-specs/workflow-manager/001-workflow-manager-service-tools/
├── spec.md               # feature spec (engine pivot, US1..US9, FR-001..024, NFR-001..005, SC-001..014)
├── design.md             # structural design — service-owned engine (architect, source-verified)
├── mockup.html           # UI mockup — binding UI contract (list/detail/run + history replay)
└── plan.md               # this file
```

### Source Code — marketplace item (item root `data/user-apps/items/workflows/`)

```text
workflows/                                  # item root
├── services/
│   ├── service.json                        # REWRITE — deploymentMode:"tools", entry index.js, configSchema (port default 0)
│   ├── index.js                            # REWRITE — worker entry: lifecycle + tool_declare + IPC + migration
│   ├── tools.js                            # NEW — 12 tool declarations + JSON schemas (FR-002/016/024)
│   ├── handlers.js                         # NEW — tool handlers for the 12 tools
│   ├── engine/
│   │   ├── node-model.js                   # NEW — orthogonal node axes: agent source × output type
│   │   ├── scheduler.js                    # NEW — DAG scheduler: ready-set, maxConcurrentSteps, research fan-out
│   │   ├── router.js                       # NEW — dynamic routing: candidate selection + retry-loop (US7)
│   │   ├── validate.js                     # NEW — DAG acyclicity + node schema validation (re-implemented)
│   │   ├── generate.js                     # NEW — workflow generation from a task description (re-implemented)
│   │   ├── store.js                        # NEW — workflow + run CRUD over loopback /api/fs (re-implemented)
│   │   └── executor.js                     # NEW — execution contract: loopback /api/subagents/delegate per node (ADR-1)
│   ├── vfs.js                              # NEW — loopback /api/fs bridge helpers (ADR-2)
│   ├── migration.js                        # NEW — additive legacy-workflow migration (ADR-5)
│   └── runs.js                             # NEW — run entity persistence + workflow_run_list/run_get (US6)
├── app/
│   └── src/main.tsx (+ components/CSS)     # REWRITE — graph UI: list/detail/run + historical-run replay (mockup-driven)
├── config/
│   └── workflows.json                      # REWRITE — { port: 0, host: "127.0.0.1" }
└── skills/
    └── workflow-manager/SKILL.md           # NEW — item-bundled skill (US9/FR-023)
```

### Source Code — bos-core retirement (feature branch)

```text
src/lib/workflows/types.ts                  # RETIRE (delete)
src/lib/workflows/runner.ts                 # RETIRE (delete)
src/lib/workflows/store.ts                  # RETIRE (delete)
src/lib/workflows/validate.ts               # RETIRE (delete)
src/lib/workflows/generate.ts               # RETIRE (delete)
src/app/api/workflows/route.ts              # RETIRE (delete)
src/app/api/workflows/run/route.ts          # RETIRE (delete)
src/app/api/workflows/status/route.ts       # RETIRE (delete)
src/app/api/workflows/cancel/route.ts       # RETIRE (delete)
src/app/api/workflows/generate/route.ts     # RETIRE (delete)
src/app/api/workflows/validate/route.ts     # RETIRE (delete)
src/lib/assistant/tools/server/workflows.ts # RETIRE (delete) — workflowTools() shadows service tools
src/lib/assistant/registry.ts               # MODIFY — remove workflowTools import + spread
src/components/agent/WorkflowActions.tsx    # RETIRE (delete) — dead once routes are gone
src/components/agent/CopilotProvider.tsx    # MODIFY — remove <WorkflowActions/> import + usage
src/lib/agent/capabilities-registry.ts      # MODIFY — remove 7 static workflow_* capability entries
docs/dev/architecture-overview.md           # MODIFY — §14 workflows subsystem retirement note
```

### Test structure (per user instruction: unit + e2e in scope)

```text
# unit — service modules
<item>/services/__tests__/node-model.test.js
<item>/services/__tests__/scheduler.test.js
<item>/services/__tests__/router.test.js
<item>/services/__tests__/validate.test.js
<item>/services/__tests__/generate.test.js
<item>/services/__tests__/store.test.js
<item>/services/__tests__/executor.test.js
<item>/services/__tests__/vfs.test.js
<item>/services/__tests__/migration.test.js
<item>/services/__tests__/runs.test.js
<item>/services/__tests__/handlers.test.js
<item>/services/__tests__/tools.test.js

# e2e — app views (Build Studio e2e/<feature-id>.spec.ts)
specs/user-specs/workflow-manager/001-workflow-manager-service-tools/e2e/001-workflow-manager-service-tools.spec.ts
```

**Structure Decision**: Item layout mirrors the marketplace-item target shape (`target-marketplace-item.md` — app/ + services/ + config/ + skills/); the bos-core retirement is a scoped, feature-branch deletion of the whole workflow subsystem. Two shapes, two delegation mechanisms, never conflated.

---

## Design Notes (folded from design.md)

### Classification
`marketplace-item` + `bos-core` — deliberate dual scope (design.md §2.1). The item rewrite lives under `data/user-apps/items/workflows/` (app + service facets of ONE item); the bos-core retirement removes the old engine on the active feature branch. Two target shapes, two delegation mechanisms.

### Key ADRs (authoritative detail in design.md §6)
- **ADR-1 (REVERSED → service-owned engine)**: Node execution = loopback `POST /api/subagents/delegate` per node (existing route, NDJSON, ephemeral/named agent support). The worker owns the model/scheduler/routing/persistence; each node's "work" is one loopback delegate call. Alternatives rejected with source reasons (worker-IPC needs new bos-core plumbing; new route recreates the retired surface; in-worker execution is impossible). **Cancellation = Option (b), user-approved**: worker aborts its delegate fetch; inner-loop linked-abort settles `cancelled`; no bos-core delegate-route change.
- **ADR-2 (kept)**: Persist workflows + runs to real VFS via loopback `/api/fs`, never a host path.
- **ADR-3 (kept)**: Service binds a real port defaulting to `0` (OS-assigned) — no EADDRINUSE.
- **ADR-4 (REVERSED)**: No loopback `/api/workflows/*`; validation/generation re-implemented in the worker; node execution via the delegate route.
- **ADR-5 (kept)**: Additive, idempotent migration — copy + archive, never delete.
- **ADR-6 (kept)**: Resolve BOS's HTTP origin from `NEXT_PUBLIC_APP_ORIGIN`/`APP_ORIGIN` (no `BOS_PORT` exists).
- **ADR-7 (SUBSUMED → expanded)**: Full bos-core retirement — `src/lib/workflows/*` + `/api/workflows/*` + `workflowTools()` + dependents, not just the tool module.
- **ADR-8 (kept)**: `workflow_run` is fire-and-poll (returns `runId` immediately; caller polls).
- **ADR-9 (NEW)**: Runs are first-class persisted entities (runId, timestamps, final state, per-step outcomes, event log) at `/Workflows/.runs/<workflowId>/<runId>.json`.

### Node model (design.md §3.4.2) — two orthogonal axes
- **Agent source** (who executes): static BOS agent (`{kind:"static", agentId}`) | ephemeral (`{kind:"ephemeral", task, tools?, skills?}`).
- **Output type** (what it produces): `delegate` | `tool` | `research` | `ag-ui` — combines freely with agent source.
- Dynamic routing: optional `candidateAgents[]`; router.js selects appropriate candidate(s) as last action with retry-loop (US7/FR-018).

### Tool surface (design.md §3.4.3) — 12 tools (FR-002/014/016/024)
`workflow_list` (live status + run_id, FR-024), `create`, `read`, `modify`, `run` (fire-and-poll, ADR-8), `status`, `cancel`, `delete`, `export`, `validate`, `run_list`, `run_get`.

### Open items carried into tasks (design.md §7)
- **#2 Generation requires an LLM call** — `engine/generate.js` needs an LLM; reach via the delegate route (ephemeral planner) OR the workflow-builder agent constructs workflows directly via `workflow_create`. Confirm which path `workflow_create` takes.
- **#3 Skill scope for ephemeral nodes** — the delegate route builds the skills index from the parent context; verify per-node skill scoping, else fold skills into task text.
- **#4 Five net-new tools** (list/read/delete/run_list/run_get) — confirm exact names/schemas.
- **#5 App capability grants** — `services:read` (+`fs:read`) granted post-install in Settings → Apps.
- **#6 Docs drift** — `architecture-overview.md` §14 update in the bos-core change.
- **#7 Feature branch** — bos-core retirement on the active branch; item via separate `app_build`.

---

## Optional companions

`research.md` / `data-model.md` / `contracts/` / `quickstart.md` are **not** separately warranted here — `design.md` already resolves the technical unknowns (execution contract, origin resolution, NDJSON contract, cancellation semantics, tool surface, node model). The data model is defined in spec Key Entities + design.md §3.4. The tool declarations in `tools.js` (names/schemas) serve as the interface contract and live in design.md §3.4.3.

---

## Completion Summary (plan step)

- Branch: `bos/042-workflow-manager-service` (active feature branch for the bos-core retirement); the marketplace item uses `app_build` (no branch needed).
- plan.md rewritten at `specs/user-specs/workflow-manager/001-workflow-manager-service-tools/plan.md` to reflect the engine pivot.
- No extension hooks present.
- Next step: `tasks` (break the dual-scope plan into dependency-ordered tasks, with unit + e2e tests in scope).

---

# §9 Scope-add (US10–US15) — Plan

**Date**: 2026-08-29 | **Active branch**: `bos/001-workflow-manager-service` | **Design**: `design.md` §9

## Scope-add Summary

This scope-add to the installed `workflows` item adds **six** capabilities on top of the already-implemented base engine:

1. **US10 (extended) — Node trajectory panel** (app facet, mockup is binding contract): the right-side resizable panel becomes a **per-node agent-debug surface** — executed prompt, reasoning, every tool call (name/args/result/status), per-sub-agent fan-out status, current-action string, agent response, lifecycle events, output/artifact. Live (streaming) and historical (replayed from run log). The redundant per-step status list is removed (FR-027).

2. **US11 — Branch routing correct, structured, and safe** (service facet, P1): structured `select_branch` signal (never prose-inferred); Option A selection propagation (only declared candidate leaves are gated by selection; all other nodes route by their own dependencies); zero-executed-leaves guard (`workflow.branch.skipped` + non-plain-`completed`); `workflow_validate` candidate-topology checks.

3. **US12 — Ephemeral agents actually get their declared tools** (P1): **item side** — `executor.js` forwards `tools` + `deferredTools` + skills to the delegate route. **bos-core patch** (ADR-12, scoped to `runner.ts` `runLocalHeadless` + `discovery.ts` + delegate `onEvent`): the headless path honors the declared allowlist for frontend-execution tools (via a server-side VFS bridge) and `find_tools` gates from the in-memory ephemeral agent object (returns declared deferred tools, not `[]`).

4. **US13 — Live run progress observable** (service facet, P1): `workflow_status`/`workflow_run_get` return a populated per-step map (status + attempt count + current-action string + per-sub-agent status for research nodes). Same live state consumed by the app trajectory panel (single source of truth, ADR-13). The worker exposes `GET /run/<runId>` (+`?since=`) on its already-bound port (ADR-11); the app reads it via `window.__bos` + `services:read`.

5. **US14 — Dry-run/fixture mode** (service facet, P2): `workflow_run` gains an opt-in `dryRun`/`fixtures` input; designated nodes' real execution is skipped and a canned output is injected (scheduler short-circuit, ADR-14 — no `src/` change). Validates DAG, routing, leaf reachability in seconds.

6. **US15 — Per-step + per-run timeout + latency docs** (service facet, P2): engine enforces configurable timeouts (step → failed with timeout reason; run → failed/timed-out + halted). Skill/docs state realistic relative latency (research ≫ faster than serial delegate fan-out) and recommend research for parallel investigations.

## Technical Context (delta)

**Language/Version**: Same — plain Node.js (service facet), TypeScript/TSX (app facet).

**New dependencies**: None. The scope-add uses the same BOS primitives as the base (loopback `/api/fs`, `/api/subagents/delegate`, worker IPC, `window.__bos` broker).

**New storage**: None. The run-log file (`/Workflows/.runs/<workflowId>/<runId>.json`) is the same file, enriched with an `agent.*` event vocabulary and a `StepRuntimeState` structure (ADR-13, FR-028). No new store.

**New testing**:
- Unit: `engine/run-state.js`, `engine/router.js` (Option A gating + guard), `engine/scheduler.js` (timeout + dry-run short-circuit), `engine/validate.js` (candidate-topology errors), `engine/executor.js` (agent-event emission + tool/deferredTools forwarding), `handlers.js` (populated `workflow_status` output, `workflow_run` dry-run wiring), `runs.js` (extended run-log persistence).
- E2e: Run view trajectory panel (node identity, prompt, reasoning, tool calls, sub-agent fan-out, lifecycle events, output), resize handle interaction, History view trajectory panel, `completed_with_warnings` status chip.
- Bos-core patch: unit test that named-agent `find_tools` is byte-identical (regression guard); unit test that an ephemeral agent's `find_tools` returns its declared deferred tools.

## Constitution Check (delta)

Re-verified per `design.md` §9.2 — all principles comply. The only new `src/` surface is the scoped `runner.ts`/`discovery.ts`/delegate-`onEvent` patch (ADR-12 + ADR-13 stream enrichment) — two functions + an event-vocabulary add, feature-branch-isolated, blast-radius-mitigated (scope to ephemeral-agent branch only; named-agent behavior unchanged).

| Principle | Compliance |
|---|---|
| **II. Server Authority & SSR Boundary** | Complies. Live-state SOT lives in the worker; app reads it over `window.__bos` + `services:read`. No new bos-core API surface except the scoped `runner.ts`/`discovery.ts` patch. |
| **IV. Minimize Blast Radius** | Complies. The new `src/` delta is two small, localized functions + a delegate-`onEvent` vocabulary add. No new subsystem, no new registry entry, no new route. |
| **V. The VFS Is Not the Source** | Complies. Extended run log persists to the same real-VFS location. |
| **VI. Specs & Docs Stay in Sync** | Complies. `docs/dev/` note for the headless ephemeral tool-granting behavior + enriched delegate stream. |
| **VII. Respect Boundaries** | Complies. Item files under `data/user-apps/items/workflows/`; the one `src/` change is a scoped platform fix justified by source (ADR-12). |

No complexity-tracking violations.

## Project Structure (delta)

### Item — service facet (new/modified)

```text
services/
├── engine/
│   ├── run-state.js                    # NEW — RunState/StepRuntimeState SOT + event log + live-read + subscribe(since) tail (ADR-13, US13)
│   ├── router.js                       # MODIFY — structured select_branch read; Option A gating; retry-then-fail (US11, FR-029/030/031)
│   ├── scheduler.js                    # MODIFY — Option A ready-set; per-step + per-run timeout; dry-run fixture short-circuit (US11/US14/US15, FR-031/037/038)
│   ├── validate.js                     # MODIFY — candidate-topology structural errors (FR-033)
│   └── executor.js                     # MODIFY — emit agent.* events; forward tools + deferredTools + skills; consume enriched delegate stream (US10/US12, FR-028/034)
├── tools.js                            # MODIFY — dryRun/fixtures on workflow_run; per-step + per-sub-agent on workflow_status/workflow_run_get; select_branch into routing-node specs (FR-036/037)
├── handlers.js                         # MODIFY — workflow_status/workflow_run_get return populated live per-step map; workflow_validate returns topology errors; workflow_run wires dry-run (FR-033/036/037)
└── runs.js                             # MODIFY — persist extended run log (agent.* events) — same file, richer schema (FR-028)
```

### Item — app facet (new/modified)

```text
app/src/
├── components/
│   ├── TrajectoryPanel.tsx             # NEW — right-side resizable panel: node identity, executed prompt, reasoning, tool calls, sub-agent fan-out, current-action, response, lifecycle events, output (mockup is binding contract, FR-025/026)
│   ├── GraphView.tsx                   # MODIFY — add node click handler; selection ring; remove per-step status list (FR-027)
│   └── RunView.tsx / HistoryView.tsx   # MODIFY — add TrajectoryPanel; resizable divider (pointer drag, 260–680px); wire live state via window.__bos → service GET /run/<runId>?since= (ADR-11); historical replay from workflow_run_get
└── ...
```

### Item — skill + docs

```text
skills/workflow-manager/SKILL.md        # MODIFY — research-as-default-for-parallel-investigation guidance; dry-run usage; latency expectations (US15, FR-023 extended)
docs/usage.md                           # MODIFY — latency docs; dry-run examples (US15)
```

### Bos-core patch (feature branch `bos/001-workflow-manager-service`)

```text
src/lib/agent/subagents/runner.ts       # MODIFY — runLocalHeadless: build ephemeral gate from in-memory agent object (not getAgent); honor declared deferredTools; route frontend-execution tools through server-side VFS bridge (ADR-12)
src/lib/assistant/tools/server/discovery.ts  # MODIFY — find_tools/find_agent: resolve ephemeral agent's gate from in-run agent (returns declared deferred tools, not []) (ADR-12)
src/app/api/subagents/delegate/route.ts # MODIFY — onEvent: add tool_result (name+result+ok), reasoning_delta, final-text emission (ADR-13 stream enrichment, US10 fidelity)
docs/dev/...                            # MODIFY — note headless ephemeral tool-granting behavior + enriched delegate stream
```

## Design Notes (folded from design.md §9)

### ADRs (authoritative detail in design.md §9.7)

- **ADR-10 — Option A selection propagation** (over direct-parent rule): a node is gated by a selection only if it is declared a candidate leaf of a routing node; otherwise it routes by its own dependencies. The shared-step case (`render`) works by construction. Makes the zero-leaf guard (FR-032) well-defined and `workflow_validate`'s topology check (FR-033) decidable.
- **ADR-11 — App reads live state from the service's own HTTP server via the broker**: the worker exposes `GET /run/<runId>` (+`?since=`) on its already-bound port (ADR-3); the app reaches it via `window.__bos` + `services:read`. One source, two consumers, no divergence. Degrades to polling `workflow_status` if the grant is missing.
- **ADR-12 — Ephemeral-agent tool fidelity is a platform concern** (verified against `runner.ts`, `discovery.ts`, `frontend-declarations.ts`): the headless path drops frontend-execution tools and `find_tools` returns `[]` for ephemeral agents. Fix scoped to `runLocalHeadless` + `discovery.ts`/delegate route. The declared tool list must mean what it says (FR-034/SC-021). This is the only new `src/` surface in the scope.
- **ADR-13 — Live state and the run log are one append-only stream**: the event log (step + `agent.*` + `workflow.branch.skipped`) is appended once with monotonic seq. `workflow_status`/`workflow_run_get` and the trajectory panel both project per-step state from it. Live = tail; historical = replay. No second store. No divergence.
- **ADR-14 — Dry-run fixtures short-circuit in the scheduler**: when `dryRun` + a fixture is present for a node, the executor never calls the delegate; the canned output is injected directly. No `src/` change. The `select_branch` signal can itself be fixture-able.

### New event vocabulary (FR-028, ADR-13)

The existing run-log event vocabulary is extended in the same file with per-node/per-attempt:

```text
agent.prompt          { node, attempt, prompt }
agent.reasoning       { node, attempt, text }            // where the provider exposes it
agent.tool_call       { node, attempt, seq, name, args, inflight:true }
agent.tool_result     { node, attempt, callId, result, status: ok|error }
agent.select_branch   { node, attempt, selected:[candidateId] }
agent.response        { node, attempt, text }
workflow.branch.skipped { runId, nodeId, selected, executedLeaves:0 }
```

The trajectory panel is a node-scoped projection of this single log (design.md §9.9 maps each mockup section to its event/state source).

### RunState / StepRuntimeState (ADR-13, US13)

```text
RunState { runId, workflowId, status, finalState?, startedAt, endedAt?,
           selected: Map<nodeId, candidateId[]>,   // US11 selection tokens
           steps: Map<nodeId, StepRuntimeState> }
StepRuntimeState { status, attempt, maxAttempts,
                   currentAction?,                  // short, e.g. "streaming rows 4–8k…"
                   subAgents?: Map<subAgentId, {label,status,action}>,  // research fan-out (FR-036)
                   outputs?: structuredData }        // first-class handoff (FR-035)
```

### Delegation split

| Target | Mechanism | Branch |
|---|---|---|
| **Item work** (service facet US10–US15 + app facet US10 + skill/docs) | `agent_delegate` (`contentOnly:true`) → `app_build` | none (item store) |
| **Bos-core patch** (ADR-12: `runner.ts` + `discovery.ts` + delegate `onEvent`) | `dev_delegate` | `bos/001-workflow-manager-service` (active) |

The bos-core patch is **prerequisite** for US12 (the item's `executor.js` must forward `tools` + `deferredTools` to a delegate route that actually honors them) — but the two can be built in any order as long as the patch is promoted before the item is re-installed.

## Open items carried into tasks (design.md §9.8 + base §7)

1. **US12 blast radius (highest)** — scope `runner.ts`/`discovery.ts` edits to the ephemeral-agent branch; keep named-agent behavior byte-identical; unit-test that a named agent's `find_tools` is unchanged.
2. **US10 stream fidelity vs. provider support** — reasoning is provider-dependent; confirm the agent loop already computes per-call `ok`/error for server tools so the `tool_result` enrichment is a forward, not a re-implementation.
3. **US11 `completed_with_warnings` state** — confirm the app's status-pill set gains a 5th chip (`completed_with_warnings`) and that `workflow_status` surfaces the `workflow.branch.skipped` event in its log.
4. **US13 app reachability** — `services:read` grant required in Settings → Apps; decide whether to also poll as a fallback.
5. **US14 fixture + live-state interaction** — a fixture-designated node must emit a plausible `StepRuntimeState` through the same event-append path as real execution (ADR-13) so replay is indistinguishable.
6. **Base open items #2/#3/#4/#5/#6/#7** — carried unchanged (generation LLM path, skill scope for ephemeral nodes, five net-new tool names/schemas, app capability grants, docs drift, feature branch).
