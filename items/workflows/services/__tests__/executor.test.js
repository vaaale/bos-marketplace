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


  // ===========================================================================
  // Scope-add: agent-trace events (US10/FR-028), ephemeral tool fidelity
  // (US12/FR-034), enriched-stream consumption, dry-run fixtures (US14).
  // ===========================================================================

  await t.test("FR-034: an ephemeral node forwards its FULL declared tool list, deferredTools, and skills", () => {
    const node = normalizeNode({
      id: "writer",
      agentSource: { kind: "ephemeral", task: "write the findings", tools: ["file_read", "file_write", "run_command"], skills: ["workflow-manager"] },
    });
    const body = delegateRequestFor(node, "do it", {});
    assert.deepEqual(body.ephemeral.tools, ["file_read", "file_write", "run_command"]);
    // Every declared tool is ALSO discoverable via find_tools — a declared
    // tool must never silently vanish (the run_command-heredoc fallback bug).
    assert.deepEqual(body.ephemeral.deferredTools, ["file_read", "file_write", "run_command"]);
    assert.deepEqual(body.ephemeral.skills, ["workflow-manager"]);
  });

  await t.test("FR-029: a routing node's spec carries the select_branch tool, enum-limited to its own candidates", () => {
    const node = normalizeNode({
      id: "classify",
      agentSource: { kind: "ephemeral", task: "classify", tools: ["file_read"] },
      candidates: ["alarm", "quiet"],
    });
    const body = delegateRequestFor(node, "do it", {});
    assert.ok(body.ephemeral.tools.includes("select_branch"));
    const declared = body.ephemeral.extraTools[0];
    assert.equal(declared.name, "select_branch");
    assert.deepEqual(declared.inputSchema.properties.selected.items.enum, ["alarm", "quiet"]);
    assert.deepEqual(body.ephemeral.deferredTools, ["file_read"], "select_branch is granted directly, not deferred");
  });

  await t.test("a single-candidate (auto-delegating) node gets NO select_branch tool (FR-019)", () => {
    const node = normalizeNode({ id: "gate", agentSource: { kind: "ephemeral", task: "gate" }, candidates: ["only"] });
    const body = delegateRequestFor(node, "do it", {});
    assert.equal(body.ephemeral.tools.includes("select_branch"), false);
    assert.equal(body.ephemeral.extraTools, undefined);
  });

  await t.test("a routing node's task text instructs a structured selection, never a prose SELECT: line", () => {
    const node = normalizeNode({ id: "classify", agentSource: { kind: "ephemeral", task: "classify it" }, candidates: ["alarm", "quiet"] });
    const task = require("../engine/executor").buildTaskText(node, { outputs: new Map(), workflowName: "wf" });
    assert.match(task, /select_branch/);
    assert.doesNotMatch(task, /^SELECT:/m);
  });

  await t.test("FR-035: upstream fan-out outputs are rendered as first-class structured context, no file handoff", () => {
    const { renderUpstream } = require("../engine/executor");
    const rendered = renderUpstream("research", [
      { label: "finance", output: "finance finding" },
      { label: "shipping", error: "sub-agent failed" },
    ]);
    assert.match(rendered, /2 result\(s\)/);
    assert.match(rendered, /\[finance\] finance finding/);
    assert.match(rendered, /ERROR: sub-agent failed/);
  });

  await t.test("FR-028: executeNode emits the agent trace (prompt, tool call in/out, response) through ctx.emit", async () => {
    const tracingBos = await startFakeBos({
      delegate: () => [
        { type: "tool", name: "fetch_csv", args: { path: "/warehouse/sales.csv" } },
        { type: "tool_result", name: "fetch_csv", result: "12,480 rows", ok: true },
        { type: "reasoning_delta", text: "Two rows share an invoice id." },
        { type: "done", result: { output: "raw.csv (12,480 rows)" } },
      ],
    });
    process.env.NEXT_PUBLIC_APP_ORIGIN = tracingBos.origin;
    for (const mod of ["../vfs", "../engine/executor"]) delete require.cache[require.resolve(mod)];
    const fresh = require("../engine/executor");

    const events = [];
    const node = normalizeNode({ id: "ingest", outputType: "delegate", agentSource: { kind: "ephemeral", task: "Fetch the sales CSV." } });
    const ctx = { outputs: new Map(), workflowName: "wf", emit: (type, patch) => events.push({ type, ...patch }) };
    const { output } = await fresh.executeNode(node, ctx);
    assert.equal(output, "raw.csv (12,480 rows)");

    const prompt = events.find((e) => e.type === "agent.prompt");
    assert.match(prompt.prompt, /Fetch the sales CSV/);
    assert.equal(prompt.stepId, "ingest");

    const toolCalls = events.filter((e) => e.type === "agent.tool_call");
    assert.equal(toolCalls[0].name, "fetch_csv");
    assert.equal(toolCalls[0].inflight, true);
    assert.deepEqual(toolCalls[0].args, { path: "/warehouse/sales.csv" });
    assert.equal(toolCalls[1].inflight, false);
    assert.equal(toolCalls[1].ok, true);
    assert.equal(toolCalls[1].result, "12,480 rows");

    assert.match(events.find((e) => e.type === "agent.reasoning").text, /invoice id/);
    assert.equal(events.filter((e) => e.type === "agent.response").pop().text, "raw.csv (12,480 rows)");

    await tracingBos.close();
    process.env.NEXT_PUBLIC_APP_ORIGIN = bos.origin;
    for (const mod of ["../vfs", "../engine/executor"]) delete require.cache[require.resolve(mod)];
  });

  await t.test("readStreamEvent normalizes both the {tool,input} and {name,args} spellings", () => {
    const { readStreamEvent } = require("../engine/executor");
    assert.deepEqual(readStreamEvent({ type: "tool", tool: "file_read", input: { path: "/x" } }), {
      kind: "tool_call",
      callId: undefined,
      name: "file_read",
      args: { path: "/x" },
      result: undefined,
      ok: undefined,
      inflight: true,
    });
    assert.equal(readStreamEvent({ type: "done", result: { output: "x" } }).kind, "done");
    assert.equal(readStreamEvent({ type: "unknown_future_event" }), null);
  });

  await t.test("FR-037: a fixture-designated node returns its canned output without any delegate call", async () => {
    const neverBos = await startFakeBos({
      delegate: () => {
        throw new Error("a dry-run node must never reach the delegate route");
      },
    });
    process.env.NEXT_PUBLIC_APP_ORIGIN = neverBos.origin;
    for (const mod of ["../vfs", "../engine/executor"]) delete require.cache[require.resolve(mod)];
    const fresh = require("../engine/executor");

    const events = [];
    const node = normalizeNode({ id: "research", outputType: "delegate", agentSource: { kind: "ephemeral", task: "expensive work" } });
    const ctx = {
      outputs: new Map(),
      workflowName: "wf",
      emit: (type, patch) => events.push({ type, ...patch }),
      dryRun: true,
      fixtures: { research: { finding: "canned" } },
    };
    const result = await fresh.executeNode(node, ctx);
    assert.deepEqual(result.output, { finding: "canned" });
    assert.equal(result.dryRun, true);
    assert.ok(events.some((e) => e.type === "agent.action" && /dry-run fixture/.test(e.action)));

    // fixtureFor keys off presence, so `undefined` is a legitimate fixture.
    assert.deepEqual(fresh.fixtureFor(node, { dryRun: true, fixtures: { research: undefined } }), { key: "research", value: undefined });
    assert.equal(fresh.fixtureFor(node, { dryRun: false, fixtures: { research: 1 } }), null);
    assert.equal(fresh.fixtureFor(node, { dryRun: true, fixtures: { other: 1 } }), null);

    await neverBos.close();
    process.env.NEXT_PUBLIC_APP_ORIGIN = bos.origin;
    for (const mod of ["../vfs", "../engine/executor"]) delete require.cache[require.resolve(mod)];
  });

  await bos.close();
});
