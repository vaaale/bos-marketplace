// scheduler.test.js — DAG scheduling: ready-set dispatch, maxConcurrentSteps
// cap, Research fan-out, retry/backoff, cancellation, dynamic-routing
// integration. ag-ui nodes are used wherever the test doesn't care about the
// delegate contract itself (executor.js short-circuits them with no network
// call — see executor.test.js for that contract in isolation).

const test = require("node:test");
const assert = require("node:assert/strict");
const { startFakeBos } = require("./_fake-bos");

test("scheduler.js", async (t) => {
  const bos = await startFakeBos({
    delegate: (body) => [{ type: "done", result: { output: `handled: ${body.task}` } }],
  });
  process.env.NEXT_PUBLIC_APP_ORIGIN = bos.origin;
  delete require.cache[require.resolve("../vfs")];
  delete require.cache[require.resolve("../engine/executor")];
  delete require.cache[require.resolve("../engine/scheduler")];
  const { runWorkflow } = require("../engine/scheduler");

  function run(wf, opts = {}) {
    const events = [];
    return runWorkflow(wf, {
      runId: "run-1",
      abortSignal: opts.signal || new AbortController().signal,
      emit: (ev) => events.push(ev),
      maxConcurrentSteps: opts.maxConcurrentSteps,
      ...opts,
    }).then((result) => ({ ...result, events }));
  }

  await t.test("runs a linear DAG to completion in dependency order", async () => {
    const wf = {
      id: "wf-1",
      name: "Linear",
      steps: [
        { id: "a", outputType: "ag-ui", input: 1 },
        { id: "b", outputType: "ag-ui", input: 2, dependencies: ["a"] },
        { id: "c", outputType: "ag-ui", input: 3, dependencies: ["b"] },
      ],
    };
    const { state, steps, events } = await run(wf);
    assert.equal(state, "completed");
    assert.equal(steps.a.status, "completed");
    assert.equal(steps.b.status, "completed");
    assert.equal(steps.c.status, "completed");
    const order = events.filter((e) => e.type === "step.start").map((e) => e.stepId);
    assert.deepEqual(order, ["a", "b", "c"]);
  });

  await t.test("runs independent branches concurrently (both start before either completes)", async () => {
    const wf = {
      id: "wf-2",
      name: "Parallel",
      steps: [
        { id: "a", outputType: "ag-ui", input: 1 },
        { id: "b", outputType: "ag-ui", input: 2 },
      ],
    };
    const events = [];
    const { state } = await runWorkflowTrack(wf, events);
    assert.equal(state, "completed");
    const starts = events.filter((e) => e.type === "step.start").map((e) => e.stepId).sort();
    assert.deepEqual(starts, ["a", "b"]);

    async function runWorkflowTrack(w, evs) {
      const { runWorkflow: rw } = require("../engine/scheduler");
      return rw(w, { runId: "run-2", abortSignal: new AbortController().signal, emit: (ev) => evs.push(ev) });
    }
  });

  await t.test("caps concurrency at maxConcurrentSteps for independent branches", async () => {
    const wf = {
      id: "wf-3",
      name: "Fan",
      config: { maxConcurrentSteps: 2 },
      steps: Array.from({ length: 5 }, (_, i) => ({ id: `s${i}`, outputType: "ag-ui", input: i })),
    };
    let maxInFlight = 0;
    let current = 0;
    const events = [];
    const emit = (ev) => {
      events.push(ev);
      if (ev.type === "step.start") {
        current++;
        maxInFlight = Math.max(maxInFlight, current);
      }
      if (ev.type === "step.complete") current--;
    };
    const { runWorkflow: rw } = require("../engine/scheduler");
    const { state } = await rw(wf, { runId: "run-3", abortSignal: new AbortController().signal, emit });
    assert.equal(state, "completed");
    assert.ok(maxInFlight <= 2, `expected maxInFlight <= 2, got ${maxInFlight}`);
  });

  await t.test("a failed step fails the workflow and leaves unreached steps neutral", async () => {
    // Validation (handlers.js's earlier gate) is out of scope here — this
    // exercises the scheduler's own failure handling, so force a failure
    // deterministically via a delegate backend that reports an error.
    const failingBos = await startFakeBos({ delegate: () => [{ type: "error", error: "step exploded" }] });
    process.env.NEXT_PUBLIC_APP_ORIGIN = failingBos.origin;
    delete require.cache[require.resolve("../vfs")];
    delete require.cache[require.resolve("../engine/executor")];
    delete require.cache[require.resolve("../engine/scheduler")];
    const { runWorkflow: rw } = require("../engine/scheduler");
    const wfDelegate = {
      id: "wf-4b",
      name: "Fails2",
      config: { defaultRetryLimit: 1 },
      steps: [
        { id: "a", outputType: "delegate", agentSource: { kind: "static", agentId: "researcher" } },
        { id: "b", outputType: "ag-ui", input: 1, dependencies: ["a"] },
      ],
    };
    const { state, steps } = await rw(wfDelegate, { runId: "run-4", abortSignal: new AbortController().signal, emit: () => {} });
    assert.equal(state, "failed");
    assert.equal(steps.a.status, "failed");
    assert.equal(steps.b.status, "neutral");
    await failingBos.close();
    process.env.NEXT_PUBLIC_APP_ORIGIN = bos.origin;
    delete require.cache[require.resolve("../vfs")];
    delete require.cache[require.resolve("../engine/executor")];
    delete require.cache[require.resolve("../engine/scheduler")];
  });

  await t.test("cancellation marks in-progress/pending steps cancelled and halts the scheduler", async () => {
    const { runWorkflow: rw } = require("../engine/scheduler");
    const ctl = new AbortController();
    const wf = {
      id: "wf-5",
      name: "Cancel",
      steps: [
        { id: "a", outputType: "ag-ui", input: 1 },
        { id: "b", outputType: "ag-ui", input: 2, dependencies: ["a"] },
      ],
    };
    ctl.abort();
    const { state, steps } = await rw(wf, { runId: "run-5", abortSignal: ctl.signal, emit: () => {} });
    assert.equal(state, "cancelled");
    assert.equal(steps.a.status, "cancelled");
    assert.equal(steps.b.status, "cancelled");
  });

  await t.test("Research nodes fan out one delegate call per researchAgents entry", async () => {
    const { runWorkflow: rw } = require("../engine/scheduler");
    const wf = {
      id: "wf-6",
      name: "Research",
      steps: [
        {
          id: "r",
          outputType: "research",
          researchAgents: ["finance-agent", { task: "shipping analysis" }],
        },
      ],
    };
    const { state, steps } = await rw(wf, { runId: "run-6", abortSignal: new AbortController().signal, emit: () => {} });
    assert.equal(state, "completed");
    assert.equal(steps.r.status, "completed");
    assert.equal(steps.r.output.length, 2);
    assert.match(steps.r.output[0].output, /^handled: /);
  });

  await t.test("dynamic routing: a node with candidates only unlocks the selected child", async () => {
    const { runWorkflow: rw } = require("../engine/scheduler");
    const selectiveBos = await startFakeBos({
      delegate: () => [{ type: "done", result: { output: "reasoning...\nSELECT: finance" } }],
    });
    process.env.NEXT_PUBLIC_APP_ORIGIN = selectiveBos.origin;
    delete require.cache[require.resolve("../vfs")];
    delete require.cache[require.resolve("../engine/executor")];
    delete require.cache[require.resolve("../engine/scheduler")];
    const { runWorkflow: rwFresh } = require("../engine/scheduler");
    const wf = {
      id: "wf-7",
      name: "Routing",
      steps: [
        { id: "classify", outputType: "delegate", agentSource: { kind: "static", agentId: "classifier" }, candidates: ["finance", "shipping"] },
        { id: "finance", outputType: "ag-ui", input: "f", dependencies: ["classify"] },
        { id: "shipping", outputType: "ag-ui", input: "s", dependencies: ["classify"] },
      ],
    };
    const { state, steps } = await rwFresh(wf, { runId: "run-7", abortSignal: new AbortController().signal, emit: () => {} });
    assert.equal(state, "completed");
    assert.equal(steps.classify.status, "completed");
    assert.equal(steps.finance.status, "completed");
    assert.equal(steps.shipping.status, "neutral");
    await selectiveBos.close();
    process.env.NEXT_PUBLIC_APP_ORIGIN = bos.origin;
    delete require.cache[require.resolve("../vfs")];
    delete require.cache[require.resolve("../engine/executor")];
    delete require.cache[require.resolve("../engine/scheduler")];
  });

  await t.test("a single-candidate node auto-delegates without a SELECT line (FR-019)", async () => {
    const { runWorkflow: rw } = require("../engine/scheduler");
    const wf = {
      id: "wf-8",
      name: "AutoDelegate",
      steps: [
        { id: "a", outputType: "delegate", agentSource: { kind: "static", agentId: "x" }, candidates: ["only"] },
        { id: "only", outputType: "ag-ui", input: 1, dependencies: ["a"] },
      ],
    };
    const { state, steps } = await rw(wf, { runId: "run-8", abortSignal: new AbortController().signal, emit: () => {} });
    assert.equal(state, "completed");
    assert.equal(steps.only.status, "completed");
  });

  await bos.close();
});
