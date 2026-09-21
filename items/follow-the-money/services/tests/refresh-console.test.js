"use strict";
// Refresh Console — per-attempt refresh event log (observability layer).
//
// Motivation: every defect this item shipped was a SILENT state (no error, no
// visibility into what the refresh actually did). These tests pin the contract:
//   (a) status mapping — each ProviderError code -> exact detail string
//   (b) seq / ?since semantics — tail returns only events after N, counts whole-run
//   (c) the in-memory ring is bounded at 200
//   (d) ?since= with no refresh yet returns empty events, not an error
//   (e) NFR-009 — the key value/prefix is NEVER echoed into an event
//
// Each test references code that does not exist pre-fix (classifyProviderFailure,
// createRefreshBuffer, getBuffer, the /api/refresh/log endpoint), so all fail
// before the implementation lands.
//
// The retry/backoff path is exercised with an instant sleep seam
// (_setSleepForTests) so the 5 s × 2^n backoff doesn't slow the suite — this
// file runs in its own process, so the override is isolated from other tests.

const test = require("node:test");
const assert = require("node:assert/strict");
const os = require("node:os");
const fs = require("node:fs");
const path = require("node:path");

const { ProviderError } = require("../src/providers/http.js");
const configMod = require("../src/config/config.js");
const {
  doRefresh,
  classifyProviderFailure,
  classifyAttempt,
  getBuffer,
  _setSleepForTests
} = require("../src/pipeline/refresh.js");
const { createRefreshBuffer } = require("../src/storage/refreshbuffer.js");
const { createServer } = require("../src/http/server.js");

// Instant backoff for the whole file (isolated process).
_setSleepForTests(() => Promise.resolve());

function makeBars(n) {
  const out = [];
  for (let i = 0; i < n; i++) {
    const d = new Date(Date.UTC(2026, 0, 1));
    d.setUTCDate(d.getUTCDate() + i);
    const close = 100 + (i % 5);
    out.push({
      date: d.toISOString().slice(0, 10),
      open: close,
      high: close + 1,
      low: close - 1,
      close,
      volume: 1e6,
      currency: "NOK"
    });
  }
  return out;
}

function tmpDataDir() {
  return fs.mkdtempSync(path.join(os.tmpdir(), "ftm-rc-"));
}

// ---- (a) status mapping: each ProviderError code -> exact detail string ----

test("(a) classifyProviderFailure maps every code to its exact detail string", () => {
  assert.deepEqual(classifyProviderFailure("INVALID_KEY", "whatever"), {
    status: "error",
    detail: "key rejected (401) — re-enter/rotate"
  });
  assert.deepEqual(classifyProviderFailure("NOT_FOUND", "HTTP 404"), {
    status: "error",
    detail: "not found on provider"
  });
  assert.deepEqual(classifyProviderFailure("TIMEOUT", "took 10s"), {
    status: "error",
    detail: "timeout / transient"
  });
  assert.deepEqual(classifyProviderFailure("TRANSIENT", "HTTP 503"), {
    status: "error",
    detail: "timeout / transient"
  });
  assert.deepEqual(classifyProviderFailure("RATE_LIMITED", "HTTP 429"), {
    status: "retry",
    detail: "rate-limited → retry"
  });
  assert.deepEqual(classifyProviderFailure("NO_KEY", "no key"), {
    status: "skip",
    detail: "awaiting data source"
  });
  // "other -> short cause string"
  assert.deepEqual(classifyProviderFailure("UNKNOWN", "boom"), { status: "error", detail: "boom" });
  assert.deepEqual(classifyProviderFailure("SOMETHING_ELSE", null), {
    status: "error",
    detail: "SOMETHING_ELSE"
  });
});

test("(a) classifyAttempt: retry vs error for a transient that will / won't retry", () => {
  // a transient that WILL be retried is a "retry" line
  assert.deepEqual(classifyAttempt("TRANSIENT", "boom", true), {
    status: "retry",
    detail: "timeout / transient"
  });
  // the same code on the terminal attempt is the "timeout / transient" error
  assert.deepEqual(classifyAttempt("TRANSIENT", "boom", false), {
    status: "error",
    detail: "timeout / transient"
  });
  // RATE_LIMITED is always a retry line (retry-class, never error)
  assert.equal(classifyAttempt("RATE_LIMITED", "429", true).status, "retry");
  assert.equal(classifyAttempt("RATE_LIMITED", "429", false).status, "retry");
  assert.equal(classifyAttempt("RATE_LIMITED", "429", false).detail, "rate-limited → retry");
  // non-retry codes pass straight through
  assert.deepEqual(classifyAttempt("INVALID_KEY", "x", true), classifyProviderFailure("INVALID_KEY", "x"));
});

// ---- (b) seq / since semantics + (c) ring bounded at 200 (buffer unit) ----

test("(b) seq is monotonic within a refresh and ?since=N tails only newer events", () => {
  const buf = createRefreshBuffer();
  buf.reset("r1", new Date().toISOString());
  // 2 ok, 3 issues
  buf.push({ symbol: "A", name: "A", provider: "nasdaq", status: "ok", detail: "ok" });
  buf.push({ symbol: "B", name: "B", provider: "nasdaq", status: "error", detail: "timeout / transient" });
  buf.push({ symbol: "C", name: "C", provider: "twelvedata", status: "retry", detail: "rate-limited → retry" });
  buf.push({ symbol: "D", name: "D", provider: "twelvedata", status: "ok", detail: "ok" });
  buf.push({ symbol: "E", name: "E", provider: "twelvedata", status: "skip", detail: "awaiting data source" });

  const all = buf.snapshot();
  assert.deepEqual(all.events.map((e) => e.seq), [1, 2, 3, 4, 5]);
  assert.equal(all.okCount, 2); // A, D
  assert.equal(all.issueCount, 3); // B, C, E

  // since=3 -> only seq 4,5 (the new tail); counts still describe the whole run
  const tail = buf.snapshot(3);
  assert.deepEqual(tail.events.map((e) => e.seq), [4, 5]);
  assert.equal(tail.okCount, 2);
  assert.equal(tail.issueCount, 3);

  // since=0 -> whole ring; since=last -> empty
  assert.equal(buf.snapshot(0).events.length, 5);
  assert.equal(buf.snapshot(5).events.length, 0);

  // a new refresh resets seq to 1 and clears the ring
  buf.reset("r2", new Date().toISOString());
  buf.push({ symbol: "A", name: "A", provider: "nasdaq", status: "ok", detail: "ok" });
  const r2 = buf.snapshot();
  assert.equal(r2.refreshId, "r2");
  assert.deepEqual(r2.events.map((e) => e.seq), [1]);
  assert.equal(r2.okCount, 1);
  assert.equal(r2.issueCount, 0);
});

test("(c) the ring is bounded at 200 (oldest events drop off, counts follow the ring)", () => {
  const buf = createRefreshBuffer();
  buf.reset("r1", new Date().toISOString());
  const TOTAL = 250;
  for (let i = 1; i <= TOTAL; i++) {
    // even seqs ok, odd seqs error
    buf.push({ symbol: "S" + i, name: "S" + i, provider: "nasdaq", status: i % 2 === 0 ? "ok" : "error", detail: i % 2 === 0 ? "ok" : "timeout / transient" });
  }
  const snap = buf.snapshot();
  assert.equal(snap.events.length, 200);
  assert.equal(snap.events[0].seq, TOTAL - 199); // 51
  assert.equal(snap.events[snap.events.length - 1].seq, TOTAL); // 250
  // counts reflect the 200 in the ring, not the 250 pushed
  assert.equal(snap.okCount + snap.issueCount, 200);
  assert.equal(snap.okCount, 100); // even seqs 52..250
  assert.equal(snap.issueCount, 100);
});

// ---- (d) ?since= with no refresh yet -> empty events, not an error ----

function makeCtx(dataDir, registry, state) {
  return { dataDir, registry, state: state || { refreshing: false }, log: () => {} };
}

test("(d) GET /api/refresh/log with no refresh yet returns 200 + empty events (not an error)", async () => {
  const d = tmpDataDir();
  const { createRegistry } = require("../src/providers/registry.js");
  const ctx = makeCtx(d, createRegistry({}));
  const server = createServer(ctx);
  await new Promise((r) => server.listen(0, "127.0.0.1", r));
  const port = server.address().port;
  try {
    for (const qs of ["", "?since=0", "?since=5", "?since=notanumber"]) {
      const res = await fetch(`http://127.0.0.1:${port}/api/refresh/log${qs}`);
      assert.equal(res.status, 200, "no-refresh log must be 200, not an error (" + qs + ")");
      const body = await res.json();
      assert.deepEqual(body.events, []);
      assert.equal(body.okCount, 0);
      assert.equal(body.issueCount, 0);
      assert.equal(body.inProgress, false);
      assert.equal(body.refreshId, null);
    }
  } finally {
    await new Promise((r) => server.close(r));
  }
});

// ---- (e) NFR-009: the key value/prefix is never echoed into an event ----

test("(e) NFR-009: a 401 event's detail is the fixed string and never echoes the key (value or prefix)", async () => {
  const d = tmpDataDir();
  const KEY = "sk-live-supersecretkey-0123456789abcdef";
  configMod.setKey(d, "twelvedata", KEY);

  // A hostile provider that ECHOES the key in its 401 error body — the exact
  // condition NFR-009 guards against. The pipeline must still emit the fixed
  // detail string and never leak the key.
  const twelvedata = {
    id: "twelvedata",
    requiresKey: true,
    async fetchDaily() {
      throw new ProviderError("INVALID_KEY", false, { cause: "provider rejected key: " + KEY });
    }
  };
  const nasdaq = { id: "nasdaq", requiresKey: false, async fetchDaily() { return makeBars(140); } };
  const registry = {
    adapters: { nasdaq, twelvedata },
    chainFor(inst) {
      const ids = Array.isArray(inst.providerIds) && inst.providerIds.length ? inst.providerIds : inst.provider === "fallback" ? ["twelvedata"] : inst.provider === "both" ? ["nasdaq", "twelvedata"] : ["nasdaq"];
      return ids.map((id) => this.adapters[id]).filter(Boolean);
    },
    paced(id, fn) {
      return fn();
    }
  };

  const ctx = makeCtx(d, registry);
  await doRefresh(ctx, "Norway", "nfr-test");

  const events = getBuffer(ctx).snapshot().events;
  const keyEvents = events.filter((e) => e.detail === "key rejected (401) — re-enter/rotate");
  assert.ok(keyEvents.length >= 1, "expected at least one 401 event with the fixed detail string");
  assert.equal(keyEvents[0].status, "error");
  assert.equal(keyEvents[0].keyed, true, "a key-gated symbol carries the keyed flag");

  // The key value AND its prefix must not appear ANYWHERE in any event.
  const serialized = JSON.stringify(events);
  assert.ok(!serialized.includes(KEY), "event log must not contain the key value");
  assert.ok(!serialized.includes(KEY.slice(0, 4)), "event log must not contain the key prefix");
  assert.ok(!serialized.includes(KEY.slice(0, 10)), "event log must not contain a longer key prefix");
});

// ---- integration: the emitters fire through the real per-symbol chain walk ----

function makeBehaviorRegistry(spec) {
  // spec: symbol -> outcome | [outcome, outcome, ...] (one per attempt)
  const counters = {};
  function outcomeFor(symbol, callIdx) {
    const s = spec[symbol];
    if (s === undefined) return "ok";
    const list = Array.isArray(s) ? s : [s];
    return list[Math.min(callIdx, list.length - 1)];
  }
  function throwFor(o) {
    if (o === "invalid_key") throw new ProviderError("INVALID_KEY", false, { cause: "HTTP 401" });
    if (o === "not_found") throw new ProviderError("NOT_FOUND", false, { cause: "HTTP 404" });
    if (o === "rate_limited") throw new ProviderError("RATE_LIMITED", true, { cause: "HTTP 429" });
    if (o === "transient") throw new ProviderError("TRANSIENT", true, { cause: "boom" });
    return null; // ok
  }
  function fetchDaily(inst) {
    const i = (counters[inst.symbol] = (counters[inst.symbol] || 0) + 1);
    const t = throwFor(outcomeFor(inst.symbol, i - 1));
    if (t) throw t;
    return makeBars(140);
  }
  const twelvedata = { id: "twelvedata", requiresKey: true, fetchDaily };
  const nasdaq = { id: "nasdaq", requiresKey: false, fetchDaily };
  return {
    adapters: { nasdaq, twelvedata },
    chainFor(inst) {
      const ids = Array.isArray(inst.providerIds) && inst.providerIds.length ? inst.providerIds : inst.provider === "fallback" ? ["twelvedata"] : inst.provider === "both" ? ["nasdaq", "twelvedata"] : ["nasdaq"];
      return ids.map((id) => this.adapters[id]).filter(Boolean);
    },
    paced(id, fn) {
      return fn();
    }
  };
}

async function runRefresh(dataDir, spec, keyConfigured) {
  const registry = makeBehaviorRegistry(spec);
  if (keyConfigured) configMod.setKey(dataDir, "twelvedata", "TEST_KEY_DO_NOT_LEAK");
  const ctx = makeCtx(dataDir, registry);
  await doRefresh(ctx, "Norway", "itest");
  return getBuffer(ctx).snapshot().events;
}

test("integration: ok / Fix-A invalid_key / not_found each emit the right status + detail", async () => {
  const d = tmpDataDir();
  const events = await runRefresh(d, { "^OBX": "ok", "EQNR.OL": "invalid_key", "DNB.OL": "not_found" }, true);
  const bySym = (s) => events.filter((e) => e.symbol === s);

  const okE = bySym("^OBX");
  assert.equal(okE.length, 1);
  assert.equal(okE[0].status, "ok");
  assert.equal(okE[0].detail, "ok");
  assert.equal(okE[0].probeEnabled, true, "a first-successful keyed probe carries probeEnabled (app shows 'probe → enabled')");
  assert.equal(okE[0].keyed, true);
  assert.equal(okE[0].provider, "twelvedata");

  const ikE = bySym("EQNR.OL");
  assert.equal(ikE.length, 1);
  assert.equal(ikE[0].status, "error");
  assert.equal(ikE[0].detail, "key rejected (401) — re-enter/rotate");

  const nfE = bySym("DNB.OL");
  assert.equal(nfE.length, 1);
  assert.equal(nfE[0].status, "error");
  assert.equal(nfE[0].detail, "not found on provider");
});

test("integration: a rate-limited-then-successful symbol emits a retry line then an ok line", async () => {
  const d = tmpDataDir();
  const events = await runRefresh(d, { "^OBX": ["rate_limited", "ok"], "EQNR.OL": "ok", "DNB.OL": "ok" }, true);
  const obx = events.filter((e) => e.symbol === "^OBX");
  assert.deepEqual(
    obx.map((e) => e.status),
    ["retry", "ok"],
    "one event per attempt: rate-limited -> retry, then success -> ok"
  );
  assert.equal(obx[0].detail, "rate-limited → retry");
  assert.equal(obx[1].detail, "ok");
});

test("integration: a transient that exhausts retries emits retry, retry, then a terminal error", async () => {
  const d = tmpDataDir();
  const events = await runRefresh(d, { "^OBX": "transient", "EQNR.OL": "ok", "DNB.OL": "ok" }, true);
  const obx = events.filter((e) => e.symbol === "^OBX");
  assert.deepEqual(
    obx.map((e) => e.status),
    ["retry", "retry", "error"],
    "transient retries are 'retry' lines; the final attempt is the 'timeout / transient' error"
  );
  assert.ok(obx.every((e) => e.detail === "timeout / transient"));
});

test("integration: a credit-exhausted keyed symbol emits a deferred line", async () => {
  const d = tmpDataDir();
  // budget 0 -> the first twelvedata fetch is deferred (no credits available)
  const user = configMod.readUserConfig(d);
  user.thresholds = Object.assign({}, user.thresholds, { dailyCreditBudget: 0 });
  configMod.writeUserConfig(d, user);
  configMod.setKey(d, "twelvedata", "TEST_KEY_DO_NOT_LEAK");

  const events = await runRefresh(d, { "^OBX": "ok", "EQNR.OL": "ok", "DNB.OL": "ok" }, false); // key already set above
  const deferred = events.filter((e) => e.status === "deferred");
  assert.ok(deferred.length >= 1, "an exhausted budget defers keyed symbols");
  assert.equal(deferred[0].detail, "deferred — credit budget");
});

test("integration: a key-gated symbol with NO key configured emits a skip line", async () => {
  const d = tmpDataDir();
  // no key configured -> the 3 keyed Norway symbols are hard-gated (skip)
  const events = await runRefresh(d, { "^OBX": "ok", "EQNR.OL": "ok", "DNB.OL": "ok" }, false);
  const skips = events.filter((e) => e.status === "skip");
  assert.equal(skips.length, 3, "each key-gated no-key symbol emits a skip line");
  assert.ok(skips.every((e) => e.detail === "awaiting data source"));
  assert.ok(skips.every((e) => e.keyed === true));
  // nothing was fetched ok (no key -> no probe)
  assert.equal(events.filter((e) => e.status === "ok").length, 0);
});

test("integration: the buffer is reset on a new refresh (seq restarts at 1, ring cleared)", async () => {
  const d = tmpDataDir();
  const { startRefresh } = require("../src/pipeline/refresh.js");
  configMod.setKey(d, "twelvedata", "TEST_KEY_DO_NOT_LEAK");
  const registry = makeBehaviorRegistry({ "^OBX": "ok", "EQNR.OL": "ok", "DNB.OL": "ok" });
  const ctx = makeCtx(d, registry, { refreshing: false });

  const first = startRefresh(ctx, "Norway");
  assert.equal(first.started, true);
  await first.done; // let the first refresh finish
  const afterFirst = getBuffer(ctx).snapshot();
  assert.ok(afterFirst.events.length >= 3, "first refresh recorded events");
  const maxSeq1 = afterFirst.events[afterFirst.events.length - 1].seq;
  assert.equal(afterFirst.inProgress, false, "inProgress flips false when the refresh completes");

  const second = startRefresh(ctx, "Norway");
  assert.equal(second.started, true);
  await second.done;
  const afterSecond = getBuffer(ctx).snapshot();
  assert.notEqual(afterSecond.refreshId, afterFirst.refreshId, "each run has its own refreshId");
  assert.equal(afterSecond.events[0].seq, 1, "seq restarts at 1 on a fresh run (reset each run)");
  assert.ok(maxSeq1 >= 1);
});
