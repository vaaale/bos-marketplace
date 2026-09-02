// event-node.test.js — the `event` output type (US18 / FR-046/047/048):
//
//   * node-model  — the EmitEventNodeConfig shape (valid/invalid), `event` in
//                   the outputType union, and NO agentSource requirement.
//   * executor    — static emit (real loopback POST, asserted body), template
//                   resolution (upstream present / unresolved -> null /
//                   fallback / invalid JSON -> node fails), the `_wf`
//                   provenance envelope, and an emit HTTP error failing the
//                   node.
//   * validate    — FR-048a triggers, FR-048b `com.bos.workflows.*` policy,
//                   FR-048c template references must name real nodes.
//
// Uses the shared _fake-bos fixture (now serving /api/events too) rather than
// stubbing http, so the real request/JSON path is exercised end to end.

const test = require("node:test");
const assert = require("node:assert/strict");
const { startFakeBos } = require("./_fake-bos");

function eventNode(config, extra = {}) {
  return { id: "notify", outputType: "event", config, ...extra };
}

const STATIC_CONFIG = {
  eventType: "com.bos.workflows.analysis.complete",
  payload: { mode: "static", value: { key: "val" } },
};

test("node-model: the `event` output type", async (t) => {
  const { OUTPUT_TYPES, normalizeNode, eventNodeConfigErrors, isEventNode, isValidEventType, parseTemplateRefs } = require("../engine/node-model");

  await t.test("`event` is part of the outputType union", () => {
    assert.ok(OUTPUT_TYPES.includes("event"));
    assert.deepEqual(OUTPUT_TYPES, ["delegate", "tool", "research", "ag-ui", "event"]);
  });

  await t.test("normalizeNode keeps an event node's eventType + payload and reports it as an event node", () => {
    const node = normalizeNode(eventNode(STATIC_CONFIG));
    assert.equal(node.outputType, "event");
    assert.ok(isEventNode(node));
    assert.equal(node.config.eventType, "com.bos.workflows.analysis.complete");
    assert.deepEqual(node.config.payload, { mode: "static", value: { key: "val" } });
  });

  await t.test("a valid static EmitEventNodeConfig has no config errors", () => {
    assert.deepEqual(eventNodeConfigErrors(normalizeNode(eventNode(STATIC_CONFIG))), []);
  });

  await t.test("a valid template EmitEventNodeConfig has no config errors (fallback optional)", () => {
    const withFallback = eventNode({
      eventType: "com.bos.workflows.analysis.complete",
      payload: { mode: "template", text: '{"summary": {{research_1.output}}}', fallback: null },
    });
    assert.deepEqual(eventNodeConfigErrors(normalizeNode(withFallback)), []);
    const withoutFallback = eventNode({
      eventType: "com.bos.workflows.analysis.complete",
      payload: { mode: "template", text: '{"summary": {{research_1.output}}}' },
    });
    assert.deepEqual(eventNodeConfigErrors(normalizeNode(withoutFallback)), []);
  });

  await t.test("an eventType that does not match the pattern is a config error", () => {
    for (const bad of ["NotLowercase.Event", "nodots", "com.bos..double", "com.bos.workflows.Bad", ""]) {
      const errors = eventNodeConfigErrors(normalizeNode(eventNode({ ...STATIC_CONFIG, eventType: bad })));
      assert.ok(errors.length > 0, `"${bad}" should be rejected`);
    }
    assert.ok(isValidEventType("com.bos.workflows.analysis.complete"));
    assert.ok(isValidEventType("com.bos.gsuite.email.received"));
    assert.ok(!isValidEventType("nodots"));
    assert.ok(!isValidEventType(undefined));
  });

  await t.test("a payload that is neither static nor template is a config error", () => {
    const noMode = eventNodeConfigErrors(normalizeNode(eventNode({ ...STATIC_CONFIG, payload: {} })));
    assert.match(noMode.join(" "), /payload\.mode/);
    const bogus = eventNodeConfigErrors(normalizeNode(eventNode({ ...STATIC_CONFIG, payload: { mode: "magic" } })));
    assert.match(bogus.join(" "), /must be "static" or "template"/);
    const noPayload = eventNodeConfigErrors(normalizeNode(eventNode({ eventType: STATIC_CONFIG.eventType })));
    assert.ok(noPayload.length > 0);
  });

  await t.test("static mode requires an object value; template mode requires text", () => {
    assert.match(
      eventNodeConfigErrors(normalizeNode(eventNode({ ...STATIC_CONFIG, payload: { mode: "static" } }))).join(" "),
      /requires config\.payload\.value/,
    );
    assert.match(
      eventNodeConfigErrors(normalizeNode(eventNode({ ...STATIC_CONFIG, payload: { mode: "static", value: "not an object" } }))).join(" "),
      /JSON object/,
    );
    assert.match(
      eventNodeConfigErrors(normalizeNode(eventNode({ ...STATIC_CONFIG, payload: { mode: "template" } }))).join(" "),
      /requires config\.payload\.text/,
    );
  });

  await t.test("an event node needs NO agentSource — it is a pure I/O node, not an agent step", () => {
    const { validateWorkflow } = require("../engine/validate");
    const wf = { id: "wf", name: "Emit only", steps: [normalizeNode(eventNode(STATIC_CONFIG))] };
    const result = validateWorkflow(wf);
    assert.equal(result.ok, true, result.errors.join("; "));
    assert.equal(
      result.errors.filter((e) => /agentSource|agentId/.test(e)).length,
      0,
    );
  });

  await t.test("parseTemplateRefs finds every {{nodeId.field}} reference, dropping the `output` root segment", () => {
    const refs = parseTemplateRefs('{"a": {{n1.output}}, "b": {{n2.output.results.0.name}}, "c": {{n3.summary}}}');
    assert.deepEqual(
      refs.map((r) => [r.nodeId, r.path.join(".")]),
      [
        ["n1", ""],
        ["n2", "results.0.name"],
        ["n3", "summary"],
      ],
    );
  });
});

test("executor: emitting an `event` node", async (t) => {
  const bos = await startFakeBos({});
  process.env.NEXT_PUBLIC_APP_ORIGIN = bos.origin;
  const savedPort = process.env.PORT;
  delete process.env.PORT;
  for (const mod of ["../vfs", "../engine/executor"]) delete require.cache[require.resolve(mod)];
  const executor = require("../engine/executor");
  const { normalizeNode } = require("../engine/node-model");

  function ctxFor(outputs = {}) {
    return {
      outputs: new Map(Object.entries(outputs)),
      workflow: { id: "wf-1" },
      workflowName: "Analysis",
      runId: "run-1",
    };
  }

  t.after(async () => {
    await bos.close();
    if (savedPort !== undefined) process.env.PORT = savedPort;
  });

  await t.test("a static payload is POSTed to /api/events verbatim, and the node output records the event id", async () => {
    bos.emitted.length = 0;
    const node = normalizeNode(eventNode(STATIC_CONFIG));
    const { output } = await executor.executeNode(node, ctxFor());
    assert.equal(bos.emitted.length, 1);
    const body = bos.emitted[0];
    assert.equal(body.type, "com.bos.workflows.analysis.complete");
    assert.equal(body.source.appId, "workflows");
    assert.equal(body.payload.key, "val");
    assert.deepEqual(output, { emitted: true, eventId: "evt_1" });
  });

  await t.test("FR-047: every emitted event carries the `_wf` provenance envelope", async () => {
    bos.emitted.length = 0;
    const node = normalizeNode(eventNode(STATIC_CONFIG));
    await executor.executeNode(node, ctxFor());
    assert.deepEqual(bos.emitted[0].payload._wf, { workflowId: "wf-1", runId: "run-1", nodeId: "notify" });
  });

  await t.test("no delegate/LLM call is made — an event node is pure I/O", async () => {
    // The fake BOS answers /api/subagents/delegate too; a delegate call would
    // show up as an echoed task output rather than an { emitted } result.
    bos.emitted.length = 0;
    const node = normalizeNode(eventNode(STATIC_CONFIG));
    const { output, toolEvents } = await executor.executeNode(node, ctxFor());
    assert.equal(output.emitted, true);
    assert.deepEqual(toolEvents, []);
  });

  await t.test("template mode resolves {{nodeId.field}} against upstream outputs (strings quoted, numbers bare)", async () => {
    bos.emitted.length = 0;
    const node = normalizeNode(
      eventNode({
        eventType: "com.bos.workflows.analysis.complete",
        payload: { mode: "template", text: '{"summary": {{research_1.output}}, "count": {{research_1.count}}, "top": {{research_1.output.results.0.name}}}' },
      }),
    );
    // `research_1.output` and `research_1.count` read the same node output —
    // the leading `output` segment names the output root itself.
    const { output } = await executor.executeNode(
      node,
      ctxFor({ research_1: { results: [{ name: "alpha" }, { name: "beta" }], count: 2 } }),
    );
    assert.equal(output.emitted, true);
    const emittedPayload = bos.emitted[0].payload;
    assert.deepEqual(emittedPayload.summary, { results: [{ name: "alpha" }, { name: "beta" }], count: 2 });
    assert.equal(emittedPayload.count, 2);
    assert.equal(emittedPayload.top, "alpha");
  });

  await t.test("a string upstream output is JSON-quoted, so the template stays valid JSON", async () => {
    bos.emitted.length = 0;
    const node = normalizeNode(
      eventNode({
        eventType: "com.bos.workflows.analysis.complete",
        payload: { mode: "template", text: '{"summary": {{research_1.output}}}' },
      }),
    );
    await executor.executeNode(node, ctxFor({ research_1: 'he said "hi"\nthen left' }));
    assert.equal(bos.emitted[0].payload.summary, 'he said "hi"\nthen left');
  });

  await t.test("an unresolved reference (node never ran, or missing field) resolves to null", async () => {
    bos.emitted.length = 0;
    const node = normalizeNode(
      eventNode({
        eventType: "com.bos.workflows.analysis.complete",
        payload: { mode: "template", text: '{"never_ran": {{ghost.output}}, "missing_field": {{research_1.output.nope}}}' },
      }),
    );
    await executor.executeNode(node, ctxFor({ research_1: { summary: "done" } }));
    assert.deepEqual(bos.emitted[0].payload.never_ran, null);
    assert.deepEqual(bos.emitted[0].payload.missing_field, null);
  });

  await t.test("`fallback` replaces an unresolved reference when one is declared", async () => {
    bos.emitted.length = 0;
    const node = normalizeNode(
      eventNode({
        eventType: "com.bos.workflows.analysis.complete",
        payload: { mode: "template", text: '{"summary": {{ghost.output}}}', fallback: "unavailable" },
      }),
    );
    await executor.executeNode(node, ctxFor());
    assert.equal(bos.emitted[0].payload.summary, "unavailable");
  });

  await t.test("a template that renders to invalid JSON fails the node and emits nothing", async () => {
    bos.emitted.length = 0;
    const node = normalizeNode(
      eventNode({
        eventType: "com.bos.workflows.analysis.complete",
        payload: { mode: "template", text: '{"summary": {{research_1.output}}' }, // missing closing brace
      }),
    );
    await assert.rejects(() => executor.executeNode(node, ctxFor({ research_1: "x" })), /did not render to valid JSON/);
    assert.equal(bos.emitted.length, 0);
  });

  await t.test("a template that renders to a non-object (array/scalar) fails the node", async () => {
    bos.emitted.length = 0;
    const node = normalizeNode(
      eventNode({
        eventType: "com.bos.workflows.analysis.complete",
        payload: { mode: "template", text: "[{{research_1.output}}]" },
      }),
    );
    await assert.rejects(() => executor.executeNode(node, ctxFor({ research_1: 1 })), /must be a JSON object/);
    assert.equal(bos.emitted.length, 0);
  });

  await t.test("a config error is not retried as a transient failure", () => {
    const { isTransientError } = require("../engine/scheduler");
    const node = normalizeNode(eventNode({ ...STATIC_CONFIG, payload: { mode: "static", value: "not an object" } }));
    assert.throws(
      () => executor.resolveEventPayload(node, ctxFor()),
      (err) => {
        assert.equal(err.code, "event_config");
        assert.equal(isTransientError(err), false);
        return true;
      },
    );
  });

  await t.test("an emit HTTP error fails the node with the API's error body", async () => {
    const failing = await startFakeBos({ events: { emit: () => ({ status: 400, body: { error: { code: "invalid-type", message: "payload must be a JSON object" } } }) } });
    process.env.NEXT_PUBLIC_APP_ORIGIN = failing.origin;
    for (const mod of ["../vfs", "../engine/executor"]) delete require.cache[require.resolve(mod)];
    const fresh = require("../engine/executor");
    const node = normalizeNode(eventNode(STATIC_CONFIG));
    await assert.rejects(() => fresh.executeNode(node, ctxFor()), /payload must be a JSON object/);
    await failing.close();
    process.env.NEXT_PUBLIC_APP_ORIGIN = bos.origin;
    for (const mod of ["../vfs", "../engine/executor"]) delete require.cache[require.resolve(mod)];
  });

  await t.test("the node's trajectory records the emit (prompt/action/response), not a delegate call", async () => {
    const events = [];
    const emitTrace = (type, patch) => events.push({ type, ...patch });
    const node = normalizeNode(eventNode(STATIC_CONFIG));
    const ctx = { ...ctxFor(), emit: emitTrace };
    await require("../engine/executor").executeNode(node, ctx);
    const types = events.map((e) => e.type);
    assert.ok(types.includes("agent.prompt"));
    assert.ok(types.includes("agent.action"));
    assert.ok(types.includes("agent.response"));
    assert.match(events.find((e) => e.type === "agent.response").text, /Emitted "com\.bos\.workflows\.analysis\.complete"/);
  });

  await t.test("a dry-run fixture short-circuits the emit entirely (no event fired)", async () => {
    bos.emitted.length = 0;
    const node = normalizeNode(eventNode(STATIC_CONFIG));
    const ctx = { ...ctxFor(), dryRun: true, fixtures: { notify: { emitted: true, eventId: "fixture" } } };
    const { output, dryRun } = await require("../engine/executor").executeNode(node, ctx);
    assert.equal(dryRun, true);
    assert.deepEqual(output, { emitted: true, eventId: "fixture" });
    assert.equal(bos.emitted.length, 0);
  });

  await t.test("the scheduler runs an event node inline and records its output for dependents", async () => {
    bos.emitted.length = 0;
    for (const mod of ["../engine/scheduler"]) delete require.cache[require.resolve(mod)];
    const { runWorkflow } = require("../engine/scheduler");
    const wf = {
      id: "wf-1",
      name: "Analysis",
      steps: [
        { id: "research_1", outputType: "ag-ui", input: { summary: "all good" } },
        {
          id: "notify",
          outputType: "event",
          dependencies: ["research_1"],
          config: { eventType: "com.bos.workflows.analysis.complete", payload: { mode: "template", text: '{"summary": {{research_1.output.summary}}}' } },
        },
      ],
    };
    const result = await runWorkflow(wf, {
      runId: "run-9",
      workflowName: "Analysis",
      abortSignal: new AbortController().signal,
      emit: () => {},
      maxConcurrentSteps: 2,
    });
    assert.equal(result.state, "completed", JSON.stringify(result.steps));
    assert.equal(result.steps.notify.output.emitted, true);
    assert.match(result.steps.notify.output.eventId, /^evt_\d+$/);
    assert.equal(bos.emitted.length, 1);
    assert.equal(bos.emitted[0].payload.summary, "all good");
    assert.deepEqual(bos.emitted[0].payload._wf, { workflowId: "wf-1", runId: "run-9", nodeId: "notify" });
  });
});

test("validate: FR-048 event policy", async (t) => {
  const { validateWorkflow } = require("../engine/validate");

  const OK_EVENT_STEP = {
    id: "notify",
    outputType: "event",
    dependencies: ["research_1"],
    config: { eventType: "com.bos.workflows.analysis.complete", payload: { mode: "static", value: { ok: true } } },
  };
  const wfWith = (steps, extra = {}) => ({ id: "wf", name: "Analysis", steps, ...extra });
  const RESEARCH_STEP = { id: "research_1", outputType: "ag-ui", input: { summary: "s" } };

  await t.test("a well-formed event workflow validates", () => {
    const result = validateWorkflow(wfWith([RESEARCH_STEP, OK_EVENT_STEP]));
    assert.equal(result.ok, true, result.errors.join("; "));
  });

  await t.test("FR-048a: every `triggers` entry must be a well-formed event type", () => {
    const ok = validateWorkflow(wfWith([RESEARCH_STEP, OK_EVENT_STEP], { triggers: ["com.bos.gsuite.email.received", "com.bos.workflows.analysis.complete"] }));
    assert.equal(ok.ok, true, ok.errors.join("; "));

    const bad = validateWorkflow(wfWith([RESEARCH_STEP, OK_EVENT_STEP], { triggers: ["Not An Event"] }));
    assert.equal(bad.ok, false);
    assert.match(bad.errors.join(" "), /not a valid event type/);

    const notAnArray = validateWorkflow(wfWith([RESEARCH_STEP, OK_EVENT_STEP], { triggers: "com.bos.gsuite.email.received" }));
    assert.equal(notAnArray.ok, false);
    assert.match(notAnArray.errors.join(" "), /`triggers` must be an array/);
  });

  await t.test("FR-048b: an event node may only emit under com.bos.workflows.*", () => {
    const foreign = validateWorkflow(
      wfWith([RESEARCH_STEP, { ...OK_EVENT_STEP, config: { ...OK_EVENT_STEP.config, eventType: "com.bos.gsuite.email.received" } }]),
    );
    assert.equal(foreign.ok, false);
    assert.match(foreign.errors.join(" "), /outside "com\.bos\.workflows\.\*"/);

    const own = validateWorkflow(
      wfWith([RESEARCH_STEP, { ...OK_EVENT_STEP, config: { ...OK_EVENT_STEP.config, eventType: "com.bos.workflows.custom.thing" } }]),
    );
    assert.equal(own.ok, true, own.errors.join("; "));
  });

  await t.test("FR-048b: a malformed eventType is reported as a shape error", () => {
    const result = validateWorkflow(wfWith([RESEARCH_STEP, { ...OK_EVENT_STEP, config: { ...OK_EVENT_STEP.config, eventType: "Com.Bos.Workflows.Nope" } }]));
    assert.equal(result.ok, false);
    assert.match(result.errors.join(" "), /invalid config\.eventType/);
  });

  await t.test("FR-048c: every template reference must name a step that exists", () => {
    const good = validateWorkflow(
      wfWith([
        RESEARCH_STEP,
        { ...OK_EVENT_STEP, config: { eventType: "com.bos.workflows.analysis.complete", payload: { mode: "template", text: '{"s": {{research_1.output.summary}}}' } } },
      ]),
    );
    assert.equal(good.ok, true, good.errors.join("; "));

    const dangling = validateWorkflow(
      wfWith([
        RESEARCH_STEP,
        { ...OK_EVENT_STEP, config: { eventType: "com.bos.workflows.analysis.complete", payload: { mode: "template", text: '{"s": {{reserch_1.output.summary}}}' } } },
      ]),
    );
    assert.equal(dangling.ok, false);
    assert.match(dangling.errors.join(" "), /no step "reserch_1" exists/);
  });

  await t.test("an invalid event payload mode is a validation error", () => {
    const result = validateWorkflow(wfWith([RESEARCH_STEP, { ...OK_EVENT_STEP, config: { eventType: "com.bos.workflows.a.b", payload: { mode: "magic" } } }]));
    assert.equal(result.ok, false);
    assert.match(result.errors.join(" "), /must be "static" or "template"/);
  });
});
