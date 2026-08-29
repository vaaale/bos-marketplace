// validate.test.js — DAG acyclicity + node shape validation.

const test = require("node:test");
const assert = require("node:assert/strict");
const { validateWorkflow, isAcyclic } = require("../engine/validate");

function wf(steps, extra = {}) {
  return { id: "wf-1", name: "Test", steps, ...extra };
}

test("validate.js", async (t) => {
  await t.test("rejects a workflow with no steps", () => {
    const r = validateWorkflow(wf([]));
    assert.equal(r.ok, false);
    assert.ok(r.errors.some((e) => e.includes("at least one step")));
  });

  await t.test("accepts a minimal valid single-step workflow", () => {
    const r = validateWorkflow(
      wf([{ id: "a", outputType: "delegate", agentSource: { kind: "static", agentId: "researcher" } }]),
    );
    assert.equal(r.ok, true);
    assert.deepEqual(r.errors, []);
  });

  await t.test("flags a duplicate step id", () => {
    const r = validateWorkflow(
      wf([
        { id: "a", agentSource: { kind: "static", agentId: "x" } },
        { id: "a", agentSource: { kind: "static", agentId: "y" } },
      ]),
    );
    assert.ok(r.errors.some((e) => e.includes("Duplicate step id")));
  });

  await t.test("flags a static agentSource missing agentId", () => {
    const r = validateWorkflow(wf([{ id: "a", agentSource: { kind: "static" } }]));
    assert.ok(r.errors.some((e) => e.includes("requires an agentId")));
  });

  await t.test("flags an ephemeral agentSource missing a task", () => {
    const r = validateWorkflow(wf([{ id: "a", agentSource: { kind: "ephemeral" } }]));
    assert.ok(r.errors.some((e) => e.includes("requires a task description")));
  });

  await t.test("flags a tool node missing toolName", () => {
    const r = validateWorkflow(wf([{ id: "a", outputType: "tool", agentSource: { kind: "static", agentId: "x" } }]));
    assert.ok(r.errors.some((e) => e.includes("requires a toolName")));
  });

  await t.test("flags a dependency on a missing step", () => {
    const r = validateWorkflow(wf([{ id: "a", agentSource: { kind: "static", agentId: "x" }, dependencies: ["ghost"] }]));
    assert.ok(r.errors.some((e) => e.includes('depends on missing step "ghost"')));
  });

  await t.test("flags a dependency cycle", () => {
    const r = validateWorkflow(
      wf([
        { id: "a", agentSource: { kind: "static", agentId: "x" }, dependencies: ["b"] },
        { id: "b", agentSource: { kind: "static", agentId: "x" }, dependencies: ["a"] },
      ]),
    );
    assert.ok(r.errors.some((e) => e.includes("dependency cycle")));
  });

  await t.test("isAcyclic true for a valid DAG, false for a cycle", () => {
    assert.equal(isAcyclic([{ id: "a", dependencies: [] }, { id: "b", dependencies: ["a"] }]), true);
    assert.equal(isAcyclic([{ id: "a", dependencies: ["b"] }, { id: "b", dependencies: ["a"] }]), false);
  });

  await t.test("flags an unknown dynamic-routing candidate", () => {
    const r = validateWorkflow(
      wf([{ id: "a", agentSource: { kind: "static", agentId: "x" }, candidates: ["ghost"] }]),
    );
    assert.ok(r.errors.some((e) => e.includes('unknown candidate "ghost"')));
  });

  // ---------------------------------------------------------------------------
  // FR-033 — candidate topology. Both shapes below silently produce a run that
  // "completes" having done nothing, so both are structural ERRORS.
  // ---------------------------------------------------------------------------

  await t.test("flags an UNREACHABLE candidate leaf (no dependency path from its routing node)", () => {
    const r = validateWorkflow(
      wf([
        { id: "a", agentSource: { kind: "static", agentId: "x" }, candidates: ["b"] },
        { id: "b", agentSource: { kind: "static", agentId: "x" }, dependencies: [] },
      ]),
    );
    assert.equal(r.ok, false);
    assert.ok(r.errors.some((e) => e.includes("unreachable candidate leaf")), JSON.stringify(r.errors));
  });

  await t.test("accepts a candidate leaf reached THROUGH a shared step (Option A, FR-031)", () => {
    const r = validateWorkflow(
      wf([
        { id: "classify", agentSource: { kind: "static", agentId: "x" }, candidates: ["alarm", "quiet"] },
        { id: "render", agentSource: { kind: "static", agentId: "x" }, dependencies: ["classify"] },
        { id: "alarm", outputType: "ag-ui", input: 1, dependencies: ["render"] },
        { id: "quiet", outputType: "ag-ui", input: 1, dependencies: ["render"] },
      ]),
    );
    assert.equal(r.ok, true, JSON.stringify(r.errors));
  });

  await t.test("flags a node that is ambiguously BOTH a gated candidate leaf and a shared dependency", () => {
    const r = validateWorkflow(
      wf([
        { id: "classify", agentSource: { kind: "static", agentId: "x" }, candidates: ["alarm", "quiet"] },
        { id: "alarm", outputType: "ag-ui", input: 1, dependencies: ["classify"] },
        { id: "quiet", outputType: "ag-ui", input: 1, dependencies: ["classify"] },
        // `publish` is NOT gated by classify, yet depends on a gated leaf —
        // it can never run whenever `alarm` is not the selected branch.
        { id: "publish", outputType: "ag-ui", input: 1, dependencies: ["alarm"] },
      ]),
    );
    assert.equal(r.ok, false);
    assert.ok(r.errors.some((e) => e.includes("ambiguously both a gated candidate leaf")), JSON.stringify(r.errors));
  });

  await t.test("does not flag a dependent that is gated by the SAME routing node", () => {
    const r = validateWorkflow(
      wf([
        { id: "classify", agentSource: { kind: "static", agentId: "x" }, candidates: ["alarm", "escalate"] },
        { id: "alarm", outputType: "ag-ui", input: 1, dependencies: ["classify"] },
        { id: "escalate", outputType: "ag-ui", input: 1, dependencies: ["alarm"] },
      ]),
    );
    assert.equal(r.ok, true, JSON.stringify(r.errors));
  });

  await t.test("a workflow with no candidates at all is unaffected by the topology checks", () => {
    const r = validateWorkflow(
      wf([
        { id: "a", agentSource: { kind: "static", agentId: "x" } },
        { id: "b", agentSource: { kind: "static", agentId: "x" }, dependencies: ["a"] },
      ]),
    );
    assert.equal(r.ok, true);
    assert.deepEqual(r.errors, []);
  });
});
