# Workflow Manager — Tool Reference

The service declares 12 tools at startup via `tool_declare` (039-compliant —
`deploymentMode: "tools"` in `services/service.json`). They are gated exactly
like built-in tools (allowlist/deferred approval) and disappear from the
registry the instant the service stops or is uninstalled.

All handlers live in `services/handlers.js`; schemas in `services/tools.js`.

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
- Output: `{ workflow_id, name, steps, validation: { ok, errors[], warnings[] } }`

## `workflow_read`

Read a workflow's full JSON. **Read-only, `parallelSafe`.**

- Input: `{ workflowId }`
- Output: the workflow object (`id`, `name`, `version`, `config`, `steps[]`).

## `workflow_modify`

Apply a JSON-merge patch to an existing workflow (arrays are replaced
wholesale, not merged element-wise), then re-validate.

- Input: `{ workflowId, changes: object }`
- Output: `{ workflow_id, steps, validation }`

## `workflow_run`

Start a run. **Fire-and-poll** — returns immediately (well under the 30s tool
timeout) and does NOT wait for the workflow to finish.

- Input: `{ workflowId, featureBranch?, conversationId? }`
- Output: `{ runId, workflowId }`
- Refused (throws) if the workflow fails validation, or if it already has a
  run in progress (one concurrent run per workflow).

## `workflow_status`

Current run state for a workflow: live, if a run is in progress; otherwise
the most recent historical run's final state. **Read-only, `parallelSafe`.**

- Input: `{ workflowId }`
- Output: `{ running: boolean, runId?, workflowId, state, steps?, events?, error? }`
  (`state` is `"never_run"` if the workflow has never been run).

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
resolvability. **Read-only, `parallelSafe`.**

- Input: `{ workflowId? , workflow? }` — pass `workflowId` to validate a saved
  workflow, or `workflow` to validate one before saving.
- Output: `{ ok, errors: string[], warnings: string[] }`

## `workflow_run_list`

List a workflow's historical runs, newest first. **Read-only, `parallelSafe`.**

- Input: `{ workflowId }`
- Output: array of `{ runId, startedAt, endedAt, state }`

## `workflow_run_get`

Read one run's full detail — per-step final outcomes and the complete event
log. **Read-only, `parallelSafe`.**

- Input: `{ workflowId, runId }`
- Output: `{ runId, workflowId, startedAt, endedAt, state, steps, events, error? }`

## A full build → run → poll → cancel → inspect loop

```
workflow_create({ workflow: { name: "Demo", steps: [...] } })
  -> { workflow_id: "demo-ab12", validation: { ok: true, ... } }

workflow_run({ workflowId: "demo-ab12" })
  -> { runId: "run-abc123-xyz", workflowId: "demo-ab12" }

workflow_status({ workflowId: "demo-ab12" })        # poll every few seconds
  -> { running: true, runId: "run-abc123-xyz", state: "running", steps: {...} }
  ... eventually ...
  -> { running: false, state: "completed", steps: {...} }

workflow_cancel({ workflowId: "demo-ab12" })         # only if you need to stop early
  -> { workflowId: "demo-ab12", cancelled: true }

workflow_run_list({ workflowId: "demo-ab12" })
  -> [{ runId: "run-abc123-xyz", startedAt, endedAt, state: "completed" }, ...]

workflow_run_get({ workflowId: "demo-ab12", runId: "run-abc123-xyz" })
  -> { state: "completed", steps: { ... per-step outcomes ... }, events: [...] }
```
