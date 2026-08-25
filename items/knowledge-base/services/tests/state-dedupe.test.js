"use strict";

const { test, describe, beforeEach, afterEach } = require("node:test");
const assert = require("node:assert/strict");
const fs = require("fs");
const os = require("os");
const path = require("path");

// state.js is a singleton module keyed by its own module-level `dataDir` —
// re-require fresh (bypassing require's cache) per test so each test gets an
// isolated temp directory instead of sharing state across the suite.
function freshState() {
  const modulePath = require.resolve("../lib/state");
  delete require.cache[modulePath];
  return require(modulePath);
}
function freshDedupe(state) {
  const modulePath = require.resolve("../lib/dedupe");
  delete require.cache[modulePath];
  // dedupe.js requires state.js internally by path, which resolves to the
  // SAME cache entry we just refreshed above (already re-required), so this
  // picks up the fresh instance rather than a stale cached one.
  return require(modulePath);
}

let tmpDir;
let state;
let dedupe;

beforeEach(() => {
  tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "kb-state-test-"));
  state = freshState();
  state.init(tmpDir);
  dedupe = freshDedupe(state);
});

afterEach(() => {
  fs.rmSync(tmpDir, { recursive: true, force: true });
});

describe("state — knowledge bases", () => {
  test("create + list round-trips", async () => {
    const kb = await state.createKb({ name: "Engineering Docs", description: "desc" });
    assert.ok(kb.id.startsWith("kb_"));
    const list = state.listKbs();
    assert.equal(list.length, 1);
    assert.equal(list[0].name, "Engineering Docs");
  });

  test("kbs.json shape matches src/lib/agent/kb-catalog.ts's contract", async () => {
    await state.createKb({ name: "Docs" });
    const raw = JSON.parse(fs.readFileSync(path.join(tmpDir, "kbs.json"), "utf8"));
    assert.ok(Array.isArray(raw.kbs));
    assert.equal(typeof raw.kbs[0].id, "string");
    assert.equal(typeof raw.kbs[0].name, "string");
  });

  test("duplicate names are rejected", async () => {
    await state.createKb({ name: "Docs" });
    await assert.rejects(() => state.createKb({ name: "Docs" }), /already exists/);
  });

  test("rename persists", async () => {
    const kb = await state.createKb({ name: "Docs" });
    await state.renameKb(kb.id, { name: "Docs v2" });
    assert.equal(state.getKb(kb.id).name, "Docs v2");
  });

  test("delete removes it and its sources", async () => {
    const kb = await state.createKb({ name: "Docs" });
    await state.createSource({ kbId: kb.id, type: "upload", name: "a.txt", reference: "/a.txt" });
    await state.deleteKb(kb.id);
    assert.equal(state.getKb(kb.id), null);
  });
});

describe("state — sources", () => {
  test("create defaults to pending with empty stats", async () => {
    const kb = await state.createKb({ name: "Docs" });
    const source = await state.createSource({ kbId: kb.id, type: "upload", name: "a.txt", reference: "/a.txt" });
    assert.equal(source.status, "pending");
    assert.equal(source.stats.episodes, 0);
  });

  test("updateSource merges stats instead of replacing them", async () => {
    const kb = await state.createKb({ name: "Docs" });
    const source = await state.createSource({ kbId: kb.id, type: "upload", name: "a.txt", reference: "/a.txt" });
    await state.updateSource(source.id, { stats: { itemsTotal: 5 } });
    await state.updateSource(source.id, { stats: { itemsDone: 2 } });
    const updated = state.getSource(source.id);
    assert.equal(updated.stats.itemsTotal, 5);
    assert.equal(updated.stats.itemsDone, 2);
  });
});

describe("dedupe", () => {
  test("first occurrence is not a duplicate; re-adding the same content is", async () => {
    const kb = await state.createKb({ name: "Docs" });
    const first = dedupe.check(kb.id, "hello world");
    assert.equal(first.isDuplicate, false);
    await dedupe.register(kb.id, first.hash, "src_1", ["ep_1"]);

    const second = dedupe.check(kb.id, "hello world");
    assert.equal(second.isDuplicate, true);
    assert.deepEqual(second.existing.episodeIds, ["ep_1"]);
  });

  test("different content in the same KB is not a duplicate", async () => {
    const kb = await state.createKb({ name: "Docs" });
    await dedupe.register(kb.id, dedupe.check(kb.id, "content A").hash, "src_1", ["ep_1"]);
    assert.equal(dedupe.check(kb.id, "content B").isDuplicate, false);
  });

  test("the same content in a different KB is not a duplicate (per-KB scoping)", async () => {
    const kbA = await state.createKb({ name: "A" });
    const kbB = await state.createKb({ name: "B" });
    await dedupe.register(kbA.id, dedupe.check(kbA.id, "shared text").hash, "src_1", ["ep_1"]);
    assert.equal(dedupe.check(kbB.id, "shared text").isDuplicate, false);
  });

  test("forgetSource clears only that source's hashes", async () => {
    const kb = await state.createKb({ name: "Docs" });
    const h1 = dedupe.check(kb.id, "one").hash;
    const h2 = dedupe.check(kb.id, "two").hash;
    await dedupe.register(kb.id, h1, "src_1", ["ep_1"]);
    await dedupe.register(kb.id, h2, "src_2", ["ep_2"]);
    await dedupe.forgetSource(kb.id, "src_1");
    assert.equal(dedupe.check(kb.id, "one").isDuplicate, false);
    assert.equal(dedupe.check(kb.id, "two").isDuplicate, true);
  });
});
