// events.test.js — US16 (event-triggered runs): the trigger union, the
// subscription reconciler (handler_declare over worker IPC / unregister over
// loopback HTTP), and the event_dispatch handler's run provenance +
// ack-on-run-START contract (FR-039…FR-043, NFR-007).
//
// Everything here is injected: `ipcPost` stands in for parentPort.postMessage
// and `httpJson` for vfs.jsonRequest, so no worker thread and no live BOS are
// needed — the same reason _fake-bos.js exists for the VFS-backed modules.

const test = require("node:test");
const assert = require("node:assert/strict");
const events = require("../events");

/** Records every `handler_declare` (and anything else) posted over IPC. */
function fakeIpc() {
  const sent = [];
  return { sent, post: (msg) => sent.push(msg), declares: () => sent.filter((m) => m.type === "handler_declare") };
}

/** Records every loopback call; `fail` makes the NEXT matching call fail. */
function fakeHttp({ status = 200, body = { ok: true }, failPath } = {}) {
  const calls = [];
  return {
    calls,
    json: async (method, path, payload) => {
      calls.push({ method, path, body: payload });
      if (failPath && path.includes(failPath)) return { status: 500, body: { error: { message: "kernel exploded" } } };
      return { status, body };
    },
  };
}

function fakeLog() {
  const lines = [];
  return { lines, log: (level, message) => lines.push({ level, message }) };
}

const WF = (id, triggers) => ({ id, name: id, steps: [{ id: "a", outputType: "ag-ui", input: 1 }], ...(triggers === undefined ? {} : { triggers }) });

test("events.js — deriveTriggerUnion (FR-039)", async (t) => {
  await t.test("an empty workflow list yields an empty set", () => {
    assert.equal(events.deriveTriggerUnion([]).size, 0);
    assert.equal(events.deriveTriggerUnion(undefined).size, 0);
  });

  await t.test("a single workflow contributes exactly its declared triggers", () => {
    const union = events.deriveTriggerUnion([WF("w1", ["com.bos.files.created", "com.bos.mail.received"])]);
    assert.deepEqual(Array.from(union).sort(), ["com.bos.files.created", "com.bos.mail.received"]);
  });

  await t.test("overlapping triggers across workflows are unioned, never duplicated", () => {
    const union = events.deriveTriggerUnion([
      WF("w1", ["com.bos.files.created", "com.bos.mail.received"]),
      WF("w2", ["com.bos.files.created"]),
      WF("w3", ["com.bos.downloads.finished"]),
    ]);
    assert.equal(union.size, 3);
    assert.deepEqual(Array.from(union).sort(), ["com.bos.downloads.finished", "com.bos.files.created", "com.bos.mail.received"]);
  });

  await t.test("a workflow with no triggers field, an empty array, or junk entries contributes nothing", () => {
    const union = events.deriveTriggerUnion([WF("w1"), WF("w2", []), WF("w3", ["", "   ", 42, null])]);
    assert.equal(union.size, 0);
  });

  await t.test("trigger values are trimmed", () => {
    assert.deepEqual(Array.from(events.deriveTriggerUnion([WF("w1", ["  com.bos.files.created  "])])), ["com.bos.files.created"]);
  });
});

test("events.js — reconcileSubscriptions (FR-039, NFR-005)", async (t) => {
  t.beforeEach(() => events.resetSubscriptions());

  await t.test("initial reconcile declares one headless handler per event type", async () => {
    const ipc = fakeIpc();
    const http = fakeHttp();
    const logs = fakeLog();
    const set = await events.reconcileSubscriptions([WF("w1", ["com.bos.files.created"]), WF("w2", ["com.bos.mail.received"])], {
      ipcPost: ipc.post,
      httpJson: http.json,
      log: logs.log,
    });

    assert.deepEqual(Array.from(set).sort(), ["com.bos.files.created", "com.bos.mail.received"]);
    assert.equal(ipc.declares().length, 2);
    const declare = ipc.declares().find((m) => m.payload.eventType === "com.bos.files.created");
    assert.equal(declare.payload.handlerId, "workflows:com.bos.files.created");
    assert.equal(declare.payload.mode, "headless");
    assert.ok(declare.payload.callId, "handler_declare carries a callId, like tool_declare");
    assert.ok(declare.payload.displayName, "the kernel falls back to the handlerId without one");
    assert.equal(http.calls.length, 0, "nothing to unregister on a first reconcile");
    assert.ok(
      logs.lines.some((l) => l.level === "info" && /event subscribe/.test(l.message)),
      "subscribe is logged structurally (NFR-005)",
    );
  });

  await t.test("adding a workflow declares only the NEW type", async () => {
    const ipc = fakeIpc();
    const http = fakeHttp();
    await events.reconcileSubscriptions([WF("w1", ["com.bos.files.created"])], { ipcPost: ipc.post, httpJson: http.json });
    assert.equal(ipc.declares().length, 1);

    await events.reconcileSubscriptions([WF("w1", ["com.bos.files.created"]), WF("w2", ["com.bos.mail.received"])], {
      ipcPost: ipc.post,
      httpJson: http.json,
    });
    assert.equal(ipc.declares().length, 2);
    assert.equal(ipc.declares()[1].payload.eventType, "com.bos.mail.received");
    assert.equal(http.calls.length, 0);
  });

  await t.test("deleting the last workflow for a type unregisters that handler", async () => {
    const ipc = fakeIpc();
    const http = fakeHttp();
    const logs = fakeLog();
    await events.reconcileSubscriptions([WF("w1", ["com.bos.files.created"]), WF("w2", ["com.bos.mail.received"])], {
      ipcPost: ipc.post,
      httpJson: http.json,
      log: logs.log,
    });

    // w2 deleted — com.bos.mail.received has no subscriber left.
    const set = await events.reconcileSubscriptions([WF("w1", ["com.bos.files.created"])], { ipcPost: ipc.post, httpJson: http.json, log: logs.log });

    assert.deepEqual(Array.from(set), ["com.bos.files.created"]);
    assert.equal(ipc.declares().length, 2, "no re-declaration of the surviving type");
    assert.equal(http.calls.length, 1);
    assert.equal(http.calls[0].method, "POST");
    assert.equal(http.calls[0].path, "/api/events/unregister");
    assert.equal(http.calls[0].body.handlerId, "workflows:com.bos.mail.received");
    assert.equal(http.calls[0].body.ownerId, "workflows", "the kernel's unregister route requires the owner id");
    assert.ok(logs.lines.some((l) => /event unsubscribe/.test(l.message)));
  });

  await t.test("a type still triggered by ANOTHER workflow is not unregistered", async () => {
    const ipc = fakeIpc();
    const http = fakeHttp();
    await events.reconcileSubscriptions([WF("w1", ["com.bos.files.created"]), WF("w2", ["com.bos.files.created"])], {
      ipcPost: ipc.post,
      httpJson: http.json,
    });
    assert.equal(ipc.declares().length, 1, "one handler per distinct TYPE, not per workflow");

    await events.reconcileSubscriptions([WF("w2", ["com.bos.files.created"])], { ipcPost: ipc.post, httpJson: http.json });
    assert.equal(http.calls.length, 0);
  });

  await t.test("is idempotent — reconciling twice with the same workflows declares nothing new", async () => {
    const ipc = fakeIpc();
    const http = fakeHttp();
    const workflows = [WF("w1", ["com.bos.files.created", "com.bos.mail.received"]), WF("w2", ["com.bos.files.created"])];
    await events.reconcileSubscriptions(workflows, { ipcPost: ipc.post, httpJson: http.json });
    await events.reconcileSubscriptions(workflows, { ipcPost: ipc.post, httpJson: http.json });
    await events.reconcileSubscriptions(workflows, { ipcPost: ipc.post, httpJson: http.json });

    assert.equal(ipc.declares().length, 2);
    assert.equal(http.calls.length, 0);
    assert.deepEqual(Array.from(events.getSubscribedSet()).sort(), ["com.bos.files.created", "com.bos.mail.received"]);
  });

  await t.test("an already-subscribed type is never re-declared, so a user's `enabled` toggle survives a reconcile", async () => {
    // The kernel's register() preserves a previously-set `enabled` across an
    // upsert, but the cheaper guarantee is that we do not send the upsert at
    // all: a reconcile that changes nothing produces ZERO IPC traffic.
    const ipc = fakeIpc();
    const http = fakeHttp();
    await events.reconcileSubscriptions([WF("w1", ["com.bos.files.created"])], { ipcPost: ipc.post, httpJson: http.json });
    const afterFirst = ipc.sent.length;
    await events.reconcileSubscriptions([WF("w1", ["com.bos.files.created"]), WF("w2", [])], { ipcPost: ipc.post, httpJson: http.json });
    assert.equal(ipc.sent.length, afterFirst, "no IPC message at all on a no-op reconcile");
  });

  await t.test("an unregister that fails is logged, not thrown, and the type is dropped anyway", async () => {
    const ipc = fakeIpc();
    const http = fakeHttp({ failPath: "/api/events/unregister" });
    const logs = fakeLog();
    await events.reconcileSubscriptions([WF("w1", ["com.bos.files.created"])], { ipcPost: ipc.post, httpJson: http.json, log: logs.log });
    const set = await events.reconcileSubscriptions([], { ipcPost: ipc.post, httpJson: http.json, log: logs.log });

    assert.equal(set.size, 0);
    assert.ok(logs.lines.some((l) => l.level === "warn" && /event unsubscribe failed/.test(l.message)));

    // …and because it was dropped, a workflow re-declaring that trigger later
    // gets a fresh handler_declare rather than being silently skipped.
    await events.reconcileSubscriptions([WF("w1", ["com.bos.files.created"])], { ipcPost: ipc.post, httpJson: http.json, log: logs.log });
    assert.equal(ipc.declares().length, 2);
  });

  await t.test("a `prefix.*` trigger is declared verbatim (the kernel matches patterns itself)", async () => {
    const ipc = fakeIpc();
    await events.reconcileSubscriptions([WF("w1", ["com.bos.files.*"])], { ipcPost: ipc.post, httpJson: fakeHttp().json });
    assert.equal(ipc.declares()[0].payload.eventType, "com.bos.files.*");
    assert.equal(ipc.declares()[0].payload.handlerId, "workflows:com.bos.files.*");
  });
});

test("events.js — handleEventDispatch (FR-040/041/042/043, NFR-007)", async (t) => {
  t.beforeEach(() => events.resetSubscriptions());

  /** A real 034 EventDispatchPayload (src/core/service/types.ts). */
  function dispatch({ eventId = "evt-1", type = "com.bos.files.created", payload = { path: "/Downloads/report.csv" }, callId = "call-1" } = {}) {
    return {
      callId,
      eventId,
      handlerId: `workflows:${type}`,
      record: { id: eventId, type, payload, source: { appId: "files", name: "Files" }, ts: 1, sequence: 1, summary: "a file appeared" },
    };
  }

  function fakeStarter() {
    const calls = [];
    let n = 0;
    return {
      calls,
      startRun: async (opts) => {
        calls.push(opts);
        return { runId: `run-${++n}`, workflowId: opts.workflowId, startSource: opts.startSource };
      },
    };
  }

  await t.test("starts a run for the matching workflow, carrying the full event provenance (FR-041/042)", async () => {
    const starter = fakeStarter();
    const http = fakeHttp();
    const logs = fakeLog();
    const result = await events.handleEventDispatch(dispatch(), {
      startRun: starter.startRun,
      httpJson: http.json,
      log: logs.log,
      workflows: [WF("w1", ["com.bos.files.created"]), WF("w2", ["com.bos.mail.received"])],
    });

    assert.equal(starter.calls.length, 1);
    assert.deepEqual(starter.calls[0], {
      workflowId: "w1",
      startSource: "event",
      triggerEventId: "evt-1",
      triggerEventType: "com.bos.files.created",
      eventContext: { path: "/Downloads/report.csv" },
    });
    assert.deepEqual(result.started, [{ workflowId: "w1", runId: "run-1" }]);
    assert.equal(result.acked, true);
    assert.ok(logs.lines.some((l) => l.level === "info" && /started run run-1/.test(l.message)));
  });

  await t.test("acks the event immediately, on run-START, with the right handlerId/callerId (NFR-007)", async () => {
    const starter = fakeStarter();
    const http = fakeHttp();
    await events.handleEventDispatch(dispatch(), {
      startRun: starter.startRun,
      httpJson: http.json,
      workflows: [WF("w1", ["com.bos.files.created"])],
    });

    const ack = http.calls.find((c) => c.path.endsWith("/ack"));
    assert.ok(ack, "an ack was sent");
    assert.equal(ack.method, "POST");
    assert.equal(ack.path, "/api/events/evt-1/ack");
    assert.equal(ack.body.handlerId, "workflows:com.bos.files.created");
    assert.equal(ack.body.callerId, "workflows");
    assert.equal(ack.body.callId, "call-1", "the exactly-once-settle guard is echoed back");
    assert.deepEqual(ack.body.result.startedRuns, [{ workflowId: "w1", runId: "run-1" }]);
  });

  await t.test("does not start anything for an event no workflow triggers on — but still acks it", async () => {
    const starter = fakeStarter();
    const http = fakeHttp();
    await events.handleEventDispatch(dispatch({ type: "com.bos.mail.received" }), {
      startRun: starter.startRun,
      httpJson: http.json,
      workflows: [WF("w1", ["com.bos.files.created"]), WF("w2")],
    });

    assert.equal(starter.calls.length, 0, "startRun is not called for a non-matching type");
    // An un-acked event stays pending and is re-dispatched forever, so
    // "nothing to do" must settle too.
    assert.equal(http.calls.filter((c) => c.path.endsWith("/ack")).length, 1);
  });

  await t.test("fans out to EVERY workflow triggered by the same type", async () => {
    const starter = fakeStarter();
    await events.handleEventDispatch(dispatch(), {
      startRun: starter.startRun,
      httpJson: fakeHttp().json,
      workflows: [WF("w1", ["com.bos.files.created"]), WF("w2", ["com.bos.files.created"])],
    });
    assert.deepEqual(
      starter.calls.map((c) => c.workflowId),
      ["w1", "w2"],
    );
  });

  await t.test("two events for the SAME workflow start two independent runs (FR-043)", async () => {
    const starter = fakeStarter();
    const http = fakeHttp();
    const workflows = [WF("w1", ["com.bos.files.created"])];
    const deps = { startRun: starter.startRun, httpJson: http.json, workflows };

    const [a, b] = await Promise.all([
      events.handleEventDispatch(dispatch({ eventId: "evt-1", callId: "call-1", payload: { path: "/a.csv" } }), deps),
      events.handleEventDispatch(dispatch({ eventId: "evt-2", callId: "call-2", payload: { path: "/b.csv" } }), deps),
    ]);

    assert.equal(starter.calls.length, 2, "no de-duplication — concurrent runs of one workflow are valid");
    assert.notEqual(a.started[0].runId, b.started[0].runId);
    assert.deepEqual(
      starter.calls.map((c) => c.triggerEventId).sort(),
      ["evt-1", "evt-2"],
    );
    assert.deepEqual(
      starter.calls.map((c) => c.eventContext.path).sort(),
      ["/a.csv", "/b.csv"],
    );
    assert.deepEqual(
      http.calls.filter((c) => c.path.endsWith("/ack")).map((c) => c.path).sort(),
      ["/api/events/evt-1/ack", "/api/events/evt-2/ack"],
    );
  });

  await t.test("a failed ack is logged as an error, never thrown — the started run continues (FR-043)", async () => {
    const starter = fakeStarter();
    const http = fakeHttp({ failPath: "/ack" });
    const logs = fakeLog();

    const result = await events.handleEventDispatch(dispatch(), {
      startRun: starter.startRun,
      httpJson: http.json,
      log: logs.log,
      workflows: [WF("w1", ["com.bos.files.created"])],
    });

    assert.equal(starter.calls.length, 1, "the run started before the ack was attempted");
    assert.equal(result.acked, false);
    assert.deepEqual(result.started, [{ workflowId: "w1", runId: "run-1" }]);
    assert.ok(logs.lines.some((l) => l.level === "error" && /ack failed/.test(l.message)));
  });

  await t.test("a workflow that refuses to start does not block its siblings or the ack", async () => {
    const calls = [];
    const http = fakeHttp();
    const logs = fakeLog();
    const startRun = async (opts) => {
      calls.push(opts.workflowId);
      if (opts.workflowId === "w1") throw new Error("failed validation");
      return { runId: "run-ok" };
    };

    const result = await events.handleEventDispatch(dispatch(), {
      startRun,
      httpJson: http.json,
      log: logs.log,
      workflows: [WF("w1", ["com.bos.files.created"]), WF("w2", ["com.bos.files.created"])],
    });

    assert.deepEqual(calls, ["w1", "w2"]);
    assert.equal(result.started[0].error, "failed validation");
    assert.equal(result.started[1].runId, "run-ok");
    assert.equal(result.acked, true);
  });

  await t.test("reads the workflow list lazily via listWorkflows when no array is supplied", async () => {
    const starter = fakeStarter();
    let reads = 0;
    await events.handleEventDispatch(dispatch(), {
      startRun: starter.startRun,
      httpJson: fakeHttp().json,
      listWorkflows: async () => {
        reads++;
        return [WF("w1", ["com.bos.files.created"])];
      },
    });
    assert.equal(reads, 1);
    assert.equal(starter.calls[0].workflowId, "w1");
  });

  await t.test("a `prefix.*` trigger matches a concrete emitted type", async () => {
    const starter = fakeStarter();
    await events.handleEventDispatch(dispatch({ type: "com.bos.files.created" }), {
      startRun: starter.startRun,
      httpJson: fakeHttp().json,
      workflows: [WF("w1", ["com.bos.files.*"])],
    });
    assert.equal(starter.calls.length, 1);
    assert.equal(starter.calls[0].triggerEventType, "com.bos.files.created");
  });

  await t.test("accepts the flatter { eventType, event } dispatch shape too", async () => {
    const starter = fakeStarter();
    await events.handleEventDispatch(
      {
        handlerId: "workflows:com.bos.files.created",
        eventType: "com.bos.files.created",
        eventId: "evt-9",
        event: { id: "evt-9", type: "com.bos.files.created", payload: { path: "/x" } },
      },
      { startRun: starter.startRun, httpJson: fakeHttp().json, workflows: [WF("w1", ["com.bos.files.created"])] },
    );
    assert.equal(starter.calls[0].triggerEventId, "evt-9");
    assert.deepEqual(starter.calls[0].eventContext, { path: "/x" });
  });

  await t.test("a listWorkflows failure still acks (a stuck event is worse than a missed run)", async () => {
    const http = fakeHttp();
    const logs = fakeLog();
    const result = await events.handleEventDispatch(dispatch(), {
      startRun: async () => ({ runId: "never" }),
      httpJson: http.json,
      log: logs.log,
      listWorkflows: async () => {
        throw new Error("VFS bridge down");
      },
    });
    assert.deepEqual(result.started, []);
    assert.equal(result.acked, true);
    assert.ok(logs.lines.some((l) => l.level === "warn" && /could not read workflows/.test(l.message)));
  });
});
