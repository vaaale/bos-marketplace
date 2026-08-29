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
