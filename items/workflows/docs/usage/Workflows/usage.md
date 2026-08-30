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
- is a plain **ag-ui** value with no delegation at all.

Steps can depend on other steps (so they run in the right order), and steps
with no dependency between them run **concurrently** — a workflow with three
independent research questions runs all three at once, not one after another.

A step can also declare that its outcome determines which of several
downstream steps to take next — the workflow "routes" itself at run time
based on what an earlier step learned. You'll see this as a node with more
than one outgoing path in the graph, only one (or a chosen few) of which
lights up during a given run.

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
cancelled, or "neutral" if it never ran, e.g. because an earlier step failed
or a routing choice skipped it) and the full event log, replayed from the
persisted run record rather than from the live engine.

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
highlighted**, each step's real-time status, and the raw event stream as it
happens. A **Cancel run** button stops it — in-progress steps are marked
cancelled and the scheduler halts; anything that hadn't started yet is marked
"neutral."

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
