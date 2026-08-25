"use strict";

const { test, describe, beforeEach, afterEach } = require("node:test");
const assert = require("node:assert/strict");
const fs = require("fs");
const os = require("os");
const path = require("path");

// pipeline.js's real collaborators (state, dedupe, graphiti, the upload
// source's VFS bridge) are swapped for scripted stubs via require.cache, the
// same pattern used in tests/sources-drive.test.js — this exercises the
// REAL orchestration logic (acquire -> extract -> chunk -> dedupe ->
// add_episode -> journal update) end to end, without a live BOS server or a
// live Graphiti deployment.

let tmpDir;
let state;
let pipeline;
let graphitiCalls;
let verifyCalls;

function stubModule(relativePath, exportsObj) {
  const resolved = require.resolve(relativePath);
  require.cache[resolved] = { id: resolved, filename: resolved, loaded: true, exports: exportsObj };
}

function clearCache(relativePaths) {
  for (const p of relativePaths) delete require.cache[require.resolve(p)];
}

function setup({ graphitiFails, verifyLands = true, folderTree } = {}) {
  clearCache([
    "../lib/state",
    "../lib/dedupe",
    "../lib/graphiti",
    "../lib/http-bridge",
    "../lib/pipeline",
    "../lib/sources/upload",
    "../lib/sources/folder",
  ]);

  state = require("../lib/state");
  state.init(tmpDir);

  stubModule("../lib/http-bridge", {
    vfsStat: async () => ({ status: 200, body: { entry: { size: 42, modified: Date.now() } } }),
    // Content varies by path — the folder-source tests below read multiple
    // distinct files in the same KB, and identical content across them would
    // dedupe (FR-008) into a single add_episode call, hiding the very thing
    // those tests check (every file gets its own episode).
    vfsReadBytes: async (p) => Buffer.from(`# Architecture\n\nThe pipeline extracts, chunks, and pushes episodes (${p}).`),
    // Only exercised by the folder-source tests below — a flat single-level
    // tree keyed by VFS path, mirroring the shape /api/fs?op=list returns.
    vfsList: async (p) => ({ status: 200, body: { entries: (folderTree && folderTree[p]) || [] } }),
  });

  graphitiCalls = [];
  verifyCalls = [];
  stubModule("../lib/graphiti", {
    addEpisode: async (args) => {
      graphitiCalls.push(args);
      if (graphitiFails) throw new Error("connect ECONNREFUSED 127.0.0.1:8020");
      return { message: "queued" };
    },
    // Real graphiti.js polls get_episodes until an episode matching the name
    // it just queued shows up (add_memory is fire-and-forget and never
    // returns an id) and reports back the uuid Graphiti itself assigned —
    // `verifyLands` controls whether that poll ever finds a match, so tests
    // can exercise both "queued and verified" and "queued but the episode
    // never actually landed" without waiting out a real poll loop.
    waitForEpisode: async (args) => {
      verifyCalls.push(args);
      return verifyLands
        ? { landed: true, uuid: `ep_${graphitiCalls.length}`, attempts: 1, elapsedMs: 5 }
        : { landed: false, uuid: null, attempts: 3, elapsedMs: 15 };
    },
    getEpisodes: async () => [],
    deleteEpisode: async () => undefined,
    clearGraph: async () => undefined,
    getStatus: async () => ({ ok: true }),
    currentEndpoint: () => "http://fake/mcp",
    // pipeline.js's verifyTimeoutMs() reads this to compute the (possibly
    // concurrency-scaled) timeoutMs it passes to waitForEpisode — 300000
    // matches graphiti.js's own DEFAULT_VERIFY_TIMEOUT_MS (038 round 3).
    currentVerifyTimeoutMs: () => 300000,
  });

  pipeline = require("../lib/pipeline");
}

beforeEach(() => {
  tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "kb-pipeline-test-"));
});

afterEach(() => {
  fs.rmSync(tmpDir, { recursive: true, force: true });
});

function waitForCallCount(count, timeoutMs = 2000) {
  const deadline = Date.now() + timeoutMs;
  return new Promise((resolve, reject) => {
    const tick = () => {
      if (graphitiCalls.length >= count) return resolve();
      if (Date.now() > deadline) return reject(new Error(`timed out waiting for ${count} graphiti calls, got ${graphitiCalls.length}`));
      setTimeout(tick, 10);
    };
    tick();
  });
}

// `sinceUpdatedAt`, when given, additionally requires the matched row to be
// newer than a previously-observed updatedAt — needed when polling for the
// *second* of two back-to-back runs on the same source, since a fast run can
// otherwise still be reading the first run's already-terminal status.
function waitForStatus(sourceId, statuses, timeoutMs = 2000, sinceUpdatedAt) {
  const deadline = Date.now() + timeoutMs;
  return new Promise((resolve, reject) => {
    const tick = () => {
      const source = state.getSource(sourceId);
      if (source && statuses.includes(source.status) && (!sinceUpdatedAt || source.updatedAt !== sinceUpdatedAt)) return resolve(source);
      if (Date.now() > deadline) return reject(new Error(`timed out waiting for status in [${statuses}], got "${source && source.status}"`));
      setTimeout(tick, 10);
    };
    tick();
  });
}

describe("pipeline — upload source, happy path", () => {
  test("indexes the file and records episodes", async () => {
    setup();
    const kb = await state.createKb({ name: "Docs" });
    const source = await state.createSource({ kbId: kb.id, type: "upload", name: "architecture.md", reference: "/architecture.md" });

    pipeline.enqueue(source.id);
    const finished = await waitForStatus(source.id, ["indexed", "failed"]);

    assert.equal(finished.status, "indexed");
    assert.equal(finished.stats.episodes, 1);
    assert.equal(graphitiCalls.length, 1);
    assert.equal(graphitiCalls[0].name, "architecture.md");
    // Regression check: add_memory's `source` must be a Graphiti-recognized
    // value ('text'/'json'/'message' per its live inputSchema), never the BOS
    // source.type ("upload") — passing "upload" made the live server warn
    // "Unknown source type 'upload', using 'text' as default" and then fail
    // the episode with "node ... not found".
    assert.equal(graphitiCalls[0].source, "text");
    // 038 round 3: pipeline must pass the configured verify timeout through
    // to waitForEpisode rather than relying on graphiti.js's own internal
    // default — with a single job in flight (no concurrency scaling), this
    // is exactly graphiti.currentVerifyTimeoutMs()'s stubbed value.
    assert.equal(verifyCalls.length, 1);
    assert.equal(verifyCalls[0].timeoutMs, 300000);
  });

  test("re-ingesting identical content is a no-op via dedupe (idempotent, FR-008)", async () => {
    setup();
    const kb = await state.createKb({ name: "Docs" });
    const source = await state.createSource({ kbId: kb.id, type: "upload", name: "architecture.md", reference: "/architecture.md" });
    pipeline.enqueue(source.id);
    await waitForStatus(source.id, ["indexed", "failed"]);
    assert.equal(graphitiCalls.length, 1);

    // Re-run the exact same source (same bytes, same content hash).
    pipeline.enqueue(source.id);
    await new Promise((r) => setTimeout(r, 200));
    assert.equal(graphitiCalls.length, 1, "add_episode should not be called again for identical content");
  });
});

describe("pipeline — folder source, happy path (038 addition)", () => {
  test("recursively indexes every file under the VFS folder", async () => {
    const folderTree = {
      "/KnowledgeBase/kb1/docs": [
        { name: "sub", path: "/KnowledgeBase/kb1/docs/sub", type: "dir", size: 0, modified: 0 },
        { name: "a.md", path: "/KnowledgeBase/kb1/docs/a.md", type: "file", size: 10, modified: Date.now() },
      ],
      "/KnowledgeBase/kb1/docs/sub": [
        { name: "b.md", path: "/KnowledgeBase/kb1/docs/sub/b.md", type: "file", size: 10, modified: Date.now() },
      ],
    };
    setup({ folderTree });
    const kb = await state.createKb({ name: "Docs" });
    const source = await state.createSource({ kbId: kb.id, type: "folder", name: "docs", reference: "/KnowledgeBase/kb1/docs" });

    pipeline.enqueue(source.id);
    const finished = await waitForStatus(source.id, ["indexed", "failed"]);

    assert.equal(finished.status, "indexed");
    assert.equal(finished.stats.episodes, 2);
    assert.equal(finished.stats.itemsTotal, 2);
    assert.equal(graphitiCalls.length, 2);
    assert.deepEqual(graphitiCalls.map((c) => c.name).sort(), ["a.md", "sub/b.md"]);
  });

  test("de-indexes files that disappeared from the folder on refresh (FR-010)", async () => {
    const folderTree = {
      "/root": [
        { name: "a.md", path: "/root/a.md", type: "file", size: 10, modified: Date.now() },
        { name: "b.md", path: "/root/b.md", type: "file", size: 10, modified: Date.now() },
      ],
    };
    setup({ folderTree });
    const kb = await state.createKb({ name: "Docs" });
    const source = await state.createSource({ kbId: kb.id, type: "folder", name: "docs", reference: "/root" });
    pipeline.enqueue(source.id);
    await waitForStatus(source.id, ["indexed", "failed"]);
    assert.equal(graphitiCalls.length, 2);

    // "b.md" removed from the folder since the last run.
    const staleUpdatedAt = state.getSource(source.id).updatedAt;
    folderTree["/root"] = [{ name: "a.md", path: "/root/a.md", type: "file", size: 10, modified: Date.now() }];
    pipeline.enqueue(source.id);
    // state.updateSource resolves through withLock's Promise chain, so this
    // run's status writes land a tick after enqueue() returns — with a tiny
    // fake folder, the whole run can finish between two 10ms polls, so
    // waiting for status alone can still observe the *previous* run's
    // already-terminal "indexed" row. Requiring updatedAt to have moved on
    // rules that out regardless of how fast either run completes.
    const finished = await waitForStatus(source.id, ["indexed", "failed"], 2000, staleUpdatedAt);
    assert.equal(finished.status, "indexed");
    assert.equal(finished.stats.itemsTotal, 1);
  });
});

describe("pipeline — episode queued but never verifiably lands", () => {
  test("a source is marked failed, not indexed, when add_memory's queued episode never shows up in get_episodes", async () => {
    setup({ verifyLands: false });
    const kb = await state.createKb({ name: "Docs" });
    const source = await state.createSource({ kbId: kb.id, type: "upload", name: "architecture.md", reference: "/architecture.md" });

    pipeline.enqueue(source.id);
    const finished = await waitForStatus(source.id, ["indexed", "failed"]);

    // This is the exact bug this feature exists to fix: add_memory's queued
    // acknowledgement is not proof the episode landed, so a source must
    // never be "indexed" on that ack alone.
    assert.equal(finished.status, "failed");
    assert.match(finished.statusMessage, /queued in Graphiti.*but wasn't confirmed landed/);
    assert.equal(finished.stats.episodes, 0);

    const events = state.listEvents(kb.id);
    assert.ok(events.some((e) => e.level === "error" && /wasn't confirmed landed/.test(e.message)));
  });

  test("an unverified episode is not registered in the dedupe hash, so retrying re-attempts add_memory", async () => {
    setup({ verifyLands: false });
    const kb = await state.createKb({ name: "Docs" });
    const source = await state.createSource({ kbId: kb.id, type: "upload", name: "architecture.md", reference: "/architecture.md" });

    pipeline.enqueue(source.id);
    await waitForStatus(source.id, ["failed"]);
    assert.equal(graphitiCalls.length, 1);

    await pipeline.retry(source.id);
    await waitForCallCount(2, 2000);
    assert.equal(graphitiCalls.length, 2, "retry must call add_memory again — an unverified episode must not be treated as already-indexed content");
  });
});

describe("pipeline — Graphiti unavailable", () => {
  test("an upload source fails with an actionable message instead of hanging", async () => {
    setup({ graphitiFails: true });
    const kb = await state.createKb({ name: "Docs" });
    const source = await state.createSource({ kbId: kb.id, type: "upload", name: "architecture.md", reference: "/architecture.md" });

    pipeline.enqueue(source.id);
    const finished = await waitForStatus(source.id, ["indexed", "failed"]);

    assert.equal(finished.status, "failed");
    assert.match(finished.statusMessage, /Graphiti unavailable/);

    const events = state.listEvents(kb.id);
    assert.ok(events.some((e) => e.level === "error" && /failed to extract/.test(e.title)));
  });

  test("other sources in the same KB are unaffected by one source's failure", async () => {
    setup({ graphitiFails: true });
    const kb = await state.createKb({ name: "Docs" });
    const failing = await state.createSource({ kbId: kb.id, type: "upload", name: "a.md", reference: "/a.md" });
    await waitForStatus(failing.id, ["pending"], 100).catch(() => undefined); // let it start below

    pipeline.enqueue(failing.id);
    await waitForStatus(failing.id, ["failed"]);

    // A second source created after the failure is unaffected — its own
    // status is independent, proving the queue didn't wedge on the failure.
    stubModule("../lib/graphiti", {
      addEpisode: async () => ({ message: "queued" }),
      waitForEpisode: async () => ({ landed: true, uuid: "ep_ok", attempts: 1, elapsedMs: 5 }),
      getEpisodes: async () => [],
      deleteEpisode: async () => undefined,
      clearGraph: async () => undefined,
      getStatus: async () => ({ ok: true }),
      currentEndpoint: () => "http://fake/mcp",
      currentVerifyTimeoutMs: () => 300000,
    });
    delete require.cache[require.resolve("../lib/pipeline")];
    pipeline = require("../lib/pipeline");
    const healthy = await state.createSource({ kbId: kb.id, type: "upload", name: "b.md", reference: "/b.md" });
    pipeline.enqueue(healthy.id);
    const finished = await waitForStatus(healthy.id, ["indexed", "failed"]);
    assert.equal(finished.status, "indexed");
  });
});
