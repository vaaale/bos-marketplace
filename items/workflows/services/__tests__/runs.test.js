// runs.test.js — fire-and-poll run tracking (ADR-8) + first-class run
// persistence (ADR-9): startRun/cancelRun/getStatus/getRun/listRuns/deleteRuns.

const test = require("node:test");
const assert = require("node:assert/strict");
const { startFakeBos } = require("./_fake-bos");

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
  process.env.NEXT_PUBLIC_APP_ORIGIN = bos.origin;
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

  await bos.close();
});
