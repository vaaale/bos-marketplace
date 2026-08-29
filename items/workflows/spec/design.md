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
