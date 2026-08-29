// run-state.test.js — the single source of truth for live per-step state
// (US13/FR-036) and the per-node agent trace the trajectory panel renders
// (US10/FR-026/FR-028): event folding, tool-call merging, sub-agent fan-out
// status, the subscribe(since) tail, and replay of a persisted run.

const test = require("node:test");
const assert = require("node:assert/strict");
const { createRunState, replayRunState, registerRunState, getRunState, unregisterRunState } = require("../engine/run-state");

function rs() {
  return createRunState({ runId: "run-1", workflowId: "wf-1", workflowName: "Test" }).seedSteps([{ id: "a" }, { id: "b", retryLimit: 3 }]);
}

test("run-state.js", async (t) => {
  await t.test("seeds every declared step as pending — never an empty steps map (FR-036)", () => {
    const steps = rs().stepsSnapshot();
    assert.deepEqual(Object.keys(steps).sort(), ["a", "b"]);
    assert.equal(steps.a.status, "pending");
    assert.equal(steps.b.maxAttempts, 3);
  });

  await t.test("folds step lifecycle events into status/attempt/currentAction", () => {
    const state = rs();
    state.record({ type: "workflow.start" });
    state.record({ type: "step.start", stepId: "a", attempt: 1, maxAttempts: 2 });
    state.record({ type: "step.running", stepId: "a", action: "delegating to researcher" });
    let snap = state.stepsSnapshot();
    assert.equal(snap.a.status, "running");
    assert.equal(snap.a.attempt, 1);
    assert.equal(snap.a.maxAttempts, 2);
    assert.equal(snap.a.currentAction, "delegating to researcher");

    state.record({ type: "step.complete", stepId: "a", attempt: 1, payload: { rows: 12 } });
    snap = state.stepsSnapshot();
    assert.equal(snap.a.status, "completed");
    assert.deepEqual(snap.a.outputs, { rows: 12 });
    assert.equal(snap.a.currentAction, undefined, "a settled step has no current action");
  });

  await t.test("records a retry with its attempt number, and a failure with its error", () => {
    const state = rs();
    state.record({ type: "step.start", stepId: "b", attempt: 1, maxAttempts: 3 });
    state.record({ type: "step.retry", stepId: "b", attempt: 1, error: "fetch failed" });
    state.record({ type: "step.start", stepId: "b", attempt: 2, maxAttempts: 3 });
    assert.equal(state.stepsSnapshot().b.attempt, 2);
    state.record({ type: "step.fail", stepId: "b", attempt: 2, error: 'step "b" timed out after 5s', reason: "step-timeout" });
    const snap = state.stepsSnapshot().b;
    assert.equal(snap.status, "failed");
    assert.equal(snap.timedOut, true);
    assert.match(snap.error, /timed out/);
  });

  await t.test("a skipped (unselected) leaf keeps its branch-not-selected reason", () => {
    const state = rs();
    state.record({ type: "step.skip", stepId: "b", reason: "branch-not-selected" });
    assert.equal(state.stepsSnapshot().b.status, "skipped");
    assert.equal(state.stepsSnapshot().b.reason, "branch-not-selected");
  });

  await t.test("builds the agent trace: prompt, reasoning, response", () => {
    const state = rs();
    state.record({ type: "agent.prompt", stepId: "a", prompt: "Map each row to the analytics schema." });
    state.record({ type: "agent.reasoning", stepId: "a", text: "Blank amounts " });
    state.record({ type: "agent.reasoning", stepId: "a", text: "default to 0." });
    state.record({ type: "agent.response", stepId: "a", text: "mapped.json (12,478 records)" });
    const trace = state.stepsSnapshot().a.agentTrace;
    assert.equal(trace.prompt, "Map each row to the analytics schema.");
    assert.equal(trace.thinking, "Blank amounts default to 0.");
    assert.equal(trace.response, "mapped.json (12,478 records)");
  });

  await t.test("merges an inflight tool call IN PLACE with its completion (FR-028)", () => {
    const state = rs();
    state.record({ type: "agent.tool_call", stepId: "a", callId: "c1", name: "map_rows", args: { schema: "analytics.v2" }, inflight: true });
    let calls = state.stepsSnapshot().a.agentTrace.toolCalls;
    assert.equal(calls.length, 1);
    assert.equal(calls[0].inflight, true);
    assert.equal(calls[0].ok, undefined);

    state.record({ type: "agent.tool_call", stepId: "a", callId: "c1", name: "map_rows", result: "12,478 records", ok: true, inflight: false });
    calls = state.stepsSnapshot().a.agentTrace.toolCalls;
    assert.equal(calls.length, 1, "the completion updates the call rather than appending a second row");
    assert.equal(calls[0].inflight, false);
    assert.equal(calls[0].ok, true);
    assert.equal(calls[0].result, "12,478 records");
    assert.deepEqual(calls[0].args, { schema: "analytics.v2" });
  });

  await t.test("records a failed tool call with ok:false", () => {
    const state = rs();
    state.record({ type: "agent.tool_call", stepId: "a", callId: "c2", name: "emit", args: {}, result: "REJECTED — schema validation failed", ok: false, inflight: false });
    const call = state.stepsSnapshot().a.agentTrace.toolCalls[0];
    assert.equal(call.ok, false);
    assert.match(call.result, /REJECTED/);
  });

  await t.test("a retry resets the trace so the panel shows THIS attempt's activity", () => {
    const state = rs();
    state.record({ type: "step.start", stepId: "b", attempt: 1, maxAttempts: 3 });
    state.record({ type: "agent.tool_call", stepId: "b", callId: "x", name: "old_call", ok: true, inflight: false });
    state.record({ type: "step.start", stepId: "b", attempt: 2, maxAttempts: 3 });
    state.record({ type: "agent.tool_call", stepId: "b", callId: "y", name: "new_call", ok: true, inflight: false });
    const calls = state.stepsSnapshot().b.agentTrace.toolCalls;
    assert.deepEqual(calls.map((c) => c.name), ["new_call"]);
  });

  await t.test("tracks per-sub-agent fan-out status so the straggler is identifiable (FR-022)", () => {
    const state = rs();
    for (const i of [0, 1]) state.record({ type: "agent.sub_agent", stepId: "a", subAgentId: `a#${i}`, label: `fan-${i}`, status: "pending", action: "" });
    state.record({ type: "agent.sub_agent", stepId: "a", subAgentId: "a#0", status: "running", action: "mapping rows…" });
    state.record({ type: "agent.sub_agent", stepId: "a", subAgentId: "a#1", status: "completed", action: "done" });
    const subAgents = state.stepsSnapshot().a.subAgents;
    assert.equal(subAgents["a#0"].status, "running");
    assert.equal(subAgents["a#0"].action, "mapping rows…");
    assert.equal(subAgents["a#0"].label, "fan-0");
    assert.equal(subAgents["a#1"].status, "completed");
  });

  await t.test("a sub-agent's own agent events land on that sub-agent, not the parent trace", () => {
    const state = rs();
    state.record({ type: "agent.sub_agent", stepId: "a", subAgentId: "a#0", label: "fan-0", status: "running" });
    state.record({ type: "agent.prompt", stepId: "a", subAgentId: "a#0", prompt: "investigate finance" });
    const snap = state.stepsSnapshot().a;
    assert.equal(snap.subAgents["a#0"].agentTrace.prompt, "investigate finance");
    assert.equal(snap.agentTrace, undefined, "the parent's trace stays empty when only sub-agents ran");
  });

  await t.test("records routing selections and branch warnings", () => {
    const state = rs();
    state.record({ type: "step.complete", stepId: "a", attempt: 1, selected: ["b"] });
    assert.deepEqual(state.snapshot().selected, { a: ["b"] });
    state.record({ type: "workflow.branch.skipped", stepId: "a", selected: ["b"], reason: "zero leaves" });
    state.record({ type: "workflow.complete", finalState: "completed_with_warnings" });
    const snap = state.snapshot();
    assert.equal(snap.state, "completed_with_warnings");
    assert.equal(snap.finalState, "completed_with_warnings");
    assert.equal(snap.warnings.length, 1);
  });

  await t.test("the event log carries a monotonic seq and eventsSince tails it", () => {
    const state = rs();
    state.record({ type: "step.start", stepId: "a", attempt: 1 });
    state.record({ type: "step.complete", stepId: "a", attempt: 1 });
    assert.deepEqual(state.events.map((e) => e.seq), [1, 2]);
    assert.deepEqual(state.eventsSince(1).map((e) => e.type), ["step.complete"]);
    assert.deepEqual(state.snapshot({ since: 2 }).events, []);
    assert.equal(state.snapshot({ since: 2 }).seq, 2, "the snapshot still reports the head seq for the next poll");
  });

  await t.test("subscribe(since) replays the backlog then streams new events; unsubscribe stops it", () => {
    const state = rs();
    state.record({ type: "step.start", stepId: "a", attempt: 1 });
    const seen = [];
    const stop = state.subscribe(0, (evs) => seen.push(...evs.map((e) => e.type)));
    assert.deepEqual(seen, ["step.start"]);
    state.record({ type: "step.complete", stepId: "a", attempt: 1 });
    assert.deepEqual(seen, ["step.start", "step.complete"]);
    stop();
    state.record({ type: "workflow.complete", finalState: "completed" });
    assert.deepEqual(seen, ["step.start", "step.complete"]);
  });

  await t.test("a throwing subscriber never breaks the engine's event loop", () => {
    const state = rs();
    state.subscribe(0, () => {
      throw new Error("bad consumer");
    });
    assert.doesNotThrow(() => state.record({ type: "step.start", stepId: "a", attempt: 1 }));
    assert.equal(state.stepsSnapshot().a.status, "running");
  });

  await t.test("replayRunState rebuilds the identical projection from a persisted run (historical mode)", () => {
    const live = rs();
    live.record({ type: "workflow.start" });
    live.record({ type: "step.start", stepId: "a", attempt: 1, maxAttempts: 1 });
    live.record({ type: "agent.prompt", stepId: "a", prompt: "do the thing" });
    live.record({ type: "agent.tool_call", stepId: "a", callId: "c1", name: "fetch_csv", args: { path: "/x" }, inflight: true });
    live.record({ type: "agent.tool_call", stepId: "a", callId: "c1", result: "12 rows", ok: true, inflight: false });
    live.record({ type: "agent.response", stepId: "a", text: "raw.csv" });
    live.record({ type: "step.complete", stepId: "a", attempt: 1, payload: "raw.csv" });
    live.applyFinalSteps({ a: { status: "completed", attempts: 1, output: "raw.csv" }, b: { status: "neutral", attempts: 0 } });
    live.status = "completed";
    live.finalState = "completed";
    live.endedAt = live.startedAt + 5;

    const persisted = JSON.parse(JSON.stringify(live.toPersisted()));
    assert.equal(persisted.schemaVersion, 2);
    assert.ok(persisted.events.some((e) => e.type === "agent.tool_call"), "agent.* events are part of the persisted log (FR-028)");

    const replayed = replayRunState(persisted);
    assert.deepEqual(replayed.stepsSnapshot(), live.stepsSnapshot());
    assert.equal(replayed.snapshot().state, "completed");
    assert.equal(replayed.stepsSnapshot().b.status, "neutral", "a never-ran step replays as neutral");
    const trace = replayed.stepsSnapshot().a.agentTrace;
    assert.equal(trace.prompt, "do the thing");
    assert.equal(trace.toolCalls.length, 1);
    assert.equal(trace.toolCalls[0].ok, true);
  });

  await t.test("the registry resolves a run's live state by runId alone (GET /run/<runId>)", () => {
    const state = rs();
    registerRunState(state);
    assert.equal(getRunState("run-1"), state);
    unregisterRunState("run-1");
    assert.equal(getRunState("run-1"), undefined);
  });
});
