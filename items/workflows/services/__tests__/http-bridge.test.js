// http-bridge.test.js — the app-facing REST surface, focused on the
// scope-add's new route: GET /run/<runId>[?since=] (US13/FR-036), the live
// projection the trajectory panel tails. Every other route is a thin wrapper
// over handlers.js and is covered by handlers.test.js.

const test = require("node:test");
const assert = require("node:assert/strict");
const http = require("http");
const { createRequestHandler } = require("../http-bridge");
const { createRunState, registerRunState, unregisterRunState } = require("../engine/run-state");

function startBridge(handlers) {
  const server = http.createServer(createRequestHandler({ handlers, getRuntime: () => ({ serviceId: "workflows", port: 0 }) }));
  return new Promise((resolve) => {
    server.listen(0, "127.0.0.1", () =>
      resolve({
        base: `http://127.0.0.1:${server.address().port}`,
        close: () =>
          new Promise((r) => {
            server.closeAllConnections?.();
            server.close(() => r());
          }),
      }),
    );
  });
}

function getJson(url) {
  return new Promise((resolve, reject) => {
    http
      .get(url, (res) => {
        let raw = "";
        res.setEncoding("utf8");
        res.on("data", (c) => (raw += c));
        res.on("end", () => resolve({ status: res.statusCode, body: raw ? JSON.parse(raw) : null }));
      })
      .on("error", reject);
  });
}

test("http-bridge.js", async (t) => {
  const state = createRunState({ runId: "run-bridge-1", workflowId: "wf-bridge", workflowName: "Bridge" }).seedSteps([{ id: "a" }, { id: "b" }]);
  registerRunState(state);
  state.record({ type: "workflow.start" });
  state.record({ type: "step.start", stepId: "a", attempt: 1, maxAttempts: 1 });
  state.record({ type: "agent.prompt", stepId: "a", prompt: "assembled task + upstream context" });

  const persistedRuns = { "run-persisted": { runId: "run-persisted", workflowId: "wf-bridge", state: "completed", steps: { a: { status: "completed" } }, events: [] } };
  const bridge = await startBridge({
    workflow_run_get: async ({ workflowId, runId }) => {
      const run = persistedRuns[runId];
      if (!run || run.workflowId !== workflowId) throw new Error(`no such run: ${runId}`);
      return run;
    },
  });

  await t.test("GET /run/<runId> returns the live per-step projection", async () => {
    const { status, body } = await getJson(`${bridge.base}/run/run-bridge-1`);
    assert.equal(status, 200);
    assert.equal(body.runId, "run-bridge-1");
    assert.equal(body.state, "running");
    assert.equal(body.steps.a.status, "running");
    assert.equal(body.steps.b.status, "pending");
    assert.match(body.steps.a.agentTrace.prompt, /assembled task/);
    assert.equal(body.seq, 3);
    assert.equal(body.events.length, 3);
  });

  await t.test("GET /run/<runId>?since=<seq> returns only newer events but the full step map", async () => {
    const { body } = await getJson(`${bridge.base}/run/run-bridge-1?since=2`);
    assert.deepEqual(body.events.map((e) => e.type), ["agent.prompt"]);
    assert.equal(body.seq, 3);
    assert.equal(body.steps.a.status, "running");
  });

  await t.test("GET /run/<unknown> is a 404 that explains the ?workflowId= fallback", async () => {
    const { status, body } = await getJson(`${bridge.base}/run/run-nope`);
    assert.equal(status, 404);
    assert.match(body.error, /workflowId/);
  });

  await t.test("GET /run/<runId>?workflowId= falls back to the persisted log once the live state is gone", async () => {
    const { status, body } = await getJson(`${bridge.base}/run/run-persisted?workflowId=wf-bridge`);
    assert.equal(status, 200);
    assert.equal(body.state, "completed");
  });

  await bridge.close();
  unregisterRunState("run-bridge-1");
});
