---
name: workflow-manager
description: Build, run, and inspect multi-step agent workflows (DAGs of delegate/tool/research/ag-ui/event nodes) via the Workflow Manager's service-declared tools, including event-triggered runs and emitting BOS events from a step.
---

# Workflow Manager

The Workflow Manager service owns a complete workflow engine — a node model, a
parallel scheduler, dynamic routing, and persistence — and exposes it to you
as 14 native tools (see the tool table at the end of this skill). Use this
skill whenever a task calls for a multi-step, possibly-branching,
possibly-parallel piece of work that's worth saving and re-running rather than
doing once inline — and whenever that work should start **when something
happens** rather than when someone asks.

## The node model — two independent choices per step

Every step ("node") in a workflow is defined by two **orthogonal** choices —
never conflate them:

1. **`agentSource`** — WHO executes the node:
   - `{ "kind": "static", "agentId": "<existing-bos-agent-id>" }` — use this
     when a real BOS agent already fits (check what exists before defaulting
     to ephemeral).
   - `{ "kind": "ephemeral", "task": "...", "tools": ["..."], "skills": ["..."] }`
     — a one-off agent you define inline: a task description plus the tool
     and skill lists it needs. This is the common case — most workflow steps
     don't need a dedicated named agent.

2. **`outputType`** — WHAT the node produces, independent of who runs it:
   - `"delegate"` — a sub-agent's free-form output (the default for most steps).
   - `"tool"` — a single, tightly-scoped tool call. Also set `toolName`.
   - `"research"` — fan out several sub-agents in parallel and collect their
     outputs. Also set `researchAgents`: an array where each entry is either a
     plain string (a static agent id) or an inline object
     `{ "task": "...", "tools": [...], "skills": [...] }` (an ephemeral spec).
     **This is the DEFAULT choice for "run N investigations in parallel and
     feed them to a synthesis step"** — the entries run concurrently up to
     `maxConcurrentSteps`, their outputs are collected as first-class
     structured data your dependent step receives inline (no file handoff),
     and each sub-agent's live status is individually observable. It is
     materially faster than wiring N separate delegate steps by hand.
   - `"ag-ui"` — no delegation at all; the node's `input` is returned directly
     as a UI artifact. Use this for a fixed value or a UI-only step.
   - `"event"` — no delegation and no agent at all: the node emits one BOS
     event and finishes. The cheapest node type there is. Configured with
     `config`, not `agentSource`/`input` — see "Emitting events" below.

Any combination is valid: an ephemeral agent with research output, a static
agent with tool output, etc.

## Building the DAG

- Every step has an `id` and a `dependencies: [<step-id>, ...]` array. A step
  with no dependencies is ready immediately; independent steps (no dependency
  between them) run **concurrently**, up to `config.maxConcurrentSteps`
  (workflow-level, default 5) — don't add a fake dependency just to force
  ordering you don't actually need.
- Give each step an `outputConvention` describing, in plain language, what it
  should produce and where a downstream step should expect to find it (the
  executor passes upstream outputs to dependents automatically, but a clear
  convention keeps outputs well-formed).

## Latency: prefer research over a hand-rolled serial fan-out

Rough, realistic expectations — use them when you decide how to shape a
workflow, and when you set expectations for the user:

| Shape | Wall clock |
| --- | --- |
| One `delegate` step (a real sub-agent doing real work) | seconds to many minutes; a deep investigation can run 10–40 min |
| A `research` node with N entries | ≈ the SLOWEST entry, not the sum — they run concurrently up to `maxConcurrentSteps` |
| N separate `delegate` steps chained by dependencies | ≈ the SUM of all N — materially slower, and usually an authoring mistake |
| A `tool` step | usually sub-second to seconds |
| An `ag-ui` step | instant (no delegation at all) |
| A dry run (`dryRun: true` with fixtures) | seconds for the whole DAG |

So: for independent investigations, use ONE `research` node rather than
several delegate steps. Two independent 20-minute investigations take ~20
minutes as a research fan-out and ~40 minutes serially. Tell the user the
expected order of magnitude before starting a long run, and don't poll faster
than the work can plausibly progress.

## Dynamic routing — candidates (use sparingly, only when the workflow should adapt)

A step MAY declare `"candidates": [{ "id": "<step-id>", "description": "..." }, ...]`
— a list of DOWNSTREAM step ids that this step's agent chooses between as its
**last action**, based on what it learned while executing. Use this when the
right next step genuinely depends on information only available after this
step runs (e.g. "classify the company, then route to the Finance,
Construction, or Shipping handling").

- **Exactly one candidate**: no choice is needed — it's just a delegation,
  wired automatically. Don't add a routing instruction for a single-candidate
  step.
- **Multiple candidates**: the engine gives the node's agent a `select_branch`
  tool (`{ "selected": ["<candidate-id>", ...] }`, enum-limited to that node's
  own candidates) and appends the instruction to call it as the last action.
  **The selection is read only from that structured signal** — a JSON
  `{"select_branch": {"selected": ["<id>"]}}` object is accepted as an
  equivalent when the tool is unavailable. Prose is never parsed, so an agent
  that merely *says* "I'll take the alarm branch" has NOT selected anything.
  You don't write any of this yourself: declare `candidates` and the engine
  handles the instruction, the retry-loop, and the read.
- **No valid selection after the retry-loop → the node FAILS.** The engine
  never falls back to an arbitrary candidate.

### How a selection propagates (this is the part that trips people up)

Only a node that is **declared a candidate leaf** of a routing node is gated
by that node's selection. **Every other node is gated purely by its own
`dependencies`** and runs normally. So:

```
classify ──► render ──► alarm      (alarm/quiet are classify's candidates)
                   └──► quiet
```

`render` is a shared step: it depends on `classify` but is not one of its
candidates, so it runs regardless of the choice. `alarm` runs only if
`classify` selected it; `quiet` is then reported `skipped`
(reason `branch-not-selected`) — not an error, and not a failure.

Two authoring rules follow, and `workflow_validate` enforces both as
**errors**:

1. **A candidate must be reachable from its routing node** — there has to be a
   dependency path routing-node → … → candidate. A candidate that doesn't
   (transitively) depend on its router can never be unlocked.
2. **A candidate leaf must not double as a shared dependency.** If an ungated
   node depends on a gated leaf, it is silently blocked whenever that leaf
   isn't selected. Put shared work ABOVE the branch point (like `render`), and
   make the leaves terminal — or declare the dependent a candidate of the same
   routing node.

Finally, if a routing node selects a branch that ends up executing **zero**
leaves, the run does not report a plain `completed`: it emits a
`workflow.branch.skipped` event and finishes as **`completed_with_warnings`**.
Treat that state as "the workflow did nothing useful" and investigate.

## Building a workflow

Prefer constructing the workflow object yourself and passing it via
`workflow_create`'s `workflow` parameter — you already know the node shapes
above, and this avoids an extra planning round-trip:

```json
{
  "workflow": {
    "name": "Sustainability Analysis",
    "config": { "maxConcurrentSteps": 5, "defaultTimeout": 900, "runTimeout": 7200 },
    "steps": [
      { "id": "research", "outputType": "research",
        "researchAgents": [
          { "task": "Research the company's carbon disclosure history." },
          { "task": "Research the company's supply-chain sustainability record." },
          { "task": "Research the company's regulatory exposure." }
        ] },
      { "id": "classify", "outputType": "delegate", "dependencies": ["research"],
        "agentSource": { "kind": "ephemeral", "task": "Classify the company's primary business line from the research findings." },
        "candidates": [
          { "id": "finance", "description": "Financial services company" },
          { "id": "shipping", "description": "Shipping/logistics company" }
        ] },
      { "id": "brief", "outputType": "delegate", "dependencies": ["classify"],
        "agentSource": { "kind": "ephemeral", "task": "Summarize the research findings into a shared brief.", "tools": ["file_write"] } },
      { "id": "finance", "outputType": "delegate", "dependencies": ["brief"],
        "agentSource": { "kind": "ephemeral", "task": "Write the final financial-sector sustainability report from the brief." } },
      { "id": "shipping", "outputType": "delegate", "dependencies": ["brief"],
        "agentSource": { "kind": "ephemeral", "task": "Write the final shipping-sector sustainability report from the brief." } }
    ]
  }
}
```

Note the shape: the shared work (`research`, `brief`) sits ABOVE the branch
point and the two candidate leaves are **terminal**. A merge step that depends
on both leaves would be blocked whenever one of them isn't selected — which is
exactly what `workflow_validate` flags as an ambiguous shared/gated node.

If you'd rather describe the goal in plain language and let the engine plan
it, call `workflow_create` with `taskDescription` instead of `workflow` — it
costs one extra delegation but needs no node authoring.

Always follow up a create/modify with `workflow_validate` if you're not
already confident the DAG is acyclic and every dependency/candidate resolves
— it's cheap and catches authoring mistakes before a run wastes time.

## Event-triggered workflows — running when something happens

A workflow does not have to be started by hand. Give it a `triggers` array of
BOS **event types** and the service subscribes a headless handler for each one;
every matching event that arrives starts a run.

```json
{
  "workflowId": "invoice-triage-1a2b",
  "changes": { "triggers": ["com.bos.gsuite.email.received", "com.bos.files.created"] }
}
```

- **Discover types first.** Call `workflow_event_types` — it returns
  `[{ type, handlerCount, displayName }]` for every type BOS's event kernel
  currently has handlers registered for. Use it instead of guessing a type
  string; a typo'd trigger is a workflow that silently never runs. An empty
  list is a legitimate answer (nothing is registered yet), not an error.
- **Setting triggers is just `workflow_modify`.** `triggers` is a normal
  top-level workflow field, so patch it like any other; arrays are replaced
  wholesale, so send the full desired list, not a delta. The service
  re-subscribes immediately on every create/modify/delete — new types are
  subscribed, types nothing triggers on any more are unsubscribed. `triggers`
  is echoed back in the result so you can confirm what was stored.
- **A `prefix.*` pattern is allowed.** `"com.bos.files.*"` is woken by
  `com.bos.files.created`, `com.bos.files.deleted`, and so on. An exact type
  matches only itself.
- **The event payload becomes the first step's input.** For every ROOT node (a
  node with no `dependencies`), the executor appends a "Triggering event:"
  block to the node's prompt carrying the event type, the event id, and the
  event's payload as JSON. Nodes further down the DAG see it the ordinary way,
  through their upstream's output. So author root nodes of a triggered
  workflow to expect that block — e.g. "Triage the email described in the
  triggering event payload."
- **Re-entrancy: always a NEW run, never a queue.** Two matching events produce
  two independent, concurrently-executing runs of the same workflow. This is
  deliberate, not a bug: the "a workflow is already running, refuse to start
  another" guard applies only to user- and tool-started runs. If concurrent
  runs would be wrong for a given workflow (they share a file, a lock, an
  external quota), the workflow itself has to be idempotent — the engine will
  not serialize them for you.
- **The event is acked as soon as the run STARTS**, never when it finishes. A
  run can take an hour; the kernel's per-handler dispatch queue is serial, so
  acking late would stall every later event of that type behind it. A
  consequence: a failed run does not un-ack its event.
- **Provenance is recorded.** A triggered run carries `startSource: "event"`
  plus `triggerEventType`, `triggerEventId` and `eventContext`; a run you
  started with `workflow_run` carries `startSource: "tool"`, and one started
  from the app carries `"user"`. All three show up in `workflow_status`,
  `workflow_run_get` and `workflow_run_list`, so "why did this run?" is always
  answerable after the fact.

## Emitting events — the `event` node

A step with `"outputType": "event"` emits one BOS event and finishes. It has no
agent, makes no model call, and its whole definition is `config`:

```json
{
  "id": "announce",
  "outputType": "event",
  "dependencies": ["analyze"],
  "config": {
    "eventType": "com.bos.workflows.analysis.complete",
    "payload": { "mode": "static", "value": { "status": "done" } }
  }
}
```

- **Namespace policy: `com.bos.workflows.*` only.** A workflow may emit only
  under this item's own namespace — `workflow_validate` rejects anything else
  as an error. (Reacting to another component's events is fine and expected;
  *impersonating* one is not.) Event types are dot-separated and lowercase.
- **Two payload modes**, and the payload is always a JSON **object**:
  - `{"mode": "static", "value": { … }}` — emitted verbatim.
  - `{"mode": "template", "text": "…"}` — a JSON template string in which
    `{{nodeId.field}}` is substituted with that upstream node's output before
    the text is parsed as JSON. `{{n.output}}`, `{{n.output.summary}}` and
    `{{n.summary}}` all address node `n`'s output; substituted values are
    JSON-encoded, so `{"summary": {{analyze.summary}}}` is correct and
    `{"summary": "{{analyze.summary}}"}` double-quotes a string that already
    carries its own quotes. Referenced nodes must be real upstreams of the
    event node — `workflow_validate` checks resolvability, and the run fails if
    the rendered text isn't a JSON object.
- **Every emitted event carries a `_wf` provenance envelope** (`workflowId`,
  `runId`, `nodeId`) merged into its payload, so a downstream handler or the
  Event Viewer can trace it back to the node that produced it.

### ⚠ Cycle warning — never emit an event your own workflow triggers on

There is **no loop detection** across the event boundary. If a workflow's
`triggers` include (or prefix-match) the type one of its own `event` nodes
emits, each run emits an event that starts another run, forever:

```
triggers: ["com.bos.workflows.*"]        ← matches everything this item emits
steps:    [{ outputType: "event", config: { eventType: "com.bos.workflows.done" } }]
                                          ← starts another run of itself. Unbounded.
```

The same trap exists indirectly: workflow A emits a type that triggers workflow
B, which emits a type that triggers A. Before you set `triggers` or add an
`event` node, check the emitted types against the trigger lists of **every**
workflow (`workflow_list` + `workflow_read`), and be especially careful with
`com.bos.workflows.*`-shaped trigger patterns — they match this item's entire
emission namespace. If you must chain workflows by event, use distinct,
narrowly-named types in one direction only, and say so in the workflow's name.

## Executing a workflow — fire-and-poll

`workflow_run` is **asynchronous**: it returns `{ runId, workflowId }`
immediately and does **not** wait for the run to finish (a multi-step run can
take minutes; the tool call itself must return well under 30 seconds). After
calling it:

1. Poll `workflow_status` (or `workflow_run_get` with the `runId`) every so
   often to observe progress — don't call it in a tight loop; a few seconds
   between polls is reasonable for most workflows.
2. `workflow_status` returns a POPULATED per-step map for a live run — for
   each step: `status`
   (`pending`/`running`/`completed`/`failed`/`cancelled`/`skipped`/`neutral`),
   `attempt`/`maxAttempts`, a short `currentAction` string while it runs, a
   per-sub-agent `subAgents` map for a research fan-out (so you can name the
   straggler), and an `agentTrace` (the executed prompt, reasoning where
   exposed, each tool call with its arguments/result/ok, and the response).
   Use it to answer "what is it doing right now" without guessing. The run is
   done once `state` is `completed`, `completed_with_warnings`, `failed`, or
   `cancelled` — treat `completed_with_warnings` as "check the
   `workflow.branch.skipped` warning, a branch did nothing".
3. If you need to check on a workflow without already holding a `runId`,
   `workflow_list` reports each workflow's live `status` (`running`/`idle`)
   and, when running, its current `run_id` — use that to resume polling.
4. Call `workflow_cancel` to stop an in-progress run; in-progress steps are
   marked `cancelled`, steps that never started are marked `neutral`.

## Inspecting historical runs

Every run — completed, failed, or cancelled — is persisted. Use
`workflow_run_list` to see a workflow's past runs (id, timestamps, final
state), and `workflow_run_get` with a specific `runId` to see that run's full
per-step outcomes and event log — useful for "why did step X fail last time"
or "what did the research step find" after the fact, without needing the app
open.

## Deleting historical runs — `workflow_run_delete`

`workflow_run_delete` removes one or more of a workflow's persisted **run
logs**. The workflow definition and all of its future runs are completely
intact — this only prunes history.

- Input: `{ "workflowId": "<id>", "runIds": ["<runId>", ...] }` — a non-empty,
  duplicate-free array of run ids, all belonging to that one workflow.
- Result: `{ workflowId, deleted, results: [{ runId, status, error? }] }` —
  `deleted` counts the runs whose log was actually removed; per run, `status`
  is `"deleted"`, `"not_found"` (no such log — already deleted, still in
  progress, or a run of a different workflow; not counted in `deleted`), or
  `"error"` (the log exists but its delete failed, with `error` explaining
  why). It is idempotent: re-deleting the same ids just reports `not_found`
  and never aborts the batch.
- **Terminal runs only.** An in-progress run has no persisted log yet, so it
  cannot be deleted — use `workflow_cancel` to stop it first (it then persists
  as `cancelled` and becomes deletable like any other historical run).

**Do not confuse it with `workflow_delete` — the blast radius is different.**
`workflow_run_delete` removes selected run logs and nothing else; the workflow
keeps existing and keeps running. `workflow_delete` removes the ENTIRE
workflow: its definition, its trigger subscriptions, and ALL of its runs, and
cannot be undone. When a user asks to "clean up old runs", they mean
`workflow_run_delete`; reach for `workflow_delete` only when they want the
workflow itself gone.

In the app, the same operation is the detail view's **historical runs table**:
runs are listed newest-first with their datetime, run id, final-state chip and
duration; each row has a checkbox (the header checkbox selects/deselects all,
showing a mixed state for a partial selection), and the **Delete (n)** button
removes the selected run logs immediately — no confirmation dialog — then
confirms "workflow definition untouched". Clicking a row (not its checkbox)
still opens the run's replay. In-progress runs never appear in the table.

## Dry-run mode — validate a workflow in seconds, not an hour

Before committing to a long run, validate the DAG, the branch routing, and
leaf reachability with fixtures:

```json
{
  "workflowId": "sustainability-analysis-1a2b",
  "dryRun": true,
  "fixtures": {
    "research": [{ "label": "carbon", "output": "canned finding" }],
    "classify": { "select_branch": { "selected": ["finance"] } }
  }
}
```

- A node named in `fixtures` is **not executed at all** — no sub-agent, no
  network; its canned value is handed to its dependents exactly as a real
  output would be. A whole research fan-out can be fixture-designated with one
  entry (key = the node id), or a single sub-agent with `"<nodeId>#<index>"`.
- A routing node's fixture can BE the selection signal (the `select_branch`
  shape above), which is how you exercise each branch deterministically.
- Nodes with no fixture still run for real, so you can dry-run the expensive
  half and really execute the cheap half.
- `dryRun` is opt-in: without it, `fixtures` is ignored and behavior is
  exactly as before.

Use this whenever you are iterating on routing or dependencies — a full run
just to confirm which branch fired is a waste of an hour.

## Timeouts — nothing hangs forever

The workflow's `config` carries the defaults the engine enforces:
`defaultTimeout` (per step, seconds), `defaultRetryLimit`, and `runTimeout`
(the whole run). A step past its timeout is marked `failed` with a timeout
reason and is NOT retried (a hung agent will just hang again); a run past its
deadline is halted and marked failed. A node can override the step timeout
with its own `timeout`. Set these deliberately for long research workflows —
the built-in defaults (900s per step, 7200s per run) are a safety net, not a
plan.

## Ephemeral tool lists are honored

An ephemeral node's declared `tools` (and `skills`) really are granted to the
spawned agent, including tools that are otherwise deferred behind
`find_tools`. So a node that needs to read or write VFS files should just
declare `"tools": ["file_read", "file_write"]` — do NOT route file I/O
through `run_command` heredocs as a workaround. And for a fan-out → merge
handoff you usually need no files at all: research/delegate outputs are passed
to dependent steps as structured data automatically.

## Common mistakes to avoid

- Don't add a `dependencies` edge just to force serial execution when steps
  are actually independent — that defeats the parallel scheduler and slows
  the workflow down for no reason.
- Don't use `candidates` for ordinary linear dependencies — it's specifically
  for run-time, information-dependent branching. If you already know the
  order at authoring time, just use `dependencies`.
- Don't hang a merge step off two candidate leaves — under the selection rules
  above it can never run when one of them is skipped. Put shared work above
  the branch point and keep leaves terminal (`workflow_validate` errors on
  this).
- Don't chain N independent investigations as N delegate steps — use one
  `research` node so they run concurrently.
- Don't burn a full run to test routing — use `dryRun` with fixtures.
- Don't poll `workflow_status` faster than the workflow could plausibly
  progress — most steps take at least a few seconds.
- Don't forget `toolName` on a `"tool"`-outputType step, or `researchAgents`
  on a `"research"`-outputType step — `workflow_validate` will catch both.
- Don't guess an event type for `triggers` — call `workflow_event_types` and
  use the real string. A typo'd trigger fails silently: the workflow simply
  never runs.
- Don't give an `event` node an `agentSource`, an `input`, or a `toolName` —
  its `config` is its entire definition, and it makes no model call.
- **Don't let a workflow trigger on a type it (or a workflow it triggers) can
  emit.** There is no cycle guard across the event boundary — see the warning
  above.
- Don't assume event-triggered runs serialize. Two events = two concurrent
  runs; make the workflow idempotent if that matters.

## Tool reference

| Tool | What it does |
| --- | --- |
| `workflow_list` | Every saved workflow with its live `status` (`running`/`idle`) and current `run_id`. |
| `workflow_create` | Save a workflow — pass `workflow` (the object) or `taskDescription` (planned for you). Returns `validation` and the stored `triggers`. |
| `workflow_read` | The full workflow JSON, including `steps` and `triggers`. |
| `workflow_modify` | Patch a saved workflow (`changes`). Arrays are replaced wholesale; patching `triggers` re-subscribes immediately. |
| `workflow_run` | Start a run. Asynchronous — returns `{ runId }` at once. Accepts `dryRun` + `fixtures`. |
| `workflow_status` | The live run projection: per-step status, attempts, current action, sub-agent fan-out, agent trace, and run provenance. |
| `workflow_cancel` | Stop the in-progress run. |
| `workflow_delete` | Delete the ENTIRE workflow — definition, trigger subscriptions, and ALL its runs. Cannot be undone. |
| `workflow_export` | The workflow as portable JSON. |
| `workflow_validate` | DAG acyclicity, node shape, candidate topology, trigger types, event-node namespace and template references. |
| `workflow_run_list` | A workflow's past runs, newest first, each with `startSource`/`triggerEventType`/`triggerEventId`. |
| `workflow_run_get` | One run's full detail: per-step outcomes, agent traces, routing selections, and the complete event log. |
| `workflow_run_delete` | Delete selected historical run LOGS only (`{ workflowId, runIds[] }` → `{ workflowId, deleted, results[] }`) — the workflow definition is untouched; in-progress runs are not deletable. |
| `workflow_event_types` | **(event authoring)** The event types BOS's kernel currently has handlers for — `[{ type, handlerCount, displayName }]`. Call this before setting `triggers`. |
