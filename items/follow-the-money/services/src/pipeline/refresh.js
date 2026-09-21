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
// Unavailable reasons (per symbol). Distinguishing them is the point of Fix A:
// "not configured" (no key) vs "key rejected" (present but 401/403) vs "ticker
// not found" (404) vs "will probe" (T10 pending) are four different user
// actions — collapsing them into one silent label is what hid the incident.
const UNAVAILABLE_REASON = "data source not configured";
const KEY_REJECTED_REASON = "key rejected — re-enter or rotate";
const NOT_FOUND_REASON = "ticker not found on provider";
const PENDING_PROBE_REASON = "will probe on next refresh";

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

// ---- Fix B: the T10 hard gate self-resolves ------------------------------
// A key-gated symbol that ships enabled:false probes on its FIRST real fetch
// (no extra credits — the probe IS the fetch). Success enables it (persisted);
// a definitive NOT_FOUND marks it so later cycles skip it without re-attacking
// the provider (no credit waste). Both write through the same atomic user
// config path every other universe override does — one mechanism.
function patchUniverseOverride(dataDir, symbol, patch) {
  const user = configMod.readUserConfig(dataDir);
  user.universeOverrides = Object.assign({}, user.universeOverrides);
  user.universeOverrides[symbol] = Object.assign({}, user.universeOverrides[symbol] || {}, patch);
  configMod.writeUserConfig(dataDir, user);
}
function enableInstrument(dataDir, symbol) {
  patchUniverseOverride(dataDir, symbol, { enabled: true, notFound: false });
}
function markInstrumentNotFound(dataDir, symbol) {
  patchUniverseOverride(dataDir, symbol, { enabled: false, notFound: true });
}

async function fetchViaChain(ctx, inst, range, events, manifest, dailyCreditBudget) {
  const dataDir = ctx.dataDir;
  const chain = ctx.registry.chainFor(inst);
  let sawNoKey = false;
  let sawInvalidKey = false;
  let failedProvider = null;
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
        failedProvider = adapter.id;
        if (pe.code === "NOT_FOUND") {
          events.push(adapter.id + " NOT_FOUND (" + inst.symbol + ")");
          fellThrough = true; // fall through to the next provider
        } else if (pe.code === "NO_KEY") {
          sawNoKey = true;
          fellThrough = true;
        } else if (pe.code === "INVALID_KEY") {
          // Fix A: a PRESENT key the provider rejected (HTTP 401/403) — the
          // user has a key but it is expired/rotated. Distinct from NO_KEY.
          sawInvalidKey = true;
          events.push(adapter.id + " INVALID_KEY (" + inst.symbol + ")");
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
  // Chain exhausted. Resolve the unavailable reason from what was actually
  // observed. The three user-action cases (Fix A) each get a distinct label:
  // a present-but-rejected key ("key rejected"), an empty key slot ("not
  // configured"), or a provider 404 ("ticker not found"). A transient failure
  // (rate-limit / network / 5xx) is NOT "unavailable" — it retries next cycle
  // with backoff and keeps its prior data (counted as symbolsFailed).
  let unavailable = false;
  let reason = null;
  if (sawInvalidKey) {
    unavailable = true;
    reason = KEY_REJECTED_REASON;
  } else if (sawNoKey && (!lastError || lastError.code === "NOT_FOUND" || lastError.code === "NO_KEY")) {
    unavailable = true;
    reason = UNAVAILABLE_REASON;
  } else if (lastError && lastError.code === "NOT_FOUND") {
    unavailable = true;
    reason = NOT_FOUND_REASON;
  }
  return { ok: false, unavailable, reason, error: lastError, failedProvider };
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

  const overrides = cfg.universeOverrides;
  for (const inst of targets) {
    const key = inst.region + "|" + inst.symbol;
    const chain = ctx.registry.chainFor(inst);
    const gated = isKeyGated(ctx.registry, inst);
    // Per-provider key gate (NFR-008): a key-gated instrument (every provider
    // in its chain requires a key) is fetchable only if SOME provider in the
    // chain has its own key slot configured.
    const hasKeyInChain = chain.some((a) => !a.requiresKey || configMod.keyConfiguredFor(dataDir, a.id));
    // A permanently-NOT_FOUND probe (Fix B): the symbol was probed once and the
    // provider rejected the ticker, so stop re-attacking it (no credit waste).
    const notFound = gated && !inst.enabled && Boolean(overrides[inst.symbol] && overrides[inst.symbol].notFound);
    // Fix B: a disabled key-gated symbol WITH a configured key PROBES on this
    // fetch — the probe IS the real fetch (no extra credits). Non-keyed and
    // no-key symbols keep the hard gate (skipped, labeled unavailable).
    const probe = gated && !inst.enabled && hasKeyInChain && !notFound;
    if ((gated && !hasKeyInChain) || (!inst.enabled && !probe)) {
      // hard-gate / no-key / permanent not-found: never fetched, labeled
      fetchStatus[key] = {
        ok: false,
        unavailable: true,
        reason: notFound ? NOT_FOUND_REASON : UNAVAILABLE_REASON
      };
      continue;
    }
    const range = neededRange(dataDir, inst, new Date());
    const events = [];
    const result = await fetchViaChain(ctx, inst, range, events, manifest, cfg.dailyCreditBudget);
    const primaryId = chain.length ? chain[0].id : "nasdaq";
    const failProvider = result.failedProvider || primaryId;
    if (result.ok) {
      if (probe) {
        // The T10 gate self-resolves: the first successful real fetch enables
        // the symbol (persisted atomically) — it joins the universe next cycle.
        enableInstrument(dataDir, inst.symbol);
        events.push("enabled " + inst.symbol + " (first successful fetch)");
      }
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
    } else if (result.unavailable && result.reason === NOT_FOUND_REASON && probe) {
      // A probe that hit NOT_FOUND: the provider rejects this ticker. Mark it
      // permanently (enabled:false, notFound:true) so later cycles skip it
      // without re-attacking — no credit waste (Fix B).
      markInstrumentNotFound(dataDir, inst.symbol);
      events.push("not found " + inst.symbol + " (probe) — marked, skipped next cycle");
      fetchStatus[key] = { ok: false, unavailable: true, reason: NOT_FOUND_REASON };
      const p = prov(failProvider);
      p.events.push(...events);
    } else if (result.unavailable) {
      fetchStatus[key] = { ok: false, unavailable: true, reason: result.reason || UNAVAILABLE_REASON };
      const p = prov(failProvider);
      p.events.push(...events);
    } else {
      fetchStatus[key] = { ok: false };
      const p = prov(failProvider);
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
    // The per-symbol unavailable reason (Fix A) is stamped on the signal so the
    // read surface can show WHY (key rejected / not configured / not found)
    // instead of one silent "awaiting" label.
    const unavailableReason = unavailable && status && status.reason ? status.reason : null;
    const priorSignal = require("../storage/signals.js").readSignal(dataDir, inst.region, inst.symbol);
    const providerUsed = fetchedOk
      ? status.providerUsed
      : priorSignal && priorSignal.providerUsed ? priorSignal.providerUsed : null;
    const signal = computeSignal({
      instrument: inst,
      bars,
      thresholds,
      availability: { unavailable, stale, providerUsed, unavailableReason }
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

module.exports = {
  startRefresh,
  doRefresh,
  REGION_ORDER,
  REGION_CURRENCY,
  UNAVAILABLE_REASON,
  KEY_REJECTED_REASON,
  NOT_FOUND_REASON,
  PENDING_PROBE_REASON,
  isKeyGated,
  isDisplayInstrument,
  enableInstrument,
  markInstrumentNotFound
};
