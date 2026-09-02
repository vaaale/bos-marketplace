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
├── tools.js                 # the 13 tool declarations + JSON schemas
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
- **`outputType`** — `"delegate" | "tool" | "research" | "ag-ui" | "event"`.

A node may additionally declare `candidates: [{ id, agentId?, description? }]`
for dynamic routing (see below), and `researchAgents` (an array of
agent-source-like entries) when `outputType` is `"research"`.

An `"event"` node is the one output type with **no agent at all** — it needs no
`agentSource`. It carries
`config: { eventType, payload: { mode: "static", value } | { mode: "template", text, fallback? } }`
and emits that event into BOS's event system with one `POST /api/events`
(US18). `eventType` must match `^[a-z0-9]+(\.[a-z0-9_-]+)+$` **and** live under
`com.bos.workflows.*` — a workflow only emits in its own namespace (FR-048b,
ADR-14). In template mode, every `{{nodeId.field}}` placeholder in `text` is
replaced with the JSON-serialized upstream output (a leading `output` segment
names the output root, and a numeric segment indexes an array); an unresolved
reference becomes `null`, or `payload.fallback` when one is declared. The
rendered text must parse as a JSON **object**, otherwise the node fails with a
config error rather than emitting a malformed event. Every emitted payload
carries a `_wf: { workflowId, runId, nodeId }` provenance envelope (FR-047).
`validate.js` also checks that each template reference names a step that exists
(FR-048c) and that every entry of a workflow's optional `triggers` array is a
well-formed event type (FR-048a).

## The execution contract (`engine/executor.js`)

Each node's actual execution is one `POST /api/subagents/delegate` loopback
call — the same route BOS's own sub-agent delegation uses, already capable of
running a named or ephemeral agent and streaming NDJSON. `executeNode()`:

- short-circuits `"ag-ui"` nodes entirely (no network call — the node's
  `input` IS the output),
- handles `"event"` nodes inline — resolve the payload, one
  `POST /api/events`, output `{ emitted: true, eventId }` — with no delegate
  call, no model, and no sub-process (the cheapest node type there is); a
  non-2xx from the event API fails the node with the API's own error text, and
  a dry-run fixture short-circuits the emit so a rehearsal never fires a real
  event,
- builds a delegate request from the node's `agentSource` (an `agent` field
  for static, an `ephemeral` object for ephemeral),
- for `"tool"` nodes, constrains the task text to "call ONLY the tool named X",
- consumes the NDJSON stream via `delegateOnce()`, resolving to
  `{ output, toolEvents, reasoning, response }` or rejecting on a
  stream-reported error. The reader normalizes both the historical
  `{type:"tool", tool, input}` shape and the enriched
  `{type:"tool"|"tool_result"|"reasoning_delta"}` + `done.result.text` shape,
  and emits an `agent.*` event per stream event through `ctx.emit` so the run
  state can build each node's agent trace live (FR-028),
- forwards an ephemeral node's FULL declared `tools` list plus a
  `deferredTools` mirror of it and its `skills` (FR-034) — a declared tool must
  actually be granted AND discoverable via `find_tools`, never silently
  dropped,
- injects the per-node `select_branch` tool (enum-limited to that node's own
  candidate ids) for a routing node (FR-029),
- substitutes a canned output, with no network call at all, for a node
  designated in a dry run's `fixtures` (FR-037).

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

**Selection propagation is Option A (FR-031)**: dependency edges are released
for EVERY dependent when a node completes, and a node is additionally gated by
a selection ONLY if it is a declared candidate leaf (`router.buildCandidateIndex`
/ `selectionAllows`). That is what lets a SHARED step that depends on a routing
node — the `render` between the branch point and the leaves — run normally,
instead of blocking the whole downstream graph. A candidate leaf the router
did not select is explicitly `step.skip`ped (`reason: "branch-not-selected"`),
not left silently pending. On cancellation, every still-pending or in-flight
step is marked `"cancelled"`; a still-pending step at run end (a sibling
failure, or a dependency that was skipped) is `"neutral"`.

**Zero-executed-leaves guard (FR-032)**: at the end of a run, any routing node
whose selection executed no leaf emits `workflow.branch.skipped` and downgrades
the final state to `completed_with_warnings` — a branch that performed no
terminal action is never reported as a plain `completed`.

**Timeouts (FR-038)**: `withTimeout` enforces a per-step deadline
(`node.timeout ?? config.defaultTimeout ?? 900s`) — a step timeout is
deliberately NOT treated as transient, so a hung agent fails fast instead of
being retried into the same hang — and an internal `AbortController` enforces
the per-run deadline (`config.runTimeout ?? 7200s`), halting the run and
reporting `failed` with a `run-timeout` reason.

**Dry run (FR-037)**: `dryRun` + `fixtures` are threaded into `ctx`; a
fixture-designated node (including a whole research fan-out, or one sub-agent
via `<nodeId>#<index>`) returns its canned output without touching the network.

**Fan-out observability (FR-022/FR-036)**: `runResearchFanOut` emits an
`agent.sub_agent` transition (pending → running → completed/failed) per entry,
so the straggler in an N-way fan-out is identifiable live.

## Dynamic routing (`engine/router.js`)

The selection is a STRUCTURED signal, never prose (FR-029). The prose
`SELECT: <id>` line this module used to match is gone: it is exactly how an
agent that said "I'll select the alarm branch" got recorded as having chosen
`quiet`. `readSelectionSignal()` reads, in priority order:

1. a `select_branch` **tool call** in the delegate's tool-event stream
   (`{ selected: [...] }`) — the canonical signal, declared per node by
   `tools.js`'s `selectBranchTool()` with an `enum` of that node's own
   candidate ids;
2. a structured output OBJECT carrying `select_branch` / `selected` (also the
   shape a dry-run fixture uses);
3. a strict JSON envelope embedded in the output text — a fenced ```json block
   or a balanced `{...}`, parsed with `JSON.parse` and accepted only if it is a
   `select_branch` envelope.

A signal naming any id outside the node's candidates invalidates the WHOLE
signal (never a partial route). If nothing valid is produced,
`resolveCandidates()` calls back into the scheduler's `retryDelegate`
(re-running the SAME node with a clarifying instruction appended) up to a
retry cap and then THROWS — the node fails (FR-030); the engine never defaults
to an arbitrary candidate. A node with exactly one candidate skips all of this
and auto-delegates (FR-019).

`buildCandidateIndex()` / `selectionAllows()` / `selectionRejects()` are the
Option A gating helpers the scheduler uses (see above).

## Live run state (`engine/run-state.js`)

ONE reducer folds every engine event into the run's projection — this is the
single source of truth both the `workflow_*` tools and the app's trajectory
panel read (FR-036), so they cannot disagree:

```
RunState { runId, workflowId, status, finalState?, startedAt, endedAt?,
           selected: Map<nodeId, candidateId[]>,
           steps: Map<nodeId, StepRuntimeState> }
StepRuntimeState { status, attempt, maxAttempts, currentAction?,
                   subAgents?: Map<subAgentId, {label,status,action}>,
                   outputs?, agentTrace?: { prompt?, thinking?,
                                            toolCalls: [{name,args,result,ok,inflight}],
                                            response? } }
```

- The event log is append-only with a monotonic `seq`; `eventsSince(seq)` and
  `subscribe(since, cb)` make tailing cheap, and `GET /run/<runId>?since=` on
  the worker's already-bound port exposes it to the app.
- `agent.tool_call` events are MERGED: an inflight call is updated in place by
  its completion rather than appended twice. A new attempt resets the trace so
  the panel shows the current attempt's activity.
- Steps are seeded `pending` from the workflow definition at run start, so a
  poll never sees `steps: {}`.
- `replayRunState(persisted)` rebuilds the identical projection from a
  persisted run, which is what makes a historical run replayable in the panel
  with its full agent trace.

## Persistence (`engine/store.js`, `runs.js`, `vfs.js`)

Everything goes through the loopback `/api/fs` bridge (`vfs.js`) — the
sanctioned way for an unbundled worker-thread service to reach the real VFS.
Nothing is ever written to a host path derived from the service's own config
directory.

- Workflows: `/Workflows/<id>-workflow.json`.
- Runs (first-class entities, distinct from a workflow's own JSON):
  `/Workflows/.runs/<workflowId>/<runId>.json` — `{ schemaVersion: 2, runId,
  workflowId, startedAt, endedAt, state, finalState, selected, steps, warnings,
  events, error? }`. The event log includes the `agent.*` execution events
  (FR-028) alongside the step lifecycle, which is what makes a historical run
  fully replayable — same file, richer schema.

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
create/modify/delete/run/cancel/status/export/validate/run-list/run-get, plus
`GET /run/<runId>[?since=][&workflowId=]` for the live run projection)
bound on the service's own configurable port (default `0`) — every route is a
thin wrapper over the SAME `handlers.js` functions the tool surface calls, so
the app and the assistant can never observe divergent behavior.
