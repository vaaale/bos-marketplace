"use strict";
// Full-refresh orchestration — the core of US5 / NFR-003.
// Per enabled instrument: backfill-or-incremental range -> walk the provider
// chain in order (availability check; retry with exponential backoff, honoring
// Retry-After; NOT_FOUND falls through to the next provider) -> record
// providerUsed -> per-symbol ATOMIC bar upsert. Then the compute phase:
// every display instrument's Signal, each RegionRollup, and the cross-region
// Pulse are recomputed and rewritten (fully derived, FR-009).
// Partial failure never zeroes prior data; failed symbols retry next cycle.
// Credit accounting: creditsUsedToday (UTC-midnight reset, persisted in the
// manifest) capped at dailyCreditBudget — exhausted keyed symbols are marked
// "deferred — credit budget" (not an error).

const path = require("node:path");
const store = require("../storage/store.js");
const { readBars, upsertBars } = require("../storage/bars.js");
const { writeSignal, writeRegionRollup, readRegionRollup, writePulse } = require("../storage/signals.js");
const { appendRecord } = require("../storage/refreshlog.js");
const { computeSignal, toSignalLite } = require("../signal/engine.js");
const { computePulse } = require("../signal/pulse.js");
const { neededRange } = require("./backfill.js");
const { ProviderError, sleep } = require("../providers/http.js");
const configMod = require("../config/config.js");

const REGION_ORDER = ["US", "Europe", "Norway", "Asia"];
const REGION_CURRENCY = { US: "USD", Europe: "USD", Norway: "NOK", Asia: "USD" };
const UNAVAILABLE_REASON = "data source not configured";

// A display instrument appears in rollups/health even when it cannot be
// fetched: enabled instruments always; disabled instruments only when they
// are key-gated (the hard-gate / no-key "Awaiting Data" rows). An instrument
// the user disabled that has a no-key provider is simply excluded.
function isKeyGated(registry, inst) {
  const chain = registry.chainFor(inst);
  return chain.length > 0 && chain.every((a) => a.requiresKey);
}
function isDisplayInstrument(registry, inst) {
  return inst.enabled || isKeyGated(registry, inst);
}

async function fetchViaChain(ctx, inst, range, events, manifest, dailyCreditBudget) {
  const dataDir = ctx.dataDir;
  const chain = ctx.registry.chainFor(inst);
  let sawNoKey = false;
  let lastError = null;
  for (const adapter of chain) {
    // Per-provider key availability (NFR-008): a keyed adapter is usable only
    // if ITS OWN key slot is configured — not a single global flag.
    if (adapter.requiresKey && !configMod.keyConfiguredFor(dataDir, adapter.id)) {
      sawNoKey = true;
      continue; // availability check: NO_KEY -> next provider
    }
    if (adapter.id === "twelvedata" && manifest.creditsUsedToday >= dailyCreditBudget) {
      events.push("deferred — credit budget (" + inst.symbol + ")");
      return { ok: false, deferred: true };
    }
    const maxAttempts = 3;
    let fellThrough = false;
    for (let attempt = 0; attempt < maxAttempts && !fellThrough; attempt++) {
      try {
        const opts =
          adapter.id === "twelvedata"
            ? { apiKey: configMod.getKey(dataDir, adapter.id), onCredit: () => { manifest.creditsUsedToday += 1; } }
            : undefined;
        const bars = await ctx.registry.paced(adapter.id, () => adapter.fetchDaily(inst, range, opts));
        return { ok: true, providerUsed: adapter.id, bars };
      } catch (err) {
        const pe =
          err instanceof ProviderError
            ? err
            : new ProviderError("UNKNOWN", false, { cause: String((err && err.message) || err) });
        lastError = pe;
        if (pe.code === "NOT_FOUND") {
          events.push(adapter.id + " NOT_FOUND (" + inst.symbol + ")");
          fellThrough = true; // fall through to the next provider
        } else if (pe.code === "NO_KEY") {
          sawNoKey = true;
          fellThrough = true;
        } else if (pe.code === "UNAUTHORIZED") {
          events.push(adapter.id + " UNAUTHORIZED (" + inst.symbol + ")");
          fellThrough = true;
        } else if (pe.code === "RATE_LIMITED") {
          events.push(
            adapter.id + " 429" + (pe.retryAfterMs ? " retry-after " + Math.round(pe.retryAfterMs / 1000) + "s" : "") +
              " (" + inst.symbol + ")"
          );
          if (adapter.id === "nasdaq") {
            // back off 5 s, retry once, then fall through
            if (attempt === 0) await sleep(5000);
            else fellThrough = true;
          } else {
            if (attempt < maxAttempts - 1) await sleep(pe.retryAfterMs !== undefined ? pe.retryAfterMs : 5000 * Math.pow(2, attempt));
            else fellThrough = true;
          }
        } else if (pe.code === "TRANSIENT") {
          if (attempt < maxAttempts - 1) await sleep(5000 * Math.pow(2, attempt)); // base 5 s × 2^attempt
          else fellThrough = true;
        } else {
          events.push(adapter.id + " " + pe.code + " (" + inst.symbol + "): " + (pe.cause || ""));
          fellThrough = true;
        }
      }
    }
  }
  // Chain exhausted. Missing-key cause (incl. primary NOT_FOUND + no key)
  // -> "unavailable — data source not configured" (spec edge case).
  const keyCause =
    sawNoKey && (!lastError || lastError.code === "NOT_FOUND" || lastError.code === "NO_KEY");
  return { ok: false, unavailable: keyCause, error: lastError };
}

// The full pipeline. scope: "all" | region name.
async function doRefresh(ctx, scope, refreshId) {
  const dataDir = ctx.dataDir;
  const cfg = configMod.getConfig(dataDir);
  const thresholds = cfg.thresholds;
  const universe = configMod.getUniverse(dataDir);
  const nowIso = new Date().toISOString();
  const today = nowIso.slice(0, 10);
  const effScope = scope && scope !== "all" ? scope : "all";

  // persist the merged universe snapshot (FR-006/FR-017)
  store.writeJSON(path.join(dataDir, "universe", "instruments.json"), { instruments: universe });

  const manifest = configMod.readManifest(dataDir);
  if (manifest.creditsDate !== today) {
    manifest.creditsDate = today;
    manifest.creditsUsedToday = 0;
  }
  if (!manifest.createdAt) manifest.createdAt = nowIso;
  if (!manifest.lastOkFetch) manifest.lastOkFetch = {};

  const display = universe.filter((i) => isDisplayInstrument(ctx.registry, i));
  const targets = display.filter((i) => effScope === "all" || i.region === effScope);

  // fetch phase ------------------------------------------------------------
  const perProvider = {}; // id -> { symbolsOk, symbolsFailed, events }
  function prov(id) {
    if (!perProvider[id]) perProvider[id] = { symbolsOk: 0, symbolsFailed: 0, events: [] };
    return perProvider[id];
  }
  const fetchStatus = {}; // "region|symbol" -> { ok, providerUsed, unavailable, deferred }
  let maxBarDate = null;

  for (const inst of targets) {
    const key = inst.region + "|" + inst.symbol;
    const chain = ctx.registry.chainFor(inst);
    const gated = isKeyGated(ctx.registry, inst);
    // Per-provider key gate (NFR-008): a key-gated instrument (every provider
    // in its chain requires a key) is fetchable only if SOME provider in the
    // chain has its own key slot configured.
    const hasKeyInChain = chain.some((a) => !a.requiresKey || configMod.keyConfiguredFor(dataDir, a.id));
    if (!inst.enabled || (gated && !hasKeyInChain)) {
      // hard-gate / no-key: never fetched, labeled unavailable
      fetchStatus[key] = { ok: false, unavailable: true };
      continue;
    }
    const range = neededRange(dataDir, inst, new Date());
    const events = [];
    const result = await fetchViaChain(ctx, inst, range, events, manifest, cfg.dailyCreditBudget);
    const primaryId = chain.length ? chain[0].id : "nasdaq";
    if (result.ok) {
      const bars = upsertBars(dataDir, inst, result.bars, thresholds); // atomic, per-symbol
      fetchStatus[key] = { ok: true, providerUsed: result.providerUsed };
      manifest.lastOkFetch[key] = nowIso;
      const p = prov(result.providerUsed);
      p.symbolsOk += 1;
      p.events.push(...events);
      if (bars.length) {
        const d = bars[bars.length - 1].date;
        if (!maxBarDate || d > maxBarDate) maxBarDate = d;
      }
    } else if (result.deferred) {
      fetchStatus[key] = { ok: false, deferred: true };
      const p = prov("twelvedata");
      p.events.push(...events);
    } else if (result.unavailable) {
      fetchStatus[key] = { ok: false, unavailable: true };
      const p = prov(primaryId);
      p.events.push(...events);
    } else {
      fetchStatus[key] = { ok: false };
      const p = prov(result.error && result.error.code === "RATE_LIMITED" ? primaryId : primaryId);
      p.symbolsFailed += 1;
      p.events.push(...events);
    }
  }

  // compute phase (M2) ------------------------------------------------------
  // Recompute Signals + rollups for every region touched by the scope; the
  // Pulse is rebuilt from all four regions (persisted rollups for untouched
  // regions stay as they are and feed the pulse via their signals).
  const providerUsedPrior = {}; // keep prior providerUsed for symbols not fetched this cycle
  const regionLites = {};
  for (const region of REGION_ORDER) regionLites[region] = [];

  for (const inst of display) {
    const key = inst.region + "|" + inst.symbol;
    const inScope = effScope === "all" || inst.region === effScope;
    const status = fetchStatus[key] || null;
    const barsDoc = readBars(dataDir, inst);
    const bars = barsDoc.bars;
    if (!inScope) {
      // untouched region: reuse the persisted rollup below, skip recompute
      continue;
    }
    const fetchedOk = Boolean(status && status.ok);
    const unavailable = Boolean(status && status.unavailable) && !fetchedOk;
    const stale = !fetchedOk && bars.length > 0;
    const priorSignal = require("../storage/signals.js").readSignal(dataDir, inst.region, inst.symbol);
    const providerUsed = fetchedOk
      ? status.providerUsed
      : priorSignal && priorSignal.providerUsed ? priorSignal.providerUsed : null;
    const signal = computeSignal({
      instrument: inst,
      bars,
      thresholds,
      availability: { unavailable, stale, providerUsed }
    });
    writeSignal(dataDir, signal);
    regionLites[inst.region].push(toSignalLite(signal, inst, thresholds));
  }

  const allLites = [];
  for (const region of REGION_ORDER) {
    let rollup;
    const touched = effScope === "all" || region === effScope;
    if (touched) {
      rollup = writeRegionRollup(dataDir, region, REGION_CURRENCY[region], regionLites[region]);
    } else {
      rollup = readRegionRollup(dataDir, region) || { instruments: [], asOf: null };
    }
    allLites.push(...(rollup.instruments || []));
  }
  const pulseEntries = computePulse(allLites, thresholds);
  let pulseAsOf = null;
  for (const e of pulseEntries) if (e.asOf && (!pulseAsOf || e.asOf > pulseAsOf)) pulseAsOf = e.asOf;
  if (!pulseAsOf) pulseAsOf = maxBarDate;
  writePulse(dataDir, pulseAsOf, pulseEntries);

  // refresh records ---------------------------------------------------------
  const providerIds = Object.keys(perProvider).sort();
  for (const id of providerIds) {
    const p = perProvider[id];
    appendRecord(dataDir, {
      ts: nowIso,
      refreshId,
      scope: effScope,
      provider: id,
      symbolsOk: p.symbolsOk,
      symbolsFailed: p.symbolsFailed,
      creditsUsedToday: id === "twelvedata" ? manifest.creditsUsedToday : undefined,
      keyConfigured: configMod.keyConfiguredFor(dataDir, id),
      asOf: maxBarDate,
      events: p.events.slice(0, 50)
    });
  }

  // manifest ---------------------------------------------------------------
  if (effScope === "all") {
    manifest.lastFullRefresh = nowIso;
    manifest.backfillDone = true;
  }
  manifest.universeHash = configMod.universeHash(universe);
  configMod.writeManifest(dataDir, manifest);

  ctx.state.lastRefreshFinished = nowIso;
  return { refreshId, symbols: targets.length };
}

// Fire-and-forget entry with the overlap guard (`refreshing`).
function startRefresh(ctx, scope) {
  if (ctx.state.refreshing) {
    return { started: false, refreshId: null, reason: "refresh already running" };
  }
  ctx.state.refreshing = true;
  const refreshId = "r" + Date.now().toString(36) + Math.floor(Math.random() * 1e6).toString(36);
  const done = doRefresh(ctx, scope, refreshId)
    .catch((err) => {
      ctx.log("refresh " + refreshId + " failed: " + String((err && err.stack) || err));
    })
    .finally(() => {
      ctx.state.refreshing = false;
    });
  return { started: true, refreshId, done };
}

module.exports = { startRefresh, doRefresh, REGION_ORDER, REGION_CURRENCY, UNAVAILABLE_REASON, isKeyGated, isDisplayInstrument };
