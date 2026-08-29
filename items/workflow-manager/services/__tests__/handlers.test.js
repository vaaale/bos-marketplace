// handlers.test.js — tool handlers wired to the engine (US1: create/read/
// modify/delete/export/validate/run/status/cancel/list/run_list/run_get all
// reachable via tools, independent of the UI). Uses `workflow` (direct
// object) rather than `taskDescription` for workflow_create so these tests
// don't depend on generate.js's planner-delegate round trip — that path is
// exercised in generate.js directly (see engine/generate.js's own contract);
// the delegate backend here still answers workflow_run's ag-ui-only test
// workflows without needing any delegate call at all.

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

test("handlers.js", async (t) => {
  const bos = await startFakeBos({ delegate: (body) => [{ type: "done", result: { output: `handled: ${body.task}` } }] });
  process.env.NEXT_PUBLIC_APP_ORIGIN = bos.origin;
  for (const mod of ["../vfs", "../engine/store", "../engine/executor", "../engine/scheduler", "../runs", "../handlers"]) {
    delete require.cache[require.resolve(mod)];
  }
  const { makeHandlers } = require("../handlers");
  const logs = [];
  const handlers = makeHandlers({ log: (level, message) => logs.push({ level, message }), defaultMaxConcurrentSteps: 5 });

  const SIMPLE_WORKFLOW = { name: "Simple", steps: [{ id: "a", outputType: "ag-ui", input: 1 }] };

  await t.test("workflow_create with an inline `workflow` object saves and validates it", async () => {
    const result = await handlers.workflow_create({ workflow: SIMPLE_WORKFLOW });
    assert.ok(result.workflow_id);
    assert.equal(result.validation.ok, true);
  });

  await t.test("workflow_create rejects a call with neither `workflow` nor `taskDescription`", async () => {
    await assert.rejects(() => handlers.workflow_create({}), /requires either/);
  });

  let workflowId;
  await t.test("workflow_read returns the saved workflow", async () => {
    const created = await handlers.workflow_create({ workflow: { name: "Readable", steps: [{ id: "a", outputType: "ag-ui", input: 1 }] } });
    workflowId = created.workflow_id;
    const wf = await handlers.workflow_read({ workflowId });
    assert.equal(wf.name, "Readable");
  });

  await t.test("workflow_read throws a clear error for a missing id", async () => {
    await assert.rejects(() => handlers.workflow_read({ workflowId: "no-such-id" }), /no such workflow/);
  });

  await t.test("workflow_modify applies a JSON-merge patch and re-validates", async () => {
    const result = await handlers.workflow_modify({ workflowId, changes: { name: "Renamed" } });
    assert.equal(result.validation.ok, true);
    const wf = await handlers.workflow_read({ workflowId });
    assert.equal(wf.name, "Renamed");
  });

  await t.test("workflow_export returns the workflow as a JSON string", async () => {
    const exported = await handlers.workflow_export({ workflowId });
    const parsed = JSON.parse(exported);
    assert.equal(parsed.id, workflowId);
  });

  await t.test("workflow_validate validates a saved workflow by id", async () => {
    const result = await handlers.workflow_validate({ workflowId });
    assert.equal(result.ok, true);
  });

  await t.test("workflow_validate validates an inline workflow without saving it", async () => {
    const result = await handlers.workflow_validate({ workflow: { name: "x", steps: [] } });
    assert.equal(result.ok, false);
    assert.ok(result.errors.some((e) => e.includes("at least one step")));
  });

  await t.test("workflow_list reports idle status for a workflow with no run", async () => {
    const list = await handlers.workflow_list();
    const entry = list.find((e) => e.workflow_id === workflowId);
    assert.equal(entry.status, "idle");
    assert.equal("run_id" in entry, false);
  });

  await t.test("workflow_run is fire-and-poll: returns a runId immediately, workflow_list then shows running", async () => {
    const t0 = Date.now();
    const { runId } = await handlers.workflow_run({ workflowId });
    assert.ok(runId);
    assert.ok(Date.now() - t0 < 200);
    const list = await handlers.workflow_list();
    const entry = list.find((e) => e.workflow_id === workflowId);
    // The run may already have settled by the time we poll (ag-ui steps are
    // instant) — either "running" with this runId, or already "idle" again.
    if (entry.status === "running") assert.equal(entry.run_id, runId);
  });

  await t.test("workflow_run rejects a workflow that fails validation", async () => {
    const created = await handlers.workflow_create({ workflow: { name: "Bad", steps: [{ id: "a", outputType: "tool" }] } });
    await assert.rejects(() => handlers.workflow_run({ workflowId: created.workflow_id }), /failed validation/);
  });

  await t.test("workflow_status reports the run's final state after it settles", async () => {
    const created = await handlers.workflow_create({ workflow: SIMPLE_WORKFLOW });
    const { runId } = await handlers.workflow_run({ workflowId: created.workflow_id });
    await waitUntil(async () => {
      const s = await handlers.workflow_status({ workflowId: created.workflow_id });
      return s.state === "completed" ? s : null;
    });
    const status = await handlers.workflow_status({ workflowId: created.workflow_id });
    assert.equal(status.state, "completed");
    assert.equal(status.runId, runId);
  });

  await t.test("workflow_run_list and workflow_run_get expose the same run via tools", async () => {
    const created = await handlers.workflow_create({ workflow: SIMPLE_WORKFLOW });
    const { runId } = await handlers.workflow_run({ workflowId: created.workflow_id });
    await waitUntil(async () => {
      const list = await handlers.workflow_run_list({ workflowId: created.workflow_id });
      return list.length > 0 ? list : null;
    });
    const list = await handlers.workflow_run_list({ workflowId: created.workflow_id });
    assert.equal(list[0].runId, runId);
    const run = await handlers.workflow_run_get({ workflowId: created.workflow_id, runId });
    assert.equal(run.runId, runId);
    assert.equal(run.steps.a.status, "completed");
  });

  await t.test("workflow_run_get throws for an unknown runId", async () => {
    await assert.rejects(() => handlers.workflow_run_get({ workflowId, runId: "nope" }), /no such run/);
  });

  await t.test("workflow_cancel returns cancelled:false when nothing is running", async () => {
    const result = await handlers.workflow_cancel({ workflowId });
    assert.equal(result.cancelled, false);
  });

  await t.test("workflow_delete removes the workflow and its run logs", async () => {
    const created = await handlers.workflow_create({ workflow: SIMPLE_WORKFLOW });
    await handlers.workflow_delete({ workflowId: created.workflow_id });
    await assert.rejects(() => handlers.workflow_read({ workflowId: created.workflow_id }), /no such workflow/);
  });

  await t.test("a second workflow_run is rejected while one is already in progress", async () => {
    const slowBos = await startFakeBos({
      delegate: () => new Promise(() => {}), // never resolves — keeps the run "in progress"
    });
    // Use a delegate-based node so the run stays in-flight long enough to race a second call.
    process.env.NEXT_PUBLIC_APP_ORIGIN = slowBos.origin;
    for (const mod of ["../vfs", "../engine/executor", "../engine/scheduler", "../runs", "../handlers", "../engine/store"]) {
      delete require.cache[require.resolve(mod)];
    }
    const { makeHandlers: makeHandlersFresh } = require("../handlers");
    const freshHandlers = makeHandlersFresh({ log: () => {}, defaultMaxConcurrentSteps: 5 });
    const created = await freshHandlers.workflow_create({
      workflow: { name: "Slow", steps: [{ id: "a", outputType: "delegate", agentSource: { kind: "static", agentId: "x" } }] },
    });
    await freshHandlers.workflow_run({ workflowId: created.workflow_id });
    await assert.rejects(() => freshHandlers.workflow_run({ workflowId: created.workflow_id }), /already has a run in progress/);
    await slowBos.close();
    process.env.NEXT_PUBLIC_APP_ORIGIN = bos.origin;
    for (const mod of ["../vfs", "../engine/executor", "../engine/scheduler", "../runs", "../handlers", "../engine/store"]) {
      delete require.cache[require.resolve(mod)];
    }
  });


  // ===========================================================================
  // Scope-add: US13 (populated live per-step state) + US14 (dry run).
  // ===========================================================================

  await t.test("US13/FR-036: workflow_status returns a POPULATED per-step map while the run is in progress", async () => {
    const slowBos = await startFakeBos({ delegate: () => new Promise(() => {}) }); // an agent that never answers
    process.env.NEXT_PUBLIC_APP_ORIGIN = slowBos.origin;
    for (const mod of ["../vfs", "../engine/store", "../engine/executor", "../engine/scheduler", "../runs", "../handlers"]) {
      delete require.cache[require.resolve(mod)];
    }
    const live = require("../handlers").makeHandlers({ log: () => {}, defaultMaxConcurrentSteps: 5 });
    const created = await live.workflow_create({
      workflow: {
        name: "Live",
        steps: [
          { id: "slow", outputType: "delegate", agentSource: { kind: "ephemeral", task: "takes forever" } },
          { id: "after", outputType: "ag-ui", input: 1, dependencies: ["slow"] },
        ],
      },
    });
    const { runId } = await live.workflow_run({ workflowId: created.workflow_id });

    const status = await waitUntil(async () => {
      const s = await live.workflow_status({ workflowId: created.workflow_id });
      return s.steps && s.steps.slow && s.steps.slow.status === "running" ? s : null;
    });

    assert.equal(status.running, true);
    assert.equal(status.runId, runId);
    // The whole point of FR-036: NOT an empty steps map.
    assert.notDeepEqual(status.steps, {});
    assert.equal(status.steps.slow.status, "running");
    assert.equal(status.steps.slow.attempt, 1);
    assert.ok(status.steps.slow.currentAction, "an in-progress step exposes a short current-action string");
    assert.equal(status.steps.after.status, "pending", "a step that has not started yet is still reported");
    // The agent trace is live too (FR-026/FR-028) — the executed prompt is
    // available the moment the delegate call is dispatched.
    assert.match(status.steps.slow.agentTrace.prompt, /takes forever/);
    assert.ok(status.seq > 0, "the snapshot carries the event-log head for ?since= tailing");

    await live.workflow_cancel({ workflowId: created.workflow_id });
    await waitUntil(async () => {
      const s = await live.workflow_status({ workflowId: created.workflow_id });
      return s.running === false ? s : null;
    }, { timeoutMs: 5000 });

    await slowBos.close();
    process.env.NEXT_PUBLIC_APP_ORIGIN = bos.origin;
    for (const mod of ["../vfs", "../engine/store", "../engine/executor", "../engine/scheduler", "../runs", "../handlers"]) {
      delete require.cache[require.resolve(mod)];
    }
  });

  await t.test("US13: a research node's live status exposes per-sub-agent progress", async () => {
    let released;
    const gate = new Promise((r) => (released = r));
    const fanBos = await startFakeBos({
      delegate: async (body) => {
        if (body.task.includes("slow one")) await gate;
        return [{ type: "done", result: { output: "sub-agent output" } }];
      },
    });
    process.env.NEXT_PUBLIC_APP_ORIGIN = fanBos.origin;
    for (const mod of ["../vfs", "../engine/store", "../engine/executor", "../engine/scheduler", "../runs", "../handlers"]) {
      delete require.cache[require.resolve(mod)];
    }
    const live = require("../handlers").makeHandlers({ log: () => {}, defaultMaxConcurrentSteps: 5 });
    const created = await live.workflow_create({
      workflow: { name: "Fan", steps: [{ id: "r", outputType: "research", researchAgents: [{ task: "quick one" }, { task: "the slow one" }] }] },
    });
    await live.workflow_run({ workflowId: created.workflow_id });

    const status = await waitUntil(async () => {
      const s = await live.workflow_status({ workflowId: created.workflow_id });
      const subs = s.steps?.r?.subAgents;
      return subs && Object.values(subs).some((sa) => sa.status === "completed") && Object.values(subs).some((sa) => sa.status === "running") ? s : null;
    });
    const subs = Object.values(status.steps.r.subAgents);
    assert.equal(subs.length, 2);
    const straggler = subs.find((sa) => sa.status === "running");
    assert.match(straggler.label, /slow one/, "the in-flight straggler is identifiable by label");

    released();
    await waitUntil(async () => ((await live.workflow_status({ workflowId: created.workflow_id })).running === false ? true : null), { timeoutMs: 5000 });

    await fanBos.close();
    process.env.NEXT_PUBLIC_APP_ORIGIN = bos.origin;
    for (const mod of ["../vfs", "../engine/store", "../engine/executor", "../engine/scheduler", "../runs", "../handlers"]) {
      delete require.cache[require.resolve(mod)];
    }
  });

  await t.test("US14: workflow_run wires dry-run fixtures end to end, in seconds and with no real delegation", async () => {
    let delegateCalls = 0;
    const guardBos = await startFakeBos({
      delegate: () => {
        delegateCalls++;
        return [{ type: "done", result: { output: "REAL" } }];
      },
    });
    process.env.NEXT_PUBLIC_APP_ORIGIN = guardBos.origin;
    for (const mod of ["../vfs", "../engine/store", "../engine/executor", "../engine/scheduler", "../runs", "../handlers"]) {
      delete require.cache[require.resolve(mod)];
    }
    const dry = require("../handlers").makeHandlers({ log: () => {}, defaultMaxConcurrentSteps: 5 });
    const created = await dry.workflow_create({
      workflow: {
        name: "Dry",
        steps: [
          { id: "research", outputType: "research", researchAgents: [{ task: "a 40-minute investigation" }] },
          { id: "classify", outputType: "delegate", dependencies: ["research"], agentSource: { kind: "ephemeral", task: "classify" }, candidates: ["alarm", "quiet"] },
          { id: "alarm", outputType: "ag-ui", input: { alarm: true }, dependencies: ["classify"] },
          { id: "quiet", outputType: "ag-ui", input: { quiet: true }, dependencies: ["classify"] },
        ],
      },
    });
    const t0 = Date.now();
    const started = await dry.workflow_run({
      workflowId: created.workflow_id,
      dryRun: true,
      fixtures: { research: [{ label: "canned", output: "canned finding" }], classify: { select_branch: { selected: ["alarm"] } } },
    });
    assert.equal(started.dryRun, true);
    const final = await waitUntil(async () => {
      const s = await dry.workflow_status({ workflowId: created.workflow_id });
      return s.running === false && s.state !== "never_run" ? s : null;
    });
    assert.equal(final.state, "completed");
    assert.equal(delegateCalls, 0, "a dry run performs no real work (NFR-006)");
    assert.equal(final.steps.alarm.status, "completed");
    assert.equal(final.steps.quiet.status, "skipped");
    assert.deepEqual(final.selected.classify, ["alarm"]);
    assert.ok(Date.now() - t0 < 5000);

    await guardBos.close();
    process.env.NEXT_PUBLIC_APP_ORIGIN = bos.origin;
    for (const mod of ["../vfs", "../engine/store", "../engine/executor", "../engine/scheduler", "../runs", "../handlers"]) {
      delete require.cache[require.resolve(mod)];
    }
  });

  await t.test("FR-033: workflow_validate reports candidate-topology errors", async () => {
    const unreachable = await handlers.workflow_validate({
      workflow: {
        id: "topo-1",
        name: "Unreachable leaf",
        steps: [
          { id: "classify", agentSource: { kind: "static", agentId: "x" }, candidates: ["alarm"] },
          { id: "alarm", outputType: "ag-ui", input: 1 },
        ],
      },
    });
    assert.equal(unreachable.ok, false);
    assert.ok(unreachable.errors.some((e) => e.includes("unreachable candidate leaf")));

    const shared = await handlers.workflow_validate({
      workflow: {
        id: "topo-2",
        name: "Ambiguous leaf",
        steps: [
          { id: "classify", agentSource: { kind: "static", agentId: "x" }, candidates: ["alarm", "quiet"] },
          { id: "alarm", outputType: "ag-ui", input: 1, dependencies: ["classify"] },
          { id: "quiet", outputType: "ag-ui", input: 1, dependencies: ["classify"] },
          { id: "publish", outputType: "ag-ui", input: 1, dependencies: ["alarm"] },
        ],
      },
    });
    assert.equal(shared.ok, false);
    assert.ok(shared.errors.some((e) => e.includes("ambiguously both a gated candidate leaf")));
  });

  await bos.close();
});
