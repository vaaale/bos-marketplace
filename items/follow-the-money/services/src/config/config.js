"use strict";
// Durable service config (FR-014/FR-017) + secret handling (NFR-009).
// data/config.json  — thresholds/cadence overrides, watchlist, custom
//                     instruments, universe overrides for default instruments.
// data/secret.json  — the market-data API key, mode 0600, inside the data/
//                     subdir so BOS's config-route enumeration (top-level
//                     *.json only) can never expose it. Presence-only in
//                     every app-facing response.

const path = require("node:path");
const store = require("../storage/store.js");
const defaults = require("./defaults.js");
const { DEFAULT_UNIVERSE } = require("../universe/default-universe.js");

function configPath(dataDir) {
  return path.join(dataDir, "config.json");
}
function secretPath(dataDir) {
  return path.join(dataDir, "secret.json");
}
function manifestPath(dataDir) {
  return path.join(dataDir, "manifest.json");
}

function emptyUserConfig() {
  return { thresholds: {}, cadence: {}, watchlist: [], customInstruments: [], universeOverrides: {} };
}

function readUserConfig(dataDir) {
  const raw = store.readJSON(configPath(dataDir), null) || {};
  const c = emptyUserConfig();
  if (raw.thresholds && typeof raw.thresholds === "object") c.thresholds = raw.thresholds;
  if (raw.cadence && typeof raw.cadence === "object") c.cadence = raw.cadence;
  if (Array.isArray(raw.watchlist)) c.watchlist = raw.watchlist;
  if (Array.isArray(raw.customInstruments)) c.customInstruments = raw.customInstruments;
  if (raw.universeOverrides && typeof raw.universeOverrides === "object") c.universeOverrides = raw.universeOverrides;
  return c;
}

function writeUserConfig(dataDir, userConfig) {
  store.writeJSON(configPath(dataDir), userConfig);
}

// Effective (merged) config: defaults overlaid with user overrides.
function getConfig(dataDir) {
  const user = readUserConfig(dataDir);
  return {
    thresholds: Object.assign({}, defaults.thresholds, user.thresholds, {
      lookbackDays: Object.assign({}, defaults.thresholds.lookbackDays,
        (user.thresholds && user.thresholds.lookbackDays) || {})
    }),
    cadence: Object.assign({}, defaults.cadence, user.cadence),
    dailyCreditBudget:
      user.thresholds && user.thresholds.dailyCreditBudget !== undefined
        ? user.thresholds.dailyCreditBudget
        : defaults.dailyCreditBudget,
    pacing: defaults.pacing,
    watchlist: user.watchlist,
    customInstruments: user.customInstruments,
    universeOverrides: user.universeOverrides
  };
}

// ---- secret (key) ----
function keyConfigured(dataDir) {
  return store.exists(secretPath(dataDir));
}
function getKey(dataDir) {
  const doc = store.readJSON(secretPath(dataDir), null);
  return (doc && doc.apiKey) || null;
}
function setKey(dataDir, apiKey) {
  store.writeJSON(secretPath(dataDir), { apiKey }, { mode: 0o600 });
}
function clearKey(dataDir) {
  store.removeFile(secretPath(dataDir));
}

// ---- manifest ----
function readManifest(dataDir) {
  return (
    store.readJSON(manifestPath(dataDir), null) || {
      schemaVersion: 1,
      createdAt: null,
      lastFullRefresh: null,
      universeHash: null,
      backfillDone: false,
      creditsUsedToday: 0,
      creditsDate: null,
      lastOkFetch: {}
    }
  );
}
function writeManifest(dataDir, manifest) {
  store.writeJSON(manifestPath(dataDir), manifest);
}

// ---- universe (FR-006 / FR-017) ----
// Merged universe = defaults (with per-symbol user overrides applied) +
// user-added custom instruments (source:"user").
function providerIdsFor(provider) {
  if (provider === "both") return ["nasdaq", "twelvedata"];
  if (provider === "fallback") return ["twelvedata"];
  return ["nasdaq"];
}

function getUniverse(dataDir) {
  const cfg = getConfig(dataDir);
  const overridable = ["name", "category", "region", "enabled", "weight"];
  const merged = DEFAULT_UNIVERSE.map((d) => {
    const o = cfg.universeOverrides[d.symbol];
    if (!o) return Object.assign({}, d);
    const out = Object.assign({}, d);
    for (const k of overridable) {
      if (o[k] !== undefined) out[k] = o[k];
    }
    return out;
  });
  for (const c of cfg.customInstruments) {
    merged.push(
      Object.assign(
        {
          symbol: c.symbol,
          name: c.name || c.symbol,
          region: c.region || "US",
          category: c.category || "stock",
          provider: c.provider || "primary",
          providerIds: Array.isArray(c.providerIds) && c.providerIds.length ? c.providerIds : providerIdsFor(c.provider || "primary"),
          currency: c.currency || "USD",
          enabled: c.enabled !== false,
          weight: c.weight !== undefined ? c.weight : null,
          source: "user"
        },
        c.assetClass ? { assetClass: c.assetClass } : {}
      )
    );
  }
  return merged;
}

// Deterministic FNV-1a hash of the universe symbols (no randomness).
function universeHash(instruments) {
  const s = instruments.map((i) => i.symbol + ":" + (i.enabled ? "1" : "0")).join(",");
  let h = 2166136261;
  for (let i = 0; i < s.length; i++) {
    h ^= s.charCodeAt(i);
    h = Math.imul(h, 16777619);
  }
  return (h >>> 0).toString(16);
}

// ---- PATCH /api/config ops (design §2.5). Each op idempotent/independent.
// Returns { ok, error?, cadenceChanged? }.
function applyConfigOps(dataDir, ops) {
  const user = readUserConfig(dataDir);
  let cadenceChanged = false;

  if (ops.setKey) {
    if (!ops.setKey.apiKey || typeof ops.setKey.apiKey !== "string") {
      return { ok: false, error: "setKey requires a non-empty apiKey string" };
    }
    setKey(dataDir, ops.setKey.apiKey);
  }
  if (ops.clearKey === true) clearKey(dataDir);

  if (ops.thresholds && typeof ops.thresholds === "object") {
    user.thresholds = Object.assign({}, user.thresholds, ops.thresholds);
  }
  if (ops.cadence && typeof ops.cadence === "object") {
    user.cadence = Object.assign({}, user.cadence, ops.cadence);
    cadenceChanged = true;
  }
  if (typeof ops.watchlistAdd === "string" && ops.watchlistAdd) {
    if (user.watchlist.indexOf(ops.watchlistAdd) === -1) user.watchlist.push(ops.watchlistAdd);
  }
  if (typeof ops.watchlistRemove === "string" && ops.watchlistRemove) {
    user.watchlist = user.watchlist.filter((s) => s !== ops.watchlistRemove);
  }
  if (ops.instrumentAdd && typeof ops.instrumentAdd === "object") {
    const a = ops.instrumentAdd;
    if (!a.symbol || typeof a.symbol !== "string") return { ok: false, error: "instrumentAdd requires a symbol" };
    const isDefault = DEFAULT_UNIVERSE.some((d) => d.symbol === a.symbol);
    if (isDefault) return { ok: false, error: "symbol already in the default universe" };
    user.customInstruments = user.customInstruments.filter((c) => c.symbol !== a.symbol);
    user.customInstruments.push({
      symbol: a.symbol,
      name: a.name || a.symbol,
      region: a.region || "US",
      category: a.category || "stock",
      provider: a.provider || "primary",
      currency: a.currency || "USD",
      enabled: a.enabled !== false,
      weight: a.weight !== undefined ? a.weight : null,
      source: "user"
    });
  }
  if (ops.instrumentEdit && typeof ops.instrumentEdit === "object") {
    const e = ops.instrumentEdit;
    if (!e.symbol) return { ok: false, error: "instrumentEdit requires a symbol" };
    const custom = user.customInstruments.find((c) => c.symbol === e.symbol);
    const editable = ["name", "category", "region", "enabled", "weight"];
    if (custom) {
      for (const k of editable) if (e[k] !== undefined) custom[k] = e[k];
    } else if (DEFAULT_UNIVERSE.some((d) => d.symbol === e.symbol)) {
      const o = user.universeOverrides[e.symbol] || {};
      for (const k of editable) if (e[k] !== undefined) o[k] = e[k];
      user.universeOverrides[e.symbol] = o;
    } else {
      return { ok: false, error: "unknown symbol: " + e.symbol };
    }
  }
  if (ops.instrumentDisable && typeof ops.instrumentDisable === "object") {
    const d = ops.instrumentDisable;
    if (!d.symbol) return { ok: false, error: "instrumentDisable requires a symbol" };
    const custom = user.customInstruments.find((c) => c.symbol === d.symbol);
    if (custom) custom.enabled = d.enabled === true;
    else if (DEFAULT_UNIVERSE.some((x) => x.symbol === d.symbol)) {
      const o = user.universeOverrides[d.symbol] || {};
      o.enabled = d.enabled === true;
      user.universeOverrides[d.symbol] = o;
    } else return { ok: false, error: "unknown symbol: " + d.symbol };
  }
  if (typeof ops.instrumentRemove === "string" && ops.instrumentRemove) {
    // custom only — defaults cannot be removed, only disabled
    if (DEFAULT_UNIVERSE.some((d) => d.symbol === ops.instrumentRemove)) {
      return { ok: false, error: "default instruments cannot be removed — disable instead" };
    }
    user.customInstruments = user.customInstruments.filter((c) => c.symbol !== ops.instrumentRemove);
  }

  writeUserConfig(dataDir, user);
  return { ok: true, cadenceChanged };
}

// Masked config for GET /api/config — the key value is NEVER included.
function maskedConfig(dataDir) {
  const cfg = getConfig(dataDir);
  return {
    thresholds: cfg.thresholds,
    watchlist: cfg.watchlist,
    customInstruments: cfg.customInstruments,
    cadence: cfg.cadence,
    keyConfigured: keyConfigured(dataDir)
  };
}

module.exports = {
  getConfig,
  readUserConfig,
  writeUserConfig,
  keyConfigured,
  getKey,
  setKey,
  clearKey,
  readManifest,
  writeManifest,
  getUniverse,
  universeHash,
  applyConfigOps,
  maskedConfig
};
