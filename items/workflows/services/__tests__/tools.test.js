// tools.test.js — the 12 workflow_* tool declarations (FR-002/014/016/024)
// and their gating opt-in (parallelSafe on read-only tools, US2/039 FR-005 —
// the actual allowlist/deferred enforcement lives in BOS's service-tool-bridge
// and is out of scope for a marketplace item's own unit tests; what this item
// controls is declaring shapes BOS can gate correctly).

const test = require("node:test");
const assert = require("node:assert/strict");
const { DECLARATIONS } = require("../tools");

const EXPECTED_NAMES = [
  "workflow_list",
  "workflow_create",
  "workflow_read",
  "workflow_modify",
  "workflow_run",
  "workflow_status",
  "workflow_cancel",
  "workflow_delete",
  "workflow_export",
  "workflow_validate",
  "workflow_run_list",
  "workflow_run_get",
];

const READ_ONLY_NAMES = new Set(["workflow_list", "workflow_read", "workflow_status", "workflow_export", "workflow_validate", "workflow_run_list", "workflow_run_get"]);
const WRITER_NAMES = new Set(["workflow_create", "workflow_modify", "workflow_run", "workflow_cancel", "workflow_delete"]);

test("tools.js", async (t) => {
  await t.test("declares exactly the 12 required tools (FR-002)", () => {
    assert.equal(DECLARATIONS.length, 12);
    assert.deepEqual(DECLARATIONS.map((d) => d.name).sort(), [...EXPECTED_NAMES].sort());
  });

  await t.test("every declaration has a name, description, and object inputSchema", () => {
    for (const d of DECLARATIONS) {
      assert.equal(typeof d.name, "string");
      assert.ok(d.name.startsWith("workflow_"));
      assert.equal(typeof d.description, "string");
      assert.ok(d.description.length > 10, `${d.name} needs a real description`);
      assert.equal(d.inputSchema.type, "object");
    }
  });

  await t.test("read-only tools are marked parallelSafe (039 opt-in for concurrent dispatch)", () => {
    for (const d of DECLARATIONS) {
      if (READ_ONLY_NAMES.has(d.name)) assert.equal(d.parallelSafe, true, `${d.name} should be parallelSafe`);
    }
  });

  await t.test("writers are NOT marked parallelSafe (they mutate shared state)", () => {
    for (const d of DECLARATIONS) {
      if (WRITER_NAMES.has(d.name)) assert.equal(d.parallelSafe, undefined, `${d.name} should not be parallelSafe`);
    }
  });

  await t.test("workflow_run's schema requires workflowId only (featureBranch/conversationId optional)", () => {
    const d = DECLARATIONS.find((x) => x.name === "workflow_run");
    assert.deepEqual(d.inputSchema.required, ["workflowId"]);
    assert.ok("featureBranch" in d.inputSchema.properties);
    assert.ok("conversationId" in d.inputSchema.properties);
  });

  await t.test("workflow_run_get requires both workflowId and runId", () => {
    const d = DECLARATIONS.find((x) => x.name === "workflow_run_get");
    assert.deepEqual(d.inputSchema.required.sort(), ["runId", "workflowId"]);
  });

  await t.test("workflow_create accepts either `workflow` or `taskDescription` (neither strictly required at the schema level)", () => {
    const d = DECLARATIONS.find((x) => x.name === "workflow_create");
    assert.ok("workflow" in d.inputSchema.properties);
    assert.ok("taskDescription" in d.inputSchema.properties);
    assert.deepEqual(d.inputSchema.required, []);
  });

  await t.test("no duplicate tool names", () => {
    const names = DECLARATIONS.map((d) => d.name);
    assert.equal(new Set(names).size, names.length);
  });
});
