// runs.js — run-state tracking (live) + run persistence (ADR-9: runs are
// first-class entities under /Workflows/.runs/<workflowId>/<runId>.json,
// distinct from a workflow's own JSON). Implements the fire-and-poll contract
// (ADR-8): startRun() kicks off scheduler.runWorkflow() WITHOUT awaiting it
// and returns a runId immediately; callers poll getStatus()/getRun().
//
// The live per-step projection itself lives in engine/run-state.js — this
// file owns only the lifecycle (start/cancel/persist/read) and the LIVE
// registry. Every scheduler event is folded into that RunState synchronously,
// which is what makes `workflow_status` return a POPULATED steps map during a
// run instead of `steps: {}` (US13/FR-036), and what the app's trajectory
// panel tails over `GET /run/<runId>?since=` (US10).

const vfs = require("./vfs");
const { RUNS_ROOT } = require("./engine/store");
const { runWorkflow } = require("./engine/scheduler");
const { createRunState, replayRunState, registerRunState, getRunState, unregisterRunState } = require("./engine/run-state");

// runId -> { workflowId, runState, abortController }
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

async function persistRun(runState) {
  await vfs.mkdir(`${RUNS_ROOT}/${runState.workflowId}`);
  await vfs.writeText(runPath(runState.workflowId, runState.runId), JSON.stringify(runState.toPersisted(), null, 2));
}

function isRunning(workflowId) {
  return ACTIVE_BY_WORKFLOW.has(workflowId);
}

function activeRunId(workflowId) {
  return ACTIVE_BY_WORKFLOW.get(workflowId);
}

/** Fire-and-poll: returns { runId } immediately; the run continues in the background. */
function startRun(workflow, { featureBranch, conversationId, maxConcurrentSteps, dryRun, fixtures, onEvent } = {}) {
  const runId = generateRunId();
  const abortController = new AbortController();
  const runState = createRunState({ runId, workflowId: workflow.id, workflowName: workflow.name }).seedSteps(workflow.steps);
  registerRunState(runState);

  LIVE.set(runId, { workflowId: workflow.id, runId, runState, abortController });
  ACTIVE_BY_WORKFLOW.set(workflow.id, runId);

  const emit = (ev) => {
    runState.record(ev);
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
        dryRun,
        fixtures,
        abortSignal: abortController.signal,
        emit,
      });
      // The scheduler's final map is authoritative for steps that never
      // emitted an event ("neutral"); everything else is already folded in.
      runState.applyFinalSteps(result.steps);
      runState.status = result.state;
      runState.finalState = result.finalState || result.state;
    } catch (err) {
      runState.status = "failed";
      runState.finalState = "failed";
      runState.error = err.message;
    } finally {
      runState.endedAt = Date.now();
      ACTIVE_BY_WORKFLOW.delete(workflow.id);
      await persistRun(runState).catch(() => {});
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

function liveSnapshot(runId, opts) {
  const live = LIVE.get(runId);
  if (!live) return undefined;
  return live.runState.snapshot(opts);
}

/** workflow_status / workflow_run_get: prefer the live projection, fall back
 *  to disk — a persisted run is REPLAYED through the same reducer, so a
 *  historical run exposes the identical per-step + agentTrace shape. */
async function getRun(workflowId, runId, opts) {
  const live = liveSnapshot(runId, opts);
  if (live && live.workflowId === workflowId) return live;
  try {
    const persisted = JSON.parse(await vfs.readText(runPath(workflowId, runId)));
    const replayed = replayRunState(persisted);
    return replayed ? replayed.snapshot(opts) : undefined;
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
    const rs = live.runState;
    byRunId.set(runId, { runId, startedAt: rs.startedAt, endedAt: rs.endedAt, state: rs.status, finalState: rs.finalState });
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
      byRunId.set(runId, { runId, startedAt: run.startedAt, endedAt: run.endedAt, state: run.state, finalState: run.finalState });
    } catch {
      // skip unreadable run file
    }
  }
  return Array.from(byRunId.values()).sort((a, b) => (b.startedAt ?? 0) - (a.startedAt ?? 0));
}

/** workflow_status: current run (live if any, else the most recent historical run). */
async function getStatus(workflowId, opts) {
  const runId = activeRunId(workflowId);
  if (runId) return { running: true, ...(await getRun(workflowId, runId, opts)) };
  const runList = await listRuns(workflowId);
  if (!runList.length) return { running: false, workflowId, state: "never_run", steps: {}, events: [] };
  const latest = await getRun(workflowId, runList[0].runId, opts);
  return { running: false, ...latest };
}

async function deleteRuns(workflowId) {
  await vfs.remove(`${RUNS_ROOT}/${workflowId}`).catch(() => {});
  for (const [runId, live] of LIVE) {
    if (live.workflowId !== workflowId) continue;
    LIVE.delete(runId);
    unregisterRunState(runId);
  }
  ACTIVE_BY_WORKFLOW.delete(workflowId);
}

/** GET /run/<runId> (http-bridge.js) — live projection by run id alone. */
function getLiveRunState(runId) {
  return getRunState(runId);
}

module.exports = {
  startRun,
  cancelRun,
  isRunning,
  activeRunId,
  getRun,
  getLiveRunState,
  listRuns,
  getStatus,
  deleteRuns,
  generateRunId,
};
