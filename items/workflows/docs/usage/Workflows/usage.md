# Workflow Manager — Usage Guide

The Workflow Manager lets you (or the assistant) build multi-step, possibly
branching, possibly parallel pieces of work — "workflows" — save them, run
them, and inspect exactly what happened afterward. It's made of two parts
that always agree on the same data: a background **service** that owns the
actual workflow engine, and an **app** (this window) that gives you a graph
view of it.

## What a workflow is

A workflow is a DAG (directed acyclic graph) of steps. Each step either:

- **delegates** to an agent (an existing BrowserOS agent, or a one-off
  "ephemeral" agent described inline — a task plus the tools/skills it needs),
- calls a single **tool**,
- fans out several agents in parallel as a **research** step and collects
  their outputs, or
- is a plain **ag-ui** value with no delegation at all, or
- **emits an event** into BrowserOS — an `event` step has no agent at all: it
  publishes an event (with a payload you write literally, or assembled from
  earlier steps' outputs with `{{stepId.field}}` placeholders) that other
  workflows, apps, or notification handlers can react to. A dry run with a
  fixture for that step never actually fires the event.

Steps can depend on other steps (so they run in the right order), and steps
with no dependency between them run **concurrently** — a workflow with three
independent research questions runs all three at once, not one after another.

A step can also declare that its outcome determines which of several
downstream steps to take next — the workflow "routes" itself at run time
based on what an earlier step learned. You'll see this as a node with more
than one outgoing path in the graph, only one (or a chosen few) of which
lights up during a given run. The step that isn't chosen is shown as
**skipped** ("branch not selected") — that's a normal outcome, not an error.
Only the steps that were explicitly declared as branch choices are gated this
way; a shared step that sits between the branch point and the branches runs
regardless of the choice.

If a run chooses a branch but that branch ends up doing nothing at all, the
run deliberately does **not** report a plain success — it finishes as
"Completed · warnings", so a workflow that silently skipped its real work is
visible instead of looking green.

## Starting a workflow when something happens (event triggers)

A workflow doesn't have to be started by hand. Give it a list of **triggers** —
BrowserOS notification event types — and it runs itself whenever one of those
events is emitted:

```json
{
  "name": "Triage a new download",
  "triggers": ["com.bos.files.created"],
  "steps": [ … ]
}
```

- Add or change `triggers` with `workflow_modify` (or ask the assistant); the
  subscription updates the moment the workflow is saved, and disappears when
  you remove the trigger or delete the workflow.
- Several workflows can watch the same event — all of them run.
- A trigger may name one exact type, or a whole family with a wildcard:
  `"com.bos.files.*"`.
- **The event's payload is handed to the workflow's first step**, as a
  "Triggering event" section in its prompt — so a triage workflow can read the
  path of the file that just appeared without you wiring anything up.
- Each run records how it started ("user", "tool" or "event") and, for an
  event run, which event triggered it — visible in the run history.
- Two events arriving close together start **two independent runs** of the
  same workflow; they don't queue and they don't cancel each other. (Starting
  a run by hand while one is already in progress is still refused.)

The event is marked handled as soon as the run *starts*, not when it finishes
— a workflow that takes an hour never blocks the notification system.

## How long things take

- A **research** step runs all of its sub-agents at the same time, so it takes
  about as long as its slowest one — not the sum. Two 20-minute
  investigations take ~20 minutes, not 40.
- The same investigations wired as separate delegate steps run one after
  another and take the sum. If the work is independent, prefer one research
  step.
- A tool step is usually seconds; an ag-ui step is instant.
- A **dry run** (below) evaluates the whole graph in seconds.

A stuck agent can't run forever: the engine enforces a per-step timeout and a
whole-run deadline (both configurable on the workflow, with safe defaults), so
a hung step fails with a timeout reason rather than quietly consuming an hour.

## Example: building a workflow from a one-line trigger

Ask the assistant something like:

> Build a workflow that fetches this week's sales CSV, cleans it, and emails
> a summary to the team.

The assistant (guided by the bundled Workflow Manager skill) will construct a
small DAG — an ingest step, a clean step, and a report step, each wired with
the right dependencies — and save it via the `workflow_create` tool. You'll
see it appear in the **list view** below immediately (both the app and the
assistant read the exact same `/Workflows/` location, so nothing you create
one way is invisible to the other).

A more elaborate example — "Analyze this company's sustainability exposure,
covering finance, shipping, and legal risk, then write a report" — is exactly
the kind of task that benefits from a **research** step (three independent
sub-questions run in parallel) feeding into a final report step that waits
for all three.

## The three views

### List

Shows every workflow under `/Workflows/` — its name, id, step count, and a
status pill (Ready / Running / Failed). The **service status pill** in the
toolbar tells you whether the background engine is actually running; if it's
stopped, a banner explains that workflow tools and runs are unavailable until
you start it (Settings → Plugins → Services → Workflow Manager → Start).
When there are no workflows yet, an empty-state panel explains where to put
one and offers a "New workflow" button.

Click a card to open its **detail** view, or use the inline **Run**/**Watch**/
**Cancel** buttons directly from the list.

### Detail

Opens a single workflow: its graph (nodes = steps, edges = dependencies),
its full step list with each step's agent-source/output-type label (e.g.
`tool · fetch:csv`, `research · 3 agent(s)`, `delegate · db`), and action
buttons for every workflow lifecycle operation — Run, Edit, Export, Validate,
Delete. A **historical runs** strip lists every past run of this workflow;
clicking one that has finished opens a **replay panel** showing exactly what
happened on that run — each step's final outcome (completed, failed,
cancelled, "skipped" if a routing choice passed it over, or "neutral" if it
never ran at all) and the full event log, replayed from the persisted run
record rather than from the live engine. Clicking a node in that replayed
graph opens the same **node trajectory panel** described below, with the
agent's prompt, tool calls, and response from that historical run.

**Edit** opens the graph editor in place: click a node in the graph (or its
row in the step list) to select it, edit its fields in the panel below
(outputType, agentSource — static agent id or an ephemeral task/tools/skills
— toolName, research fan-out, dynamic-routing candidates, input JSON,
outputConvention, retry/timeout), toggle which other steps it depends on
(the graph's edges), or add/delete steps entirely. "Save" sends the whole
`steps` array through `workflow_modify`, so an edit is a real, persisted
change to the same `/Workflows/<id>-workflow.json` the engine and the
assistant read — not a separate draft. An "Edit as JSON" toggle in the same
panel switches to raw-JSON editing for anyone who prefers it.

### Run

Opens automatically when you start (or resume watching) a run. Shows a
progress bar, the live graph with the **currently-executing step
highlighted**, and the raw event stream as it happens. A **Cancel run** button
stops it — in-progress steps are marked cancelled and the scheduler halts;
anything that hadn't started yet is marked "neutral."

Per-step status lives on the graph itself (node colors) plus the trajectory
panel below — there's no separate status list repeating what the graph already
shows.

### The node trajectory panel (debugging what an agent actually did)

**Click any node** on the graph — in a live run or in a historical replay — and
a panel opens to the right of the graph showing that node's full execution
trajectory. Drag the divider between the graph and the panel to resize it; the
graph reflows into whatever space is left. Click another node to switch, or the
✕ to dismiss it.

The panel is the per-node debugging surface. It shows:

- **Identity** — the node's name, its current/final status, the agent behind it
  (a named agent, an ephemeral one, or a tool node), and what it produces.
- **Currently** — a one-line "what is it doing right now" while it runs, and a
  **Retrying — attempt 2/3** line when a step is on a retry.
- **Executed prompt** — the exact instructions the node's agent received,
  including the upstream context that was fed into it.
- **Reasoning** — the agent's thinking, where the provider exposes it.
- **Tool calls** — every tool the agent called, with its arguments (`in`), its
  return value (`out`), and whether it succeeded, failed, or is still running.
- **Sub-agents · fan-out** — for a research step, each parallel sub-agent with
  its own status, so you can see which one is the straggler.
- **Agent response** — the text the agent produced (or a live "generating…"
  indicator while it streams).
- **Lifecycle events** — start / retry / running / complete / fail / cancel /
  skip, with timestamps and durations.
- **Output / artifact** — what the step handed downstream.

For a live run this updates in real time; for a historical run it is replayed
from the persisted log, so a run from last week is just as inspectable. A node
that never ran shows "No events yet — this node never ran in this run."

### Dry runs — check a workflow in seconds

Before committing to a long run you (or the assistant) can run a workflow in
**dry-run mode**: name any nodes you want to fake, give each one a canned
output, and the engine skips their real execution entirely while running
everything else normally. It's the fast way to confirm the graph is wired
correctly and the right branch is taken, without waiting for a 40-minute
research step. Ask the assistant for it in so many words:

> Dry-run the sustainability workflow with a canned research result and force
> the finance branch.

which becomes a `workflow_run` with `dryRun: true` and
`fixtures: { "research": …, "classify": { "select_branch": { "selected": ["finance"] } } }`.

## The bundled skill

Installing the Workflow Manager also installs a skill (`workflow-manager`)
that teaches the assistant how to build well-formed workflows — including
when to use ephemeral agents vs. a named one, when a step should fan out as
research, how dynamic routing works, and how to poll a run and retrieve
historical results — so you can drive the whole thing conversationally
without ever opening this app, if you prefer.

## Capability grant

The app reads the service's own bound port to talk to it directly; if it's
ever installed from a remote marketplace (opaque-origin sandbox) rather than
your own local one, it falls back to the `services:read` capability, which
must be granted explicitly in Settings → Apps — it's never granted
automatically.
