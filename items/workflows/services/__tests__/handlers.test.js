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

test("handlers.js", async (t) => {
  const bos = await startFakeBos({ delegate: (body) => [{ type: "done", result: { output: `handled: ${body.task}` } }] });
  pointVfsAt(bos);
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
    pointVfsAt(slowBos);
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
    pointVfsAt(bos);
    for (const mod of ["../vfs", "../engine/executor", "../engine/scheduler", "../runs", "../handlers", "../engine/store"]) {
      delete require.cache[require.resolve(mod)];
    }
  });


  // ===========================================================================
  // Scope-add: US13 (populated live per-step state) + US14 (dry run).
  // ===========================================================================

  await t.test("US13/FR-036: workflow_status returns a POPULATED per-step map while the run is in progress", async () => {
    const slowBos = await startFakeBos({ delegate: () => new Promise(() => {}) }); // an agent that never answers
    pointVfsAt(slowBos);
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
    pointVfsAt(bos);
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
    pointVfsAt(fanBos);
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
    pointVfsAt(bos);
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
    pointVfsAt(guardBos);
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
    pointVfsAt(bos);
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

// ===========================================================================
// Scope-add 002 / US16 — the handlers' half of event-triggered runs: every
// workflow write reconciles the declared event subscriptions (FR-039), and
// the shared run starter records provenance + lets event runs overlap
// (FR-041/FR-043).
// ===========================================================================
test("handlers.js — US16 event integration", async (t) => {
  // A real poller: the module-level waitUntil() above resolves on the first
  // tick when handed an async predicate (a pending Promise is truthy), which
  // is fine for the assertions that use it but not for "wait until this run
  // has actually settled".
  async function untilReady(fn, { timeoutMs = 4000, intervalMs = 10 } = {}) {
    const start = Date.now();
    for (;;) {
      const result = await fn();
      if (result) return result;
      if (Date.now() - start > timeoutMs) throw new Error("untilReady: timed out");
      await new Promise((res) => setTimeout(res, intervalMs));
    }
  }

  const bos = await startFakeBos({ delegate: (body) => [{ type: "done", result: { output: `handled: ${body.task}` } }] });
  pointVfsAt(bos);
  const MODS = ["../vfs", "../engine/store", "../engine/executor", "../engine/scheduler", "../runs", "../events", "../handlers"];
  for (const mod of MODS) delete require.cache[require.resolve(mod)];
  const events = require("../events");
  const { makeHandlers } = require("../handlers");

  const sent = [];
  const declares = () => sent.filter((m) => m.type === "handler_declare");
  const handlers = makeHandlers({ log: () => {}, ipcPost: (msg) => sent.push(msg), defaultMaxConcurrentSteps: 5 });

  const STEP = { id: "a", outputType: "ag-ui", input: 1 };
  let w1;
  let w2;

  await t.test("workflow_create declares a headless handler per declared trigger (FR-039)", async () => {
    const created = await handlers.workflow_create({
      workflow: { name: "Triage", steps: [STEP], triggers: ["com.bos.files.created", "com.bos.mail.received"] },
    });
    w1 = created.workflow_id;
    assert.deepEqual(created.triggers, ["com.bos.files.created", "com.bos.mail.received"]);
    assert.deepEqual(
      declares()
        .map((m) => m.payload.eventType)
        .sort(),
      ["com.bos.files.created", "com.bos.mail.received"],
    );
    assert.ok(declares().every((m) => m.payload.handlerId === `workflows:${m.payload.eventType}`));
  });

  await t.test("a second workflow on the SAME trigger declares nothing new (idempotent)", async () => {
    const before = declares().length;
    const created = await handlers.workflow_create({ workflow: { name: "Second", steps: [STEP], triggers: ["com.bos.files.created"] } });
    w2 = created.workflow_id;
    assert.equal(declares().length, before);
    assert.deepEqual(Array.from(events.getSubscribedSet()).sort(), ["com.bos.files.created", "com.bos.mail.received"]);
  });

  await t.test("a workflow with no triggers subscribes to nothing", async () => {
    const before = declares().length;
    await handlers.workflow_create({ workflow: { name: "Manual", steps: [STEP] } });
    assert.equal(declares().length, before);
  });

  await t.test("workflow_modify that drops a trigger unsubscribes that type", async () => {
    await handlers.workflow_modify({ workflowId: w1, changes: { triggers: ["com.bos.files.created"] } });
    // com.bos.mail.received had only w1 as a subscriber → gone. (The fake BOS
    // has no /api/events/unregister route, so the loopback call 404s — which
    // is exactly the non-fatal path: the write still succeeded and the local
    // subscription set is still updated.)
    assert.deepEqual(Array.from(events.getSubscribedSet()), ["com.bos.files.created"]);
  });

  await t.test("workflow_delete reconciles down to the surviving union", async () => {
    await handlers.workflow_delete({ workflowId: w1 });
    assert.deepEqual(Array.from(events.getSubscribedSet()), ["com.bos.files.created"], "w2 still triggers on it");
    await handlers.workflow_delete({ workflowId: w2 });
    assert.equal(events.getSubscribedSet().size, 0);
  });

  await t.test("a run started through workflow_run reports startSource \"tool\"; the bridge can say \"user\"", async () => {
    const created = await handlers.workflow_create({ workflow: { name: "Sourced", steps: [STEP] } });
    const toolRun = await handlers.workflow_run({ workflowId: created.workflow_id });
    assert.equal(toolRun.startSource, "tool");
    const persisted = await untilReady(async () => {
      const run = await handlers.workflow_run_get({ workflowId: created.workflow_id, runId: toolRun.runId });
      return run && run.state === "completed" ? run : null;
    });
    assert.equal(persisted.startSource, "tool");

    const userRun = await handlers.workflow_run({ workflowId: created.workflow_id, startSource: "user" });
    assert.equal(userRun.startSource, "user");
    // A caller may not promote itself to "event" through this path.
    await untilReady(async () => {
      const s = await handlers.workflow_status({ workflowId: created.workflow_id });
      return s.state === "completed" && !s.running ? s : null;
    });
    const faked = await handlers.workflow_run({ workflowId: created.workflow_id, startSource: "event", triggerEventId: "evt-x" });
    assert.equal(faked.startSource, "tool");
  });

  await bos.close();

  await t.test("an event-triggered run carries its provenance and is NOT blocked by an in-flight run (FR-041/FR-043)", async () => {
    const slowBos = await startFakeBos({ delegate: () => new Promise(() => {}) }); // an agent that never answers
    pointVfsAt(slowBos);
    for (const mod of MODS) delete require.cache[require.resolve(mod)];
    const { makeHandlers: makeFresh, makeRunStarter } = require("../handlers");
    const ctx = { log: () => {}, defaultMaxConcurrentSteps: 5 };
    const live = makeFresh(ctx);
    const startRun = makeRunStarter(ctx);
    const created = await live.workflow_create({
      workflow: { name: "Slow triggered", steps: [{ id: "a", outputType: "delegate", agentSource: { kind: "ephemeral", task: "forever" } }], triggers: ["com.bos.files.created"] },
    });

    const first = await startRun({
      workflowId: created.workflow_id,
      startSource: "event",
      triggerEventId: "evt-1",
      triggerEventType: "com.bos.files.created",
      eventContext: { path: "/a.csv" },
    });
    const second = await startRun({
      workflowId: created.workflow_id,
      startSource: "event",
      triggerEventId: "evt-2",
      triggerEventType: "com.bos.files.created",
      eventContext: { path: "/b.csv" },
    });

    assert.notEqual(first.runId, second.runId, "two events → two independent runs");
    assert.equal(first.startSource, "event");
    assert.equal(second.triggerEventId, "evt-2");

    // A tool run is still refused while a run is in flight.
    await assert.rejects(() => live.workflow_run({ workflowId: created.workflow_id }), /already has a run in progress/);

    const runA = await live.workflow_run_get({ workflowId: created.workflow_id, runId: first.runId });
    assert.equal(runA.startSource, "event");
    assert.equal(runA.triggerEventType, "com.bos.files.created");
    assert.deepEqual(runA.eventContext, { path: "/a.csv" });
    const runB = await live.workflow_run_get({ workflowId: created.workflow_id, runId: second.runId });
    assert.deepEqual(runB.eventContext, { path: "/b.csv" });

    // Both runs are visible as active; the newest is the one workflow_status
    // and workflow_cancel address.
    const runList = await live.workflow_run_list({ workflowId: created.workflow_id });
    assert.deepEqual(runList.map((r) => r.runId).sort(), [first.runId, second.runId].sort());
    assert.ok(runList.every((r) => r.startSource === "event"));

    await slowBos.close();
    pointVfsAt(bos);
    for (const mod of MODS) delete require.cache[require.resolve(mod)];
  });
});

// ===========================================================================
// Scope-add US19 — workflow_run_delete: individual run-log deletion with
// per-run deleted/not_found/error outcomes, idempotency, the workflow-scope
// guard, and the "workflow definition untouched" guarantee.
// ===========================================================================
test("handlers.js — US19 workflow_run_delete", async (t) => {
  async function untilReady(fn, { timeoutMs = 4000, intervalMs = 10 } = {}) {
    const start = Date.now();
    for (;;) {
      const result = await fn();
      if (result) return result;
      if (Date.now() - start > timeoutMs) throw new Error("untilReady: timed out");
      await new Promise((res) => setTimeout(res, intervalMs));
    }
  }

  const bos = await startFakeBos({
    delegate: (body) => [{ type: "done", result: { output: `handled: ${body.task}` } }],
    // Any path containing "run-io-fails" 500s on delete — the error-path seam.
    fsDelete: (path) => (path.includes("run-io-fails") ? { status: 500, body: { error: "disk on fire" } } : undefined),
  });
  pointVfsAt(bos);
  const MODS = ["../vfs", "../engine/store", "../engine/executor", "../engine/scheduler", "../runs", "../handlers"];
  for (const mod of MODS) delete require.cache[require.resolve(mod)];
  const { makeHandlers } = require("../handlers");
  const handlers = makeHandlers({ log: () => {}, defaultMaxConcurrentSteps: 5 });

  const SIMPLE = { name: "Deletable", steps: [{ id: "a", outputType: "ag-ui", input: 1 }] };

  /** Run to a persisted log: persistRun happens strictly AFTER the run settles
   *  (and after the active entry clears), so once the file is on the fake VFS
   *  the next sequential workflow_run cannot hit the single-active-run guard. */
  async function runToCompletion(workflowId) {
    const { runId } = await handlers.workflow_run({ workflowId });
    await untilReady(() => (bos.files.has(`/Workflows/.runs/${workflowId}/${runId}.json`) ? true : null));
    return runId;
  }

  let workflowId;

  await t.test("deletes exactly the named run logs; the workflow definition and every other run are untouched", async () => {
    const created = await handlers.workflow_create({ workflow: SIMPLE });
    workflowId = created.workflow_id;
    const defPath = `/Workflows/${workflowId}-workflow.json`;
    const defBefore = bos.files.get(defPath);
    const run1 = await runToCompletion(workflowId);
    const run2 = await runToCompletion(workflowId);
    const run3 = await runToCompletion(workflowId);

    const result = await handlers.workflow_run_delete({ workflowId, runIds: [run1, run2] });
    assert.equal(result.workflowId, workflowId);
    assert.equal(result.deleted, 2);
    assert.deepEqual(result.results, [
      { runId: run1, status: "deleted" },
      { runId: run2, status: "deleted" },
    ]);
    assert.equal(bos.files.has(`/Workflows/.runs/${workflowId}/${run1}.json`), false);
    assert.equal(bos.files.has(`/Workflows/.runs/${workflowId}/${run2}.json`), false);
    assert.equal(bos.files.has(`/Workflows/.runs/${workflowId}/${run3}.json`), true, "the un-named run survives");
    assert.equal(bos.files.get(defPath), defBefore, "the <id>-workflow.json definition is byte-identical");

    // Gone from workflow_run_list too — which exercises runs.forgetRun(): a
    // settled run stays in the in-memory LIVE map, and listRuns() merges LIVE
    // with disk, so without the forget the deleted runs would resurrect here.
    const list = await handlers.workflow_run_list({ workflowId });
    assert.deepEqual(list.map((r) => r.runId), [run3]);
  });

  await t.test("idempotent: re-deleting an already-deleted run is not_found, not an abort; duplicate ids count once", async () => {
    const run = await runToCompletion(workflowId);
    const first = await handlers.workflow_run_delete({ workflowId, runIds: [run, run] });
    assert.equal(first.deleted, 1, "a duplicated id is deleted (and counted) exactly once");
    assert.deepEqual(first.results, [{ runId: run, status: "deleted" }]);

    const again = await handlers.workflow_run_delete({ workflowId, runIds: [run] });
    assert.equal(again.deleted, 0);
    assert.deepEqual(again.results, [{ runId: run, status: "not_found" }]);
  });

  await t.test("a mixed batch reports per-run outcomes and still deletes what it can", async () => {
    const runA = await runToCompletion(workflowId);
    // Plant a log whose /api/fs delete fails (the fake BOS 500s this path).
    const errPath = `/Workflows/.runs/${workflowId}/run-io-fails.json`;
    bos.files.set(errPath, JSON.stringify({ runId: "run-io-fails" }));

    const result = await handlers.workflow_run_delete({ workflowId, runIds: [runA, "run-io-fails", "run-never-existed"] });
    assert.equal(result.deleted, 1);
    assert.deepEqual(result.results[0], { runId: runA, status: "deleted" });
    assert.equal(result.results[1].runId, "run-io-fails");
    assert.equal(result.results[1].status, "error");
    assert.match(result.results[1].error, /disk on fire/);
    assert.deepEqual(result.results[2], { runId: "run-never-existed", status: "not_found" });
    assert.equal(bos.files.has(errPath), true, "a failed delete leaves the log in place");
    bos.files.delete(errPath);
  });

  await t.test("workflow-scope guard: a run id living under a DIFFERENT workflow's dir is not reached", async () => {
    const other = await handlers.workflow_create({ workflow: { name: "Other", steps: [{ id: "a", outputType: "ag-ui", input: 1 }] } });
    const otherRun = await runToCompletion(other.workflow_id);

    // The path is built from the CALLER's workflowId, so the other workflow's
    // run resolves to a non-existent path — not_found, never a cross-delete.
    const result = await handlers.workflow_run_delete({ workflowId, runIds: [otherRun] });
    assert.deepEqual(result.results, [{ runId: otherRun, status: "not_found" }]);
    assert.equal(bos.files.has(`/Workflows/.runs/${other.workflow_id}/${otherRun}.json`), true, "the other workflow's log is untouched");
  });

  await t.test("defensive arg validation: missing workflowId, non-array / empty / non-string runIds are all rejected", async () => {
    await assert.rejects(() => handlers.workflow_run_delete({ runIds: ["x"] }), /workflowId is required/);
    await assert.rejects(() => handlers.workflow_run_delete({ workflowId, runIds: "run-1" }), /non-empty array/);
    await assert.rejects(() => handlers.workflow_run_delete({ workflowId, runIds: [] }), /non-empty array/);
    await assert.rejects(() => handlers.workflow_run_delete({ workflowId, runIds: ["ok", ""] }), /non-empty strings/);
  });

  await bos.close();
});
