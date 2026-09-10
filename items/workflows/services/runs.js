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
// workflowId -> [runId, …] in start order, only while that workflow has at
// least one active run. Usually exactly one: `workflow_run` still rejects a
// second run while one is in progress. EVENT-triggered runs are the exception
// (US16/FR-043 — two events for the same workflow start two independent runs),
// which is why this is a list rather than a single id: each run removes only
// its OWN entry when it settles, so one finishing early can never make a
// still-running sibling look idle. `activeRunId` reports the newest.
const ACTIVE_BY_WORKFLOW = new Map();

function markActive(workflowId, runId) {
  const list = ACTIVE_BY_WORKFLOW.get(workflowId);
  if (list) list.push(runId);
  else ACTIVE_BY_WORKFLOW.set(workflowId, [runId]);
}

function clearActive(workflowId, runId) {
  const list = ACTIVE_BY_WORKFLOW.get(workflowId);
  if (!list) return;
  const idx = list.indexOf(runId);
  if (idx >= 0) list.splice(idx, 1);
  if (!list.length) ACTIVE_BY_WORKFLOW.delete(workflowId);
}

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
  return (ACTIVE_BY_WORKFLOW.get(workflowId) || []).length > 0;
}

/** The NEWEST active run for a workflow (undefined when it is idle). */
function activeRunId(workflowId) {
  const list = ACTIVE_BY_WORKFLOW.get(workflowId) || [];
  return list.length ? list[list.length - 1] : undefined;
}

/** Every active run for a workflow, oldest first (FR-043). */
function activeRunIds(workflowId) {
  return Array.from(ACTIVE_BY_WORKFLOW.get(workflowId) || []);
}

/** Fire-and-poll: returns { runId } immediately; the run continues in the
 *  background. `startSource`/`triggerEvent*`/`eventContext` are US16/FR-041's
 *  run provenance — they are recorded on the run and, for an event-triggered
 *  run, made available to the workflow's root node(s) (FR-042, executor.js). */
function startRun(
  workflow,
  { featureBranch, conversationId, maxConcurrentSteps, dryRun, fixtures, onEvent, startSource, triggerEventId, triggerEventType, eventContext } = {},
) {
  const runId = generateRunId();
  const abortController = new AbortController();
  const runState = createRunState({
    runId,
    workflowId: workflow.id,
    workflowName: workflow.name,
    startSource,
    triggerEventId,
    triggerEventType,
    eventContext,
  }).seedSteps(workflow.steps);
  registerRunState(runState);

  LIVE.set(runId, { workflowId: workflow.id, runId, runState, abortController });
  markActive(workflow.id, runId);

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
        startSource: runState.startSource,
        triggerEventId: runState.triggerEventId,
        triggerEventType: runState.triggerEventType,
        eventContext: runState.eventContext,
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
      clearActive(workflow.id, runId);
      await persistRun(runState).catch(() => {});
      // Keep the finished run in LIVE for a short grace period so an
      // immediate workflow_status poll still sees it without a VFS round
      // trip; getRun()/getStatus() below fall back to disk regardless.
    }
  })();

  return { runId };
}

function cancelRun(workflowId) {
  const runId = activeRunId(workflowId);
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
    byRunId.set(runId, {
      runId,
      startedAt: rs.startedAt,
      endedAt: rs.endedAt,
      state: rs.status,
      finalState: rs.finalState,
      startSource: rs.startSource,
      triggerEventType: rs.triggerEventType,
      triggerEventId: rs.triggerEventId,
    });
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
      byRunId.set(runId, {
        runId,
        startedAt: run.startedAt,
        endedAt: run.endedAt,
        state: run.state,
        finalState: run.finalState,
        // A pre-US16 run record has no startSource — it was a tool run.
        startSource: run.startSource || "tool",
        triggerEventType: run.triggerEventType ?? null,
        triggerEventId: run.triggerEventId ?? null,
      });
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

/**
 * US19 — drop ONE run's in-memory state after its persisted log is deleted.
 * This is load-bearing, not just defensive: a settled run stays in LIVE (the
 * post-run grace entry is never evicted), and listRuns() merges LIVE with
 * disk — so without this, a deleted run would keep reappearing in
 * workflow_run_list until the service restarts. Never touches an ACTIVE run:
 * an in-progress run has no persisted log yet (persistRun runs at settle), so
 * deleteRunLogs() reports it not_found and never gets here — the active-list
 * check is the safety net for that invariant.
 */
function forgetRun(workflowId, runId) {
  const live = LIVE.get(runId);
  if (!live || live.workflowId !== workflowId) return;
  if ((ACTIVE_BY_WORKFLOW.get(workflowId) || []).includes(runId)) return;
  LIVE.delete(runId);
  unregisterRunState(runId);
}

/**
 * US19 — workflow_run_delete: remove individual persisted run logs, leaving
 * the workflow definition (and every other run) untouched. Per run:
 *   - `deleted`   — the log existed and its /api/fs delete succeeded
 *   - `not_found` — no persisted log at that path (already deleted, an
 *                   in-progress run, or a run id belonging to a DIFFERENT
 *                   workflow — the path is always built from the CALLER's
 *                   workflowId, which is the cross-workflow collision guard)
 *   - `error`     — the log exists but the delete itself failed
 * The existence pre-check is what makes not_found deterministic: BOS's
 * /api/fs `op:delete` is fs.rm(..., { force: true }) under the hood, so
 * deleting a missing path reports plain success and could never distinguish
 * "deleted" from "was never there". Idempotent by construction — a second
 * call for the same ids is all not_found, never an abort.
 */
async function deleteRunLogs(workflowId, runIds) {
  const results = [];
  let deleted = 0;
  for (const runId of runIds) {
    const path = runPath(workflowId, runId);
    if (!(await vfs.exists(path))) {
      results.push({ runId, status: "not_found" });
      continue;
    }
    try {
      await vfs.remove(path);
      forgetRun(workflowId, runId);
      deleted++;
      results.push({ runId, status: "deleted" });
    } catch (err) {
      results.push({ runId, status: "error", error: err.message });
    }
  }
  return { workflowId, deleted, results };
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
  activeRunIds,
  getRun,
  getLiveRunState,
  listRuns,
  getStatus,
  deleteRuns,
  deleteRunLogs,
  generateRunId,
};
