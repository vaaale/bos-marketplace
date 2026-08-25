// executor.test.js — the execution contract (ADR-1): loopback
// POST /api/subagents/delegate per node, NDJSON parsing, cancellation via
// AbortSignal.

const test = require("node:test");
const assert = require("node:assert/strict");
const { startFakeBos } = require("./_fake-bos");
const { normalizeNode } = require("../engine/node-model");

test("executor.js", async (t) => {
  const bos = await startFakeBos({
    delegate: (body) => [
      { type: "tool", name: "some_tool" },
      { type: "done", result: { output: `handled: ${body.task}` } },
    ],
  });
  process.env.NEXT_PUBLIC_APP_ORIGIN = bos.origin;
  delete require.cache[require.resolve("../vfs")];
  delete require.cache[require.resolve("../engine/executor")];
  const { delegateOnce, delegateRequestFor, executeNode } = require("../engine/executor");

  await t.test("delegateOnce parses the NDJSON stream into toolEvents + output", async () => {
    const result = await delegateOnce({ task: "do the thing", contentOnly: true, agent: "researcher" });
    assert.equal(result.output, "handled: do the thing");
    assert.equal(result.toolEvents.length, 1);
    assert.equal(result.toolEvents[0].name, "some_tool");
  });

  await t.test("delegateOnce rejects when the stream reports an error event", async () => {
    const failing = await startFakeBos({ delegate: () => [{ type: "error", error: "boom" }] });
    process.env.NEXT_PUBLIC_APP_ORIGIN = failing.origin;
    delete require.cache[require.resolve("../vfs")];
    delete require.cache[require.resolve("../engine/executor")];
    const fresh = require("../engine/executor");
    await assert.rejects(() => fresh.delegateOnce({ task: "x" }), /boom/);
    await failing.close();
    process.env.NEXT_PUBLIC_APP_ORIGIN = bos.origin;
    delete require.cache[require.resolve("../vfs")];
    delete require.cache[require.resolve("../engine/executor")];
  });

  await t.test("delegateRequestFor builds an `agent` request for a static agentSource", () => {
    const node = normalizeNode({ id: "a", agentSource: { kind: "static", agentId: "researcher" } });
    const body = delegateRequestFor(node, "do it", {});
    assert.equal(body.agent, "researcher");
    assert.equal(body.contentOnly, true);
  });

  await t.test("delegateRequestFor builds an `ephemeral` request for an ephemeral agentSource", () => {
    const node = normalizeNode({ id: "a", agentSource: { kind: "ephemeral", task: "summarize", tools: ["web_fetch"] } });
    const body = delegateRequestFor(node, "do it", {});
    assert.equal(body.ephemeral.tools[0], "web_fetch");
    assert.equal(body.ephemeral.type, "local");
  });

  await t.test("executeNode short-circuits ag-ui nodes without a network call", async () => {
    const node = normalizeNode({ id: "a", outputType: "ag-ui", input: { chart: "pie" } });
    const { output, toolEvents } = await require("../engine/executor").executeNode(node, { outputs: new Map(), workflowName: "wf" });
    assert.deepEqual(output, { chart: "pie" });
    assert.deepEqual(toolEvents, []);
  });

  const executorFresh = require("../engine/executor");

  await t.test("executeNode dispatches a delegate node through /api/subagents/delegate", async () => {
    const node = normalizeNode({ id: "a", outputType: "delegate", agentSource: { kind: "static", agentId: "researcher" } });
    const ctx = { outputs: new Map(), workflowName: "wf" };
    const { output } = await executorFresh.executeNode(node, ctx);
    assert.match(output, /^handled: /);
  });

  await t.test("executeNode aborts via signal", async () => {
    const node = normalizeNode({ id: "a", outputType: "delegate", agentSource: { kind: "static", agentId: "researcher" } });
    const ctl = new AbortController();
    ctl.abort();
    await assert.rejects(() => executorFresh.executeNode(node, { outputs: new Map(), workflowName: "wf" }, { signal: ctl.signal }), /aborted/);
  });

  await bos.close();
});
