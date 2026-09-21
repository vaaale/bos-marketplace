"use strict";
// Heartbeat liveness + visibility wiring (FR-010 / NFR-002).
//
// The CNBC spot-quote heartbeat is the pipeline's liveness signal, and its ONE
// failure mode was a silent null: pipelineAlive:false with no cause in
// /api/health. That is the exact no-cause-failure class the other fixes closed
// (Fix A: "not configured" vs "key rejected"; the promote data-loss warning).
//
// These drive the REAL scheduler (startScheduler) against a STUBBED cnbc
// adapter (no network) and assert the heartbeat propagates a VISIBLE outcome:
//   success -> pipelineAlive true,  lastHeartbeat set,    lastHeartbeatError null
//   failure -> pipelineAlive false, lastHeartbeat stays null, lastHeartbeatError carries the cause
//   /api/health surfaces lastHeartbeatError so a dead heartbeat can't be mistaken
//   for a live-but-quiet one.
//
// The cnbc adapter is stubbed via require.cache BEFORE the scheduler is loaded
// (the scheduler captures the adapter reference at module load). A recent
// manifest is written so startScheduler's catch-up path (which would hit the
// network) is skipped. No wall-clock values are asserted.
//
// Run with: node --test services/tests/scheduler.test.js

const test = require("node:test");
const assert = require("node:assert/strict");
const os = require("node:os");
const fs = require("node:fs");
const path = require("node:path");

const configMod = require("../src/config/config.js");

// ---- stub cnbc BEFORE requiring the scheduler (it captures the ref at load) ----
const cnbcPath = require.resolve("../src/providers/cnbc.js");
const cnbcStub = {
  id: "cnbc",
  lastError: null,
  next: null, // what fetchSpot returns
  nextError: null, // what fetchSpot records as lastError
  calls: 0,
  fetchSpot() {
    this.calls += 1;
    this.lastError = this.nextError;
    return Promise.resolve(this.next);
  }
};
require.cache[cnbcPath] = { id: cnbcPath, filename: cnbcPath, loaded: true, exports: cnbcStub };

const { startScheduler } = require("../src/pipeline/scheduler.js");
const { buildHealth } = require("../src/http/server.js");

// Minimal registry — only chainFor is used (buildHealth's display gate).
const FAKE_REGISTRY = {
  adapters: {
    nasdaq: { id: "nasdaq", requiresKey: false },
    twelvedata: { id: "twelvedata", requiresKey: true },
    cnbc: { id: "cnbc", requiresKey: false }
  },
  chainFor(inst) {
    const ids =
      Array.isArray(inst.providerIds) && inst.providerIds.length
        ? inst.providerIds
        : inst.provider === "both"
          ? ["nasdaq", "twelvedata"]
          : inst.provider === "fallback"
            ? ["twelvedata"]
            : ["nasdaq"];
    return ids.map((id) => this.adapters[id]).filter(Boolean);
  }
};

function tmpDataDir() {
  const d = fs.mkdtempSync(path.join(os.tmpdir(), "ftm-sched-"));
  // A recent lastFullRefresh -> no catch-up refresh (which would hit the network).
  const now = new Date().toISOString();
  configMod.writeManifest(d, {
    schemaVersion: 1,
    createdAt: now,
    lastFullRefresh: now,
    universeHash: null,
    backfillDone: true,
    creditsUsedToday: 0,
    creditsDate: now.slice(0, 10),
    lastOkFetch: {}
  });
  return d;
}

// Drain the microtask queue so the fire-and-forget first heartbeat settles.
async function tick() {
  await new Promise((r) => setTimeout(r, 0));
}

function startWith(d) {
  cnbcStub.calls = 0; // shared stub across tests in one process — reset per test
  const ctx = {
    dataDir: d,
    registry: FAKE_REGISTRY,
    state: { pipelineAlive: false, lastHeartbeat: null, lastHeartbeatError: null },
    log: () => {}
  };
  const sched = startScheduler(ctx);
  return { ctx, sched };
}

test("heartbeat success -> pipelineAlive true, lastHeartbeat set, lastHeartbeatError null", async () => {
  const d = tmpDataDir();
  cnbcStub.next = { last: 29644.167, currency: "USD", time: Date.parse("2026-09-18") };
  cnbcStub.nextError = null;
  const { ctx, sched } = startWith(d);
  await tick();
  try {
    assert.equal(cnbcStub.calls, 1, "the immediate first heartbeat must fire");
    assert.equal(ctx.state.pipelineAlive, true, "a good spot marks the pipeline alive");
    assert.ok(ctx.state.lastHeartbeat, "lastHeartbeat must be a real timestamp");
    assert.equal(ctx.state.lastHeartbeatError, null, "a success clears any prior error");
  } finally {
    sched.stop();
  }
});

test("heartbeat failure -> pipelineAlive false, lastHeartbeat stays null, lastHeartbeatError carries the cause", async () => {
  const d = tmpDataDir();
  cnbcStub.next = null;
  cnbcStub.nextError = "no quote for NDX (empty or unexpected response)";
  const { ctx, sched } = startWith(d);
  await tick();
  try {
    assert.equal(cnbcStub.calls, 1);
    assert.equal(ctx.state.pipelineAlive, false);
    assert.equal(ctx.state.lastHeartbeat, null, "a failed heartbeat must NOT stamp lastHeartbeat");
    assert.equal(
      ctx.state.lastHeartbeatError,
      "no quote for NDX (empty or unexpected response)",
      "the failure cause must be visible, not swallowed"
    );
  } finally {
    sched.stop();
  }
});

test("/api/health surfaces lastHeartbeatError so a dead heartbeat is not mistaken for live", async () => {
  const d = tmpDataDir();
  cnbcStub.next = null;
  cnbcStub.nextError = "no quote for NDX (empty or unexpected response)";
  const { ctx, sched } = startWith(d);
  await tick();
  try {
    const health = buildHealth(ctx);
    assert.equal(health.pipelineAlive, false);
    assert.equal(
      health.lastHeartbeatError,
      "no quote for NDX (empty or unexpected response)",
      "the health endpoint must expose the heartbeat failure cause"
    );
  } finally {
    sched.stop();
  }
});
