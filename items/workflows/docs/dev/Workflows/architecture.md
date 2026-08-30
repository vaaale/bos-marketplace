# Workflow Manager — Developer Architecture

The Workflow Manager is a marketplace item (`data/user-apps/items/workflows/`
once installed) with two facets: a **service** that owns the complete
workflow engine, and an **app** that renders it as a graph. This document
describes the service's internal architecture; see `docs/usage.md` for the
end-user view and `contribution.md` for how to extend it.

## Why the engine lives in the service, not BOS source

A worker-thread service cannot run the BOS assistant stack itself — no
`runSubAgent`/`runAgentLoop`, no in-process tool registry. So "the service
owns the engine" specifically means: the service owns the **model, scheduler,
router, and persistence**, but each node's actual execution reaches BOS's
main thread over one loopback call. Everything else genuinely lives here,
self-contained, with zero BOS-source dependency.

## Module map (`services/`)

```
services/
├── service.json           # deploymentMode:"tools", configSchema (port/host/maxConcurrentSteps)
├── index.js                # worker entry: lifecycle, tool_declare, IPC dispatch, migration bootstrap
├── tools.js                 # the 12 tool declarations + JSON schemas
├── handlers.js               # tool implementations, wired to the engine
├── http-bridge.js            # REST server the APP talks to (same handlers, different transport)
├── vfs.js                    # loopback bridge to BOS's /api/fs (ADR-2)
├── migration.js               # additive legacy-workflow recovery (ADR-5)
├── runs.js                    # fire-and-poll run tracking + first-class run persistence (ADR-8/9)
└── engine/
    ├── node-model.js          # the two orthogonal node axes (agentSource x outputType)
    ├── validate.js             # DAG acyclicity + node shape validation
    ├── generate.js              # taskDescription -> workflow, via a planner delegate call
    ├── store.js                  # workflow CRUD over the VFS bridge
    ├── executor.js                # the execution contract: loopback /api/subagents/delegate per node
    ├── router.js                   # dynamic routing: candidate selection + retry-loop
    └── scheduler.js                 # the DAG scheduler: ready-set dispatch, concurrency cap, research fan-out
```

## The node model (`engine/node-model.js`)

A node is defined by two axes that combine freely:

- **`agentSource`** — `{ kind: "static", agentId }` or
  `{ kind: "ephemeral", task, tools?, skills?, systemPrompt? }`.
- **`outputType`** — `"delegate" | "tool" | "research" | "ag-ui"`.

A node may additionally declare `candidates: [{ id, agentId?, description? }]`
for dynamic routing (see below), and `researchAgents` (an array of
agent-source-like entries) when `outputType` is `"research"`.

## The execution contract (`engine/executor.js`)

Each node's actual execution is one `POST /api/subagents/delegate` loopback
call — the same route BOS's own sub-agent delegation uses, already capable of
running a named or ephemeral agent and streaming NDJSON. `executeNode()`:

- short-circuits `"ag-ui"` nodes entirely (no network call — the node's
  `input` IS the output),
- builds a delegate request from the node's `agentSource` (an `agent` field
  for static, an `ephemeral` object for ephemeral),
- for `"tool"` nodes, constrains the task text to "call ONLY the tool named X",
- consumes the NDJSON stream via `delegateOnce()`, resolving to
  `{ output, toolEvents }` or rejecting on a stream-reported error.

**Origin resolution**: there is no `BOS_PORT` in `workerData`, so `vfs.js`/
`executor.js` resolve BOS's own HTTP origin from `NEXT_PUBLIC_APP_ORIGIN` or
`APP_ORIGIN`, falling back to `http://localhost:3000` — the loopback HOST is
always `127.0.0.1` regardless of what hostname the resolved origin names,
since this is a server-to-server call within the same container.

**Cancellation**: a run's `AbortController` (owned by `runs.js`) is threaded
through to every in-flight `executeNode()` call as `signal`. Cancelling a
workflow aborts the in-flight delegate fetch(es) directly — there is no
`runId`-keyed cancel endpoint on the delegate route, so this is deliberately
coarse (settles at the request boundary, not mid-token) rather than requiring
any BOS-source change.

## The scheduler (`engine/scheduler.js`)

A DAG scheduler over the node model: computes each node's `dependencies`,
maintains a ready-set, and dispatches up to `maxConcurrentSteps` nodes
concurrently (workflow-level `config.maxConcurrentSteps`, default 5). Each
node gets its own retry loop (exponential backoff, capped at 8s, only for
transient-looking errors — timeout/network/econnreset/etimedout/fetch
failed). A `"research"` node internally fans out one delegate call per
`researchAgents` entry, itself capped at the same concurrency limit.

On completion of a node with `candidates`, the scheduler asks `router.js`
which candidate(s) to unlock; only those children's dependency counts are
decremented — the rest stay pending forever and are reported `"neutral"` at
the end. On cancellation, every still-pending or in-flight step is marked
`"cancelled"`; on any other still-pending step at run end (failure, or
routed-away), the terminal status is `"neutral"`.

## Dynamic routing (`engine/router.js`)

When a node declares more than one candidate, `resolveCandidates()` looks for
a line of the form `SELECT: <id>[, <id> ...]` in the node's delegate output.
If missing/invalid, it calls back into the scheduler's `retryDelegate`
(re-running the SAME node with a clarifying instruction appended) up to a
retry cap, throwing only after exhausting it. A node with exactly one
candidate skips this entirely and auto-delegates (no model action needed).

This selection-line convention is this service's own design — there is no
prior BOS-source precedent for dynamic routing to port from.

## Persistence (`engine/store.js`, `runs.js`, `vfs.js`)

Everything goes through the loopback `/api/fs` bridge (`vfs.js`) — the
sanctioned way for an unbundled worker-thread service to reach the real VFS.
Nothing is ever written to a host path derived from the service's own config
directory.

- Workflows: `/Workflows/<id>-workflow.json`.
- Runs (first-class entities, distinct from a workflow's own JSON):
  `/Workflows/.runs/<workflowId>/<runId>.json` — `{ runId, workflowId,
  startedAt, endedAt, state, steps, events, error? }`.

`runs.js` also holds an in-memory `LIVE` map (`runId -> live run state`) and
an `ACTIVE_BY_WORKFLOW` map (`workflowId -> runId`, only while a run is
in-flight) so `workflow_list`/`workflow_status` can report live progress
without a VFS round trip on every poll. `listRuns()` merges the in-memory map
with what's durably persisted, since persistence happens strictly after a run
settles — a run that just finished is visible in memory before its
`persistRun()` write lands on disk.

## Migration (`migration.js`)

Two independent, additive-only, copy-then-archive-never-delete concerns:

1. **Host-path recovery** — if workflow JSON ever landed at a host path
   derived from the service's own config directory (the same bug class a
   prior marketplace item, `okf-knowledge-base`, actually shipped and fixed),
   copy any such files into the real VFS `/Workflows/` (skipping ids that
   already exist there) and rename (never delete) the legacy directory.
2. **Retired-engine cleanup** — the old BOS-source engine (now retired) wrote
   per-workflow execution logs to `/Workflows/<id>-execution-log.json`;
   superseded by first-class run entities, these are archived (renamed) so
   they don't linger as unexplained clutter.

Both run once at startup, after the tool-declare handshake (never gating it),
and are safe/idempotent to run on every boot.

## The app's REST bridge (`http-bridge.js`)

The app is not the assistant, so it needs an ordinary HTTP surface rather
than worker-IPC tool dispatch. `http-bridge.js` is a small router (list/read/
create/modify/delete/run/cancel/status/export/validate/run-list/run-get)
bound on the service's own configurable port (default `0`) — every route is a
thin wrapper over the SAME `handlers.js` functions the tool surface calls, so
the app and the assistant can never observe divergent behavior.
