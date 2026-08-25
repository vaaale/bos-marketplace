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

  await t.test("warns (not errors) when a candidate doesn't declare the parent as a dependency", () => {
    const r = validateWorkflow(
      wf([
        { id: "a", agentSource: { kind: "static", agentId: "x" }, candidates: ["b"] },
        { id: "b", agentSource: { kind: "static", agentId: "x" }, dependencies: [] },
      ]),
    );
    assert.equal(r.ok, true);
    assert.ok(r.warnings.some((w) => w.includes("will never become ready")));
  });
});
