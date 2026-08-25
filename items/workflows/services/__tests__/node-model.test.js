// node-model.test.js — the two orthogonal node axes (agentSource x outputType).

const test = require("node:test");
const assert = require("node:assert/strict");
const { normalizeNode, normalizeWorkflow, describeNode, hasCandidates, isAutoDelegate, OUTPUT_TYPES } = require("../engine/node-model");

test("node-model.js", async (t) => {
  await t.test("normalizeNode defaults outputType to delegate", () => {
    const n = normalizeNode({ id: "a" });
    assert.equal(n.outputType, "delegate");
    assert.deepEqual(n.dependencies, []);
  });

  await t.test("normalizeNode preserves a valid outputType", () => {
    for (const t2 of OUTPUT_TYPES) {
      const n = normalizeNode({ id: "a", outputType: t2 });
      assert.equal(n.outputType, t2);
    }
  });

  await t.test("normalizeNode coerces a static agentSource", () => {
    const n = normalizeNode({ id: "a", agentSource: { kind: "static", agentId: "researcher" } });
    assert.deepEqual(n.agentSource, { kind: "static", agentId: "researcher" });
  });

  await t.test("normalizeNode coerces an ephemeral agentSource with defaults", () => {
    const n = normalizeNode({ id: "a", agentSource: { kind: "ephemeral", task: "do the thing" } });
    assert.equal(n.agentSource.kind, "ephemeral");
    assert.equal(n.agentSource.task, "do the thing");
    assert.deepEqual(n.agentSource.tools, []);
    assert.deepEqual(n.agentSource.skills, []);
  });

  await t.test("normalizeNode defaults a missing/malformed agentSource to an empty static ref (not a silent ephemeral)", () => {
    const n = normalizeNode({ id: "a" });
    assert.deepEqual(n.agentSource, { kind: "static", agentId: "" });
  });

  await t.test("normalizeNode coerces researchAgents: string -> static, object -> ephemeral", () => {
    const n = normalizeNode({ id: "a", outputType: "research", researchAgents: ["finance-agent", { task: "look into shipping" }] });
    assert.equal(n.researchAgents.length, 2);
    assert.deepEqual(n.researchAgents[0], { kind: "static", agentId: "finance-agent" });
    assert.equal(n.researchAgents[1].kind, "ephemeral");
    assert.equal(n.researchAgents[1].task, "look into shipping");
  });

  await t.test("normalizeNode coerces candidates (string or object form)", () => {
    const n = normalizeNode({ id: "a", candidates: ["b", { id: "c", description: "the C path" }] });
    assert.deepEqual(n.candidates, [{ id: "b" }, { id: "c", agentId: undefined, description: "the C path" }]);
  });

  await t.test("hasCandidates / isAutoDelegate (FR-019: single candidate auto-delegates)", () => {
    const none = normalizeNode({ id: "a" });
    const one = normalizeNode({ id: "a", candidates: ["b"] });
    const many = normalizeNode({ id: "a", candidates: ["b", "c"] });
    assert.equal(hasCandidates(none), false);
    assert.equal(hasCandidates(one), true);
    assert.equal(isAutoDelegate(one), true);
    assert.equal(isAutoDelegate(many), false);
  });

  await t.test("describeNode produces 'outputType · sub' labels for the graph UI", () => {
    assert.equal(describeNode(normalizeNode({ id: "a", outputType: "tool", toolName: "fetch:csv" })), "tool · fetch:csv");
    assert.equal(describeNode(normalizeNode({ id: "a", outputType: "delegate", agentSource: { kind: "static", agentId: "db" } })), "delegate · db");
    assert.equal(describeNode(normalizeNode({ id: "a", outputType: "delegate", agentSource: { kind: "ephemeral", task: "x" } })), "delegate · ephemeral");
  });

  await t.test("normalizeWorkflow normalizes every step", () => {
    const wf = normalizeWorkflow({ id: "wf", steps: [{ id: "a" }, { id: "b", outputType: "tool", toolName: "x" }] });
    assert.equal(wf.steps.length, 2);
    assert.equal(wf.steps[1].toolName, "x");
  });
});
