# Workflow Manager — Service-Owned Workflow Engine (Engine Pivot) Design

**Spec**: `user-specs/workflow-manager/001-workflow-manager-service-tools/`
**App Target (spec.md)**: `marketplace-item` + `bos-core` retirement — **agreed, with a scope expansion**
**Date**: 2026-08-20 (REWRITTEN — engine pivot; supersedes the prior design whose ADR-1 held the engine in BOS source)

> **This is a rework.** The previous `design.md` was written under the now-reversed
> assumption "the execution engine stays in BOS source." Per the user-approved engine
> pivot in the current `spec.md`, the BOS-source engine (`src/lib/workflows/*` +
> `/api/workflows/*`) is **retired** and the workflow engine is **fully
> re-implemented inside the Workflow Manager service** (a worker-thread `marketplace-item`
> service facet). This document is the authoritative structural design for the new scope.

---

## 1. Context & Goals

### 1.1 What the feature is

The Workflow Manager is a marketplace item (app id `workflows`) composed of an
**app facet** (a graph UI that lists, authors, and drives workflows) and a
**service facet** (a worker-thread daemon). Under the engine pivot, that service
facet now **owns the complete workflow engine** — node model, dynamic routing,
parallel scheduling, persistence, and execution orchestration — and exposes it
to the assistant as **039-compliant service-declared native tools**
(`deploymentMode: "tools"`, `tool_declare` at startup, `tool_call` over worker IPC).

The pivot spans **two** target shapes at once:

- **`bos-core`** — retire the old BOS-source workflow engine: `src/lib/workflows/*`
  (types.ts, runner.ts, store.ts, validate.ts, generate.ts) and the `/api/workflows/*`
  routes, plus everything that depends on them (the `workflowTools()` server-tool set,
  the `WorkflowActions.tsx` client actions, the `Workflows` capability group).
- **`marketplace-item`** — re-implement the engine inside the item's service facet,
  exposed as service-declared tools, with the app facet as the graph UI.

### 1.2 The central architectural correction (the execution contract)

A worker-thread service **cannot run the BOS assistant stack** — LLM calls,
sub-agent execution, tool invocation — because that lives on BOS's **main thread**
(`runSubAgent` → `runAgentLoop`, `src/lib/agent/subagents/runner.ts`). Therefore
"full re-implementation" means the worker owns the workflow **model, scheduler,
routing, and persistence**, but each node's **actual execution** must still happen
through BOS over a defined contract. **This is the pivotal decision of the design
and is resolved in §3.2 and ADR-1 below.**

### 1.3 Node model — two orthogonal axes (critical modeling correction)

The spec (Key Entities + Assumptions) corrects the earlier flat-node-type modeling
error. A node has:

1. **Agent source** — *who executes the node*:
   - an existing **statically-defined BOS agent** (id in `data/agents/`), or
   - an **Ephemeral agent** (a task description + a configurable tool list + a
     configurable skill list), used when no existing agent matches the task.
2. **Output type** — *what the node produces*, independent of agent source:
   - **delegate** (a sub-agent's output), **tool** (a single tool call),
     **research** (parallel fan-out), **ag-ui** (an A2UI/UI artifact).

Agent source and output type **combine freely** (e.g. an Ephemeral-agent node with
research output, or a static-agent node with tool output). They are **not** flat
node types. A node MAY additionally declare candidate sub-agents for dynamic routing
(US7/FR-018).

### 1.4 What is preserved from the prior design

The following strong decisions from the previous design remain valid and are kept:

- **039-compliant service-declared tool surface** (FR-001/002) — `deploymentMode: "tools"`,
  one `tool_declare` per tool at startup, gated exactly like built-ins (FR-010).
- **Real-VFS persistence via loopback `/api/fs`** (ADR-2 — never host paths, NFR-004).
- **Fire-and-poll `workflow_run`** (ADR-8) — returns a `runId` immediately; caller polls.
- **Graph UI with live active-step highlight** (FR-013) — mockup-driven.
- **Historical runs as persisted entities** (US6, `workflow_run_list`/`workflow_run_get`).
- **The workflow-manager skill** (US9/FR-023) — shipped as an item-bundled skill.
- **Origin resolution from `NEXT_PUBLIC_APP_ORIGIN`/`APP_ORIGIN`** (no `BOS_PORT` exists).

### 1.5 ADRs invalidated by the pivot

| Prior ADR | Status |
|---|---|
| **ADR-1** ("engine stays in BOS source; service is a thin orchestrator over `/api/workflows/*`") | **REVERSED.** The engine is now fully re-implemented in the service; `/api/workflows/*` is retired, so the loopback-orchestration option no longer exists. |
| **ADR-4** ("execution/validation/status/generate via loopback `/api/workflows/*`") | **REVERSED.** The routes are gone. Node execution goes through the new loopback execution contract (§3.2); validation/generation are re-implemented in the worker. |
| **ADR-7 / MF-3** ("retire just `workflowTools()`; engine untouched") | **SUBSUMED.** The retirement is now the **full engine + routes + all dependents**, not just the tool module. The `bos-core` scope expands from 2 files to the whole `src/lib/workflows/` tree + `/api/workflows/*` + their consumers. |
| ADR-2 (real VFS loopback), ADR-3 (port 0), ADR-5 (additive migration), ADR-6 (origin resolution), ADR-8 (fire-and-poll) | **Keep.** All remain valid and are restated (ADR-2/3/6/8 below). |

---

## 2. Classification + Constitution Check

### 2.1 Classification

**App Target: `marketplace-item` + a `bos-core` retirement** — the feature is **both**
shapes by user approval:

- **`marketplace-item`** (primary deliverable): the item rewrite lives entirely under
  `data/user-apps/items/workflows/` — an **app facet** (the graph UI) + a **service facet**
  (the worker that owns the new engine). Per `target-marketplace-item.md`, these are
  **two facets of one item**, not two targets.
- **`bos-core`** (required retirement): removing the old engine — `src/lib/workflows/*`
  and `/api/workflows/*` — and every BOS-source consumer of them.

This **agrees** with spec.md's `App Target` field (`marketplace-item`) for the item
rewrite, and the spec's Assumptions already record the bos-core retirement. **The
feature is explicitly bos-core + marketplace-item** — not a disagreement; a deliberate
dual-scope. Build Studio must run the bos-core retirement on a feature branch
(`dev_branch_request`) and the marketplace item as a separate `agent_delegate` +
`app_build` delegation — never conflated into one mechanism (per the build-studio skill's
target table).

### 2.2 Constitution Check

| Principle | Compliance |
|---|---|
| **II. Server Authority & SSR Boundary** | Complies. The service talks to BOS only over loopback HTTP (`/api/fs`, `/api/subagents/delegate`) and worker IPC. No direct Node/filesystem access to the VFS. Node execution runs on BOS's main thread via the loopback delegate route — the worker never imports `@/` code. |
| **IV. Minimize Blast Radius** | Complies with a **scoped, user-approved exception**: the bos-core retirement touches `src/lib/workflows/*` (5 files) + `/api/workflows/*` (6 routes) + `src/lib/assistant/tools/server/workflows.ts` + `src/lib/assistant/registry.ts` + `src/components/agent/WorkflowActions.tsx` + `CopilotProvider.tsx` + `capabilities-registry.ts`. All on a feature branch; the engine is being *removed*, not rewritten in place. |
| **V. The VFS Is Not the Source** | Complies — the core correctness fix. Workflows and run logs persist to the real VFS `/Workflows/` and `/Workflows/.runs/` via loopback `/api/fs` — never a host path under `dataDir()/system/`. |
| **VI. Specs & Docs Stay in Sync** | Complies. `docs/dev/architecture-overview.md` §14 documents the workflows subsystem and must be updated to reflect the retirement (flagged for implement). `services.md` §15 already documents the `deploymentMode: "tools"` contract. |
| **VII. Respect Boundaries** | Complies. Item files stay under `data/user-apps/items/workflows/`. The bos-core retirement is scoped and feature-branch-isolated. |

No conflicts flagged. The bos-core retirement is the deliberate, user-approved exception
to "this spec only changes the marketplace item" — already recorded in spec.md's
Assumptions.

---

## 3. Architecture

### 3.1 Context (C1)

The Workflow Manager lets a user/assistant author and run multi-step workflows (DAGs
of delegate/tool/research/ag-ui nodes). The assistant drives it through native
service-declared tools; the user drives it through the app graph UI. Both read/write
the same workflows in the real VFS `/Workflows/` (visible in Files). Runs execute on
BOS's main thread through a loopback delegate contract (§3.2); the worker owns the
model/scheduler/routing/persistence.

```
┌────────────┐  calls service-declared tools   ┌──────────────────────────────┐
│  Assistant  │ ──────────────────────────────▶ │  Workflow Manager SERVICE     │
│  (BOS)      │ tool_call / tool_result (IPC)   │  deploymentMode:"tools"       │
└────────────┘                                  │  OWNS: node model, scheduler, │
                                                │  routing, persistence, run    │
┌────────────┐                                  │  state, execution contract    │
│  User / app │  lists/author/runs (graph UI)    └───────┬──────────┬───────────┘
│  (iframe)   │ ───────────────────────────────▶         │          │ loopback HTTP
└────────────┘                                 worker-IPC │          │ (BOS origin)
                                               tool_call  │          ▼
                                                          │  ┌───────────────────────────┐
                                                          │  │  BOS main thread (Next.js) │
                                                          │  │  · /api/fs (VFS bridge)      │
                                                          │  │  · /api/subagents/delegate   │
                                                          │  │    (node EXECUTION — runs    │
                                                          │  │     runSubAgent → agent loop)│
                                                          │  └───────────────────────────┘
                                                          ▼
                                              real VFS /Workflows/ + /Workflows/.runs/
                                                         (via loopback /api/fs)
```

### 3.2 The execution contract — THE central ADR (ADR-1)

**Problem.** The worker cannot run an LLM/sub-agent/tool itself. "Full
re-implementation" therefore means the worker owns everything *except* the actual
per-node execution, which must reach BOS's main thread. **How?**

I investigated the real BOS primitives and recommend:

> **Node execution = a loopback `POST /api/subagents/delegate` call from the worker
> to BOS, per node, with an ephemeral or named agent spec; the worker consumes the
> NDJSON stream. Everything else (scheduling, routing, persistence, run state) is
> owned by the worker.**

This is grounded in source:

1. **`src/app/api/subagents/delegate/route.ts` already exists and is exactly the
   execution primitive the worker needs.** It accepts an **ephemeral agent spec**
   (`{ name, systemPrompt, tools, type, ... }`) or a **named agent** (`{ agent: "<id>" }`),
   runs `runSubAgent` on the main thread (which for `type: "local"` runs a real
   `runAgentLoop` — see `src/lib/agent/subagents/runner.ts`'s `runLocalHeadless`), and
   **streams NDJSON** (`{type:"tool"}` per tool call, then `{type:"done", result}` /
   `{type:"error"}`). It resolves the feature branch server-side and supports
   `conversationId`/`threadId` for branch resolution. This is the *same* route the old
   engine's `runner.ts` effectively reached through `runSubAgent` in-process — now
   reached over loopback.

2. **The ephemeral agent shape on the delegate route maps directly onto the spec's
   Ephemeral-agent node axis.** The route's `ephemeral` object carries `name`,
   `systemPrompt`, `tools` (a tool allowlist) — and the runner composes the agent's
   skills index from the parent context. This is precisely the "task description +
   configurable tool list + configurable skill list" the spec requires (FR-021).

3. **This keeps every node's actual execution on the main thread** where `runSubAgent`/
   `runAgentLoop` already live, satisfying the hard constraint that the worker cannot
   host the assistant stack.

**Why this option over the alternatives:**

- **(a) New worker-IPC "run node" message between the worker and BOS's main thread.**
  Rejected: worker IPC (`MainToWorkerMessage`/`WorkerToMainMessage` in
  `src/core/service/types.ts`) is a fixed protocol — the worker is the *callee* for
  `tool_call`, and there is no main→worker direction that lets the worker *invoke*
  main-thread logic. Adding a worker→main "execute this node" message would require
  a BOS-source change to `workerIpc.ts`/`ServiceManager.ts` to handle a new
  `WorkerToMainMessage` type and route it into the assistant stack — new bos-core
  plumbing that the loopback route already provides for free. (Also, the worker→main
  channel is the *response* direction; the worker cannot hold a `Worker` handle.)
- **(b) A dedicated new BOS API route for workflow node execution.** Rejected as
  unnecessary: `/api/subagents/delegate` already does exactly what a node needs
  (run a named/ephemeral agent, stream NDJSON, resolve branches). A new
  `/api/workflows/...` route would re-create the very surface we just retired.
- **(c) The worker re-implements LLM/sub-agent/tool execution itself.** Impossible —
  the worker is unbundled, outside the `@/` graph, and cannot import
  `runSubAgent`/`runAgentLoop`/the tool registry at all (verified: `target-marketplace-item.md`,
  `docs/dev/apps/services.md` §6).

**Consequences.** The worker's per-node execution becomes:

```text
for each ready node:
  result = await delegateNode(node)   // POST /api/subagents/delegate over loopback
  // delegateNode maps the node's agent source + output type to a delegate request:
  //   - static agent  → { agent: node.agentId, task, ... }
  //   - ephemeral     → { ephemeral: { name, systemPrompt, tools, skills? }, task }
  // consume NDJSON; capture output + tool events; route per node.outputType
```

The worker does **not** re-implement `runAgentLoop`. It is the workflow *engine*:
it schedules ready nodes up to `maxConcurrentSteps`, fans out research nodes, performs
dynamic-routing selection/retry, persists events, and tracks run state — but each node's
"work" is one loopback delegate call.

**Cancellation.** The worker owns the `runId` and per-run `AbortController`. Because a
node executes *inside* a loopback delegate call, cancelling a workflow must abort that
in-flight fetch. This is a genuine gap to resolve (see §7 Open Item #1): the current
`/api/subagents/delegate` route has no `cancel` endpoint and no `runId`-keyed abort
controller. Two sub-options, both flagged for implement:
  - extend the delegate route with a `cancel`/`runId` param (small bos-core change), or
  - the worker aborts its own fetch and relies on the run's step-level cancellation
    semantics (the delegate's inner loop settles `cancelled` on signal abort per
    `agent-loop.ts`'s `runServerTool` linked-abort) — acceptable but less precise.
This is the **single open execution-contract risk** (§7) and must be decided before
`plan`.

### 3.3 Container (C2)

BOS's real containers involved:

1. **The Next.js app process (main thread)** — hosts the VFS bridge (`/api/fs`), the
   sub-agent delegate route (`/api/subagents/delegate`), the assistant stack
   (`runSubAgent`/`runAgentLoop`), and the service-tool bridge (`serviceToolBridge`).
   **No longer hosts a workflow engine** (retired).
2. **The Workflow Manager worker-thread service** — a plain Node worker (unbundled,
   outside the `@/` graph), bound to its own configurable port (default `0`). It owns
   the workflow engine (model, scheduler, routing, persistence, run state), declares
   the workflow tools, and triggers node execution via loopback.
3. **The VFS store** (`src/os/vfs.ts`, backed by `data/vfs/`) — workflows at
   `/Workflows/`, run logs at `/Workflows/.runs/`, reached via loopback `/api/fs`.
4. **The marketplace item's own git repo** (`data/user-apps/items/workflows/`) — the
   item source (app + service + config + skill).
5. **The Supervisor** (deployment-fronted scenarios) — proxies to the service's bound
   port via `httpPath`/`wsPath` when BOS is behind a reverse proxy. Not needed for
   worker-IPC tool dispatch (in-process), but the app's config reads
   (`GET /api/services/<id>/config`) use it when the app reaches the service over HTTP.

### 3.4 Component (C3) — item-level modules + retired BOS modules

#### 3.4.1 The marketplace item (`data/user-apps/items/workflows/`)

```
workflows/                                  # item root
├── services/
│   ├── service.json                        # REWRITE — deploymentMode:"tools", entry, configSchema
│   ├── index.js                            # REWRITE — worker entry: lifecycle + tool_declare + IPC
│   ├── tools.js                            # NEW — workflow tool declarations + schemas (FR-002)
│   ├── handlers.js                         # NEW — tool handlers for the 12 tools (incl. run_list/run_get)
│   ├── engine/
│   │   ├── node-model.js                   # NEW — orthogonal node axes: agent source × output type
│   │   ├── scheduler.js                    # NEW — DAG scheduler: ready-set, maxConcurrentSteps, research fan-out (FR-020/022)
│   │   ├── router.js                       # NEW — dynamic routing: candidate selection + retry-loop (FR-018/019)
│   │   ├── validate.js                     # NEW — DAG acyclicity + node schema validation (re-implemented from old validate.ts)
│   │   ├── generate.js                     # NEW — workflow generation from a task description (re-implemented from old generate.ts)
│   │   ├── store.js                        # NEW — workflow + run CRUD over loopback /api/fs (re-implements old store.ts)
│   │   └── executor.js                     # NEW — the execution contract: loopback /api/subagents/delegate per node (§3.2/ADR-1)
│   ├── vfs.js                              # NEW — loopback /api/fs bridge helpers (FR-004, NFR-004)
│   ├── migration.js                        # NEW — additive legacy-workflow migration (FR-005)
│   └── runs.js                             # NEW — run entity persistence + workflow_run_list/run_get (FR-015/016)
├── app/
│   └── src/main.tsx                        # REWRITE — graph UI (mockup-driven): list/detail/run + history replay
├── config/
│   └── workflows.json                      # REWRITE — { port: 0, host: "127.0.0.1" }
└── skills/
    └── workflow-manager/SKILL.md           # NEW — item-bundled skill (US9/FR-023), seeded via bundledAssets.ts
```

**Facets:** app + service + (bundled skill). Per `target-marketplace-item.md`, these
are all installed by one `app_build` call.

#### 3.4.2 Node model (engine/node-model.js)

```js
// Two orthogonal axes (spec Key Entities — the modeling correction).
const NODE = {
  // axis 1 — WHO executes
  agentSource: { kind: "static", agentId }        | { kind: "ephemeral", task, tools?, skills?, systemPrompt? },
  // axis 2 — WHAT it produces (independent of agentSource)
  outputType: "delegate" | "tool" | "research" | "ag-ui",
  // dynamic routing (optional)
  candidateAgents?: string[],                    // US7/FR-018
  // scheduling
  dependencies?: string[],
  retryLimit?, timeout?,
};
```

The worker's `executor.js` maps `agentSource` + `outputType` onto a
`/api/subagents/delegate` request:
- `outputType: "tool"` → the delegate task instructs the ephemeral/static agent to call
  only the specified tool (mirroring the old `runToolStep` constraint, now expressed
  as a task instruction to the delegate route).
- `outputType: "research"` → `scheduler.js` fans out one delegate call per candidate,
  running them in parallel up to `maxConcurrentSteps`, collecting outputs.
- `outputType: "ag-ui"` → returns the node's `input` as the artifact (no delegate call).
- `outputType: "delegate"` → the delegate call's output is the node output.

#### 3.4.3 Tool surface (tools.js) — FR-002/FR-014/FR-016/FR-024

The service declares **12** tools at startup (one `tool_declare` each). Schemas are
JSON Schema forms; names/descriptions sourced from the retired `workflowTools()` where
they overlap, plus the new list/read/delete/run_list/run_get tools:

| Tool | Purpose | FR |
|---|---|---|
| `workflow_list` | List workflows with `workflow_id`, `status` (`running`/`idle`), `run_id` when running (live status — FR-024) | FR-002/024 |
| `workflow_create` | Generate + persist a workflow from a task description | FR-002/014 |
| `workflow_read` | Read a workflow's full JSON | FR-002 |
| `workflow_modify` | JSON-merge patch + re-validate | FR-002/014 |
| `workflow_run` | Fire-and-poll: returns `runId` immediately (ADR-8) | FR-002/008/014 |
| `workflow_status` | Live run state + per-step statuses (FR-013) | FR-002 |
| `workflow_cancel` | Cancel a running workflow; mark in-progress steps cancelled | FR-002/009/014 |
| `workflow_delete` | Delete a workflow + its run logs | FR-002/014 |
| `workflow_export` | Return workflow JSON as string | FR-002/014 |
| `workflow_validate` | Validate DAG + nodes | FR-002/014 |
| `workflow_run_list` | List historical runs for a workflow (id, timestamp, final state) | FR-016 |
| `workflow_run_get` | Read a run's details, per-step outcomes, event log | FR-016 |

`workflow_run` is **fire-and-poll** (ADR-8): the handler starts the worker's engine run,
returns `{ runId, workflowId }` in <1s (well within the 30s `TOOL_CALL_TIMEOUT_MS`
kernel timeout), and the caller polls `workflow_status`/`workflow_run_get`.

#### 3.4.4 Run state & live status (engine/store.js + runs.js)

The worker owns a per-workflow in-memory `runId → RunState` map (mirroring the old
`store.ts` `RUNTIME` map) and persists each run to the real VFS at
`/Workflows/.runs/<workflowId>/<runId>.json` (FR-015). `workflow_list` derives live
status by checking this map (running → includes `run_id`); `workflow_status`/
`workflow_run_get` read the live map or the persisted run entity.

---

## 4. Concrete File/Module Plan

### 4.1 Marketplace item files (created/modified) — under `data/user-apps/items/workflows/`

| Path | Action | Purpose |
|---|---|---|
| `services/service.json` | **Modify** | `deploymentMode: "tools"`, entry `index.js`, configSchema (`port` default `0`), settingsRegistration. |
| `services/index.js` | **Rewrite** | Worker entry — guarded `parentPort`; lifecycle (`initialize`/`bound`/`dispose`); one `tool_declare` per tool; `tool_call` dispatch; migration trigger. |
| `services/tools.js` | **Create** | 12 tool declarations + JSON schemas (FR-002/016/024). |
| `services/handlers.js` | **Create** | Tool handlers — list/create/read/modify/run/status/cancel/delete/export/validate/run_list/run_get. |
| `services/engine/node-model.js` | **Create** | Orthogonal node axes (agent source × output type). |
| `services/engine/scheduler.js` | **Create** | DAG scheduler — ready-set, `maxConcurrentSteps`, research fan-out (FR-020/022). |
| `services/engine/router.js` | **Create** | Dynamic routing — candidate selection + retry-loop (FR-018/019). |
| `services/engine/validate.js` | **Create** | Re-implemented DAG/node validation (was `src/lib/workflows/validate.ts`). |
| `services/engine/generate.js` | **Create** | Re-implemented workflow generation (was `src/lib/workflows/generate.ts`). |
| `services/engine/store.js` | **Create** | Workflow + run CRUD over loopback `/api/fs` (re-implements `store.ts`). |
| `services/engine/executor.js` | **Create** | Execution contract — loopback `/api/subagents/delegate` per node (ADR-1). |
| `services/vfs.js` | **Create** | Loopback `/api/fs` bridge helpers (FR-004, NFR-004). |
| `services/migration.js` | **Create** | Additive legacy-workflow migration (FR-005). |
| `services/runs.js` | **Create** | Run entity persistence + run_list/run_get (FR-015/016). |
| `app/src/main.tsx` (+ components/CSS) | **Rewrite** | Graph UI — list/detail/run views + historical-run replay (mockup-driven). |
| `config/workflows.json` | **Modify** | `{ "port": 0, "host": "127.0.0.1" }`. |
| `skills/workflow-manager/SKILL.md` | **Create** | Item-bundled skill (US9/FR-023) — seeded via `bundledAssets.ts`. |

### 4.2 BOS-core retirement (feature branch) — the bos-core scope

| Path (BOS source) | Action | Purpose |
|---|---|---|
| `src/lib/workflows/types.ts` | **Retire (delete)** | Old workflow type definitions — superseded by the item's `engine/node-model.js`. |
| `src/lib/workflows/runner.ts` | **Retire (delete)** | Old main-thread engine — superseded by the service-owned engine. |
| `src/lib/workflows/store.ts` | **Retire (delete)** | Old VFS store — re-implemented in `engine/store.js`. |
| `src/lib/workflows/validate.ts` | **Retire (delete)** | Old validation — re-implemented in `engine/validate.js`. |
| `src/lib/workflows/generate.ts` | **Retire (delete)** | Old generation — re-implemented in `engine/generate.js`. |
| `src/app/api/workflows/route.ts` | **Retire (delete)** | Old CRUD route. |
| `src/app/api/workflows/run/route.ts` | **Retire (delete)** | Old run route. |
| `src/app/api/workflows/status/route.ts` | **Retire (delete)** | Old status route. |
| `src/app/api/workflows/cancel/route.ts` | **Retire (delete)** | Old cancel route. |
| `src/app/api/workflows/generate/route.ts` | **Retire (delete)** | Old generate route. |
| `src/app/api/workflows/validate/route.ts` | **Retire (delete)** | Old validate route. |
| `src/lib/assistant/tools/server/workflows.ts` | **Retire (delete)** | `workflowTools()` — otherwise it shadows the 10 overlapping service tools (registry.ts spreads service tools first, built-ins win). |
| `src/lib/assistant/registry.ts` | **Modify** | Remove the `workflowTools` import + spread. |
| `src/components/agent/WorkflowActions.tsx` | **Retire (delete)** | Client actions that proxy `/api/workflows/*` — dead once routes are gone. |
| `src/components/agent/CopilotProvider.tsx` | **Modify** | Remove `<WorkflowActions />` import + usage. |
| `src/lib/agent/capabilities-registry.ts` | **Modify** | Remove the 7 static `workflow_*` capability entries (the dynamic service-tool capabilities replace them via `registerAdditionalCapabilities`). |

**What depends on the retired engine** (verified via `bos_source_search`): only the files
above — the 6 routes, the `workflowTools()` module, `WorkflowActions.tsx`,
`CopilotProvider.tsx`, and `capabilities-registry.ts`. There are **no other** consumers
of `src/lib/workflows/*` or `/api/workflows/*` in `src/` (searched: no scheduler, no
integrations, no other components reference them). `docs/dev/architecture-overview.md` §14
documents the workflows subsystem and must be updated (§5/§7).

**Migration risk.** The old `store.ts` wrote workflows to `/Workflows/` and execution
logs to `/Workflows/<id>-execution-log.json`; the new engine writes workflows to
`/Workflows/` (same) and runs to `/Workflows/.runs/<workflowId>/<runId>.json`. The
legacy per-workflow execution logs are superseded by run entities — `migration.js`
(FR-005) must **copy** any legacy workflow JSON into the real VFS additively and
archive the legacy location; legacy execution logs can be left archived (runs are
re-created by the new engine). The `results/` subdir the old engine referenced
(`/Workflows/results/`) is retired with it.

### 4.3 No `builtin-app` entries

The `builtin-app` target shape does not apply — omitted (per the hard rule: omit
non-applicable target shapes rather than listing-and-dismissing).

---

## 5. Integration Points

Existing BOS mechanisms this design **calls into** but does **not** create/modify —
dependencies, not deliverables:

| Mechanism | Real route/file | Used for |
|---|---|---|
| **Service tool bridge** (`deploymentMode:"tools"`, `tool_declare`, gating, lifecycle cleanup) | `src/lib/agent/service-tool-bridge.ts`, `src/core/service/ServiceManager.ts`, `src/core/service/workerIpc.ts` | Declaring the 12 tools, schema-validation before dispatch (FR-003), allowlist/deferred gating (FR-010), removal on stop/crash/uninstall (FR-011). |
| **Worker IPC protocol** (`tool_call`/`tool_result`/`tool_error`) | `src/core/service/workerIpc.ts`, `serviceToolTypes.ts` | Dispatch and result/error return for each tool call. |
| **Sub-agent delegate route (execution contract)** | `src/app/api/subagents/delegate/route.ts` | Every node's actual execution — loopback, NDJSON, ephemeral/named agent support (ADR-1). |
| **Real VFS bridge** | `src/app/api/fs/route.ts` (`op=list|read|write|mkdir|delete|rename`), `src/os/vfs.ts` | All workflow + run persistence under `/Workflows/` — the sanctioned loopback path (ADR-2). |
| **Assistant tool registry / gating** | `src/lib/assistant/registry.ts` (`assistantTools()`), `src/lib/assistant/gate.ts`, `src/lib/agent/tool-gate.ts`, `capabilities-registry.ts` | Surfacing service tools + gating like built-ins. |
| **Item-bundled skill seeding** | `src/system/marketplace/install/bundledAssets.ts` (`reconcileInstalledItemAssets`), `src/lib/agent/skills/store.ts` | The `skills/workflow-manager/` item skill is copied into `data/skills/` on install/reconcile (US9/FR-023). |
| **`window.__bos` broker + app capabilities** | `src/lib/apps/store.ts` (`setAppCapabilities`) | The app facet reaches BOS APIs (services, fs) through the SDK broker with granted capabilities — not direct fetch under the opaque `marketplace`-origin sandbox. |
| **Settings → Plugins → Services** | `src/components/apps/settings/ServicesTab.tsx`, `ServiceCard.tsx`, `ServiceConfigPanel.tsx` | User manages start/stop/restart/logs/config; `runtime.json` holds the actually-bound port. |
| **Service config / reachability** | `src/app/api/services/[id]/config/route.ts` (`runtime`, `httpPath`/`wsPath`) | App reads the service's bound port / Supervisor proxy path (ADR-3, services.md §11). |

---

## 6. Key ADRs

### ADR-1 (REVERSED from prior) — The execution contract: worker owns the engine; node execution via loopback `/api/subagents/delegate`

- **Context**: The engine pivot makes the worker own the workflow engine, but a worker
  thread cannot run the assistant stack (LLM/sub-agent/tool execution lives on BOS's
  main thread — `runSubAgent` → `runAgentLoop`, `src/lib/agent/subagents/runner.ts`,
  `src/lib/assistant/agent-loop.ts`). The worker is unbundled and cannot import `@/`
  modules (`target-marketplace-item.md`, `services.md` §6).
- **Options**:
  (a) Loopback `/api/subagents/delegate` per node (an **existing** route that already
      runs named/ephemeral agents and streams NDJSON — verified `src/app/api/subagents/delegate/route.ts`).
  (b) A new worker-IPC worker→main "execute node" message (`MainToWorkerMessage`/
      `WorkerToMainMessage` in `src/core/service/types.ts`) — requires new bos-core
      plumbing in `ServiceManager.ts`/`workerIpc.ts` to route worker requests into the
      assistant stack.
  (c) A new dedicated BOS API route for workflow node execution.
  (d) Re-implement LLM/sub-agent/tool execution inside the worker (impossible).
- **Decision**: (a). The delegate route is the exact execution primitive needed, already
  exists, and runs on the main thread. (b) is rejected — the worker→main direction isn't
  part of the service protocol and would be net-new bos-core; (c) recreates a retired
  surface; (d) is structurally impossible.
- **Consequences**: The worker stays the engine (model/scheduler/routing/persistence);
  each node's execution is one loopback delegate call. **Cancellation is resolved as
  Option (b) (user-approved)**: the worker aborts its in-flight delegate fetch and relies
  on the inner loop's linked-abort settling `cancelled` — no bos-core extension to the
  delegate route (see §7). If mid-node cancellation precision is ever needed, a small
  bos-core extension to the delegate route (a `runId`-keyed abort) is the recommended
  follow-up.

### ADR-2 (kept) — Persist workflows + runs to the real VFS via loopback `/api/fs`, never a host path

- **Context**: The recurring invisible-content bug — workflows landing under
  `dataDir()/system/...` are invisible to Files/engine/app. A worker can't import
  `@/os/vfs`.
- **Decision**: All storage via loopback `/api/fs` (`op=list|read|write|mkdir|delete|rename`).
  Workflows at `/Workflows/<id>-workflow.json`; runs at `/Workflows/.runs/<workflowId>/<runId>.json`.
- **Consequences**: Visible to Files, the app, and the tools (SC-003). Small JSON files →
  JSON `/api/fs` route; no `/api/fs/raw` needed.

### ADR-3 (kept) — The service binds a real port defaulting to `0`

- **Context**: Tool dispatch is worker IPC, but every worker-thread service binds a real
  port — that's what the Supervisor forwards to (`services.md` §6/§11). A fixed non-zero
  default collides with BOS's reserved ports.
- **Decision**: `configSchema.port` defaults `0` (OS-assigned); `ServiceManager` records
  the bound port in `runtime.json`.
- **Consequences**: Satisfies NFR-003; no EADDRINUSE; the app reads the real bound
  port/`httpPath` from `GET /api/services/<id>/config` (§11 deployment table — Bastion /
  Supervisor-only / standalone).

### ADR-4 (REVERSED from prior) — No loopback `/api/workflows/*`; node execution via the delegate route, validation/generation re-implemented in the worker

- **Context**: The prior ADR-4 routed execution/validation/status/generate through
  `/api/workflows/*`. Those routes are retired.
- **Decision**: Validation and generation are re-implemented in the worker's
  `engine/validate.js`/`engine/generate.js` (self-contained; the worker can call
  `/api/subagents/delegate` for generation's LLM step). Node execution goes through
  `/api/subagents/delegate` (ADR-1). Status/run state is worker-owned.
- **Consequences**: The worker is a full engine, not an orchestrator over retired routes.

### ADR-5 (kept) — Additive, idempotent migration — copy + archive, never delete

- **Context**: Stranded legacy workflows live in non-VFS host paths. Deleting risks data
  loss; blind copying risks overwriting newer real-VFS content.
- **Decision**: Additive + idempotent: copy workflows whose id doesn't already exist under
  real VFS `/Workflows/`; archive (rename) the legacy location, never delete (FR-005).
- **Consequences**: No data loss, re-runnable, legacy archive recoverable.

### ADR-6 (kept) — Resolve BOS's HTTP origin from `NEXT_PUBLIC_APP_ORIGIN`/`APP_ORIGIN`

- **Context**: `vfs.js`/`executor.js` need BOS's own HTTP origin for loopback calls.
  There is **no** `BOS_PORT` injected (verified: `ServiceManager` passes only
  `{ configDirPath, logsPath, serviceId }`; `runtime.json` holds the service's *own* port).
- **Decision**: Read `NEXT_PUBLIC_APP_ORIGIN`/`APP_ORIGIN` with an `http://localhost:3000`
  fallback — the exact pattern BOS itself uses (`src/lib/integrations/oauth/origin.ts`,
  `webhooks/manager.ts`). Loopback host is always `127.0.0.1`.
- **Consequences**: No BOS-source change; matches BOS's own origin resolution.

### ADR-7 (SUBSUMED → expanded) — Retire the entire old engine + routes + dependents (full bos-core retirement)

- **Context**: The prior ADR-7 retired only `workflowTools()` (MF-3). The pivot requires
  the **full** retirement: `src/lib/workflows/*` + `/api/workflows/*` + `workflowTools()`
  + `WorkflowActions.tsx` + `CopilotProvider` + the static `workflow_*` capabilities.
  This is necessary (a) so service tools aren't shadowed (registry.ts spreads service
  tools first, built-ins win — verified `src/lib/assistant/registry.ts`), and (b) because
  the engine no longer exists in BOS source.
- **Decision**: Remove the complete engine/routes/dependents as a scoped bos-core
  delegation on a feature branch.
- **Consequences**: The workflow surface is fully owned by the item's service. Migration
  risk: only the files listed in §4.2 consume the old engine (verified by search); no
  hidden dependents. Docs (`architecture-overview.md` §14) must be updated.

### ADR-8 (kept) — `workflow_run` is fire-and-poll, not synchronous

- **Context**: A multi-step workflow run exceeds the kernel's 30s tool-call timeout
  (`TOOL_CALL_TIMEOUT_MS = 30_000` in `ServiceManager.ts`; verified hardcoded in the
  dispatcher — `waitForToolResult(worker, callId, TOOL_CALL_TIMEOUT_MS, signal)`).
  The old run route's `maxDuration = 600` existed because runs are long.
- **Decision**: `workflow_run` returns `{ runId, workflowId }` immediately (<1s); caller
  polls `workflow_status`/`workflow_run_get`. Step events stream to the **app** directly.
- **Consequences**: Each `tool_call` stays bounded; the assistant issues follow-up
  `workflow_status` calls (consistent with FR-024).

### ADR-9 (NEW) — Runs are first-class persisted entities, distinct from live state

- **Context**: US6/FR-015 require historical-run inspection after completion.
- **Decision**: Each run is persisted to `/Workflows/.runs/<workflowId>/<runId>.json`
  (runId, timestamps, final state, per-step outcomes, event log). Live state is the
  worker's in-memory map; on completion/failure/cancel, the run is written to VFS and
  remains inspectable via `workflow_run_list`/`workflow_run_get` and the app's run selector.
- **Consequences**: Satisfies SC-009/SC-010; historical replay is a static read, distinct
  from live-run state.

---

## 7. Risks / Open Items

1. **Node-execution cancellation (RESOLVED — Option (b), user-approved).** The worker cancels
   a workflow by aborting its own loopback delegate fetch. `/api/subagents/delegate`
   has **no cancel endpoint / runId-keyed abort controller** today (verified in
   `src/app/api/subagents/delegate/route.ts`). **Decision: Option (b)** — the worker
   aborts its in-flight delegate fetch and relies on the inner loop's linked-abort
   settling `cancelled` (per `agent-loop.ts`'s `runServerTool`). **No bos-core extension
   to the delegate route is made.** This is accepted as a known limitation: cancellation
   settles at the step/loop boundary, not as a precise mid-node abort. If mid-node
   cancellation precision is ever needed, revisit Option (a) (a `runId`-keyed abort on
   the delegate route) as a separate follow-up.
2. **Generation requires an LLM call.** `engine/generate.js` re-implements workflow
   generation from a task description, which needs an LLM call. The worker can reach it
   via the delegate route (an ephemeral "planner" agent) — but this couples generation to
   the delegate contract. Alternative: the workflow-builder agent (US9 skill) constructs
   workflows directly via `workflow_create` with a structured body, bypassing worker-side
   generation. Confirm which path `workflow_create` takes.
3. **Skill scope for ephemeral nodes.** The delegate route's ephemeral spec carries
   `tools`; the spec's ephemeral nodes also carry a `skill list`. The route builds the
   skills index from the *parent* agent context (`ephemeralComposeSystem` in
   `delegate-common.ts`). Verify a worker-initiated ephemeral delegate call can scope
   skills per-node; if not, ephemeral skill lists may need to be folded into the task
   text (open question for implement).
4. **`workflow_list`/`workflow_read`/`workflow_delete`/`workflow_run_list`/`workflow_run_get`
   don't exist in the old 7-tool set.** FR-002/016 require 12 tools; the five new ones are
   net-new declarations (sourced from the app's existing capabilities). Confirm exact
   names/schemas.
5. **App capability grants.** The app needs `services:read` (and possibly `fs:read`)
   granted in Settings → Apps after install — never auto-granted (services.md §14).
6. **Docs drift.** `docs/dev/architecture-overview.md` §14 ("Workflows") documents the
   retired subsystem. Must be updated in the bos-core change (§VI/VI).
7. **Feature branch for bos-core.** The retirement must run on an active feature branch
   (`dev_branch_request`), isolated; the marketplace item is a separate `app_build`.

---

## 8. UI Design Notes (folded from mockup)

**Path**: `mockup.html` (same spec directory). The mockup defines three views mapped onto
the app facet's `app/src/main.tsx`:

| Mockup view | Maps to | FR |
|---|---|---|
| **List view** (`#view-list`) | List view; cards read real VFS `/Workflows/` via the service (FR-006). Status pills (Ready/Running/Failed) from `workflow_status`; Running pills reflect `workflow_list`'s live `run_id`/status (FR-024). Empty state when `/Workflows/` is empty. Service-stopped banner when the service is not running. | FR-006/024 |
| **Detail/editor view** (`#view-detail`) | Detail view; steps list (each step shows agent-source + output-type), dependencies, config tabs; Run/Edit/Export/Validate/Delete actions → `workflow_run`/`workflow_modify`/`workflow_export`/`workflow_validate`/`workflow_delete`. **Historical-runs selector** (`#run-select-*`) → `workflow_run_list`; **history panel** (`#history-panel`) replays a selected run's per-step outcomes + event stream → `workflow_run_get` (FR-017). | FR-012/017 |
| **Run view** (`#view-run`) | Run view; progress bar, per-step statuses (pending/running/completed/failed/cancelled), **graph with active-step highlight** (FR-013) updating live, event stream (FR-008), Cancel run (FR-009). | FR-008/013 |

The mockup's **service-stopped banner** (`#stopped-banner`) and **service pill**
(`#service-pill`) reflect service state — when stopped, tools are removed (FR-011) and
runs are refused (FR-007). The **empty-state copy** ("the engine, Files, and the app all
read the same location") is the UX statement of ADR-2's invisible-content fix. The graph
renders node labels as `outputType · sub` (e.g. `tool · fetch:csv`, `ag-ui · normalize`,
`delegate · db`) — consistent with the node-model axes (§3.4.2).

---

# §9+ Scope-Add 002 — Event-System Integration (US16–US18, FR-039–FR-051)

> **Addendum, not a rewrite.** §1–§8 above are the converged, implemented design
> for the 001 engine pivot (status: Implemented & Promoted 2026-08-21). This section
> is the authoritative structural design for the 2026-09-02 scope-add: workflows as
> **first-class participants in the 034 event system** — *inbound* (event-triggered
> runs, US16), *discovery* (`workflow_event_types`, US17), and *outbound* (`event`
> node, US18). It **extends** the item's service and app facets in place; it does not
> re-derive the engine, the VFS bridge, the execution contract, or the tool surface
> those earlier sections already settled. The only *new* target shape this scope-add
> introduces is a small, isolated **`bos-core` platform change** (037) — §15.

## 9. Classification (delta)

**Primary target — `marketplace-item` (the `workflows` item, in place):** the scope-add
lives entirely inside the existing item — its **service facet** gains a
headless-handler subscription path, an `event` node output type, and one new
service-declared tool (`workflow_event_types`); its **app facet** gains a Triggers
editor and an event-node config form (FR-049). This **agrees** with spec.md's
`App Target: marketplace-item`.

**Secondary target — `bos-core` (037-event-namespace-relaxation), new for this scope-add:**
US16 requires the workflow service to subscribe to *arbitrary* event types (e.g.
`com.bos.gsuite.email.received`) via `handler_declare`. The 034 implementation still
rejects such a registration with `namespace-not-owned` (the `ownsNamespace` check in
`src/lib/events/api.ts` `register()`). 037 removes that check. This is the one
non-marketplace deliverable, and its file-level scope is bounded in §15.

**Agreement check:** spec.md's `App Target` field is `marketplace-item` only; the 037
bos-core change is recorded in spec.md's Context/Assumptions as a *platform dependency*
(its own spec is at `user-specs/core-platform/037-event-namespace-relaxation/`). No
disagreement — but Build Studio must schedule 037 (bos-core, feature branch) and the
item scope-add (marketplace, `app_build`) as **two delegations on the shared feature
branch** `bos/002-workflow-event-integration` (037's spec names the same branch), never
conflated. Build-ordering: §14/ADR-13.

## 10. Constitution check (delta)

| Principle | Compliance (this scope-add) |
|---|---|
| **II. Server Authority & SSR Boundary** | Complies. The service reaches the 034 system **only** over worker IPC (`handler_declare`, and being invoked via `event_dispatch`) and loopback HTTP (`POST /api/events`, `GET /api/events/handlers`, `POST /api/events/:id/ack`, `POST /api/events/unregister`). It never imports `@/lib/events/*` (the worker is unbundled, outside the `@/` graph — §3.2 / `target-marketplace-item.md`). **No self-contained token/credential scheme is introduced:** the service is a handler *callee*; it acks over loopback with `callerId: "workflows"`, which the unchanged ack-ownership check (`kernel.ts` `ack()` — `reg.ownerId !== input.callerId ⇒ ack-forbidden`) validates *by identity*, exactly as 034 intended. |
| **IV. Minimize Blast Radius** | Complies. The only bos-core edit is 037's single rejection-path removal in `api.ts` `register()` (plus optional dead-code cleanup it permits) — §15. The item change is additive inside the already-implemented service/app facets. |
| **V. The VFS Is Not the Source** | Complies. `triggers` live in the workflow JSON already persisted to real VFS `/Workflows/` (§4.1/ADR-2); no new storage location. |
| **VI. Specs & Docs Stay in Sync** | Complies. 037 supersedes 034 FR-023; the item's `docs/dev/Workflows/*` + skill (FR-050) must document event-triggered workflows and `event` nodes (flagged for implement, §14). |
| **VII. Respect Boundaries** | Complies. Item files stay under `data/user-apps/items/workflows/`; 037 is feature-branch-isolated. |

**037's security posture is unchanged.** 037 removes the *subscription* check (a
collision-guard, per the 034 design doc's own characterization: "a same-container
integrity check, not a network security boundary"). The *ack* ownership check — the
real integrity guard on the settlement path — is explicitly **unchanged** (037 FR-002,
verified present in `kernel.ts` `ack()`). In BOS's single-container trust model this
removal does not weaken any boundary. No constitution conflict beyond what 037 already
records.

## 11. Architecture (delta)

The 001 Context/Container diagram is unchanged. This scope-add adds **two arrows** to
it: the service facet now also (a) **subscribes** to 034 event types via the existing
headless-handler channel, and (b) **emits** 034 events from `event` nodes — both
reaching the same **BOS main-thread event kernel** the 034 routes delegate to.

```text
                        ┌──────────────────────────────────────────────┐
  034 EVENT KERNEL (BOS main thread, already implemented — unchanged)
                        │  src/lib/events/{kernel,dispatch,api,store}  │
                        │  · handler registry (in-memory + JSONL)      │
                        │  · FIFO per-handler dispatch, retry/backoff  │
                        │  · emit = O(1) shard append (FR-004: does   │
                        │    NOT await handler completion)            │
                        └───────┬──────────────────────┬───────────────┘
        handler_declare         │  event_dispatch       │  loopback HTTP
        (Worker→Main IPC)       │  (Main→Worker IPC)     │  (127.0.0.1)
        [037 removes the        ▼          │             ▼
         ownsNamespace gate]   │           │             │
                        ┌──────┴───────────┴─────────────┴────────────┐
                        │  Workflow Manager SERVICE (worker thread)    │
                        │  + events.js  (NEW: trigger union, subsc-   │
                        │    ribe/unsubscribe, event_dispatch handler │
                        │      → fire-and-poll run + loopback ack)    │
                        │  + engine/node-model.js (MOD: +"event" out) │
                        │  + engine/executor.js (MOD: event-node emit)│
                        │  + tools.js/handlers.js (MOD: +event_types) │
                        └──────────────────────────────────────────────┘
```

The two directions are **asymmetric in their 037 dependency**, which drives build
ordering (§14/ADR-13):
- **Inbound (US16, subscribe)** — the `handler_declare` for a non-owned type is
  *rejected* by the pre-037 `ownsNamespace` gate. **Depends on 037.**
- **Outbound (US18, emit)** — `api.emit()` has **no** namespace check at all (verified:
  `api.ts` `emit()` validates only type shape, payload size, and `source.appId`). An
  `event` node emits into `com.bos.workflows.*` (the service's owned root) *or any type*
  with no platform gate; only the item's own `workflow_validate` (FR-048b) restricts it
  to the owned namespace for provenance clarity. **Does NOT depend on 037.**

## 12. Wire protocol (all shapes verified against source)

### 12.1 Subscribe — `handler_declare` (Worker→Main)

The service emits one `handler_declare` per distinct trigger event type. Exact
`HandlerDeclarePayload` (`src/core/service/types.ts:169`), one message per type:

```js
parentPort.postMessage({
  type: "handler_declare",
  payload: {
    callId:      callId(),                    // opaque correlation id (service-generated)
    handlerId:   `workflows:${eventType}`,    // STABLE & deterministic (see §13)
    eventType:   eventType,                   // exact type string, e.g. "com.bos.gsuite.email.received"
    displayName: `Workflow trigger: ${eventType}`,
    description: `Starts a run of the workflow(s) that declare this trigger.`,
    timeoutMs:   undefined,                   // default 30_000 (DEFAULT_HANDLER_TIMEOUT_MS); ack is O(run-start), not O(run-completion)
  },
});
```

ServiceManager's existing `case "handler_declare"` (`ServiceManager.ts:378`) forwards
this to `eventsApi.register({ mode:"headless", ownerId: serviceId /* "workflows" */,
declaredBy:"service", grantedNamespaces: manifest.eventNamespaces, ... })`. **After 037,
the `ownsNamespace` gate is gone, so a non-owned `eventType` registers successfully**
without any `eventNamespaces` grant (US16 AS1; FR-051). Pre-037 the same message throws
`namespace-not-owned` — logged as `handler_declare:rejected` — which is exactly the
failure the US16 e2e asserts is absent. Re-declaring the same `handlerId` is an
**idempotent upsert** (`api.ts` `register()` preserves a previously-set `enabled`), so
service restart is safe (US16 AS5).

### 12.2 Invoked — `event_dispatch` (Main→Worker)

When the kernel emits an event whose type matches a registered workflow trigger, it
dispatches to the service over the existing `event_dispatch` channel. Exact
`EventDispatchPayload` (`src/core/service/types.ts`):

```js
{ type: "event_dispatch", payload: {
    callId:    "evt-call-<ts>-<n>",   // exactly-once-settle guard (dispatch.ts nextCallId)
    eventId:   record.id,             // the 034 event's id
    handlerId: `workflows:${eventType}`,
    record:    { id, type, payload, source, ts, sequence, summary },  // EventRecord
} }
```

The service's `event_dispatch` handler (new `events.js`) does **exactly** this, then
acks — it does **not** wait for the run:

1. Resolve which workflow(s) to start: every workflow whose `triggers` array contains
   `record.type` (exact match; FR-041). A type shared by N workflows starts N runs.
2. For each matching workflow, **start a fire-and-poll run** (§13) with provenance
   `startSource: "event"`, `triggerEventId: record.id`, `triggerEventType: record.type`,
   and `eventContext: record.payload` (FR-041/FR-042).
3. **Ack immediately** over loopback (NFR-007 — ack on run *start*, not completion):

```js
await fetch(`${ORIGIN}/api/events/${encodeURIComponent(eventId)}/ack`, {
  method: "POST", headers: { "content-type": "application/json" },
  body: JSON.stringify({ handlerId, callerId: "workflows", callId, result: { startedRuns: runIds } }),
});
```

`callerId: "workflows"` must equal the handler's `ownerId` (it does — ServiceManager
sets `ownerId: serviceId` = `"workflows"`), so the **unchanged** ack-ownership check
passes. `callId` is echoed so `dispatch.ts settleAck` matches the exact outstanding
attempt (not a superseded retry). If no workflow matches (shouldn't happen — the type is
registered precisely because one declared it), ack with `result: { startedRuns: [] }`.

### 12.3 Emit — `event` node (loopback `POST /api/events`)

An `event` node emits via the same loopback `emit` the 034 routes use (verified
`src/app/api/events/route.ts` `POST` → `api.emit` → 201):

```js
await fetch(`${ORIGIN}/api/events`, {
  method: "POST", headers: { "content-type": "application/json" },
  body: JSON.stringify({
    type:    nodeConfig.eventType,              // must be com.bos.workflows.* (FR-048b, validate-only)
    payload: { ...resolvedUserPayload, _wf: {   // FR-047 provenance envelope
                 workflowId, runId, nodeId, triggerEventId? } },
    source:  { appId: "workflows", name: "Workflow Manager" },  // FR-047 source.appId
  }),
});
```

Response (201): `{ id, sequence, ts, processing, read, activeHandlers }`. The node
**completes when the emit HTTP returns** (FR-046) — the kernel's emit is a shard append
that does **not** await handler completion (`kernel.ts` `emit()` → `dispatchEmittedEvent`
enqueues, never awaits), so this is well within the 30s node timeout (NFR-008).
Emitted events are queryable via `query_events`/Event Viewer (SC-026).

### 12.4 Discovery — `GET /api/events/handlers`

`workflow_event_types` reads the in-memory grouped registry (verified
`src/app/api/events/handlers/route.ts` `GET` → `api.listHandlersGrouped()` →
`Record<eventType, { headless: HeadlessHandlerView[], ui: UiHandlerView[] }>`). Each
`HeadlessHandlerView` carries `{ handlerId, displayName, icon?, enabled, timeoutMs,
recentFailures, ownerId }` (kernel.ts `listHandlersGrouped`). No disk I/O on the hot
path (NFR-009). Mapping to the tool response: §13.4.

## 13. Behavioral design (the five key questions)

### 13.1 Trigger-union derivation & maintenance (FR-040)

**The `triggers` arrays in the workflow JSON are the single source of truth — no
separate subscription store** (spec Key Entities: `EventTrigger`; US16 AS5). The union
is always re-derived:

```text
deriveTriggerUnion():
  types = Set()
  for wf in readAllWorkflows():            # real VFS /Workflows/*.json via loopback /api/fs
    for t in (wf.triggers ?? []): types.add(t)   # absent/empty ⇒ contributes nothing (FR-039)
  return types

reconcileSubscriptions():                  # called on start AND after every create/modify/delete
  target = deriveTriggerUnion()
  current = declaredHandlerIds()           # in-memory Set of handlerIds the service believes are live
  for t in (target - current):  emit handler_declare(t)        # 12.1
  for t in (current - target):  loopback POST /api/events/unregister { handlerId: workflows:t, ownerId: "workflows" }
  declared = target
```

Notes:
- **No `handler_unregister` worker-IPC message exists** (verified: `WorkerToMainMessage`
  has only `handler_declare`). Removal therefore goes over loopback
  `POST /api/events/unregister` (`src/app/api/events/unregister/`), the same transport
  the service already uses for ack/emit. Owner check on unregister (`ownerId ===
  "workflows"`) passes by identity.
- **Stable `handlerId = workflows:<eventType>`** makes re-declare an idempotent upsert
  and makes removal trivially addressable. A deterministic id is also what lets
  `enabled` (user toggled in Settings → Configuration) survive a service restart's
  re-declare — `api.register()` preserves it.
- **Catch-up is free.** `kernel.register()` calls `dispatch.catchUpHandler(reg)` for
  headless handlers, so a (re-)declared type immediately re-dispatches any *pending*
  events of that type that were emitted while the service was down (034 FR-005b).
  This is the at-least-once guarantee the service inherits without any code of its own.
- **Timing:** run `reconcileSubscriptions()` once after `initialized` (start), and
  synchronously inside each of the `workflow_create`/`workflow_modify`/`workflow_delete`
  handlers after the VFS write succeeds. CRUD is already serialized per-service by the
  tool-call model, so no extra locking is needed for the derive-diff-declare sequence.

### 13.2 `eventContext` injection (FR-042)

**Decision: a field on the run record, consumed by root-node input assembly — NOT a
synthetic graph node.** (ADR-10.)

- The run record (already a first-class persisted entity, §6/ADR-9) gains:
  ```json
  { "startSource": "event", "triggerEventId": "…", "triggerEventType": "…", "eventContext": { /* the triggering event's payload, verbatim */ } }
  ```
  For agent-initiated runs these fields are absent (`startSource` defaults to
  `"agent"`). `eventContext` is persisted with the run, so it is **auditable** and
  visible in the node trajectory panel (FR-026) — the debugging surface already exists.
- **Mechanically**, the engine's input-assembly step (the one that builds a node's
  prompt from upstream outputs, per §3.4.2/FR-035) special-cases the run's **root
  nodes** (nodes with no dependencies) on an event-triggered run: it appends the
  `eventContext` as structured input, e.g.
  `"Triggering event (com.bos.gsuite.email.received): <JSON of eventContext>"`, so the
  first node's agent can use the event data. This is an additive prompt section, not a
  new node, so it cannot perturb DAG structure, routing selection (FR-018/029/031), or
  the concurrency cap.
- **Why not a synthetic "input" node:** it would require graph surgery (a node not in
  the user's JSON), complicate the selection/propagation rules, and contradict the
  spec's framing ("made available to the workflow's first node(s)"). A run-record field
  read by root-node input assembly is simpler, auditable, and matches the spec.
- **Non-root nodes** do not receive `eventContext` directly — they receive it *transitively*
  through their upstream roots' outputs, exactly like any other data flow (FR-035).

### 13.3 `event` node executor + template resolution (FR-046/047/048, US18)

**Node config** (`EmitEventNodeConfig`, spec Key Entities):
```json
{ "outputType": "event",
  "eventType": "com.bos.workflows.analysis.complete",   // required; com.bos.workflows.* (FR-048b)
  "payload": { "…static…": "object" }                    // OR a template string (below)
  // "payload": "{\"summary\":\"{{research_1.summary}}\", \"rows\":{{transform.rows}}}" }
```
`payload` is **either** a JSON object (static — emitted verbatim) **or** a string
containing `{{nodeId.field}}` placeholders. `agentSource` is irrelevant to an `event`
node: it performs **no** sub-agent/LLM call, so it bypasses `executor.js`'s delegate
path entirely (it is a pure loopback emit — the cheapest possible node).

**Template-resolution algorithm.** Source data structure = the run's per-node output
map `run.outputs[nodeId]` — the same first-class structured output store FR-035
already guarantees downstream nodes read (no file handoff). Field access is a dot-path
into that node's output object.

```text
resolveTemplate(template, runOutputs):
  return template.replace(/\{\{\s*([a-zA-Z0-9_-]+)\.([a-zA-Z0-9_.\-]+)(?:\s*\|\|\s*([^}]*))?\s*\}\}/g,
    (match, nodeId, field, fallback) => {
      const node = runOutputs[nodeId];
      const val  = node ? getByDotPath(node, field) : undefined;   // §3.4.2 output map
      if (val !== undefined) return String(val);                   // scalar/stringified
      return (fallback !== undefined) ? fallback : "null";          // US18 AS3: never fails, null-or-fallback
    });
```

- **Source of values:** only *upstream, already-completed* node outputs are resolvable
  (the scheduler guarantees a node runs only after its dependencies complete, so any
  referenced node that has run is complete). A node that was **never run** (neutral/
  skipped, e.g. downstream of a failure) is absent from `run.outputs` → resolves to
  `null` (or the inline `||fallback`). **Template resolution never fails the emit**
  (US18 AS3). An unresolvable reference is logged at warn (NFR-005 — no silent swallow).
- **After resolution**, the string is `JSON.parse`d. If it is a valid JSON **object**,
  it is the user payload. If the result is not an object (e.g. the template resolved to
  a bare scalar), the node **fails** with a clear reason ("event node payload must be a
  JSON object") — this is a *config/authoring* error, distinct from a runtime
  unresolvable-reference (which yields `null` and proceeds). The static-object path
  always passes this check.
- **Provenance envelope** (`_wf: { workflowId, runId, nodeId, triggerEventId? }`) is
  added by the executor, not authored (FR-047). `triggerEventId` is present when the
  run itself was event-triggered, closing the emit→provenance chain.
- **Hard failure only on emit HTTP error** (invalid type shape, payload > 1MB,
  non-2xx) — the node then fails and the run proceeds per its on-failure policy
  (FR-038). Within NFR-008/001 (emit is O(1) shard append).

### 13.4 `workflow_event_types` tool (FR-044/045, US17)

Declared via `tool_declare` like the other 12 (so it's gated/lifecycle-managed
identically — FR-010/011). Handler: loopback `GET /api/events/handlers`, then map the
grouped registry to a flat list:

```js
// GET /api/events/handlers  →  { "com.bos.gsuite.email.received": { headless:[…], ui:[…] }, … }
const grouped = await get('/api/events/handlers');
const types = Object.entries(grouped).map(([type, g]) => ({
  type,
  headlessCount: g.headless.length,          // FR-045: count of registered headless handlers
  uiCount:      g.ui.length,
  displayName:  pickDisplayName(type, g),    // FR-045: human-readable, where available
}));
return { eventTypes: types, total: types.length };   // [] when none — NOT an error (US17 AS3)
```

`pickDisplayName`: prefer a non-workflow-owned `headless[].displayName` (stripping the
`"Workflow trigger: "` prefix if it's our own), else the first `ui[].displayName`,
else the type's last dot-segment humanized (`email.received` → "Email Received"). This
lets the assistant browse *real* registered types (including other components') when
authoring `triggers` — exactly the discovery friction US17 removes. Bounded by
NFR-009 (in-memory read).

## 14. File/module plan (delta — what this scope-add creates/modifies in the item)

All paths relative to the item root `data/user-apps/items/workflows/`. **Create** = new
module; **Modify** = additive change to an already-implemented file (001 is
Implemented & Promoted, so these are real files being extended, not stubs).

| Path | Action | Purpose |
|---|---|---|
| `services/events.js` | **Create** | The 034 integration layer: `deriveTriggerUnion()`, `reconcileSubscriptions()` (start + on CRUD), the `event_dispatch` message handler (→ fire-and-poll run + loopback ack), loopback `emit`/`ack`/`getHandlers`/`unregister` helpers (reusing the existing `vfs.js` origin + loopback pattern, §6/ADR-6). |
| `services/index.js` | **Modify** | On `initialized`: after `tool_declare`, call `events.reconcileSubscriptions()` (start path, US16 AS5). In the `worker.on("message")` switch: add `case "event_dispatch"` → `events.handleEventDispatch(payload)`. No new lifecycle; no new IPC types. |
| `services/tools.js` | **Modify** | Add the 13th tool declaration `workflow_event_types` (name, description, empty-input schema) — joins the existing 12 in one `tool_declare` batch at startup. |
| `services/handlers.js` | **Modify** | Add the `workflow_event_types` handler (§13.4). In `workflow_create`/`workflow_modify`/`workflow_delete` handlers: after the VFS write/delete succeeds, call `events.reconcileSubscriptions()` (FR-040). |
| `services/engine/node-model.js` | **Modify** | Add `"event"` to the `outputType` union; add `EmitEventNodeConfig` shape (`eventType` + `payload` object-or-template-string). `event` is orthogonal to `agentSource` (no agent needed). |
| `services/engine/executor.js` | **Modify** | Add the `event`-output branch: bypass the delegate path, run `resolveTemplate` (§13.3), loopback `POST /api/events`, complete on 201. |
| `services/engine/validate.js` | **Modify** | Add FR-048 checks: (a) `triggers[]` entries well-formed event types (`^[a-z0-9]+(\.[a-z0-9_-]+)+$`, ≤256); (b) `event` node `eventType` under `com.bos.workflows.*`; (c) every `{{nodeId.field}}` in an `event` node's template references a node that exists in the graph. |
| `services/engine/store.js` | **Modify** | Accept + persist the run-record provenance fields (`startSource`, `triggerEventId`, `triggerEventType`, `eventContext`) written by event-triggered runs (§13.2); surface them in `workflow_run_get`. |
| `app/src/main.tsx` (+ components) | **Modify** | FR-049 UI: a **Triggers** tab in the detail/editor view (list `triggers[]`, add via free text *or* a browse dropdown fed by `workflow_event_types`, remove); an **event-node config form** (event-type field + payload editor with static-JSON / template toggle and `{{nodeId.field}}` hinting). §16. |
| `skills/workflow-manager/SKILL.md` | **Modify** | FR-050: document event-triggered workflows (how to use `workflow_event_types`, set `triggers`, configure `event` nodes with type + `{{nodeId.field}}` templates), and warn about emit→trigger cycles. |
| `docs/dev/Workflows/*.md` | **Modify** | Developer docs for the 034 integration (subscription, eventContext, event node, wire shapes). `docs/usage/Workflows/*.md`: end-user "trigger a workflow by an event" page. |

**No `service.json` change required** for US16 — after 037 the service needs no
`eventNamespaces` grant (FR-051). If 037's FR-003 (field retained for documentation)
is used, an advisory `eventNamespaces: ["com.bos.workflows.*"]` may be added to
document intent — but it is **not required** and gates nothing.

## 15. The 037 platform change — file-level scope (bos-core, feature branch)

Verified against the current `src/lib/events/` source. This is the *entire* bos-core
footprint of the scope-add.

| Path (BOS source) | Action | Detail |
|---|---|---|
| `src/lib/events/api.ts` | **Modify** | In `register()`: **delete the `ownsNamespace` rejection block** — `const grants = …; if (!ownsNamespace(req.eventType, req.ownerId, grants)) throw new EventApiError("namespace-not-owned", …)` (the `grants` line + the `if`). This is the single behavioral change (037 FR-001). The rest of `register()` (idempotent upsert, `enabled` preservation) is unchanged. |
| `src/lib/events/api.ts` | **Optional (037 FR-005)** | `resolveGrantedNamespaces()` exists *solely* to feed that check — remove it, or keep it as dead code. If removed, also drop the now-unused `RegisterRequest.grantedNamespaces` *usage* (the field itself may stay accepted-and-ignored per FR-003). |
| `src/lib/events/types.ts` | **Optional (037 FR-004/006)** | `ownsNamespace()` may be removed or retained (must no longer be called to reject). The `"namespace-not-owned"` entry in `EventErrorCode`/`STATUS_BY_CODE` **must be retained** (backward-compatible error table) but is no longer thrown by any path. |
| `src/core/service/ServiceManager.ts` | **None required** | The `handler_declare` handler passes `grantedNamespaces: manifest.eventNamespaces` — after 037 this arg is harmless (ignored). Leaving it is the minimal-diff choice; dropping it is cosmetic. **Do not** touch the `event_dispatch` invoker or the ack path. |
| **Tests** | **Modify** | 034's namespace-rejection e2e/unit case (the one asserting `namespace-not-owned` for a non-owned type) is **removed or flipped to expect success** (037 SC-004). The ack-ownership test (asserting `ack-forbidden` for a cross-owner ack) is **kept unchanged** (037 US1-AS3 / SC-003) — it is the guard 037 deliberately preserves. |

**Explicitly NOT touched by 037:** `kernel.ts` (emit/dispatch/ack/registry),
`store.ts`, `dispatch.ts`, the HTTP routes, the ack-ownership check, the handler
registry data model, and the response shapes — 037 NFR-001. Registration response
shape and dispatch/ack semantics are unchanged; only the rejection path disappears.

**Backward-compatible:** handlers registered under their own namespace keep working;
the only behavior change is that previously-rejected (non-owned) registrations now
succeed (037 Assumptions). No migration (NFR-002).

## 16. UI mockup reference (delta — where the additions fit)

`mockup.html` (same spec dir) is the baseline for the 001 views (List / Detail / Run /
History). FR-049 adds two surfaces, both in the **Detail/editor view** (`#view-detail`)
and the run/history node panels:

1. **Triggers tab** — a new tab in the detail view's tab strip
   (`Steps · Dependencies · Config · **Triggers**`). Lists the workflow's
   `triggers[]` as chips with a remove (×). **Add** is a two-mode input: free text
   (for a known type string) *or* a **browse dropdown** populated by calling
   `workflow_event_types` (US17's tool — the app reaches it via the service over
   `window.__bos`, same broker as the other 12 tools). Selecting a browse entry inserts
   its `type` string. This is the discovery affordance US17 exists for — the user never
   has to type a dot-separated type by hand. A workflow with no `triggers` shows an
   empty state ("Not event-triggered"). Editing Triggers persists via `workflow_modify`
   (and re-triggers `reconcileSubscriptions()` on the service, FR-040).
2. **Event-node config form** — when an `event`-outputType node is selected in the
   editor (the graph's node-configuration surface), a config panel shows:
   - **Event type** field (free text; validated to `com.bos.workflows.*` live, mirroring
     FR-048b — show the same error the `workflow_validate` tool would).
   - **Payload editor** with a **static JSON / template** toggle. Static mode: a JSON
     object editor. Template mode: a text editor with `{{nodeId.field}}` placeholder
     hinting (auto-completion of node ids from the current graph, per FR-048c) and a
     live "resolved preview" showing what the payload would look like for the last
     known node outputs.

The run/history **node trajectory panel** (FR-025/026, already in the mockup) needs one
additive element for an event-triggered run: the run's header/provenance block shows
`startSource: event` + `triggerEventType` + `triggerEventId`, and the **root node's**
"Executed prompt" section (FR-026) displays the appended `eventContext` — so the user
sees *which* event started the run and *what* the first node was told. No new panel; it
reuses the existing trajectory rendering.

## 17. ADRs (this scope-add)

### ADR-10 — `eventContext` is a run-record field consumed by root-node input assembly, not a synthetic node
- **Context:** FR-042 must make the triggering event's payload available to the
  workflow's first node(s). Options: (a) a synthetic "input" node prepended to the DAG;
  (b) a field on the run record that the engine's root-node input-assembly reads.
- **Decision:** (b). The run record already is a persisted, auditable entity (ADR-9);
  adding `eventContext` there makes it inspectable in the trajectory panel for free.
  Root-node input assembly (the existing prompt-building step, §3.4.2) appends it as a
  structured section.
- **Consequences:** No graph mutation ⇒ no interaction with routing/selection
  (FR-018/029/031) or the concurrency cap; non-root nodes receive the event data
  transitively through outputs (FR-035). Simpler than (a), which would require
  reconciling a node that isn't in the user's JSON against validate/router/scheduler.

### ADR-11 — Stable `handlerId = workflows:<eventType>`; subscribe via worker IPC, unsubscribe via loopback
- **Context:** The union is re-derived on start and on every CRUD (FR-040). We need
  (a) idempotent re-declare across restarts, (b) preservation of a user-set `enabled`
  toggle, (c) an addressable handle for removal. `WorkerToMainMessage` offers only
  `handler_declare` (no unregister); `POST /api/events/unregister` exists over loopback.
- **Decision:** `handlerId = workflows:<eventType>` (deterministic ⇒ upsert-idempotent,
  `enabled`-preserving per `api.register()`). Add via `handler_declare` (IPC); remove via
  loopback `POST /api/events/unregister`.
- **Consequences:** Restart is safe (US16 AS5); a user disabling a trigger in Settings
  survives restart; removal is exact. The only asymmetry (add=IPC, remove=loopback) is
  forced by the fixed IPC vocabulary, and both use the same single-container identity.
  Alternative rejected: a manifest-declared `eventNamespaces`/static handler list —
  can't express a *dynamic* union that changes with workflow CRUD.

### ADR-12 — `event` node is a pure loopback emit (no agent/LLM), orthogonal to agentSource
- **Context:** US18's `event` node just publishes an event. Options: (a) run it through
  the same delegate path as other nodes (spawn an agent to "emit"); (b) a dedicated
  no-agent branch that resolves the template and does one loopback `POST /api/events`.
- **Decision:** (b). Emitting an event needs no LLM/reasoning; (a) would add latency,
  cost, and a failure mode for a deterministic action.
- **Consequences:** `event` is the cheapest node type; it always completes in well under
  the 30s timeout (NFR-008). `agentSource` is simply unused for this output type. This
  is consistent with the node model's two orthogonal axes (§3.4.2) — an `event` node has
  an output type but no meaningful agent source.

### ADR-13 — Build order: 037 lands before (or is merged into) the item's US16; US18 is independent of 037
- **Context:** US16's *subscription* to non-owned types is rejected by the pre-037
  `ownsNamespace` gate. US18's *emit* has no such gate. Both the 037 spec and this
  scope-add name the shared branch `bos/002-workflow-event-integration`.
- **Decision:** They are developed on **one shared feature branch** and promoted
  together. Within it, **037 is landed first** (it is small, self-contained bos-core);
  the item scope-add's US16 e2e ("subscribe to a non-owned type, emit, run starts") is
  run **against 037 present**. US17 (discovery) and US18 (emit node) do **not** depend
  on 037 and can be built/tested in parallel with it — only US16's *non-owned*
  subscription assertion is gated on 037 being active.
- **Consequences:** The two delegations (bos-core 037 via `dev_delegate` on the branch;
  item scope-add via `agent_delegate` contentOnly + `app_build`) are never conflated,
  but they promote as one unit. A developer who builds the item scope-add on a branch
  *without* 037 will see US16's non-owned-subscription test fail with `namespace-not-owned` —
  that is the expected, correct signal that 037 is not yet in place, not an item bug.

### ADR-14 — Emission namespace restriction is an item policy (`workflow_validate`), not a platform gate
- **Context:** FR-048b requires `event` nodes to emit under `com.bos.workflows.*`. The
  034 platform imposes **no** emission namespace check (verified `api.emit()`). So this
  restriction must be enforced *somewhere*.
- **Decision:** Enforce it in the item's `workflow_validate` (author-time) and surface
  the same check live in the event-node config form (§16) — **not** in the platform. The
  `source.appId: "workflows"` already marks provenance, so the restriction is for
  clarity, not security.
- **Consequences:** A mis-authored `event` node pointing at a foreign type is caught at
  validate/edit time, not at emit time. Keeps the platform's open pub/sub model
  intact (037's direction) while giving workflows a sane default. (Contrast: *subscription*
  is deliberately unrestricted after 037 — the asymmetry is intentional: emit provenance
  is a policy, subscription access is a platform capability.)

## 18. Risks / open questions (this scope-add)

1. **Emit→trigger cycles (authoring hazard, not a platform limit).** If workflow A
   emits `com.bos.workflows.x.done` and *subscribes* to it (or A emits a type A itself
   triggers on), runs chain indefinitely. The service does not (and per 037 *cannot*
   safely) prevent this — it is author error. **Mitigation:** `workflow_validate`
   (FR-048) and the skill (FR-050) **warn** when an `event` node's `eventType` intersects
   the same workflow's (or a reachable one's) `triggers`. **Open:** how aggressive the
   cycle warning is (same-workflow only vs. transitive across workflows) — decide at
   implement; same-workflow is the cheap, high-value first cut.
2. **Fan-out on a shared trigger type.** One event type matching N workflows starts N
   concurrent runs (§13.2/FR-043). This is correct per spec but can be surprising if a
   user shares a trigger type across many heavy workflows. **Open:** document in the
   skill that a trigger type is a *broadcast* to all declaring workflows. No code change
   expected.
3. **`eventContext` size.** The triggering event's payload is ≤1MB (034 `MAX_PAYLOAD_BYTES`),
   so `eventContext` is bounded. But a *large* eventContext in a root node's prompt can
   bloat the delegate call. **Mitigation:** input-assembly should summarize/truncate a
   very large `eventContext` in the prompt while keeping the full payload available via
   the run record (auditable). **Open:** the truncation threshold — implement detail.
4. **Template `getByDotPath` semantics on arrays.** `{{node.results.0.name}}`-style
   numeric segments — confirm the dot-path helper treats numeric segments as array
   indices (it should). Edge, implement-time.
5. **037 test-suite impact.** Removing the `ownsNamespace` gate may break any 034 test
   that *asserts* `namespace-not-owned` (037 SC-004). These must be flipped to expect
   success; the `ack-forbidden` test is kept. Build Studio should confirm no other test
   depends on the subscription gate before merging 037.
6. **Self-consistency (pre-empting review).** Verified for both Job-1 failure modes:
   **(1)** the service imports **no** `src/lib/...`/`@/...` module — it reaches the 034
   system exclusively over worker IPC (`handler_declare`/`event_dispatch`) and loopback
   HTTP (`/api/events*`), the same pattern as the existing `vfs.js`/`executor.js` bridges.
   **(2)** the service does **not** hand-roll any credential/token scheme — there is no
   headless *client* here to authenticate; the service is a handler *callee* that acks
   with `callerId: "workflows"` matching its `ownerId` (validated by the *unchanged*
   ack-ownership identity check, not a minted secret). Both are clean.

## 19. Success-criteria mapping (this scope-add)

| SC | Design anchor |
|---|---|
| SC-024 (run starts < 5s of emit) | §12.2 dispatch→run is synchronous fire-and-poll; `reconcileSubscriptions` keeps handlers live; kernel emit→dispatch is in-process. |
| SC-025 (event_types == registered handlers, 100%) | §13.4 reads `GET /api/events/handlers` (the registry itself) — no independent source to drift. |
| SC-026 (event node: exactly one emit, correct type/source/payload) | §12.3/§13.3 — one `POST /api/events` per node execution; `source.appId:"workflows"` + `_wf` envelope. |
| SC-027 (no false-positive runs) | §12.2 exact-type match on `record.type` against `triggers` (§13.1) — no prefix/payload matching. |
| SC-028 (concurrent runs independent) | §13.2/FR-043 — each matching event starts a new run; no coalesce/queue; run-record provenance disambiguates. |

---

# §20 Scope-Add 003 — Historical Runs Table with Selection + Bulk Delete (US19, FR-052–FR-055)

> **Addendum, not a rewrite.** §1–§19 are the converged, implemented design (001 engine pivot
> **Implemented & Promoted 2026-08-21**; 002 event-integration addendum §9–§19). This section is
> the authoritative structural design for the 2026-09-09 scope-add: a workflow's historical runs
> become a **datetime-sorted table** (US19/FR-052) with **per-row + select-all checkboxes**
> (FR-053) and **bulk delete** of the selected runs (FR-054), backed by one new service-declared
> tool **`workflow_run_delete`** (FR-055). It **extends** the installed `workflows` item's service
> and app facets in place; it does **not** re-derive the engine, the VFS bridge, the execution
> contract, the tool surface, or the run-persistence model those earlier sections already
> settled. **No new target shape, no new bos-core change, no new dependency, no new persisted
> field.** The binding UI contract is `mockup.html` (the `#view-detail` "Historical runs"
> block) — §20.7.

## 20.1 Classification (delta)

**`marketplace-item` (the `workflows` item, in place) — app facet + service facet of the SAME
item.** This **agrees exactly** with spec.md's `App Target: marketplace-item` field and with the
001/002 classification. The delta touches only:
- **service facet** — one new tool declaration (`workflow_run_delete`) + one new handler that
  deletes run-log files over the existing loopback `/api/fs` bridge;
- **app facet** — the historical-runs surface changes from a plain selector (FR-017) to a
  datetime-sorted, selectable table with a bulk-delete action (FR-052/053/054).

There is **no `bos-core` deliverable in this scope-add** (unlike 002's 037). The 039
service-tool-bridge, worker IPC, and the `/api/fs` loopback are all **already implemented and
unchanged** — the new tool rides them exactly like the existing 13. This is the single-target
shape; Build Studio schedules it as one `agent_delegate` (`contentOnly`) → `app_build`
(contentOnly trip-wires + `data/user-apps` branch-coupling per `target-marketplace-item.md`),
no `dev_delegate`.

## 20.2 Constitution check (delta)

| Principle | Compliance (this scope-add) |
|---|---|
| **II. Server Authority & SSR Boundary** | Complies. The delete runs **in the worker**; it reaches the VFS **only** over the existing loopback `/api/fs` bridge (`POST { op:"delete", path }`), the same call the run persistence already makes (ADR-2). The worker imports **no** `@/` module and hand-rolls **no** VFS logic (path-traversal protection, mount routing) — it sends one `op:delete` per run id. The app reaches the service **only** over `window.__bos.services.call` (the 028 broker) — never a direct cross-origin fetch to the service port. |
| **IV. Minimize Blast Radius** | Complies. Item-internal, additive. One tool added to the existing `tool_declare` batch; one handler added; the table replaces the existing selector in the app. **No `service.json` change, no capability change, no bos-core file touched.** |
| **V. The VFS Is Not the Source** | Complies — the delete **targets the real-VFS run-log location** `/Workflows/.runs/<workflowId>/<runId>.json` (ADR-9), never a host path, and **only that location** (the workflow definition at `/Workflows/<id>-workflow.json` is a different path and is never touched). |
| **VI. Specs & Docs Stay in Sync** | Complies (flagged for implement). The item's `skills/workflow-manager/SKILL.md` + `docs/dev/Workflows/*` + `docs/usage/Workflows/*` must document the runs table, the delete action, and the new `workflow_run_delete` tool (its name, schema, and result shape). |
| **VII. Respect Boundaries** | Complies. Item files stay under `data/user-apps/items/workflows/`. No `src/` file is created or modified by this scope-add. |
| **App capability surface (no new grant)** | Complies — and pinned explicitly. The app invokes the service's run-delete handler via `__bos.services.call` (the service's own REST sub-path, see §20.8); it does **NOT** use `fs:delete` directly. No new app capability grant is required — `services:read` is already held (the broker's `CAP_FOR_METHOD["services:call"] = "services:read"`; a direct `fs:delete` would map to the ungranted `fs:write`). |

No conflicts. The only behavioral surface this adds to the *service* is one more declared tool —
which is precisely the extension 039 was built for, and which FR-014's "every lifecycle operation
is tool-reachable" principle already anticipated (extended to run history).

## 20.3 Architecture (delta)

The 001/002 Context/Container diagram is **unchanged** except that the existing app facet →
service facet arrow gains **two operations** (run listing, run delete) over the channel the app
**already uses**, and the service → real-VFS arrow gains **one delete** over the bridge the run
persistence **already uses**. Nothing new is introduced — this is a matter of naming the two
existing mechanisms and adding one operation to each.

```text
   APP facet (opaque-origin iframe)                       SERVICE facet (worker thread)
 ┌──────────────────────────────────────────┐            ┌───────────────────────────────────────┐
 │ runs table (FR-052)                        │            │  run-state.js / runs.js (EXISTING)     │
 │  · workflow_run_list  ───────────────────┐│            │    persists each run to               │
 │  · per-row + select-all checkbox (FR-053)││  __bos.    │    /Workflows/.runs/<wf>/<run>.json   │
 │  · Delete(n)  workflow_run_delete ───────┼┤  services. │         ▲ (write)      ▲ (delete)      │
 │  · row click / eye = inspect  ───────────┘│  call()     │    runs.js           handlers.js      │
 │    workflow_run_get (US10, retained)      │  (028      │              └──────────┤             │
 └──────────────────────────────────────────┘  broker,   │                         │             │
      ▲ services:read cap                                 │   workflow_run_delete  │ (NEW handler) │
                                                         │   (FR-055)              │             │
   ASSISTANT (039 path, separate)                         └───────────┬─────────────┘             │
 ┌────────────────────────────┐ tool_call/worker-IPC                  │ loopback /api/fs          │
 │ service-tool-bridge.invoke │──────────────────────────────────────▶│ op:"delete"              │
 │ (schema-validated, gated)  │  (same handler, 039 face)             ▼                             ▼
 └────────────────────────────┘                              ┌─────────────────────────────────────┐
                                                             │  /api/fs (BOS main thread, EXISTING)  │
                                                             │  real VFS /Workflows/.runs/<wf>/<id>  │
                                                             └─────────────────────────────────────┘
```

(Note: on the diagram's service→VFS `op:"delete"` arrow, `/api/fs` is EXISTING — but the run-delete **handler + the service REST route** the app reaches via `__bos.services.call` are **NEW** to this scope-add; the implemented service has no per-run delete today, so this is a new route, not an existing one. See §20.4.1.)

**The two invoke faces converge on ONE handler.** This is the single most important structural
fact of the scope-add, and it resolves the "which mechanism does the app use?" question:

- **App → service:** the opaque-origin app's only channel to *invoke* the service is
  `window.__bos.services.call(id, path, init)` (028). It already uses this for
  `workflow_run_list`/`workflow_run_get`. **Bulk delete uses the same call.** This is **not**
  the 039 worker-IPC `tool_call` path — that is assistant-only (`src/lib/agent/
  service-tool-bridge.ts` `invoke()`), and an iframe cannot emit `tool_declare`/`tool_call`
  over worker IPC (it has no `parentPort`).
- **Assistant → service:** the 039 path — the service declares `workflow_run_delete` via
  `tool_declare` (FR-001), BOS validates the args against its `inputSchema` and dispatches a
  `tool_call` over worker IPC (FR-003/FR-010 gating, FR-011 lifecycle cleanup).

Both faces route to the **same service-side handler** (the run-delete function in
`handlers.js`), so there is one delete implementation with two entry points — no divergence
between what the UI can do and what the agent can do (the same "one live state, two consumers"
principle 001 applied to a write operation).

## 20.4 Service facet (delta) — `workflow_run_delete`

### 20.4.1 Where it slots into the `tool_declare` surface

The existing 001 surface declares 12 tools; 002 added the 13th (`workflow_event_types`). This
scope-add adds the **14th**: `workflow_run_delete`. It is declared **the same way** — one
`tool_declare` in the startup batch (`services/index.js` → the `tool_declare` handling in
`src/core/service/ServiceManager.ts` `case "tool_declare"`), filed under the **same single
tool group** (`workflows`) the other 13 use, so 041's `registerTool` group-resolution
(`service-tool-bridge.ts`) needs no change.

**NEW operation — not an existing one:** unlike the 13 existing tools, `workflow_run_delete` is a **NEW** operation — the implemented service currently has no per-run delete; this scope-add introduces it as both a `tool_declare`d tool (assistant face) and a REST route on the service (app face, reachable via `__bos.services.call`). The existing `workflow_delete` tool (which removes an entire workflow and all its runs) is unchanged and is a different operation with a larger blast radius.

**Disambiguation against FR-002's existing `delete`:** FR-002's tool list names a
`workflow_delete` — that deletes a **WORKFLOW** (its definition + all its runs). `workflow_
run_delete` deletes one or more **RUNS** of a workflow and **leaves the workflow definition
intact** (FR-054). They are different operations with different blast radius and must not be
merged. The spec's FR-002 list is being extended (it does not yet name run-level delete);
this design adds `workflow_run_delete` to that list's tool surface. The skill + docs must keep
the two names distinct (FR-050/VI).

### 20.4.2 Input JSON-schema (strict — FR-003)

```json
{
  "type": "object",
  "properties": {
    "workflowId": { "type": "string", "minLength": 1 },
    "runIds": {
      "type": "array",
      "items": { "type": "string", "minLength": 1 },
      "minItems": 1,
      "uniqueItems": true
    }
  },
  "required": ["workflowId", "runIds"],
  "additionalProperties": false
}
```

- **`workflowId` is REQUIRED.** This is the **cross-workflow run-id collision guard** (risk §20.6):
  run ids are scoped *per workflow* (they are the filename under `.runs/<workflowId>/`), so a
  bare run id is not globally unique. Requiring `workflowId` means the handler can **only ever
  resolve a path inside the named workflow's run directory** — a run id can never delete a run
  belonging to a different workflow, because the workflow id is part of the path, not an
  afterthought.
- **`runIds` is an array, `minItems:1`.** A single-run delete is a one-element array
  (`runIds: ["r1"]`). Array-only (rather than `oneOf [string, array]`) keeps the path
  resolution uniform and the schema strict — there is one normalization, not two.
- **`uniqueItems` + `minLength`** are cheap strictness that 002's `workflow_validate` already
  relies on the Ajv compile for (`service-tool-bridge.ts` compiles the schema once, reuses it
  on every invocation). Invalid calls are rejected **before dispatch** (FR-003, `invoke()`
  `if (!validate(args)) throw`).
- **`parallelSafe` is NOT set** on this tool. `serviceToolTypes.ts` is explicit: "Never set it
  on a writer" — two concurrent deletes could race on the same file. `workflow_run_delete` is a
  writer; it stays strictly sequential.

### 20.4.3 The delete operation → the real VFS (cite the existing persistence path)

The run-log location is **already fixed** by 001: each run persists to
`/Workflows/.runs/<workflowId>/<runId>.json` (spec Key Entities — *Run*; design ADR-9), via the
loopback `/api/fs` bridge (ADR-2, NFR-004). The **same loopback `/api/fs` op** the run
persistence uses to *write* (`POST /api/fs { op:"write" }`) is used here to *delete*
(`POST /api/fs { op:"delete", path }`) — no new persistence mechanism, no new VFS route. The
existing loopback origin + fetch helpers live in the service's `http-bridge.js` (001's
`vfs.js`, renamed per plan.md's path-correction note) — `workflow_run_delete` reuses that
helper's origin resolution (ADR-6: `NEXT_PUBLIC_APP_ORIGIN`/`APP_ORIGIN`, loopback
`127.0.0.1`).

**Per-step outcomes are embedded in the run-log file, not a separate file.** Spec Key Entities
defines *Run* as a single `.json` holding "per-step outcomes, and the persisted event log"
(US6/FR-015/FR-028); design ADR-9 confirms one file per run at `.runs/<wf>/<runId>.json`.
Therefore deleting that **one file removes the run log AND its per-step outcomes AND its event
log** — there is no sibling outcome file to delete. FR-054's "(+ per-step outcomes)" is
satisfied by the single `op:delete` on the run-log path.

```
for each runId in runIds:
  path = `/Workflows/.runs/${workflowId}/${runId}.json`      # workflowId from input, never derived
  # existence check first (cheap op:list/read, or rely on delete's not-found) for idempotency:
  if not exists(path):
     results.push({ runId, status: "not_found", error: `no run log at ${path}` })   # NOT an abort
  else:
     loopback POST /api/fs { op:"delete", path }
     results.push({ runId, status: "deleted" })
     # ALSO drop the run from the worker's in-memory live run-state map if present
     # (defensive — a terminal run normally has no live entry, see §20.4.4)
deleted = results.filter(r => r.status === "deleted").length
return { workflowId, deleted, results }                       # JSON-stringified by the 039 bridge
```

**"Workflow definition untouched" guarantee, made explicit:** the run-log path
`/Workflows/.runs/<workflowId>/<runId>.json` is a **different, disjoint path** from the workflow
definition path `/Workflows/<id>-workflow.json` (spec Key Entities — *Workflow* vs *Run*; ADR-2).
The delete resolves **only** the run-log path from `(workflowId, runId)`; it never reads, writes,
or deletes the workflow JSON. The two share the `/Workflows/` prefix but the `.runs/` subpath is
the sole thing touched. The app's post-delete flash (mockup `#runs-delete-note`) states exactly
this: "Deleted N run logs from `/Workflows/.runs/` — workflow definition untouched."

### 20.4.4 Idempotency + in-progress safety

- **Deleting an already-deleted run is a no-op, not an error.** If the run-log file does not
  exist (already deleted, or never existed), the handler records `{ status:"not_found" }` for
  that run and **continues** with the rest — the batch does not abort, and `not_found` is **not**
  counted in `deleted`. Calling `workflow_run_delete` twice with the same `runIds` returns the
  same outcome the second time as `{ deleted:0, results:[…not_found…] }` (idempotent in the
  sense that it is safe to retry and leaves state unchanged). `deleted` counts only runs whose
  log file **actually existed and was removed** — the honest number (SC-030: "correct deleted
  count").
- **In-progress runs are not deletable, by construction.** 001's run persistence (ADR-9) writes
  the run-log file **on completion/failure/cancel** — a terminal event. A run that is still
  executing lives only in the worker's in-memory live run-state map (`engine/run-state.js`),
  **not** as a persisted terminal run-log. So an in-progress run id has **no file** at
  `.runs/<wf>/<runId>.json` — attempting to delete it resolves to `not_found`, a no-op, with
  **no risk of deleting a half-written log**.
- **`workflow_run_list` (the table's source) returns only terminal runs** (FR-016: "list
  **historical** runs"). The app's table is built from `workflow_run_list`, so an in-progress run
  is **not a row** and cannot be selected (ADR-17). The in-progress rule is thus enforced twice:
  not selectable in the UI, and a server-side `not_found` no-op if an agent calls the tool with a
  live run id. (The live run is still reachable/inspectable via `workflow_status`/`run_get` and
  cancellable via `workflow_cancel` — those are unchanged.)

### 20.4.5 Result shape (FR-055: deleted count + per-run errors)

```json
{
  "workflowId": "wflow-datapipeline",
  "deleted": 2,
  "results": [
    { "runId": "run-123", "status": "deleted" },
    { "runId": "run-456", "status": "deleted" },
    { "runId": "run-789", "status": "not_found", "error": "no run log at /Workflows/.runs/wflow-datapipeline/run-789.json" }
  ]
}
```

`status` ∈ `{ "deleted", "not_found", "error" }`. `deleted` = count of `status:"deleted"`.
`"error"` is reserved for an actual I/O failure of the `op:delete` (distinct from the expected
`"not_found"`). Over the 039 path, `service-tool-bridge.ts` `invoke()` JSON-stringifies this
object for the assistant (`typeof outcome.result === "string" ? … : JSON.stringify(…)`); over the
app path, `__bos.services.call` already returns the parsed JSON body (IframeApp.tsx
`services:call`). The **app consumes this to update the table** (§20.5.3).

## 20.5 App facet (delta) — the runs table

The app already reads runs via `workflow_run_list` and inspects via `workflow_run_get` (001
FR-016/017, 002 §16). The change is confined to the **detail view's historical-runs block**: it
becomes the datetime-sorted table below. All state is **ephemeral client state** (the mockup's
module-level JS: `RUNS`, `runsSelected`, `currentHistory`) — **nothing is persisted**, and
**no new field is stored** (§20.6/data-model).

### 20.5.1 Data source + sort (FR-052)

- `RUNS` = the `workflow_run_list` result for the current `workflowId` (fetched via
  `__bos.services.call("workflows", …)` — same call as today).
- **Sort client-side by the run's start datetime, descending** (most recent first) — the
  mockup's "sorted: datetime ↓" chip. The run entity already carries start/end timestamps
  (Key Entities), so this is a pure `sort` on an existing field; the service needs no change to
  the `run_list` shape. (If `run_list` already returns datetime-desc, the client sort is a
  no-op — idempotent either way.)
- **Minimum columns** (FR-052): **Datetime** (start ts, `time · date`), **Run** (run id, shown
  as `#<id>`), **Final state** (chip). **Duration** is a **derived extra** column =
  `end − start` computed at render time — it is **not** stored and **not** a new field (the
  mockup's `dur` field).
- **Empty state:** a workflow with no terminal runs shows an empty table (the header + a
  "no runs yet" row); the Delete button stays disabled.

### 20.5.2 Selection state + select-all indeterminate (FR-053)

Held in client state, mirroring the mockup exactly (`runsSelected = new Set<runId>()`,
`updateSelectAll`):

```
total   = RUNS.length
selected = runsSelected
# header select-all checkbox (id: run-selectall):
  .checked        = total > 0 && selected.size === total
  .indeterminate  = selected.size > 0 && selected.size < total     # the partial-selection state
# row checkbox (per run id): toggle add/remove that id in `selected`
# header click (toggleSelectAll): if selected.size === total → clear; else → add every id
```

This is the **indeterminate** behavior FR-053 requires: unchecked-but-indeterminate when some
(not all) rows are selected; checked when all are; unchecked when none are.

### 20.5.3 Delete action (FR-054) — and how it invokes the service

**Mechanism (chosen, and why):** the Delete button invokes **`workflow_run_delete` over the
existing `__bos.services.call` REST-bridge path** — the same channel the app already uses for
`workflow_run_list`/`workflow_run_get`. It does **not** route through the assistant and it does
**not** open worker IPC. Rationale: (a) it is *consistent with how the existing app drives the
service* (all 13 current app→service operations already go through `__bos.services.call`;
002 §16 says the app "reaches it via the service over `window.__bos`, same broker as the other
12 tools"), and (b) it is the *only* invoke channel an opaque-origin iframe has
(IframeApp.tsx). The `tool_declare`d `workflow_run_delete` (FR-055) is the **assistant's** 039
face of the same handler — the app and the agent reach the same delete two different ways,
by design.

**No new capability grant:** `__bos.services.call` requires `services:read` (IframeApp.tsx
`CAP_FOR_METHOD`), which the app **already holds** to drive `run_list`/`run_get`. Bulk delete
reuses it — no `service.json`/manifest change.

**Flow** (mockup `deleteSelectedRuns`):
1. If `selected.size === 0` → no-op (the button is disabled anyway — §20.5.4).
2. Call the service: `__bos.services.call("workflows", "<run-delete endpoint>", { method:"POST", body:{ workflowId, runIds:[…selected] } })` → the §20.4.5 result.
3. On result: remove the rows whose `status === "deleted"` from `RUNS` (rows disappear —
   FR-054); clear `selected`; update the select-all + Delete button.
4. **Inspect-collision handling:** if the **currently-inspected** run (`currentHistory`, the
   violet-tinted row) was among the deleted, close the history view (`go("detail")`) — the mockup
   does exactly this (`if (deletedOpen) go('detail')`), so the user is not left looking at the
   replay of a run whose log is now gone (risk §20.6).
5. Show the `#runs-delete-note` flash: "Deleted N run logs from `/Workflows/.runs/` — workflow
   definition untouched." For any `not_found`/`error` in `results`, surface them in the same
   note (so a partially-failed batch is not silently treated as fully successful).

**Inspect stays independent of selection (FR-052/FR-017 retained):** row **click** and the **eye**
button both call `openHistoryRun(id)` → `workflow_run_get` → the graph + node trajectory replay
(US10). This is a **read**, orthogonal to the checkbox's **delete-selection** — checking a box
never inspects, and inspecting never checks a box (the mockup's note calls this out explicitly).

### 20.5.4 Delete(n) enable/disable (FR-054, mockup contract)

`runs-delete-btn` is `disabled` **iff** `selected.size === 0`; its label shows the count
(`Delete (n)`, id `runs-delete-count`); a `title` tooltip explains the disabled state ("Select at
least one run to enable delete") and, when enabled, states the blast radius ("Delete N selected
run(s) (run logs only — workflow definition untouched)"). This is the "no-op/disabled when
nothing is selected" of FR-054 — the button is **disabled** (not merely a no-op) so the state is
visually unambiguous.

## 20.6 Data model (delta) — NO new persisted fields

**This scope-add adds zero persisted fields.** Everything the table needs is already on the *Run*
entity (spec Key Entities; ADR-9):

| Table column | Source | Stored? |
|---|---|---|
| Datetime | Run **start** timestamp | yes (existing) |
| Run (id) | Run **runId** | yes (existing) |
| Final state | Run **final state** (completed / failed / cancelled / completed_with_warnings) | yes (existing) |
| Duration | **derived**: `end − start` at render time | **no — derived** |
| Selection (checkbox) | **ephemeral app state** (`runsSelected` Set) | **no — not persisted** |
| Inspected row (violet tint) | **ephemeral app state** (`currentHistory`) | **no — not persisted** |

**Explicit instruction to implement:** do **not** add a `stepCount`/`duration` column to the
run-log JSON, and do **not** persist selection/inspection state. Duration is `end − start`;
selection and the inspected-run marker are client state that resets on reload (matching the
mockup). The run-log file schema is **unchanged** by this scope-add.

**Delete-path note (pinned, see §20.2):** the app invokes the service's run-delete handler via `__bos.services.call` (path: the service's own REST sub-path, see §20.8); it does **NOT** use `fs:delete` directly. No new app capability grant is required — `services:read` is already held.

## 20.7 Integration points (delta — existing mechanisms merely CALLED, not modified)

| Mechanism | Real route/file | Called for (this scope-add) |
|---|---|---|
| **039 service-tool-bridge** (assistant face) | `src/lib/agent/service-tool-bridge.ts` (`registerTool` Ajv-validates + registers; `invoke` re-validates FR-003, dispatches, JSON-stringifies result), `src/core/service/serviceToolTypes.ts` (`ToolDeclaration {name, description, inputSchema, group?, parallelSafe?}`, `ToolInvocation/Result`), `src/core/service/ServiceManager.ts` `case "tool_declare"` (L341) | Declaring `workflow_run_delete` (14th tool, same `workflows` group, `parallelSafe` unset); schema-validation before dispatch; allowlist/deferred **gating like the other tools (FR-010)**; removal on stop/uninstall (FR-011). |
| **App→service REST-bridge broker** (app face) | `src/components/apps/IframeApp.tsx` (`CAP_FOR_METHOD["services:call"] = "services:read"`; the `services:call` case resolves `httpPath`/`runtime.port` via `GET /api/services/<id>/config` then fetches the service's own port in the trusted frame), `src/lib/iframe-sdk/index.ts` (`services.call(id, path, init)`) | The table's `run_list`, the delete's `run_delete`, and inspect's `run_get` — all the app's operations on the service. **`services:read` already granted**; no new grant. |
| **Real-VFS loopback delete** | `src/app/api/fs/route.ts` (`POST { op:"delete", path }`), `src/os/vfs.ts` | Removing each run-log file at `/Workflows/.runs/<wf>/<runId>.json`. Same op the run persistence uses for write (ADR-2). Path-traversal protection + mount routing handled by `/api/fs`, not the worker. |
| **Existing run persistence + run tools** | the item's `runs.js` / `engine/run-state.js` (001 US6/FR-015/016/017, ADR-9) + `workflow_run_list`/`workflow_run_get` handlers | The table's data source (`run_list`), the inspect path (`run_get`), and the run-log location/format the delete targets. The delete **reuses** this persistence contract; it does not redefine it. |

These are dependencies, not deliverables — none is created or modified by this scope-add.

## 20.8 Concrete file/module plan (delta — item only; built module names)

All paths relative to the item root `data/user-apps/items/workflows/`. **Modify** = additive
change to an already-implemented, promoted file (001/002 are Implemented & Promoted). Built-name
convention follows plan.md's path-correction note: the service's loopback helpers are
`services/http-bridge.js` and run state is `engine/run-state.js` (001's `runs.js` holds run
persistence).

| Path | Action | Purpose |
|---|---|---|
| `services/tools.js` | **Modify** | Add the 14th tool declaration `workflow_run_delete` — name, description, and the §20.4.2 `inputSchema` (`workflowId` + `runIds` required). Join the existing `tool_declare` batch; same `workflows` group; **no** `parallelSafe`. |
| `services/handlers.js` | **Modify** | Add the `workflow_run_delete` handler (§20.4.3–20.4.5): resolve each path as `.runs/<workflowId>/<runId>.json`, idempotent per-run delete via `http-bridge.js` `op:delete` (existence check → `deleted`/`not_found`/`error`), drop any matching in-memory live entry defensively, return `{ workflowId, deleted, results }`. **Also** expose the same handler as the service's **inbound REST** operation so `__bos.services.call` (the app face) routes to it — one function, two entry points (§20.3). |
| `services/http-bridge.js` | **Reuse (no change expected)** | Already provides loopback origin + fetch for `/api/fs`; the delete is one more `op:delete` through it. Add a delete helper only if the current helper doesn't already expose `op`-parametric calls. |
| `engine/run-state.js` | **Modify (minor)** | After a successful delete, drop the run id from the in-memory live map **if present** (defensive — terminal runs normally have no live entry, §20.4.4). No schema change. |
| `app/src/main.tsx` (+ components/CSS) | **Modify** | Replace the detail view's historical-runs **selector** with the **table** (§20.5): `workflow_run_list` → client-side datetime-desc sort; per-row checkbox + header select-all (with `indeterminate`); `Delete(n)` button (disabled when empty) → `__bos.services.call` run_delete → remove deleted rows + flash; row-click/eye → `workflow_run_get` replay (US10, retained, independent of selection); violet-tint the inspected row. Matches `mockup.html` `#view-detail`. |
| `skills/workflow-manager/SKILL.md` | **Modify** | FR-050/VI: document the runs table + bulk delete and the `workflow_run_delete` tool (name, schema, result shape), and **distinguish it from `workflow_delete`** (run vs workflow). |
| `docs/dev/Workflows/*.md` | **Modify** | Developer page: the two invoke faces (039 tool + app REST bridge) converging on one handler; the idempotent/terminal-only delete semantics; the run-log path contract. |
| `docs/usage/Workflows/*.md` | **Modify** | End-user page: how to view, select, and delete historical runs from the table; the "workflow definition untouched" guarantee. |

**No `service.json` change** (no new port, no new group, no new capability, no `eventNamespaces`).
**No `config/workflows.json` change.** **No `src/` change.** **No new dependency.**

## 20.9 ADRs (this scope-add)

### ADR-15 — Delete acts immediately, no confirm modal
- **Context:** FR-054 + the **approved** `mockup.html` both specify that bulk delete fires
  immediately on click — the mockup has no confirmation dialog; it has a disabled-when-empty
  button, a `Delete(n)` count, and a post-action success flash. A destructive bulk action usually
  warrants a confirm step.
- **Options:** (a) immediate delete (mockup-conformant); (b) a confirm modal before delete.
- **Decision:** (a) immediate. The mockup is the **binding UI contract** for this table and it
  encodes immediate delete; the delete is scoped and low-stakes (run logs are auditable
  *history*, not the workflow definition or any user data, and the workflow + its future runs are
  untouched). The disabled-when-empty button + the visible `Delete(n)` count + the blast-radius
  tooltip are the guardrails in place of a modal.
- **Consequences:** Faster UX; matches the contract implement must hit. The safety rails are
  (i) the table only lists terminal runs, (ii) selection is explicit per-row + select-all, (iii)
  the button is disabled at zero selection, (iv) the post-delete flash names what was removed and
  that the definition is untouched. If a confirm step is later wanted, it is a pure app-facet
  add (no service change) — the delete handler is idempotent (§20.4.4), so a modal adds no
  correctness, only caution.

### ADR-16 — `workflowId` is required input; the tool is workflow-scoped (run-scope guard)
- **Context:** Run ids are per-workflow (the filename under `.runs/<workflowId>/`). A bare run id
  is not globally unique, so an unscoped delete risks acting on the wrong workflow's run, or
  being ambiguous.
- **Options:** (a) require `workflowId` in the tool input; (b) accept a bare `runId` and search
  all workflows for it.
- **Decision:** (a). The handler resolves each path **only** from `(workflowId, runId)`; a run id
  cannot delete a run in another workflow because the workflow id is part of the path. (b) is
  rejected: it is ambiguous (two workflows can share a run id), slow (scans all `.runs/*`), and
  opens the exact cross-workflow-collision hole the guard exists to close.
- **Consequences:** Slightly more verbose call (`{workflowId, runIds}`), but deterministic and
  safe. The app always knows its current `workflowId` (it's on the detail view), so this costs
  the UI nothing. SC-030 ("only the named runs are removed") is met by construction.

### ADR-17 — In-progress runs are excluded from the delete table (terminal-only delete)
- **Context:** Should a run still executing be selectable/deletable? The table is "**historical**
  runs" (FR-052); deleting a half-written live log would be unsafe.
- **Options:** (a) the table lists only terminal runs (the default, from `workflow_run_list` =
  "historical runs"), and the tool no-ops (`not_found`) on any non-terminal/live run id; (b) the
  table lists live runs too, with a guard preventing their delete.
- **Decision:** (a). It follows directly from FR-016 (`run_list` = historical runs) and from
  ADR-9 (run-log is written **on** completion/failure/cancel — a live run has no persisted
  run-log file yet). The in-progress run is still fully reachable via `workflow_status`/
  `run_get` (inspect) and `workflow_cancel` (stop) — those are unchanged; only **delete** is
  terminal-scoped.
- **Consequences:** No risk of deleting a live log. Double-enforced: not a row in the table (so
  not selectable) **and** a server-side `not_found` no-op if an agent passes a live id. The rule
  is stated as: *a run is deletable iff its terminal run-log file exists*; the in-progress run is
  out of scope for delete by construction, not by an extra flag. **Normative invariant (MUST):** the service MUST NOT write the run-log file to VFS before the run reaches a terminal state (completed/failed/cancelled); the run file's existence is the sole predicate for "historical run" in `workflow_run_list` and for deletability in `workflow_run_delete`.

## 20.10 Risks / edge cases (delta)

1. **Deleting the run currently open for inspection.** The violet-tinted row is
   `currentHistory`. If it is deleted, the app closes the history view and returns to detail
   (§20.5.3 step 4, mockup `if (deletedOpen) go('detail')`) — the user is not left on the replay
   of a deleted run. No service concern (inspect is a read; the log is simply gone).
2. **Deleting while a run is still in progress.** Resolved by **ADR-17**: the table lists only
   terminal runs (so a live run isn't a row), and the tool returns `not_found` (a no-op) for any
   live run id because ADR-9 persists the run-log only at terminal state. A live run can never be
   deleted through this path; it is cancelled via `workflow_cancel` instead.
3. **Cross-workflow run id collision.** Resolved by **ADR-16**: `workflowId` is required and the
   path is `.runs/<workflowId>/<runId>.json`; a run id can only resolve inside the named
   workflow's directory.
4. **Empty selection.** The `Delete(n)` button is **disabled** at zero selection (FR-054, mockup
   `runs-delete-btn` `disabled`), and the handler's `minItems:1` schema also rejects an empty
   `runIds` array (FR-003) — defense in depth, so even a direct assistant call with `[]` is
   schema-rejected before dispatch.
5. **Partial-batch failure.** Some run ids `deleted`, others `not_found`/`error`. The handler does
   **not** abort on `not_found` (idempotency); the app removes only the `deleted` rows and
   surfaces the non-deleted ones in the flash (§20.5.3 step 5). `deleted` reports the honest
   count (SC-030). A genuine `op:delete` I/O error (`"error"`) is logged (NFR-005) and reported
   per-run — it does not crash the service (NFR-002) or the batch.
6. **`/api/fs` `op:delete` on a missing file — error vs no-op.** The handler **pre-checks
   existence** (a cheap `op:list`/read of the run directory or the file) so the idempotency
   behavior (`not_found`) is deterministic and does not depend on `/api/fs`'s delete-on-missing
   status code. **Confirm at implement** the exact `/api/fs` delete response on a missing path
   (`src/app/api/fs/route.ts`) and code the pre-check to match; if delete is already a silent
   no-op on missing, the pre-check can be dropped.
7. **Per-step outcomes as a sibling file (contingency).** This design assumes outcomes + event
   log are **embedded** in the single run-log `.json` (per spec Key Entities + ADR-9). **Confirm
   at implement** against the built `runs.js`/`run-state.js`: if the built item writes per-step
   outcomes as a **separate** sibling file, the delete must remove that too (a second
   `op:delete`, or delete the run's directory entry). The spec's data model says single file; the
   plan's path-correction note is the one signal the built item diverged from the 001 design on
   module layout, so verify the on-disk layout, not just the module names.
8. **Self-consistency (pre-empting review), both Job-1 failure modes checked.**
   **(1)** The service imports **no** `src/lib/…`/`@/…` module — the delete reaches the VFS only
   over the existing loopback `/api/fs` (`http-bridge.js`), the same pattern as run persistence;
   the app reaches the service only over `window.__bos.services.call` (028 broker) — neither side
   crosses its boundary. **(2)** There is **no** new credential/token scheme and **no** port-less
   exposure: the service still binds its own port (ADR-3) and the app still reaches it via
   `httpPath`/`runtime.port` (services.md §11, through `__bos.services.call`); the delete adds no
   new network surface at all. Both clean.

## 20.11 UI mockup reference (binding contract)

`mockup.html` (same spec dir), the `#view-detail` **"Historical runs"** block, is the binding UI
contract for this scope-add. Element→behavior map (all ids as in the mockup):

| Mockup element | Behavior | FR |
|---|---|---|
| `#runs-tbody` (one `<tr>` per run) | Rows from `workflow_run_list`, **datetime-desc**; cols: Datetime · Run(`#id`) · Final state(chip) · Duration(derived) · Inspect | FR-052 |
| `#run-selectall` (header checkbox) | `checked`/`indeterminate` per §20.5.2; click = select-all / clear-all toggle | FR-053 |
| per-row `<input type=checkbox>` | toggle that run's id in `runsSelected` (independent of row-click) | FR-053 |
| `#runs-delete-btn` + `#runs-delete-count` | `Delete (n)`; **disabled** at `n=0`; tooltip = blast radius; click → `__bos.services.call` run_delete → remove deleted rows | FR-054 |
| `#runs-delete-note` (flash) | "Deleted N run logs from `/Workflows/.runs/` — workflow definition untouched." | FR-054 |
| row **click** + **eye** button | `openHistoryRun` → `workflow_run_get` replay (graph + trajectory, US10) — **independent** of the checkbox; the violet-tinted row = the inspected run (`currentHistory`) | FR-017/052 (retained) |
| the violet "Mockup note" box | States the three-way split: header = select-all, row checkbox = select-to-delete, row/eye = inspect (independent) | — |

The mockup's `RUN_STATE` chip palette (completed / completed_with_warnings / failed / cancelled)
and the `updateSelectAll` / `updateDeleteBtn` / `renderRunsTable` / `toggleRun` /
`toggleSelectAll` / `deleteSelectedRuns` functions **are** the reference implementation the app
facet should match line-for-line in behavior.

## 20.12 Success-criteria mapping (delta)

| SC | Design anchor |
|---|---|
| SC-029 (table datetime-desc, checkboxes, select-all, bulk delete leaves definition untouched) | §20.5 (app) + §20.4.3 (disjoint run-log vs workflow-def path; single `op:delete` on `.runs/` only). |
| SC-030 (`workflow_run_delete` removes exactly the named runs; correct deleted count / errors) | §20.4.2 (workflow-scoped paths) + §20.4.3/20.4.5 (per-run `deleted`/`not_found`/`error`; `deleted` counts only real removals; `minItems:1`). |
