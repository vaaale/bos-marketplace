---
name: workflow-manager
description: Build, run, and inspect multi-step agent workflows (DAGs of delegate/tool/research/ag-ui nodes) via the Workflow Manager's service-declared tools.
---

# Workflow Manager

The Workflow Manager service owns a complete workflow engine — a node model, a
parallel scheduler, dynamic routing, and persistence — and exposes it to you
as 12 native tools: `workflow_list`, `workflow_create`, `workflow_read`,
`workflow_modify`, `workflow_run`, `workflow_status`, `workflow_cancel`,
`workflow_delete`, `workflow_export`, `workflow_validate`, `workflow_run_list`,
`workflow_run_get`. Use this skill whenever a task calls for a multi-step,
possibly-branching, possibly-parallel piece of work that's worth saving and
re-running rather than doing once inline.

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
     Use this for independent sub-questions (e.g. "check finance exposure",
     "check shipping exposure", "check legal exposure") that don't depend on
     each other — they run concurrently, up to the workflow's
     `maxConcurrentSteps`.
   - `"ag-ui"` — no delegation at all; the node's `input` is returned directly
     as a UI artifact. Use this for a fixed value or a UI-only step.

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

## Dynamic routing — candidates (use sparingly, only when the workflow should adapt)

A step MAY declare `"candidates": [{ "id": "<step-id>", "description": "..." }, ...]`
— a list of DOWNSTREAM step ids (which must already exist elsewhere in
`steps[]`, each declaring this step as one of its own `dependencies`) that
this step's agent chooses between as its **last action**, based on what it
learned while executing. Use this when the right next step genuinely depends
on information only available after this step runs (e.g. "classify the
company, then route to the Finance, Construction, or Shipping handling" — you
can't know which branch applies until classification happens).

- **Exactly one candidate**: no choice is needed — it's just a delegation,
  wired automatically. Don't add a routing instruction for a single-candidate
  step.
- **Multiple candidates**: the executor automatically appends a routing
  instruction to the step's task asking the agent to end its response with a
  line of the exact form `SELECT: <candidate-id>[, <candidate-id> ...]`
  (multiple ids for a step whose candidates run in parallel). You do not need
  to write this instruction yourself when authoring the workflow — just
  declare the `candidates` array; the engine handles the rest, including
  retrying automatically if the agent's response is missing a valid
  selection.
- Every candidate NOT selected simply never becomes ready — it is reported as
  `"neutral"` (never ran) in that run's history, not as an error.

## Building a workflow

Prefer constructing the workflow object yourself and passing it via
`workflow_create`'s `workflow` parameter — you already know the node shapes
above, and this avoids an extra planning round-trip:

```json
{
  "workflow": {
    "name": "Sustainability Analysis",
    "config": { "maxConcurrentSteps": 5 },
    "steps": [
      { "id": "classify", "outputType": "delegate",
        "agentSource": { "kind": "ephemeral", "task": "Classify the company's primary business line." },
        "candidates": [
          { "id": "finance", "description": "Financial services company" },
          { "id": "shipping", "description": "Shipping/logistics company" }
        ] },
      { "id": "finance", "outputType": "delegate", "dependencies": ["classify"],
        "agentSource": { "kind": "ephemeral", "task": "Analyze financial-sector sustainability exposure." } },
      { "id": "shipping", "outputType": "delegate", "dependencies": ["classify"],
        "agentSource": { "kind": "ephemeral", "task": "Analyze shipping-sector sustainability exposure." } },
      { "id": "research", "outputType": "research", "dependencies": ["classify"],
        "researchAgents": [
          { "task": "Research the company's carbon disclosure history." },
          { "task": "Research the company's supply-chain sustainability record." }
        ] },
      { "id": "report", "outputType": "delegate", "dependencies": ["finance", "shipping", "research"],
        "agentSource": { "kind": "ephemeral", "task": "Write the final sustainability report from all upstream findings." } }
    ]
  }
}
```

If you'd rather describe the goal in plain language and let the engine plan
it, call `workflow_create` with `taskDescription` instead of `workflow` — it
costs one extra delegation but needs no node authoring.

Always follow up a create/modify with `workflow_validate` if you're not
already confident the DAG is acyclic and every dependency/candidate resolves
— it's cheap and catches authoring mistakes before a run wastes time.

## Executing a workflow — fire-and-poll

`workflow_run` is **asynchronous**: it returns `{ runId, workflowId }`
immediately and does **not** wait for the run to finish (a multi-step run can
take minutes; the tool call itself must return well under 30 seconds). After
calling it:

1. Poll `workflow_status` (or `workflow_run_get` with the `runId`) every so
   often to observe progress — don't call it in a tight loop; a few seconds
   between polls is reasonable for most workflows.
2. `workflow_status` returns the current run's per-step statuses
   (`pending`/`running`/`completed`/`failed`/`cancelled`/`neutral`) and its
   overall `state`. Once `state` is `completed`, `failed`, or `cancelled`,
   the run is done.
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

## Common mistakes to avoid

- Don't add a `dependencies` edge just to force serial execution when steps
  are actually independent — that defeats the parallel scheduler and slows
  the workflow down for no reason.
- Don't use `candidates` for ordinary linear dependencies — it's specifically
  for run-time, information-dependent branching. If you already know the
  order at authoring time, just use `dependencies`.
- Don't poll `workflow_status` faster than the workflow could plausibly
  progress — most steps take at least a few seconds.
- Don't forget `toolName` on a `"tool"`-outputType step, or `researchAgents`
  on a `"research"`-outputType step — `workflow_validate` will catch both.
