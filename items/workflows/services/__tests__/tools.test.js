// tools.test.js — the 13 workflow_* tool declarations (FR-002/014/016/024,
// plus workflow_event_types — US17/FR-044; its handler behavior lives in
// event-types-tool.test.js)
// and their gating opt-in (parallelSafe on read-only tools, US2/039 FR-005 —
// the actual allowlist/deferred enforcement lives in BOS's service-tool-bridge
// and is out of scope for a marketplace item's own unit tests; what this item
// controls is declaring shapes BOS can gate correctly).

const test = require("node:test");
const assert = require("node:assert/strict");
const { DECLARATIONS, selectBranchTool, SELECT_BRANCH_TOOL_NAME } = require("../tools");

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
  "workflow_event_types",
];

const READ_ONLY_NAMES = new Set([
  "workflow_list",
  "workflow_read",
  "workflow_status",
  "workflow_export",
  "workflow_validate",
  "workflow_run_list",
  "workflow_run_get",
  "workflow_event_types",
]);
const WRITER_NAMES = new Set(["workflow_create", "workflow_modify", "workflow_run", "workflow_cancel", "workflow_delete"]);

test("tools.js", async (t) => {
  await t.test("declares exactly the 13 required tools (FR-002/FR-044)", () => {
    assert.equal(DECLARATIONS.length, 13);
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

  // ---------------------------------------------------------------------------
  // Scope-add: dry-run inputs (US14/FR-037) + the structured select_branch
  // signal (US11/FR-029), which is NOT one of the 12 assistant-facing tools.
  // ---------------------------------------------------------------------------

  await t.test("workflow_run accepts opt-in dryRun + fixtures without making them required", () => {
    const d = DECLARATIONS.find((x) => x.name === "workflow_run");
    assert.equal(d.inputSchema.properties.dryRun.type, "boolean");
    assert.equal(d.inputSchema.properties.fixtures.type, "object");
    assert.deepEqual(d.inputSchema.required, ["workflowId"]);
    assert.match(d.description, /dry/i);
  });

  await t.test("workflow_status/workflow_run_get document the populated per-step live state (FR-036)", () => {
    const status = DECLARATIONS.find((x) => x.name === "workflow_status");
    assert.match(status.description, /per-step/i);
    assert.match(status.description, /sub-agent/i);
    const runGet = DECLARATIONS.find((x) => x.name === "workflow_run_get");
    assert.match(runGet.description, /agent trace|tool calls/i);
  });

  await t.test("select_branch is a per-node signal tool, enum-limited to that node's candidates", () => {
    assert.equal(SELECT_BRANCH_TOOL_NAME, "select_branch");
    assert.equal(DECLARATIONS.some((d) => d.name === "select_branch"), false, "it is never declared to the assistant as a workflow tool");
    const single = selectBranchTool(["alarm", "quiet"], false);
    assert.deepEqual(single.inputSchema.properties.selected.items.enum, ["alarm", "quiet"]);
    assert.equal(single.inputSchema.properties.selected.maxItems, 1);
    assert.deepEqual(single.inputSchema.required, ["selected"]);
    const multi = selectBranchTool(["a", "b", "c"], true);
    assert.equal(multi.inputSchema.properties.selected.maxItems, undefined);
    assert.equal(multi.inputSchema.properties.selected.minItems, 1);
  });
});
