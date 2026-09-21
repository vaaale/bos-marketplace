"use strict";
// Fix A + Fix B — refresh-pipeline regression tests.
//
// The incident: `http.js` mapped a rejected key (HTTP 401) to NO_KEY, and
// `refresh.js` folded every no-key/unavailable case into one silent label —
// "data source not configured". A user whose key was present but EXPIRED saw
// "not configured" and never knew to re-enter/rotate it. Meanwhile the 9 keyed
// symbols shipped enabled:false (the T10 hard gate) with no UI path to enable
// them, so they could never fetch at all.
//
// These tests drive the REAL pipeline (doRefresh) against a FAKE provider
// registry (no network, no Date.now assertion) and assert the three distinct
// outcomes the fix must produce:
//   A  present-but-rejected key  -> "key rejected — re-enter or rotate"
//   A  /api/health              -> keyed provider status "auth_error"
//   B  disabled + key + 200     -> symbol enabled, bars upserted (gate self-resolves)
//   B  disabled + key + 404     -> stays disabled, notFound:true, "ticker not found"
//   B  disabled + no key        -> skipped (no fetch), "data source not configured"
//
// Run with: node --test services/tests/refresh.test.js

const test = require("node:test");
const assert = require("node:assert/strict");
const os = require("node:os");
const fs = require("node:fs");
const path = require("node:path");

const { ProviderError } = require("../src/providers/http.js");
const configMod = require("../src/config/config.js");
const { doRefresh } = require("../src/pipeline/refresh.js");
const { readBars } = require("../src/storage/bars.js");
const { readSignal } = require("../src/storage/signals.js");
const { buildHealth } = require("../src/http/server.js");

// A deterministic daily-bar series long enough to satisfy the signal engine.
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

// Fake provider registry: each adapter's fetchDaily is a pure function of a
// per-symbol behavior map (no fetch, no network). Mirrors the real registry's
// shape (adapters, chainFor, paced) that doRefresh consumes.
function makeFakeRegistry(behavior) {
  const twelvedata = {
    id: "twelvedata",
    requiresKey: true,
    async fetchDaily(inst) {
      const b = behavior[inst.symbol] || "ok";
      if (b === "ok") return makeBars(140);
      if (b === "invalid_key") throw new ProviderError("INVALID_KEY", false, { cause: "HTTP 401" });
      if (b === "not_found") throw new ProviderError("NOT_FOUND", false, { cause: "HTTP 404" });
      throw new ProviderError("TRANSIENT", true, { cause: "boom" });
    }
  };
  const nasdaq = { id: "nasdaq", requiresKey: false, async fetchDaily() { return makeBars(140); } };
  const adapters = { nasdaq, twelvedata };
  return {
    adapters,
    chainFor(inst) {
      const ids =
        Array.isArray(inst.providerIds) && inst.providerIds.length
          ? inst.providerIds
          : inst.provider === "fallback"
            ? ["twelvedata"]
            : inst.provider === "both"
              ? ["nasdaq", "twelvedata"]
              : ["nasdaq"];
      return ids.map((id) => adapters[id]).filter(Boolean);
    },
    paced(id, fn) {
      return fn();
    }
  };
}

function tmpDataDir() {
  return fs.mkdtempSync(path.join(os.tmpdir(), "ftm-refresh-"));
}

// Norway is the region with the 3 T10-gated (disabled, keyed, fallback)
// symbols — scoping the refresh there keeps each test to a handful of symbols.
const NORWAY = ["^OBX", "EQNR.OL", "DNB.OL"];

async function runRefresh(dataDir, behavior, keyConfigured) {
  const registry = makeFakeRegistry(behavior);
  if (keyConfigured) configMod.setKey(dataDir, "twelvedata", "TEST_KEY_DO_NOT_LEAK");
  const ctx = { dataDir, registry, state: { refreshing: false } };
  await doRefresh(ctx, "Norway", "test-refresh");
  return ctx;
}

// ---- Fix A: a rejected key is labeled "key rejected", never "not configured" ----

test("Fix A: present-but-rejected key (401) -> unavailable reason 'key rejected', not 'not configured'", async () => {
  const d = tmpDataDir();
  await runRefresh(d, { "^OBX": "invalid_key", "EQNR.OL": "invalid_key", "DNB.OL": "invalid_key" }, true);

  const sig = readSignal(d, "Norway", "EQNR.OL");
  assert.equal(sig.state, "unavailable");
  assert.ok(sig.unavailableReason, "a rejected-key symbol must carry an unavailableReason");
  assert.match(sig.unavailableReason, /rejected/);
  assert.ok(!/not configured/i.test(sig.unavailableReason), "must NOT be the 'not configured' silence: " + sig.unavailableReason);
});

test("Fix A: /api/health reports the keyed provider as 'auth_error' + lastError after a rejected-key refresh", async () => {
  const d = tmpDataDir();
  const ctx = await runRefresh(d, { "^OBX": "invalid_key", "EQNR.OL": "invalid_key", "DNB.OL": "invalid_key" }, true);

  const health = buildHealth(ctx);
  const td = health.providers.find((p) => p.id === "twelvedata");
  assert.equal(td.keyConfigured, true, "the key IS configured — this is a rejection, not an absence");
  assert.equal(td.status, "auth_error", "a rejected key is auth_error, not ok/limited/off");
  assert.ok(td.lastError && /401/.test(td.lastError), "lastError surfaces the 401");

  const eqnr = health.unavailable.find((u) => u.symbol === "EQNR.OL");
  assert.ok(eqnr, "the rejected symbol is listed as unavailable");
  assert.match(eqnr.reason, /rejected/);
});

// Control: a genuinely ABSENT key still says "not configured" (the two must not blur).
test("Fix A control: an ABSENT key still labels 'data source not configured'", async () => {
  const d = tmpDataDir();
  await runRefresh(d, { "^OBX": "ok", "EQNR.OL": "ok", "DNB.OL": "ok" }, false);

  const sig = readSignal(d, "Norway", "EQNR.OL");
  assert.equal(sig.state, "unavailable");
  assert.match(sig.unavailableReason, /not configured/);
});

// ---- Fix B: the T10 gate self-resolves on the first real fetch ----

test("Fix B: disabled + key + 200 -> symbol enabled (persisted) and bars upserted", async () => {
  const d = tmpDataDir();
  await runRefresh(d, { "^OBX": "ok", "EQNR.OL": "ok", "DNB.OL": "ok" }, true);

  for (const sym of NORWAY) {
    const ov = configMod.getConfig(d).universeOverrides[sym];
    assert.equal(ov && ov.enabled, true, sym + " must be enabled after a successful probe");
    const bars = readBars(d, { region: "Norway", symbol: sym, currency: "NOK" });
    assert.ok(bars.bars.length > 0, sym + " bars must be upserted");
    const sig = readSignal(d, "Norway", sym);
    assert.notEqual(sig.state, "unavailable", sym + " must no longer be unavailable after a good fetch");
  }
});

test("Fix B: disabled + key + 404 -> stays disabled, notFound:true, 'ticker not found'", async () => {
  const d = tmpDataDir();
  await runRefresh(d, { "^OBX": "not_found", "EQNR.OL": "ok", "DNB.OL": "ok" }, true);

  const ov = configMod.getConfig(d).universeOverrides["^OBX"];
  assert.equal(ov.enabled, false, "a 404 probe must NOT enable the symbol");
  assert.equal(ov.notFound, true, "the notFound marker must be persisted");
  const sig = readSignal(d, "Norway", "^OBX");
  assert.equal(sig.state, "unavailable");
  assert.match(sig.unavailableReason, /ticker not found/);
});

test("Fix B: a permanent notFound probe is SKIPPED on the next cycle (no credit waste)", async () => {
  const d = tmpDataDir();
  const behavior = { "^OBX": "not_found", "EQNR.OL": "ok", "DNB.OL": "ok" };
  await runRefresh(d, behavior, true);
  // Second cycle: ^OBX is now notFound-marked, so it must not be re-fetched.
  let attempts = 0;
  const spyingRegistry = makeFakeRegistry(behavior);
  const realFetch = spyingRegistry.adapters.twelvedata.fetchDaily;
  spyingRegistry.adapters.twelvedata.fetchDaily = async (inst) => {
    attempts += 1;
    return realFetch.call(spyingRegistry.adapters.twelvedata, inst);
  };
  // The key persists in the data dir from the first cycle, so this is a
  // real "2nd cycle" — ^OBX (now notFound-marked) must be skipped.
  const ctx = { dataDir: d, registry: spyingRegistry, state: { refreshing: false } };
  await doRefresh(ctx, "Norway", "test-refresh-2");
  // ^OBX must not have been fetched this cycle (skipped), the other two did.
  assert.equal(attempts, 2, "only the 2 non-notFound symbols should be fetched on the 2nd cycle");
});

test("Fix B: disabled + NO key -> skipped (no fetch) and labeled 'not configured'", async () => {
  const d = tmpDataDir();
  let fetchCalls = 0;
  const registry = makeFakeRegistry({ "^OBX": "ok", "EQNR.OL": "ok", "DNB.OL": "ok" });
  const realFetch = registry.adapters.twelvedata.fetchDaily;
  registry.adapters.twelvedata.fetchDaily = async (inst) => {
    fetchCalls += 1;
    return realFetch.call(registry.adapters.twelvedata, inst);
  };
  // NO key configured
  const ctx = { dataDir: d, registry, state: { refreshing: false } };
  await doRefresh(ctx, "Norway", "test-refresh");

  assert.equal(fetchCalls, 0, "no fetch may be attempted when no key is configured");
  const ov = configMod.getConfig(d).universeOverrides["EQNR.OL"];
  assert.ok(!ov || ov.enabled !== true, "must NOT be enabled without a key");
  const sig = readSignal(d, "Norway", "EQNR.OL");
  assert.equal(sig.state, "unavailable");
  assert.match(sig.unavailableReason, /not configured/);
});
