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
├── tools.js                 # the 14 tool declarations + JSON schemas
├── handlers.js               # tool implementations, wired to the engine
├── http-bridge.js            # REST server the APP talks to (same handlers, different transport)
├── vfs.js                    # loopback bridge to BOS's /api/fs (ADR-2)
├── migration.js               # additive legacy-workflow recovery (ADR-5)
├── events.js                  # US16: trigger-union subscriptions + event_dispatch -> run
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

**Path disjointness is the deletion-safety contract.** A workflow definition
lives at `/Workflows/<id>-workflow.json`; its run logs live under the separate
`/Workflows/.runs/<workflowId>/<runId>.json` tree. Nothing that deletes a run
log can ever address a definition, because the two path shapes don't overlap.

## Deleting run logs (US19 — `workflow_run_delete`)

Individual run logs can be deleted without touching the workflow. **Two invoke
faces, ONE implementation**: the assistant reaches it as the `workflow_run_delete`
tool over the 039 `tool_call` path, and the app reaches it as
`POST /workflows/<id>/runs/delete { runIds: [...] }` on the service's own REST
bridge (via `window.__bos.services.call` under `services:read` — the app holds
no `fs:write` capability, and no new capability, port, group, or config key was
added for this). Both converge on `handlers.js`'s `workflow_run_delete`, which
calls `runs.deleteRunLogs(workflowId, runIds)`.

Per run id, `deleteRunLogs`:

1. builds the path `/Workflows/.runs/<workflowId>/<runId>.json` from the
   CALLER's `workflowId`, never derived from the run id — a run id belonging to
   another workflow therefore resolves to a path that doesn't exist and reports
   `not_found` (the cross-workflow collision guard);
2. pre-checks existence with a loopback stat (`vfs.exists`). This is what makes
   the result deterministic: BOS's `/api/fs` `op:delete` is
   `fs.rm(..., { force: true })`, so deleting a missing path reports plain
   success and could never distinguish "deleted" from "was never there".
   Absent → `{ runId, status: "not_found" }`, and the batch CONTINUES —
   deletion is idempotent, and an in-progress run (whose log doesn't exist yet,
   since `persistRun()` runs at settle) is simply not deletable;
3. deletes via the same loopback bridge (`vfs.remove` →
   `POST /api/fs {op:"delete"}`) → `{ runId, status: "deleted" }`, or
   `{ runId, status: "error", error }` on a real I/O failure;
4. on success, drops the run from the in-memory maps (`forgetRun`). This is
   load-bearing, not cosmetic: a settled run stays in `LIVE`, and `listRuns()`
   merges `LIVE` with disk — without the forget, a deleted run would keep
   reappearing in `workflow_run_list` until the service restarts. `forgetRun`
   refuses to touch a run still listed in `ACTIVE_BY_WORKFLOW` (a safety net;
   the missing-log pre-check already keeps active runs out of reach).

The result is `{ workflowId, deleted, results: [{ runId, status, error? }] }`
with `deleted` counting only `status: "deleted"` entries. `workflow_delete`
remains the whole-workflow destructor (definition + ALL runs + trigger
unsubscribe); `workflow_run_delete` is strictly the run-log pruner.

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

## Event-triggered runs (`events.js`) — US16

A workflow may declare `triggers: ["com.bos.files.created", …]`. The service
turns that into subscriptions on BOS's 034 event kernel and starts a run when
one of those events is emitted.

**Subscriptions are derived, never hand-managed.** `deriveTriggerUnion()`
computes the set of distinct event types across ALL workflows;
`reconcileSubscriptions()` makes the declared handler set equal it:

| direction | transport | message |
|---|---|---|
| subscribe | Worker→Main IPC (the same channel as `tool_declare`) | `handler_declare { callId, handlerId: "workflows:<type>", eventType, mode: "headless", displayName }` |
| unsubscribe | loopback HTTP (`vfs.jsonRequest`) | `POST /api/events/unregister { handlerId, ownerId: "workflows" }` |

Reconcile runs at startup (`index.js`, after the handshake and migration —
never before, so a declare can't gate `initialized`) and after every
`workflow_create` / `workflow_modify` / `workflow_delete`. It is idempotent: a
type already subscribed is skipped, so a no-op reconcile sends no IPC at all
and a user's per-handler `enabled` toggle is never clobbered. One handler is
declared per distinct TYPE, not per workflow — N workflows on the same trigger
share it.

`service.json` grants `eventNamespaces: ["com.bos.*"]`. Without it the kernel
rejects every declare outside this service's owned root
(`com.bos.workflows.*`) — and reacting to OTHER components' events is the
whole point of a trigger.

**Dispatch → run.** A Main→Worker `event_dispatch { callId, eventId,
handlerId, record }` reaches `index.js`'s IPC switch, which calls
`events.handleEventDispatch()`. It:

1. finds every workflow whose `triggers` match `record.type` (exact, or the
   kernel's `prefix.*` pattern);
2. starts ONE INDEPENDENT run per match through the same run starter
   `workflow_run` uses (`handlers.js`'s `makeRunStarter`), with
   `startSource: "event"`, `triggerEventId`, `triggerEventType` and
   `eventContext` (= `record.payload`);
3. **acks immediately** — `POST /api/events/<id>/ack { handlerId, callerId:
   "workflows", callId }` — on run-START, not run-completion (NFR-007). A
   workflow run can take hours; the kernel's per-handler dispatch queue is
   serial, so a late ack would stall every later event of that type. An ack
   failure is logged and swallowed: the run has already started, and the
   kernel's re-dispatch may duplicate it, which FR-043 accepts.

A dispatch that matches zero workflows is still acked — an un-acked event
stays pending and is re-dispatched forever.

**Concurrency.** Event runs are NOT subject to the single-active-run guard:
two events for one workflow start two independent runs (FR-043). `runs.js`
therefore tracks active runs per workflow as a LIST; `isRunning`/`activeRunId`
keep their old meaning (the newest run), and each run clears only its own
entry when it settles. A user/tool `workflow_run` is still refused while any
run is in flight.

**Provenance + FR-042.** `run-state.js` records `startSource`
("user" | "tool" | "event", defaulting to "tool" so pre-US16 run files replay
unchanged), `triggerEventId`, `triggerEventType` and `eventContext` on the run
— live snapshot, persisted file and replay. The scheduler puts them on the
execution ctx, and `executor.js`'s `eventContextBlock()` appends a
"Triggering event:" section (type, id, JSON payload) to the task text of
ROOT nodes only — the nodes the event actually woke up. Downstream nodes get
the data the normal way, through their upstream step's output, and a
tool/user-started run's prompt is byte-for-byte what it was before US16.

## The app's REST bridge (`http-bridge.js`)

The app is not the assistant, so it needs an ordinary HTTP surface rather
than worker-IPC tool dispatch. `http-bridge.js` is a small router bound on the
service's own configurable port (default `0`) — every route is a thin wrapper
over the SAME `handlers.js` functions the tool surface calls, so the app and
the assistant can never observe divergent behavior.

### Route table

| Route | Handler |
|---|---|
| `GET /health` | service runtime info |
| `GET /run/<runId>[?since=][&workflowId=]` | live run projection (falls back to `workflow_run_get` with `?workflowId=`) |
| `GET /event-types` | `workflow_event_types` |
| `GET /workflows` | `workflow_list` |
| `POST /workflows` | `workflow_create` |
| `GET /workflows/<id>` | `workflow_read` |
| `PATCH /workflows/<id>` | `workflow_modify` |
| `DELETE /workflows/<id>` | `workflow_delete` |
| `POST /workflows/<id>/run` | `workflow_run` (as `startSource: "user"`) |
| `POST /workflows/<id>/cancel` | `workflow_cancel` |
| `GET /workflows/<id>/status` | `workflow_status` |
| `GET /workflows/<id>/export` | `workflow_export` |
| `POST /workflows/<id>/validate` | `workflow_validate` |
| `GET /workflows/<id>/runs` | `workflow_run_list` |
| `GET /workflows/<id>/runs/<runId>` | `workflow_run_get` |
| `POST /workflows/<id>/runs/delete` `{ runIds: [...] }` | `workflow_run_delete` (US19 — the app's bulk run-log delete) |
