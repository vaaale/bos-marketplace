// router.test.js — dynamic routing: candidate selection + retry-loop (US7/FR-018/FR-019).

const test = require("node:test");
const assert = require("node:assert/strict");
const { parseSelection, resolveCandidates } = require("../engine/router");
const { normalizeNode } = require("../engine/node-model");

test("router.js", async (t) => {
  await t.test("parseSelection extracts a single id", () => {
    assert.deepEqual(parseSelection("Some reasoning...\nSELECT: finance", ["finance", "shipping"]), ["finance"]);
  });

  await t.test("parseSelection extracts multiple comma-separated ids", () => {
    assert.deepEqual(parseSelection("SELECT: finance, shipping", ["finance", "shipping", "other"]), ["finance", "shipping"]);
  });

  await t.test("parseSelection ignores ids not in the valid set", () => {
    assert.deepEqual(parseSelection("SELECT: finance, bogus", ["finance", "shipping"]), ["finance"]);
  });

  await t.test("parseSelection returns [] when there is no SELECT line", () => {
    assert.deepEqual(parseSelection("just some prose", ["finance"]), []);
  });

  await t.test("resolveCandidates returns null for a node with no candidates", async () => {
    const node = normalizeNode({ id: "a" });
    assert.equal(await resolveCandidates(node, "anything", async () => "unused"), null);
  });

  await t.test("resolveCandidates auto-delegates a single candidate without needing a SELECT line (FR-019)", async () => {
    const node = normalizeNode({ id: "a", candidates: ["only-child"] });
    const picked = await resolveCandidates(node, "no select line here at all", async () => {
      throw new Error("should not retry for a single candidate");
    });
    assert.deepEqual(picked, ["only-child"]);
  });

  await t.test("resolveCandidates parses a valid SELECT line on the first attempt", async () => {
    const node = normalizeNode({ id: "a", candidates: ["finance", "shipping"] });
    const picked = await resolveCandidates(node, "reasoning...\nSELECT: shipping", async () => {
      throw new Error("should not need a retry");
    });
    assert.deepEqual(picked, ["shipping"]);
  });

  await t.test("resolveCandidates retries on an invalid/missing selection, then succeeds", async () => {
    const node = normalizeNode({ id: "a", candidates: ["finance", "shipping"] });
    let calls = 0;
    const retryDelegate = async () => {
      calls++;
      return "SELECT: finance";
    };
    const picked = await resolveCandidates(node, "no selection the first time", retryDelegate);
    assert.deepEqual(picked, ["finance"]);
    assert.equal(calls, 1);
  });

  await t.test("resolveCandidates throws after exhausting retries on a persistently invalid selection", async () => {
    const node = normalizeNode({ id: "a", candidates: ["finance", "shipping"] });
    const retryDelegate = async () => "still no valid select line";
    await assert.rejects(() => resolveCandidates(node, "nope", retryDelegate, { maxRetries: 2 }), /failed to select a valid candidate/);
  });

  await t.test("resolveCandidates supports selecting multiple candidates for a parallel node", async () => {
    const node = normalizeNode({ id: "a", candidates: ["finance", "shipping", "legal"] });
    const picked = await resolveCandidates(node, "SELECT: finance, legal", async () => {
      throw new Error("no retry expected");
    });
    assert.deepEqual(picked, ["finance", "legal"]);
  });
});
