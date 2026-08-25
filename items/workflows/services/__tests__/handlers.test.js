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

  await bos.close();
});
