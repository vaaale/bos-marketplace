// event-types-tool.test.js — `workflow_event_types` (US17 / FR-044/045), the
// 13th service-declared tool: event-type discovery for trigger authoring.
//
// The handler reads BOS's own grouped handler registry over the loopback
// origin (GET /api/events/handlers) and flattens it to
// `[{ type, handlerCount, displayName }]`. An EMPTY registry is an empty list
// (FR-045); an HTTP failure is a tool error (NFR-002) so "unreachable" is
// never mistaken for "nothing registered".

const test = require("node:test");
const assert = require("node:assert/strict");
const { startFakeBos, pointVfsAt } = require("./_fake-bos");

const REGISTRY = {
  "com.bos.gsuite.email.received": {
    ui: [{ handlerId: "gsuite.viewer", displayName: "Open in Mail", ownerId: "gsuite" }],
    headless: [{ handlerId: "triage.svc", displayName: "Triage", ownerId: "triage", enabled: true }],
  },
  "com.bos.other.type": {
    ui: [],
    headless: [{ handlerId: "other.svc", displayName: "Other handler", ownerId: "other", enabled: true }],
  },
  "com.bos.workflows.analysis.complete": { ui: [], headless: [] },
};

// `pointVfsAt(bos)` rather than setting NEXT_PUBLIC_APP_ORIGIN by hand: vfs.js
// resolves `process.env.PORT` FIRST, so a test that only sets the origin talks
// to the REAL BOS (and the real VFS) in any shell where PORT is set.
function loadHandlers(bos) {
  pointVfsAt(bos);
  for (const mod of ["../vfs", "../engine/store", "../engine/executor", "../engine/scheduler", "../runs", "../handlers"]) {
    delete require.cache[require.resolve(mod)];
  }
  const { makeHandlers } = require("../handlers");
  const logs = [];
  return { handlers: makeHandlers({ log: (level, message) => logs.push({ level, message }), defaultMaxConcurrentSteps: 5 }), logs };
}

test("tools.js declares workflow_event_types (US17/FR-044)", async (t) => {
  const { DECLARATIONS } = require("../tools");
  const declaration = DECLARATIONS.find((d) => d.name === "workflow_event_types");

  await t.test("it is declared, read-only (parallelSafe), and takes no input", () => {
    assert.ok(declaration, "workflow_event_types should be declared");
    assert.equal(declaration.parallelSafe, true);
    assert.deepEqual(declaration.inputSchema, { type: "object", properties: {}, additionalProperties: false });
    assert.match(declaration.description, /registered in the BOS event system/);
  });

  await t.test("it is part of the 14-tool declared surface (13 + US19's workflow_run_delete)", () => {
    assert.equal(DECLARATIONS.length, 14);
  });
});

test("workflow_event_types handler", async (t) => {
  const savedPort = process.env.PORT;
  const savedOrigin = process.env.NEXT_PUBLIC_APP_ORIGIN;
  t.after(() => {
    pointVfsAt(savedOrigin);
    if (savedPort !== undefined) process.env.PORT = savedPort;
    else delete process.env.PORT;
  });

  await t.test("maps the grouped registry to { type, handlerCount, displayName }", async () => {
    const bos = await startFakeBos({ events: { handlers: REGISTRY } });
    const { handlers } = loadHandlers(bos);
    const types = await handlers.workflow_event_types();
    assert.deepEqual(types, [
      { type: "com.bos.gsuite.email.received", handlerCount: 2, displayName: "Open in Mail" },
      { type: "com.bos.other.type", handlerCount: 1, displayName: "Other handler" },
      { type: "com.bos.workflows.analysis.complete", handlerCount: 0, displayName: null },
    ]);
    await bos.close();
  });

  await t.test("takes no arguments — a stray args object is ignored", async () => {
    const bos = await startFakeBos({ events: { handlers: REGISTRY } });
    const { handlers } = loadHandlers(bos);
    const types = await handlers.workflow_event_types({ unexpected: true });
    assert.equal(types.length, 3);
    await bos.close();
  });

  await t.test("FR-045: an empty registry is an empty list, not an error", async () => {
    const bos = await startFakeBos({ events: { handlers: {} } });
    const { handlers } = loadHandlers(bos);
    assert.deepEqual(await handlers.workflow_event_types(), []);
    await bos.close();
  });

  await t.test("NFR-002: an HTTP error is a tool error naming the route and status", async () => {
    const bos = await startFakeBos({ events: { handlersStatus: 500, handlersBody: { error: { code: "kernel-unavailable", message: "event kernel unavailable" } } } });
    const { handlers } = loadHandlers(bos);
    await assert.rejects(() => handlers.workflow_event_types(), /GET \/api\/events\/handlers -> 500.*event kernel unavailable/s);
    await bos.close();
  });

  await t.test("a handler entry with no displayName maps to null rather than undefined", async () => {
    const bos = await startFakeBos({ events: { handlers: { "com.bos.anon.type": { ui: [{ handlerId: "anon" }], headless: [] } } } });
    const { handlers } = loadHandlers(bos);
    assert.deepEqual(await handlers.workflow_event_types(), [{ type: "com.bos.anon.type", handlerCount: 1, displayName: null }]);
    await bos.close();
  });

  await t.test("a headless-only type takes its displayName from the headless handler", async () => {
    const bos = await startFakeBos({ events: { handlers: { "com.bos.headless.only": { headless: [{ handlerId: "h", displayName: "Headless One" }] } } } });
    const { handlers } = loadHandlers(bos);
    assert.deepEqual(await handlers.workflow_event_types(), [{ type: "com.bos.headless.only", handlerCount: 1, displayName: "Headless One" }]);
    await bos.close();
  });
});
