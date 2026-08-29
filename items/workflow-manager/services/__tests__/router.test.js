// router.test.js — dynamic routing: STRUCTURED candidate selection
// (US11/FR-029/FR-030), the retry-then-fail loop (FR-018), and Option A
// selection propagation (FR-031).
//
// The prose `SELECT: <id>` contract this module used to implement is GONE on
// purpose: it is what let an agent that said "I'll select the alarm branch"
// route to `quiet`. Everything below asserts that a selection is only ever
// read from a structured signal, and that an unparseable one FAILS rather
// than defaulting.

const test = require("node:test");
const assert = require("node:assert/strict");
const { readSelectionSignal, parseStructuredText, resolveCandidates, buildCandidateIndex, selectionAllows, selectionRejects, routingInstruction } = require("../engine/router");
const { normalizeNode } = require("../engine/node-model");

const VALID = ["finance", "shipping"];

test("router.js", async (t) => {
  await t.test("reads the selection from a select_branch TOOL CALL (the canonical signal)", () => {
    const signal = readSelectionSignal(
      { output: "I looked at the filings and made my choice.", toolEvents: [{ name: "select_branch", args: { selected: ["shipping"] } }] },
      VALID,
    );
    assert.deepEqual(signal, { selected: ["shipping"], source: "select_branch_tool" });
  });

  await t.test("tolerates the {tool,input} spelling of a tool event", () => {
    const signal = readSelectionSignal({ output: "", toolEvents: [{ tool: "select_branch", input: { selected: ["finance"] } }] }, VALID);
    assert.deepEqual(signal.selected, ["finance"]);
  });

  await t.test("tolerates JSON-string tool arguments", () => {
    const signal = readSelectionSignal({ output: "", toolEvents: [{ name: "select_branch", args: '{"selected":["finance"]}' }] }, VALID);
    assert.deepEqual(signal.selected, ["finance"]);
  });

  await t.test("reads an equivalent structured OUTPUT object (FR-029's second form)", () => {
    const signal = readSelectionSignal({ output: { select_branch: { selected: ["finance"] } }, toolEvents: [] }, VALID);
    assert.deepEqual(signal, { selected: ["finance"], source: "structured_output" });
  });

  await t.test("reads a strict JSON envelope embedded in the response text", () => {
    const signal = readSelectionSignal({ output: 'Analysis done.\n{"select_branch": {"selected": ["shipping"]}}', toolEvents: [] }, VALID);
    assert.deepEqual(signal.selected, ["shipping"]);
  });

  await t.test("reads a fenced ```json envelope", () => {
    const signal = readSelectionSignal({ output: 'Reasoning…\n```json\n{"select_branch":{"selected":["finance","shipping"]}}\n```', toolEvents: [] }, VALID);
    assert.deepEqual(signal.selected, ["finance", "shipping"]);
  });

  await t.test("NEVER infers a candidate from prose — the old SELECT: line is not a signal (FR-029)", () => {
    assert.equal(readSelectionSignal({ output: "I'll select the alarm branch.\nSELECT: finance", toolEvents: [] }, VALID), null);
    assert.equal(readSelectionSignal({ output: "Definitely shipping.", toolEvents: [] }, VALID), null);
    assert.equal(parseStructuredText("the answer is finance"), null);
  });

  await t.test("rejects a signal naming an id outside the node's own candidates", () => {
    assert.equal(readSelectionSignal({ output: "", toolEvents: [{ name: "select_branch", args: { selected: ["legal"] } }] }, VALID), null);
    // A partially-invalid selection invalidates the WHOLE signal rather than
    // silently routing to the valid half.
    assert.equal(readSelectionSignal({ output: "", toolEvents: [{ name: "select_branch", args: { selected: ["finance", "legal"] } }] }, VALID), null);
  });

  await t.test("prefers the tool call over a stale structured blob in the text", () => {
    const signal = readSelectionSignal(
      { output: '{"select_branch":{"selected":["finance"]}}', toolEvents: [{ name: "select_branch", args: { selected: ["shipping"] } }] },
      VALID,
    );
    assert.deepEqual(signal, { selected: ["shipping"], source: "select_branch_tool" });
  });

  await t.test("resolveCandidates returns null for a node with no candidates", async () => {
    const node = normalizeNode({ id: "a" });
    assert.equal(await resolveCandidates(node, { output: "anything" }, async () => "unused"), null);
  });

  await t.test("resolveCandidates auto-delegates a single candidate without any signal (FR-019)", async () => {
    const node = normalizeNode({ id: "a", candidates: ["only-child"] });
    const picked = await resolveCandidates(node, { output: "no signal here at all" }, async () => {
      throw new Error("should not retry for a single candidate");
    });
    assert.deepEqual(picked, ["only-child"]);
  });

  await t.test("resolveCandidates accepts a valid structured selection on the first attempt", async () => {
    const node = normalizeNode({ id: "a", candidates: VALID });
    const picked = await resolveCandidates(node, { output: "", toolEvents: [{ name: "select_branch", args: { selected: ["shipping"] } }] }, async () => {
      throw new Error("should not need a retry");
    });
    assert.deepEqual(picked, ["shipping"]);
  });

  await t.test("resolveCandidates retries on a missing signal, then succeeds (FR-018 retry-loop)", async () => {
    const node = normalizeNode({ id: "a", candidates: VALID });
    let calls = 0;
    const retries = [];
    const retryDelegate = async (clarification) => {
      calls++;
      retries.push(clarification);
      return { output: '{"select_branch":{"selected":["finance"]}}', toolEvents: [] };
    };
    const picked = await resolveCandidates(node, { output: "I am not sure which branch applies." }, retryDelegate);
    assert.deepEqual(picked, ["finance"]);
    assert.equal(calls, 1);
    assert.match(retries[0], /select_branch/);
  });

  await t.test("resolveCandidates FAILS after exhausting retries — it never defaults to a candidate (FR-030)", async () => {
    const node = normalizeNode({ id: "a", candidates: VALID });
    const retryDelegate = async () => ({ output: "still just prose about finance" });
    await assert.rejects(
      () => resolveCandidates(node, { output: "nope" }, retryDelegate, { maxRetries: 2 }),
      /produced no valid structured branch selection/,
    );
  });

  await t.test("resolveCandidates supports selecting multiple candidates for a parallel node", async () => {
    const node = normalizeNode({ id: "a", candidates: ["finance", "shipping", "legal"] });
    const picked = await resolveCandidates(node, { output: "", toolEvents: [{ name: "select_branch", args: { selected: ["finance", "legal"] } }] }, async () => {
      throw new Error("no retry expected");
    });
    assert.deepEqual(picked, ["finance", "legal"]);
  });

  await t.test("routingInstruction names the tool and forbids a prose-only answer", () => {
    const text = routingInstruction([{ id: "finance", description: "money" }, { id: "shipping" }], true);
    assert.match(text, /select_branch/);
    assert.match(text, /finance — money/);
    assert.match(text, /prose/i);
  });

  // -------------------------------------------------------------------------
  // Option A propagation (FR-031)
  // -------------------------------------------------------------------------

  const OPTION_A_STEPS = [
    { id: "classify", candidates: [{ id: "alarm" }, { id: "quiet" }] },
    { id: "render", dependencies: ["classify"] }, // SHARED step — not a candidate
    { id: "alarm", dependencies: ["render"] },
    { id: "quiet", dependencies: ["render"] },
  ];

  await t.test("buildCandidateIndex gates ONLY declared candidate leaves", () => {
    const { gatedBy, candidatesOf } = buildCandidateIndex(OPTION_A_STEPS);
    assert.deepEqual(candidatesOf.get("classify"), ["alarm", "quiet"]);
    assert.deepEqual([...(gatedBy.get("alarm") || [])], ["classify"]);
    assert.equal(gatedBy.has("render"), false, "a shared step must never be gated by a selection");
  });

  await t.test("a shared step is allowed regardless of the selection; leaves follow it", () => {
    const { gatedBy } = buildCandidateIndex(OPTION_A_STEPS);
    const selected = new Map();
    assert.equal(selectionAllows("render", gatedBy, selected), true, "render runs on its own dependencies alone");
    assert.equal(selectionAllows("alarm", gatedBy, selected), false, "no selection yet → leaf stays gated");

    selected.set("classify", ["alarm"]);
    assert.equal(selectionAllows("render", gatedBy, selected), true);
    assert.equal(selectionAllows("alarm", gatedBy, selected), true);
    assert.equal(selectionAllows("quiet", gatedBy, selected), false);
    assert.equal(selectionRejects("quiet", gatedBy, selected), true);
    assert.equal(selectionRejects("render", gatedBy, selected), false);
  });
});
