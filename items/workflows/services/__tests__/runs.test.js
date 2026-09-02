// runs.test.js — fire-and-poll run tracking (ADR-8) + first-class run
// persistence (ADR-9): startRun/cancelRun/getStatus/getRun/listRuns/deleteRuns.

const test = require("node:test");
const assert = require("node:assert/strict");
const { startFakeBos, pointVfsAt } = require("./_fake-bos");

function waitUntil(fn, { timeoutMs = 2000, intervalMs = 5 } = {}) {
  const start = Date.now();
  return new Promise((resolve, reject) => {
    (function poll() {
      let result;
      try {
        result = fn();
      } catch (err) {
        return reject(err);
      }
      if (result) return resolve(result);
      if (Date.now() - start > timeoutMs) return reject(new Error("waitUntil: timed out"));
      setTimeout(poll, intervalMs);
    })();
  });
}

test("runs.js", async (t) => {
  const bos = await startFakeBos({ delegate: (body) => [{ type: "done", result: { output: `handled: ${body.task}` } }] });
  pointVfsAt(bos);
  for (const mod of ["../vfs", "../engine/store", "../engine/executor", "../engine/scheduler", "../runs"]) {
    delete require.cache[require.resolve(mod)];
  }
  const runs = require("../runs");

  const linearWorkflow = {
    id: "wf-runs-1",
    name: "Linear",
    steps: [
      { id: "a", outputType: "ag-ui", input: 1 },
      { id: "b", outputType: "ag-ui", input: 2, dependencies: ["a"] },
    ],
  };

  await t.test("startRun returns a runId immediately (fire-and-poll, ADR-8)", () => {
    const t0 = Date.now();
    const { runId } = runs.startRun(linearWorkflow);
    assert.ok(runId.startsWith("run-"));
    assert.ok(Date.now() - t0 < 100, "startRun must not block for the run's completion");
  });

  await t.test("isRunning/activeRunId reflect the in-flight run, then clear on completion", async () => {
    const wf = { ...linearWorkflow, id: "wf-runs-2" };
    const { runId } = runs.startRun(wf);
    assert.equal(runs.isRunning(wf.id), true);
    assert.equal(runs.activeRunId(wf.id), runId);
    await waitUntil(() => !runs.isRunning(wf.id));
    assert.equal(runs.activeRunId(wf.id), undefined);
  });

  await t.test("getStatus reports running:true while in-flight and the final state after completion", async () => {
    const wf = { ...linearWorkflow, id: "wf-runs-3" };
    const { runId } = runs.startRun(wf);
    const live = await runs.getStatus(wf.id);
    assert.equal(live.running, true);
    assert.equal(live.runId, runId);
    await waitUntil(() => runs.isRunning(wf.id) === false);
    const done = await runs.getStatus(wf.id);
    assert.equal(done.running, false);
    assert.equal(done.state, "completed");
  });

  await t.test("getStatus reports never_run for a workflow with no runs", async () => {
    const status = await runs.getStatus("wf-runs-never");
    assert.equal(status.state, "never_run");
    assert.equal(status.running, false);
  });

  await t.test("a completed run is persisted and readable via getRun/listRuns after the live entry ages out of memory", async () => {
    const wf = { ...linearWorkflow, id: "wf-runs-4" };
    const { runId } = runs.startRun(wf);
    await waitUntil(() => runs.isRunning(wf.id) === false);
    const run = await runs.getRun(wf.id, runId);
    assert.equal(run.state, "completed");
    assert.equal(run.steps.a.status, "completed");
    const list = await runs.listRuns(wf.id);
    assert.equal(list.length, 1);
    assert.equal(list[0].runId, runId);
  });

  await t.test("cancelRun aborts an in-flight run and getStatus reflects cancelled", async () => {
    const wf = { ...linearWorkflow, id: "wf-runs-5" };
    const { runId } = runs.startRun(wf);
    const cancelled = runs.cancelRun(wf.id);
    assert.equal(cancelled, true);
    await waitUntil(() => runs.isRunning(wf.id) === false);
    const run = await runs.getRun(wf.id, runId);
    assert.equal(run.state, "cancelled");
  });

  await t.test("cancelRun returns false when the workflow has no active run", () => {
    assert.equal(runs.cancelRun("wf-runs-not-running"), false);
  });

  await t.test("workflow_list-style live status: multiple workflows track independently", async () => {
    const wfX = { ...linearWorkflow, id: "wf-runs-x" };
    const wfY = { ...linearWorkflow, id: "wf-runs-y" };
    runs.startRun(wfX);
    assert.equal(runs.isRunning(wfX.id), true);
    assert.equal(runs.isRunning(wfY.id), false);
  });

  await t.test("deleteRuns clears live + persisted run state for a workflow", async () => {
    const wf = { ...linearWorkflow, id: "wf-runs-6" };
    const { runId } = runs.startRun(wf);
    await waitUntil(() => runs.isRunning(wf.id) === false);
    await runs.deleteRuns(wf.id);
    const list = await runs.listRuns(wf.id);
    assert.equal(list.length, 0);
    assert.equal(await runs.getRun(wf.id, runId), undefined);
  });


  // ===========================================================================
  // Scope-add: the persisted run log gains agent.* events + a per-step
  // projection (FR-015/FR-028), and a live run is addressable by runId alone.
  // ===========================================================================

  await t.test("the persisted run record carries the extended schema (agent events, selected, finalState)", async () => {
    const wf = {
      id: "wf-runs-trace",
      name: "Traced",
      steps: [{ id: "a", outputType: "delegate", agentSource: { kind: "ephemeral", task: "do the thing" } }],
    };
    const { runId } = runs.startRun(wf);
    await waitUntil(() => runs.isRunning(wf.id) === false);

    const persisted = JSON.parse(await require("../vfs").readText(`/Workflows/.runs/${wf.id}/${runId}.json`));
    assert.equal(persisted.schemaVersion, 2);
    assert.equal(persisted.state, "completed");
    assert.equal(persisted.finalState, "completed");
    assert.deepEqual(persisted.selected, {});
    assert.ok(persisted.events.every((e) => typeof e.seq === "number"), "every persisted event carries its monotonic seq");
    assert.ok(persisted.events.some((e) => e.type === "agent.prompt"), "the executed prompt is persisted (FR-028)");
    assert.ok(persisted.events.some((e) => e.type === "agent.response"));
    assert.equal(persisted.steps.a.status, "completed");
    assert.match(persisted.steps.a.agentTrace.prompt, /do the thing/);
  });

  await t.test("a persisted run replays through getRun with its full per-node trace (historical mode)", async () => {
    const wf = {
      id: "wf-runs-replay",
      name: "Replayed",
      steps: [{ id: "a", outputType: "delegate", agentSource: { kind: "ephemeral", task: "replay me" } }],
    };
    const { runId } = runs.startRun(wf);
    await waitUntil(() => runs.isRunning(wf.id) === false);
    // Drop the in-memory copy so getRun is forced through the disk + replay path.
    const { unregisterRunState } = require("../engine/run-state");
    unregisterRunState(runId);

    const run = await runs.getRun(wf.id, runId);
    assert.equal(run.state, "completed");
    assert.equal(run.steps.a.status, "completed");
    assert.match(run.steps.a.agentTrace.prompt, /replay me/);
    assert.ok(run.events.length > 0);
    assert.deepEqual(run.events, run.events.slice().sort((x, y) => x.seq - y.seq), "the replayed log stays in seq order");
  });

  await t.test("getRun(?since) tails the event log without re-sending the whole history", async () => {
    const wf = { ...linearWorkflow, id: "wf-runs-since" };
    const { runId } = runs.startRun(wf);
    await waitUntil(() => runs.isRunning(wf.id) === false);
    const full = await runs.getRun(wf.id, runId);
    assert.ok(full.events.length > 2);
    const tail = await runs.getRun(wf.id, runId, { since: full.seq - 1 });
    assert.equal(tail.events.length, 1);
    assert.equal(tail.seq, full.seq);
    // The per-step map is ALWAYS complete, even on a tail read — the panel
    // never has to reassemble status from a partial event window.
    assert.deepEqual(Object.keys(tail.steps).sort(), ["a", "b"]);
  });

  await t.test("a live run is addressable by runId alone (the GET /run/<runId> registry)", async () => {
    const wf = { ...linearWorkflow, id: "wf-runs-registry" };
    const { runId } = runs.startRun(wf);
    const state = runs.getLiveRunState(runId);
    assert.ok(state, "the run registers its live state immediately");
    assert.equal(state.workflowId, wf.id);
    assert.deepEqual(Object.keys(state.stepsSnapshot()).sort(), ["a", "b"], "steps are seeded before the first dispatch");
    await waitUntil(() => runs.isRunning(wf.id) === false);
    assert.equal(runs.getLiveRunState(runId).snapshot().state, "completed");
  });

  await bos.close();
});
