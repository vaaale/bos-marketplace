# Workflow Manager — Tool Reference

The service declares 13 tools at startup via `tool_declare` (039-compliant —
`deploymentMode: "tools"` in `services/service.json`). They are gated exactly
like built-in tools (allowlist/deferred approval) and disappear from the
registry the instant the service stops or is uninstalled.

All handlers live in `services/handlers.js`; schemas in `services/tools.js`.

## Tool group

All 13 tools appear under the **Workflows** group, declared in
`services/service.json`'s `toolGroups` (bos-spec 041). The group's name and
description are what the assistant sees in its system prompt, and an agent that
has these tools deferred reaches them with `find_tools(group: "workflows")`.
Before 041 every service tool landed in a shared "Service Tools" bucket; that
bucket no longer exists, and a tool that resolves to no declared group is
rejected at startup with an error shown in Settings → Services.

## `workflow_list`

List every workflow under `/Workflows/`. **Read-only, `parallelSafe`.**

- Input: `{}`
- Output: array of `{ workflow_id, name, steps, status: "running"|"idle", run_id? }` —
  `run_id` is present only when `status` is `"running"`, so an agent can go
  straight from `workflow_list` to polling `workflow_status`/`workflow_run_get`
  without a separate lookup.

## `workflow_create`

Create and persist a new workflow.

- Input: `{ workflow?: object, taskDescription?: string }` — pass exactly one.
  `workflow` (preferred) is a fully-formed workflow object (see the bundled
  skill for the node shape); `taskDescription` plans one for you via one
  extra delegation to an ephemeral "planner" agent.
- Output: `{ workflow_id, name, steps, validation: { ok, errors[], warnings[] }, triggers[] }`
- A workflow may carry `triggers: ["<event.type>", …]` (US16). Saving it
  subscribes the service to those BrowserOS notification event types; an
  emitted event then starts a run automatically, with the event payload handed
  to the workflow's first step. `triggers` echoes back what was stored.

## `workflow_read`

Read a workflow's full JSON. **Read-only, `parallelSafe`.**

- Input: `{ workflowId }`
- Output: the workflow object (`id`, `name`, `version`, `config`, `steps[]`).

## `workflow_modify`

Apply a JSON-merge patch to an existing workflow (arrays are replaced
wholesale, not merged element-wise), then re-validate.

- Input: `{ workflowId, changes: object }`
- Output: `{ workflow_id, steps, validation, triggers[] }`
- Patching `triggers` re-subscribes immediately: new types are subscribed,
  types no longer named by ANY workflow are unsubscribed (US16).

## `workflow_run`

Start a run. **Fire-and-poll** — returns immediately (well under the 30s tool
timeout) and does NOT wait for the workflow to finish.

- Input: `{ workflowId, featureBranch?, conversationId?, dryRun?, fixtures? }`
- Output: `{ runId, workflowId, startSource, dryRun?, fixtures? }`
- Refused (throws) if the workflow fails validation, or if it already has a
  run in progress (one concurrent run per workflow).
- `startSource` records who started the run: `"tool"` here, `"user"` for the
  app's Run button, `"event"` for an event-triggered run (US16). Only the
  event path may overlap an in-flight run; a caller cannot claim `"event"`
  through this tool.

**Dry-run / fixture mode (opt-in).** With `dryRun: true`, every node named in
`fixtures` (`{ "<nodeId>": <cannedOutput> }`) skips its real execution
entirely — no sub-agent, no network — and its canned value is handed to its
dependents as if the agent had produced it, so the DAG, the branch routing and
leaf reachability can be validated in seconds instead of a full run. A whole
research fan-out can be fixture-designated by its node id (or one sub-agent by
`"<nodeId>#<index>"`), and a routing node's fixture may itself be the selection
signal: `{ "select_branch": { "selected": ["<candidate-id>"] } }`. Nodes with
no fixture still execute for real. Without `dryRun`, `fixtures` is ignored and
behavior is unchanged.

## `workflow_status`

Current run state for a workflow: live, if a run is in progress; otherwise
the most recent historical run's final state. **Read-only, `parallelSafe`.**

- Input: `{ workflowId, since? }` (`since` = a monotonic event `seq` from a
  previous poll; only newer events are returned, the step map is always full)
- Output: `{ running, runId?, workflowId, state, finalState?, steps, selected?,
  warnings?, events?, seq?, error? }` (`state` is `"never_run"` if the workflow
  has never been run; `completed_with_warnings` means a selected branch
  executed zero leaves).

`steps` is a POPULATED per-step map from the moment the run starts — never an
empty `{}`. Per step:

```
{ status:        "pending"|"running"|"completed"|"failed"|"cancelled"|"skipped"|"neutral",
  attempt, maxAttempts,
  currentAction?: "calling map_rows…",           // while in progress
  subAgents?:     { "<id>": { label, status, action } },   // research fan-out
  outputs?:       <structured output>,
  agentTrace?:    { prompt?, thinking?, response?,
                    toolCalls: [{ name, args, result, ok, inflight }] },
  error?, reason?, timedOut?, selected? }
```

This is the same live state the app's node trajectory panel renders — one
source of truth, no divergence between UI and tools.

## `workflow_cancel`

Cancel a workflow's in-progress run. In-progress steps are marked
`cancelled`; steps that never started are marked `neutral`.

- Input: `{ workflowId }`
- Output: `{ workflowId, cancelled: boolean }` — `false` if nothing was running.

## `workflow_delete`

Delete a workflow and all of its run logs. Cannot be undone.

- Input: `{ workflowId }`
- Output: `{ workflowId, deleted: true }`

## `workflow_export`

Return a workflow's full JSON as a string (for copying, diffing, or
re-importing via `workflow_create`'s `workflow` parameter). **Read-only, `parallelSafe`.**

- Input: `{ workflowId }`
- Output: a JSON string.

## `workflow_validate`

Validate DAG acyclicity, node shape, dependency and dynamic-routing candidate
resolvability, plus candidate **topology**. **Read-only, `parallelSafe`.**

Topology errors (both are silent-no-op generators at run time, so both are
errors rather than warnings):

- an **unreachable candidate leaf** — no dependency path from the routing node
  to the candidate, so the selection could never unlock it;
- an **ambiguously shared + gated leaf** — an ungated node depends on a
  candidate leaf, so it is silently blocked whenever that leaf is not
  selected.

- Input: `{ workflowId? , workflow? }` — pass `workflowId` to validate a saved
  workflow, or `workflow` to validate one before saving.
- Output: `{ ok, errors: string[], warnings: string[] }`

## `workflow_run_list`

List a workflow's historical runs, newest first. **Read-only, `parallelSafe`.**

- Input: `{ workflowId }`
- Output: array of `{ runId, startedAt, endedAt, state, startSource,
  triggerEventType, triggerEventId }` — `startSource` is `"tool"` for any run
  recorded before US16 existed.

## `workflow_run_get`

Read one run's full detail — the per-step map (identical shape to
`workflow_status`, including each node's `agentTrace` and any research
fan-out's per-sub-agent status) and the complete event log, replayed from the
persisted record. A finished run replays exactly as it looked live.
**Read-only, `parallelSafe`.**

- Input: `{ workflowId, runId, since? }`
- Output: `{ runId, workflowId, startedAt, endedAt, state, finalState?, steps,
  selected?, warnings?, events, seq?, error?, startSource, triggerEventId,
  triggerEventType, eventContext }` — the last four are the run's provenance
  (US16); `eventContext` is the triggering event's payload, and is `null` for
  anything but an event-triggered run.

The event log records agent execution as well as step lifecycle: `agent.prompt`,
`agent.reasoning`, `agent.tool_call` (an inflight call is updated in place by
its completion), `agent.response`, `agent.sub_agent`, alongside `step.start` /
`step.retry` / `step.running` / `step.complete` / `step.fail` / `step.skip` and
the run-level `workflow.start` / `workflow.complete` / `workflow.fail` /
`workflow.cancel` / `workflow.branch.skipped`.

## `workflow_event_types`

List the event types currently registered in the BOS event system, so a
workflow's triggers (and an `event` node's downstream expectations) can be
authored against types that actually exist. **Read-only, `parallelSafe`.**

- Input: `{}`
- Output: array of `{ type, handlerCount, displayName }`, sorted by `type` —
  `handlerCount` is the total of the type's UI + headless handlers, and
  `displayName` is the first registered handler's label (`null` when a type is
  registered with no handler that names itself).

An empty registry is an empty array, not an error. If the event registry cannot
be read at all, the tool fails with an error naming the route and status — so
"the registry is unreachable" is never reported as "nothing is registered".

## A full build → run → poll → cancel → inspect loop

```
workflow_create({ workflow: { name: "Demo", steps: [...] } })
  -> { workflow_id: "demo-ab12", validation: { ok: true, ... } }

workflow_run({ workflowId: "demo-ab12" })
  -> { runId: "run-abc123-xyz", workflowId: "demo-ab12" }

workflow_status({ workflowId: "demo-ab12" })        # poll every few seconds
  -> { running: true, runId: "run-abc123-xyz", state: "running",
       steps: { ingest: { status: "completed", attempt: 1 },
                transform: { status: "running", attempt: 2, maxAttempts: 3,
                             currentAction: "calling map_rows…",
                             agentTrace: { prompt: "…", toolCalls: [ … ] } } } }
  ... eventually ...
  -> { running: false, state: "completed", steps: {...} }

# validate routing in seconds instead of running the real thing
workflow_run({ workflowId: "demo-ab12", dryRun: true,
               fixtures: { research: [{ output: "canned" }],
                           classify: { select_branch: { selected: ["alarm"] } } } })
  -> { runId: "run-dry-1", workflowId: "demo-ab12", dryRun: true, fixtures: ["research", "classify"] }

workflow_cancel({ workflowId: "demo-ab12" })         # only if you need to stop early
  -> { workflowId: "demo-ab12", cancelled: true }

workflow_run_list({ workflowId: "demo-ab12" })
  -> [{ runId: "run-abc123-xyz", startedAt, endedAt, state: "completed" }, ...]

workflow_run_get({ workflowId: "demo-ab12", runId: "run-abc123-xyz" })
  -> { state: "completed", steps: { ... per-step outcomes ... }, events: [...] }
```
