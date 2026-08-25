// runs.js — run-state tracking (live, in-memory) + run persistence (ADR-9:
// runs are first-class entities under /Workflows/.runs/<workflowId>/<runId>.json,
// distinct from a workflow's own JSON). Implements the fire-and-poll contract
// (ADR-8): startRun() kicks off scheduler.runWorkflow() WITHOUT awaiting it
// and returns a runId immediately; callers poll getStatus()/getRun().

const vfs = require("./vfs");
const { RUNS_ROOT } = require("./engine/store");
const { runWorkflow } = require("./engine/scheduler");

// runId -> { workflowId, abortController, startedAt, state: "running", steps, events }
const LIVE = new Map();
// workflowId -> runId, only while that workflow has an active run (single
// concurrent run per workflow — a second workflow_run while one is active is
// rejected by handlers.js).
const ACTIVE_BY_WORKFLOW = new Map();

function generateRunId() {
  return `run-${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 8)}`;
}

function runPath(workflowId, runId) {
  return `${RUNS_ROOT}/${workflowId}/${runId}.json`;
}

async function persistRun(run) {
  await vfs.mkdir(`${RUNS_ROOT}/${run.workflowId}`);
  await vfs.writeText(runPath(run.workflowId, run.runId), JSON.stringify(run, null, 2));
}

function isRunning(workflowId) {
  return ACTIVE_BY_WORKFLOW.has(workflowId);
}

function activeRunId(workflowId) {
  return ACTIVE_BY_WORKFLOW.get(workflowId);
}

/** Fire-and-poll: returns { runId } immediately; the run continues in the background. */
function startRun(workflow, { featureBranch, conversationId, maxConcurrentSteps, onEvent } = {}) {
  const runId = generateRunId();
  const abortController = new AbortController();
  const live = {
    workflowId: workflow.id,
    runId,
    startedAt: Date.now(),
    state: "running",
    steps: {},
    events: [],
    abortController,
  };
  LIVE.set(runId, live);
  ACTIVE_BY_WORKFLOW.set(workflow.id, runId);

  const emit = (ev) => {
    live.events.push(ev);
    if (onEvent) onEvent(ev);
  };

  void (async () => {
    try {
      const result = await runWorkflow(workflow, {
        runId,
        workflowName: workflow.name,
        featureBranch,
        conversationId,
        maxConcurrentSteps,
        abortSignal: abortController.signal,
        emit,
      });
      live.state = result.state;
      live.steps = result.steps;
    } catch (err) {
      live.state = "failed";
      live.error = err.message;
    } finally {
      live.endedAt = Date.now();
      ACTIVE_BY_WORKFLOW.delete(workflow.id);
      await persistRun({
        workflowId: live.workflowId,
        runId: live.runId,
        startedAt: live.startedAt,
        endedAt: live.endedAt,
        state: live.state,
        steps: live.steps,
        events: live.events,
        error: live.error,
      }).catch(() => {});
      // Keep the finished run in LIVE for a short grace period so an
      // immediate workflow_status poll still sees it without a VFS round
      // trip; getRun()/getStatus() below fall back to disk regardless.
    }
  })();

  return { runId };
}

function cancelRun(workflowId) {
  const runId = ACTIVE_BY_WORKFLOW.get(workflowId);
  if (!runId) return false;
  const live = LIVE.get(runId);
  if (!live) return false;
  live.abortController.abort();
  return true;
}

function liveSnapshot(runId) {
  const live = LIVE.get(runId);
  if (!live) return undefined;
  return {
    workflowId: live.workflowId,
    runId: live.runId,
    startedAt: live.startedAt,
    endedAt: live.endedAt,
    state: live.state,
    steps: live.steps,
    events: live.events,
    error: live.error,
  };
}

/** workflow_status / workflow_run_get: prefer the live snapshot, fall back to disk. */
async function getRun(workflowId, runId) {
  const live = liveSnapshot(runId);
  if (live && live.workflowId === workflowId) return live;
  try {
    return JSON.parse(await vfs.readText(runPath(workflowId, runId)));
  } catch {
    return undefined;
  }
}

/**
 * workflow_run_list: historical runs for a workflow, newest first. Merges the
 * in-memory LIVE map (authoritative for a run that just finished but whose
 * persistRun() write may not have landed on disk yet — persistence happens
 * AFTER the run settles, so there is a real window where a completed run is
 * only visible in memory) with whatever is already durably persisted.
 */
async function listRuns(workflowId) {
  const byRunId = new Map();
  for (const [runId, live] of LIVE) {
    if (live.workflowId !== workflowId) continue;
    byRunId.set(runId, { runId, startedAt: live.startedAt, endedAt: live.endedAt, state: live.state });
  }
  let entries = [];
  try {
    entries = await vfs.list(`${RUNS_ROOT}/${workflowId}`);
  } catch {
    entries = [];
  }
  for (const e of entries) {
    if (e.type !== "file" || !e.name.endsWith(".json")) continue;
    const runId = e.name.replace(/\.json$/, "");
    if (byRunId.has(runId)) continue; // the in-memory snapshot is authoritative
    try {
      const run = JSON.parse(await vfs.readText(e.path));
      byRunId.set(runId, { runId, startedAt: run.startedAt, endedAt: run.endedAt, state: run.state });
    } catch {
      // skip unreadable run file
    }
  }
  return Array.from(byRunId.values()).sort((a, b) => (b.startedAt ?? 0) - (a.startedAt ?? 0));
}

/** workflow_status: current run (live if any, else the most recent historical run). */
async function getStatus(workflowId) {
  const runId = activeRunId(workflowId);
  if (runId) return { running: true, ...(await getRun(workflowId, runId)) };
  const runs = await listRuns(workflowId);
  if (!runs.length) return { running: false, workflowId, state: "never_run" };
  const latest = await getRun(workflowId, runs[0].runId);
  return { running: false, ...latest };
}

async function deleteRuns(workflowId) {
  await vfs.remove(`${RUNS_ROOT}/${workflowId}`).catch(() => {});
  for (const [runId, live] of LIVE) if (live.workflowId === workflowId) LIVE.delete(runId);
  ACTIVE_BY_WORKFLOW.delete(workflowId);
}

module.exports = {
  startRun,
  cancelRun,
  isRunning,
  activeRunId,
  getRun,
  listRuns,
  getStatus,
  deleteRuns,
  generateRunId,
};
