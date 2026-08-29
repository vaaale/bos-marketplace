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
    // FR-029: the selection arrives as a structured `select_branch` tool call
    // in the delegate stream — the prose in `output` is deliberately WRONG to
    // prove the engine never reads it.
    const selectiveBos = await startFakeBos({
      delegate: () => [
        { type: "tool", name: "select_branch", args: { selected: ["finance"] } },
        { type: "done", result: { output: "On reflection I think shipping is interesting too." } },
      ],
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
    // FR-031: an unselected leaf is explicitly SKIPPED, not left silently pending.
    assert.equal(steps.shipping.status, "skipped");
    assert.equal(steps.shipping.reason, "branch-not-selected");
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


  // ===========================================================================
  // Scope-add: US11 (Option A + zero-leaf guard), US13 (fan-out observability),
  // US14 (dry-run fixtures), US15 (per-step + per-run timeouts).
  // ===========================================================================

  /** Fresh scheduler bound to a purpose-built fake BOS (module cache reset so
   *  vfs.js/executor.js re-read NEXT_PUBLIC_APP_ORIGIN). */
  async function withBos(delegate, fn) {
    const fake = await startFakeBos({ delegate });
    const previous = process.env.NEXT_PUBLIC_APP_ORIGIN;
    process.env.NEXT_PUBLIC_APP_ORIGIN = fake.origin;
    for (const mod of ["../vfs", "../engine/executor", "../engine/scheduler"]) delete require.cache[require.resolve(mod)];
    try {
      return await fn(require("../engine/scheduler"), fake);
    } finally {
      await fake.close();
      process.env.NEXT_PUBLIC_APP_ORIGIN = previous;
      for (const mod of ["../vfs", "../engine/executor", "../engine/scheduler"]) delete require.cache[require.resolve(mod)];
    }
  }

  function selectBranch(ids) {
    return [
      { type: "tool", name: "select_branch", args: { selected: ids } },
      { type: "done", result: { output: "selection emitted structurally" } },
    ];
  }

  await t.test("FR-031 Option A: a SHARED step between the branch point and the leaves runs regardless of the selection", async () => {
    await withBos(
      (body) => (body.task.includes("classify") || body.ephemeral?.name === "workflow-node-classify" ? selectBranch(["alarm"]) : [{ type: "done", result: { output: "ok" } }]),
      async ({ runWorkflow: rw }) => {
        const events = [];
        const wf = {
          id: "wf-optionA",
          name: "Option A",
          steps: [
            { id: "classify", outputType: "delegate", agentSource: { kind: "ephemeral", task: "classify the signal" }, candidates: ["alarm", "quiet"] },
            // `render` depends on the routing node but is NOT one of its
            // candidates — under Option A it must run normally. (This is the
            // exact node that used to block the entire downstream graph.)
            { id: "render", outputType: "ag-ui", input: { rendered: true }, dependencies: ["classify"] },
            { id: "alarm", outputType: "ag-ui", input: { alarm: true }, dependencies: ["render"] },
            { id: "quiet", outputType: "ag-ui", input: { quiet: true }, dependencies: ["render"] },
          ],
        };
        const { state, steps, selected } = await rw(wf, { runId: "run-optionA", abortSignal: new AbortController().signal, emit: (ev) => events.push(ev) });
        assert.equal(state, "completed");
        assert.equal(steps.render.status, "completed", "the shared step must not be gated by the selection");
        assert.equal(steps.alarm.status, "completed");
        assert.equal(steps.quiet.status, "skipped");
        assert.deepEqual(selected.classify, ["alarm"]);
        const skip = events.find((e) => e.type === "step.skip" && e.stepId === "quiet");
        assert.equal(skip.reason, "branch-not-selected");
      },
    );
  });

  await t.test("FR-032: a selected branch that executes ZERO leaves reports completed_with_warnings, not completed", async () => {
    await withBos(
      () => selectBranch(["second"]),
      async ({ runWorkflow: rw }) => {
        const events = [];
        const wf = {
          id: "wf-zero-leaf",
          name: "Zero leaves",
          steps: [
            { id: "classify", outputType: "delegate", agentSource: { kind: "ephemeral", task: "classify" }, candidates: ["first", "second"] },
            { id: "first", outputType: "ag-ui", input: 1, dependencies: ["classify"] },
            // `second` was selected, but it can only run after `first`, which
            // the same selection skipped — so the branch performs NOTHING.
            { id: "second", outputType: "ag-ui", input: 2, dependencies: ["first"] },
          ],
        };
        const { state, steps } = await rw(wf, { runId: "run-zero-leaf", abortSignal: new AbortController().signal, emit: (ev) => events.push(ev) });
        assert.equal(state, "completed_with_warnings");
        assert.equal(steps.first.status, "skipped");
        assert.equal(steps.second.status, "neutral");
        const warning = events.find((e) => e.type === "workflow.branch.skipped");
        assert.ok(warning, "a workflow.branch.skipped event must be emitted");
        assert.equal(warning.stepId, "classify");
        assert.deepEqual(warning.selected, ["second"]);
        assert.equal(events.find((e) => e.type === "workflow.complete").finalState, "completed_with_warnings");
      },
    );
  });

  await t.test("FR-030: a routing node that never produces a structured selection FAILS (it never defaults)", async () => {
    await withBos(
      () => [{ type: "done", result: { output: "I think the alarm branch is right." } }],
      async ({ runWorkflow: rw }) => {
        const wf = {
          id: "wf-no-signal",
          name: "No signal",
          steps: [
            { id: "classify", outputType: "delegate", agentSource: { kind: "ephemeral", task: "classify" }, candidates: ["alarm", "quiet"] },
            { id: "alarm", outputType: "ag-ui", input: 1, dependencies: ["classify"] },
            { id: "quiet", outputType: "ag-ui", input: 2, dependencies: ["classify"] },
          ],
        };
        const { state, steps } = await rw(wf, { runId: "run-no-signal", abortSignal: new AbortController().signal, emit: () => {} });
        assert.equal(state, "failed");
        assert.equal(steps.classify.status, "failed");
        assert.match(steps.classify.error, /no valid structured branch selection/);
        assert.equal(steps.alarm.status, "neutral");
        assert.equal(steps.quiet.status, "neutral");
      },
    );
  });

  await t.test("FR-022/FR-036: research fan-out really is invoked, once per entry, with per-sub-agent events", async () => {
    let delegateCalls = 0;
    await withBos(
      (body) => {
        delegateCalls++;
        return [{ type: "done", result: { output: `handled: ${body.task}` } }];
      },
      async ({ runWorkflow: rw }) => {
        const events = [];
        const wf = {
          id: "wf-fanout",
          name: "Fan-out",
          steps: [{ id: "r", outputType: "research", researchAgents: ["finance-agent", { task: "shipping analysis" }, { task: "legal analysis" }] }],
        };
        const { state, steps } = await rw(wf, { runId: "run-fanout", abortSignal: new AbortController().signal, emit: (ev) => events.push(ev) });
        assert.equal(state, "completed");
        assert.equal(delegateCalls, 3, "one real delegate call per researchAgents entry — the fan-out is not dead code");
        assert.equal(steps.r.output.length, 3);
        // Outputs are first-class structured data (FR-035), not a file handoff.
        assert.match(steps.r.output[0].output, /^handled: /);
        assert.equal(steps.r.output[1].label.includes("shipping analysis"), true);

        const subEvents = events.filter((e) => e.type === "agent.sub_agent");
        const byId = new Map();
        for (const e of subEvents) byId.set(e.subAgentId, [...(byId.get(e.subAgentId) || []), e.status]);
        assert.equal(byId.size, 3);
        for (const [, statuses] of byId) {
          assert.deepEqual(statuses, ["pending", "running", "completed"]);
        }
      },
    );
  });

  await t.test("FR-037 dry run: fixture-designated nodes are substituted, no delegate call is made, and routing still resolves", async () => {
    let delegateCalls = 0;
    await withBos(
      () => {
        delegateCalls++;
        return [{ type: "done", result: { output: "REAL CALL — should not happen in this dry run" } }];
      },
      async ({ runWorkflow: rw }) => {
        const wf = {
          id: "wf-dry",
          name: "Dry run",
          steps: [
            { id: "research", outputType: "research", researchAgents: [{ task: "expensive investigation A" }, { task: "expensive investigation B" }] },
            { id: "classify", outputType: "delegate", agentSource: { kind: "ephemeral", task: "classify" }, dependencies: ["research"], candidates: ["alarm", "quiet"] },
            { id: "alarm", outputType: "ag-ui", input: { alarm: true }, dependencies: ["classify"] },
            { id: "quiet", outputType: "ag-ui", input: { quiet: true }, dependencies: ["classify"] },
          ],
        };
        const t0 = Date.now();
        const { state, steps } = await rw(wf, {
          runId: "run-dry",
          abortSignal: new AbortController().signal,
          emit: () => {},
          dryRun: true,
          fixtures: {
            research: [{ label: "A", output: "canned finding A" }, { label: "B", output: "canned finding B" }],
            // The select_branch signal can itself be a fixture.
            classify: { select_branch: { selected: ["alarm"] } },
          },
        });
        assert.equal(state, "completed");
        assert.equal(delegateCalls, 0, "a dry run must not invoke a single real sub-agent (NFR-006)");
        assert.equal(steps.research.output[0].output, "canned finding A");
        assert.equal(steps.alarm.status, "completed");
        assert.equal(steps.quiet.status, "skipped");
        assert.ok(Date.now() - t0 < 2000, "the evaluated path completes in seconds");
      },
    );
  });

  await t.test("FR-037: without dryRun, fixtures are ignored entirely (default behavior unchanged)", async () => {
    let delegateCalls = 0;
    await withBos(
      () => {
        delegateCalls++;
        return [{ type: "done", result: { output: "real output" } }];
      },
      async ({ runWorkflow: rw }) => {
        const wf = {
          id: "wf-no-dry",
          name: "Not a dry run",
          steps: [{ id: "a", outputType: "delegate", agentSource: { kind: "ephemeral", task: "do it" } }],
        };
        const { state, steps } = await rw(wf, {
          runId: "run-no-dry",
          abortSignal: new AbortController().signal,
          emit: () => {},
          fixtures: { a: "canned" },
        });
        assert.equal(state, "completed");
        assert.equal(delegateCalls, 1);
        assert.equal(steps.a.output, "real output");
      },
    );
  });

  await t.test("FR-038: a step exceeding its per-step timeout fails fast with a timeout reason", async () => {
    await withBos(
      () => new Promise(() => {}), // a hung agent: the delegate never answers
      async ({ runWorkflow: rw }) => {
        const events = [];
        const wf = {
          id: "wf-step-timeout",
          name: "Step timeout",
          steps: [
            { id: "hangs", outputType: "delegate", agentSource: { kind: "ephemeral", task: "never returns" }, timeout: 0.2, retryLimit: 1 },
            { id: "after", outputType: "ag-ui", input: 1, dependencies: ["hangs"] },
          ],
        };
        const t0 = Date.now();
        const { state, steps } = await rw(wf, { runId: "run-step-timeout", abortSignal: new AbortController().signal, emit: (ev) => events.push(ev) });
        assert.equal(state, "failed");
        assert.equal(steps.hangs.status, "failed");
        assert.equal(steps.hangs.timedOut, true);
        assert.match(steps.hangs.error, /timed out after 0\.2s/);
        assert.equal(steps.after.status, "neutral");
        assert.ok(Date.now() - t0 < 5000, "it must not hang waiting for the agent");
        const fail = events.find((e) => e.type === "step.fail" && e.stepId === "hangs");
        assert.equal(fail.reason, "step-timeout");
      },
    );
  });

  await t.test("FR-038: a run exceeding its per-run deadline is halted and reported failed", async () => {
    await withBos(
      () => new Promise(() => {}),
      async ({ runWorkflow: rw }) => {
        const events = [];
        const wf = {
          id: "wf-run-timeout",
          name: "Run timeout",
          config: { runTimeout: 0.3 },
          steps: [{ id: "hangs", outputType: "delegate", agentSource: { kind: "ephemeral", task: "never returns" }, timeout: 60, retryLimit: 1 }],
        };
        const t0 = Date.now();
        const { state, timedOut } = await rw(wf, { runId: "run-run-timeout", abortSignal: new AbortController().signal, emit: (ev) => events.push(ev) });
        assert.equal(state, "failed");
        assert.equal(timedOut, true);
        assert.ok(Date.now() - t0 < 5000);
        const fail = events.find((e) => e.type === "workflow.fail");
        assert.equal(fail.reason, "run-timeout");
        assert.match(fail.error, /run timed out after 0\.3s/);
      },
    );
  });

  await bos.close();
});
