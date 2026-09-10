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

# Scope-Add 002 — Event-System Integration: Implementation Plan (US16–US18, FR-039–FR-051)

**Branch**: `bos/002-workflow-event-integration` (shared feature branch — see ADR-13) | **Date**: 2026-09-02 | **Spec**: `item-workflows/spec.md` (US16–18) + platform dependency `user-specs/core-platform/037-event-namespace-relaxation/spec.md`

**Input**: Feature specification (scope-add US16–18) + `design.md` §9–19 (architect, source-verified). This section is an **addendum** to the 001 engine-pivot plan above; it does not re-plan the converged 001 work. The authoritative structural source for this scope-add is `design.md` §9–19.

> **Path-correction note (from review)**: `design.md` §14 listed `engine/store.js` as the home for run-record provenance persistence. In the *built* item, run-state lives in `engine/run-state.js` (separate from `engine/store.js`, which is the VFS-backed workflow/run persistence), and the loopback HTTP helpers live in `services/http-bridge.js` (not a hypothetical `vfs.js`). `tasks.md` must reference the **built** module names (`run-state.js`, `http-bridge.js`) for these two edits.

## Summary

Makes the Workflow Manager a **first-class participant in the 034 event system** in three directions: **inbound** (event-triggered runs — US16), **discovery** (`workflow_event_types` tool — US17), and **outbound** (a new `event` node output type — US18). The scope-add is **primarily `marketplace-item`** (extends the installed `workflows` item's service + app facets in place) with **one small `bos-core` platform dependency** (037: remove the 034 namespace-ownership gate on handler registration, per the user's decision that any component may listen to any event).

**Primary deliverables**:
- **`bos-core` (037)** — delete the `ownsNamespace` rejection in `src/lib/events/api.ts` `register()`; flip the one 034 test that asserts `namespace-not-owned`; keep the ack-ownership test.
- **`marketplace-item` (scope-add)** — new `services/events.js` (trigger union + subscribe/unsubscribe + `event_dispatch` handler + loopback emit/ack), the `event` node output type (node-model/executor/validate), the `workflow_event_types` tool (tools/handlers), run-record provenance fields (run-state), and the app UI (Triggers tab + event-node config form, FR-049) + skill + docs (FR-050/VI).

## Technical Context (delta)

**Language/Version**: Same as 001 — Node.js worker-thread service (plain JS, unbundled); app facet TypeScript/TSX (React). 037 is a TypeScript edit in BOS source.

**Primary Dependencies (delta)**: The **034 event system** (already implemented) — `handler_declare`/`event_dispatch` over worker IPC, loopback `POST /api/events` (emit), `GET /api/events/handlers` (registry read), `POST /api/events/:id/ack`, `POST /api/events/unregister`. No new dependency; no BOS-source import from the worker.

**Storage (delta)**: `triggers` live **inside** the existing real-VFS workflow JSON (`/Workflows/<id>-workflow.json`) — no new store (design §13.1). Run-record provenance fields (`startSource`, `triggerEventId`, `triggerEventType`, `eventContext`) extend the existing run entity at `/Workflows/.runs/<workflowId>/<runId>.json` (design §13.2/ADR-10).

**Testing (delta)**: Unit tests for the new/modified service modules (`events`, `node-model` event branch, `executor` event branch, `validate` FR-048, `handlers` event_types, `run-state` provenance) + 037's flipped namespace test. Playwright e2e for the US16 trigger round-trip, US17 discovery, US18 emit node, and the FR-049 UI surfaces.

**Performance Goals (delta)**: `workflow_event_types` reads the in-memory handler registry (NFR-009, no disk I/O). The `event` node is a single O(1) loopback emit (NFR-008). US16's dispatch→run-start is synchronous fire-and-poll (SC-024, <5s from emit).

**Constraints (delta)**: The worker reaches the 034 system **only** over worker IPC + loopback HTTP — never imports `src/lib/events/*`. **US16's non-owned subscription is gated on 037 being active** (ADR-13); US17/US18 are independent of 037.

## Constitution Check (delta)

| Principle | Compliance |
|---|---|
| **II. Server Authority & SSR Boundary** | Complies. Worker reaches 034 only over IPC + loopback; acks by identity (`callerId: "workflows"` == `ownerId`), validated by the **unchanged** ack-ownership check. No minted credential scheme (design §10, §18.6). |
| **IV. Minimize Blast Radius** | Complies. The only bos-core edit is 037's single rejection-path removal (+ optional dead-code cleanup) + its one flipped test. The item change is additive inside implemented facets. |
| **V. The VFS Is Not the Source** | Complies. `triggers` + provenance live in real-VFS workflow/run JSON; no new location. |
| **VI. Specs & Docs Stay in Sync** | Complies. 037 supersedes 034 FR-023 (recorded in 037 spec + this plan). The item's `docs/dev/Workflows/*` + `docs/usage/Workflows/*` + skill must document the integration (FR-050, flagged for implement). |
| **VII. Respect Boundaries** | Complies. Item files under `data/user-apps/items/workflows/`; 037 feature-branch-isolated. |

**037's security posture** (design §10): 037 removes a *collision-guard* (per 034's own "same-container integrity check, not a network security boundary" framing), **not** a security boundary. The ack-ownership integrity check is explicitly preserved (037 FR-002). No complexity-tracking violation.

## Project Structure (delta)

### 037 — bos-core (feature branch `bos/002-workflow-event-integration`)

```text
src/lib/events/api.ts          # MODIFY — delete the ownsNamespace rejection block in register() (037 FR-001)
                               #         (optionally remove resolveGrantedNamespaces — 037 FR-005)
src/lib/events/types.ts        # OPTIONAL — ownsNamespace may stay (037 FR-006); "namespace-not-owned"
                               #         error code MUST stay in the table, no longer thrown (037 FR-004)
tests/events/*.test.ts         # MODIFY — flip the namespace-rejection case to expect success (037 SC-004);
                               #         KEEP the ack-forbidden case unchanged (037 SC-003)
e2e/034-event-notification-system.spec.ts   # MODIFY — if it asserts namespace-not-owned, flip to success
```

### Item — scope-add (item root `data/user-apps/items/workflows/`, built module names)

```text
services/events.js             # NEW — deriveTriggerUnion, reconcileSubscriptions (start+CRUD),
                               #       event_dispatch handler (fire-and-poll + loopback ack),
                               #       loopback emit/ack/getHandlers/unregister helpers
services/index.js              # MODIFY — on initialized: events.reconcileSubscriptions();
                               #       switch: case "event_dispatch" → events.handleEventDispatch
services/tools.js              # MODIFY — add 13th tool workflow_event_types (empty-input schema)
services/handlers.js           # MODIFY — workflow_event_types handler; reconcileSubscriptions() after
                               #       workflow_create/modify/delete VFS writes
services/engine/node-model.js  # MODIFY — add "event" to outputType union; EmitEventNodeConfig shape
services/engine/executor.js    # MODIFY — event-output branch: resolveTemplate + loopback POST /api/events
services/engine/validate.js    # MODIFY — FR-048: triggers[] shape; event eventType under com.bos.workflows.*;
                               #         {{nodeId.field}} refs exist in graph
services/engine/run-state.js   # MODIFY — persist + surface run provenance fields (startSource,
                               #       triggerEventId, triggerEventType, eventContext); root-node input
                               #       assembly appends eventContext on event-triggered runs (ADR-10)
services/http-bridge.js        # REUSE — existing loopback origin + fetch helpers (emit/ack/handlers/unregister)
app/src/main.tsx (+ components)# MODIFY — FR-049: Triggers tab (chips + free-text/browse-add); event-node
                               #       config form (type field + static-JSON/template payload editor); run
                               #       provenance block in trajectory panel (startSource/triggerEvent*)
skills/workflow-manager/SKILL.md  # MODIFY — FR-050: document event triggers, event_types, event nodes, cycle warning
docs/dev/Workflows/*.md        # MODIFY — 034 integration (subscription, eventContext, event node, wire shapes)
docs/usage/Workflows/*.md      # MODIFY — end-user "trigger a workflow by an event" page
e2e/002-workflow-event-integration.spec.ts   # NEW — US16/17/18 + FR-049 UI e2e
```

**Structure Decision**: Two delegation mechanisms, never conflated (ADR-13 / design §9). **037** = a scoped `dev_delegate` on the shared feature branch (bos-core). **Item scope-add** = `agent_delegate` (`contentOnly: true`) to author the modules into the staging dir, then `app_build` (with the existing item id, to *update* not duplicate). Both promote as one unit on `bos/002-workflow-event-integration`.

## Build order & phases (the plan's core artifact)

Derived from ADR-13 — **037 lands first**; US17/US18 are independent of 037 and may build in parallel; US16's non-owned-subscription assertion is gated on 037 being active.

| Phase | Scope | Delegation | Depends on | Note |
|---|---|---|---|---|
| **P1 — 037 platform** | Delete `ownsNamespace` gate + flip its test; keep ack test | `dev_delegate` (bos-core, branch active) | — | Small, self-contained. Verify no *other* 034 test depends on the gate before merge (design §18.5). |
| **P2 — Item: event node + discovery (037-independent)** | `node-model`/`executor`/`validate` event branch; `workflow_event_types` tool (tools/handlers); loopback emit + getHandlers helpers in `events.js` | `agent_delegate` (contentOnly) → `app_build` | — | US17 + US18 are fully buildable/testable **without** 037 (emit has no platform gate — ADR-13). |
| **P3 — Item: event triggers (US16)** | `events.js` trigger union + `reconcileSubscriptions` + `event_dispatch` handler + ack; `index.js`/`handlers.js` wiring; `run-state` provenance + eventContext injection | `agent_delegate` (contentOnly) → `app_build` | **P1 (037 active)** | The non-owned-subscription e2e asserts `namespace-not-owned` is **absent** — only passes once 037 is in place. Building this before P1 would surface that expected failure (correct signal, not a bug). |
| **P4 — Item UI (FR-049)** | Triggers tab + event-node config form + run provenance block | `agent_delegate` (contentOnly) → `app_build` | P2, P3 (UI surfaces their backing tools/behaviors) | Mockup-baseline; matches existing dark theme. |
| **P5 — Docs + skill (FR-050, VI)** | `SKILL.md` + `docs/dev/Workflows/*` + `docs/usage/Workflows/*` | `agent_delegate` (contentOnly) → `app_build` | P2–P4 | Item docs live in the item's own `docs/` (surfaced by the Docs app overlay). |
| **P6 — Converge + tests** | `buildstudio_run_tests` on `item-workflows`; analyze + converge vs. spec | orchestrator | P1–P5 | Includes the 034 e2e re-run (037 flipped its test) + the new `002-*.spec.ts`. |

**Promotion**: P1 (bos-core) and P2–P5 (item) live on the one branch / one `app_build` item and promote together. The user makes the Promote/Discard call (per their preference).

## Design notes (folded from design.md §9–19)

- **ADR-10** — `eventContext` is a run-record field consumed by root-node input assembly (not a synthetic node). Auditable in the trajectory panel for free.
- **ADR-11** — Stable `handlerId = workflows:<eventType>`; subscribe via worker IPC `handler_declare`, unsubscribe via loopback `POST /api/events/unregister` (asymmetry forced by the fixed IPC vocabulary). Idempotent re-declare preserves a user-set `enabled`; kernel catch-up (034 FR-005b) is inherited free.
- **ADR-12** — `event` node is a pure loopback emit (no agent/LLM), orthogonal to `agentSource`; cheapest possible node.
- **ADR-13** — Build order: 037 first; US17/US18 independent; US16 non-owned subscription gated on 037. (Materialized as phases P1–P3 above.)
- **ADR-14** — Emission namespace (`com.bos.workflows.*`) is an **item policy** enforced in `workflow_validate` (FR-048b) + live in the config form — **not** a platform gate. Asymmetric with subscription (deliberately unrestricted after 037): emit provenance is policy, subscription access is a platform capability.
- **Wire shapes** (design §12, verified against source): `handler_declare` payload; `event_dispatch` payload + loopback ack (`callerId: "workflows"`); `event` node loopback `POST /api/events` with `_wf` provenance envelope; `GET /api/events/handlers` → `workflow_event_types` mapping.
- **Template resolution** (design §13.3): `{{nodeId.field}}` resolved from `run.outputs[nodeId]` via dot-path; never fails the emit (unresolved → `null` or `||fallback`); payload must JSON-parse to an object else the node fails on a config error; hard-fail only on emit HTTP error.
- **Open items carried to tasks** (design §18): emit→trigger cycle warning (same-workflow first cut); broadcast fan-out on a shared trigger type (document); `eventContext` prompt truncation threshold (implement detail); `getByDotPath` array-index semantics (edge); 037 test-sweep (P1).

## Optional companions

`research.md` / `data-model.md` / `contracts/` / `quickstart.md` are **not** separately warranted for this scope-add — `design.md` §9–19 already resolves the technical unknowns (034 wire protocol, build order, template algorithm, eventContext mechanism, file/module plan) and the data model is defined in spec Key Entities + design §13. The loopback wire shapes (design §12) serve as the interface contract. The 037 change has no new data model (037 Key Entities: none).

## Completion Summary (scope-add plan step)

- Branch: `bos/002-workflow-event-integration` (shared — 037 bos-core + item scope-add promote together).
- Plan extended at `item-workflows/plan.md` (§scope-add addendum) — two-delegation split, six phases (P1 037 → P2 037-independent → P3 US16 gated on 037 → P4 UI → P5 docs → P6 converge), path-correction note for `run-state.js`/`http-bridge.js`.
- Next step: `tasks` (break P1–P6 into dependency-ordered, independently-verifiable tasks; unit + e2e in scope).
