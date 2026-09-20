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

// ---- secret (key) — per-provider (NFR-008 / NFR-009) ----
// data/secret.json is keyed by PROVIDER: { providers: { <id>: "<key>" } },
// mode 0600, inside the data/ subdir so BOS's config-route enumeration
// (top-level *.json only) can never expose it. Key VALUES are presence-only
// in every app-facing response (NFR-009) — only keyConfigured booleans leave
// the service.
//
// MIGRATION: the legacy flat shapes — a bare key string, or { apiKey: "…" } —
// are normalized on every read, and rewritten to the keyed format once, on
// startup (migrateSecrets), so users do not re-enter their key after an
// upgrade. There is exactly one keyed provider today (twelvedata), so a
// legacy key maps to that provider's slot; the per-provider shape means a
// future second keyed provider is data, not a refactor (NFR-008).

const LEGACY_KEY_PROVIDER = "twelvedata";

// Normalize whatever shape is on disk into { providers: { id: key } }. Pure —
// no I/O side effects beyond the single read.
function normalizeSecretDoc(raw) {
  if (raw === null || raw === undefined) return { providers: {} };
  if (typeof raw === "string") {
    // legacy bare key string
    return { providers: raw ? { [LEGACY_KEY_PROVIDER]: raw } : {} };
  }
  if (typeof raw === "object") {
    if (raw.providers && typeof raw.providers === "object" && !Array.isArray(raw.providers)) {
      const providers = {};
      for (const k of Object.keys(raw.providers)) {
        if (typeof raw.providers[k] === "string" && raw.providers[k]) providers[k] = raw.providers[k];
      }
      return { providers };
    }
    if (typeof raw.apiKey === "string" && raw.apiKey) {
      // legacy { apiKey: "…" }
      return { providers: { [LEGACY_KEY_PROVIDER]: raw.apiKey } };
    }
  }
  return { providers: {} };
}

// Read + normalize the secret (no write). Absent file -> empty providers.
function readSecrets(dataDir) {
  return normalizeSecretDoc(store.readJSON(secretPath(dataDir), null));
}

// Startup migration: if the on-disk secret is a legacy flat shape carrying a
// key, rewrite it to the keyed format. Returns a human description of what was
// migrated, or null when there is nothing to migrate. May throw on write
// failure (the caller logs with cause; reads still normalize on the fly).
function migrateSecrets(dataDir) {
  if (!store.exists(secretPath(dataDir))) return null;
  const raw = store.readJSON(secretPath(dataDir), null);
  const isLegacy =
    typeof raw === "string" ||
    (raw !== null && typeof raw === "object" && !(raw.providers && typeof raw.providers === "object" && !Array.isArray(raw.providers)));
  if (!isLegacy) return null;
  const doc = normalizeSecretDoc(raw);
  if (Object.keys(doc.providers).length === 0) return null; // legacy but empty
  store.writeJSON(secretPath(dataDir), doc, { mode: 0o600 });
  return "flat/" + (typeof raw === "string" ? "string" : "apiKey") + " -> providers{" + Object.keys(doc.providers).join(",") + "}";
}

function getKey(dataDir, providerId) {
  const doc = readSecrets(dataDir);
  return providerId && doc.providers[providerId] ? doc.providers[providerId] : null;
}

function setKey(dataDir, providerId, apiKey) {
  const doc = readSecrets(dataDir);
  doc.providers[providerId] = apiKey;
  store.writeJSON(secretPath(dataDir), doc, { mode: 0o600 });
}

function clearKey(dataDir, providerId) {
  const doc = readSecrets(dataDir);
  delete doc.providers[providerId];
  if (Object.keys(doc.providers).length === 0) store.removeFile(secretPath(dataDir));
  else store.writeJSON(secretPath(dataDir), doc, { mode: 0o600 });
}

function keyConfiguredFor(dataDir, providerId) {
  return Boolean(getKey(dataDir, providerId));
}

// Per-provider presence map for the KEYED providers (from the registry's
// adapters' requiresKey flag). Presence only — no key values (NFR-009).
function keyConfiguredMap(dataDir, registry) {
  const out = {};
  if (registry && registry.adapters) {
    for (const id of Object.keys(registry.adapters)) {
      const a = registry.adapters[id];
      if (a && a.requiresKey) out[id] = keyConfiguredFor(dataDir, id);
    }
  }
  return out;
}

// Backward-compatible flat accessor: the (single) keyed provider's status.
// There is exactly one keyed provider today (twelvedata); this keeps the
// read side (health top-level, refresh pipeline) unchanged while storage and
// the write ops are per-provider.
function keyConfigured(dataDir) {
  return keyConfiguredFor(dataDir, LEGACY_KEY_PROVIDER);
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

// Default provider chain for a USER-ADDED instrument. Nasdaq (the no-key
// primary) serves only ETFs and indices — it cannot serve individual stocks
// (there is no stock assetclass on the chart endpoint; verified live). A
// stock therefore defaults to "both" (chain [nasdaq, twelvedata]) so the
// keyed, stock-capable fallback is in the chain and a stock actually fetches
// when a key is set (and degrades to a labeled "unavailable" when it isn't).
// Non-stocks keep the no-key "primary" default.
function defaultProviderFor(category) {
  return category === "stock" ? "both" : "primary";
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
    const cat = c.category || "stock";
    merged.push(
      Object.assign(
        {
          symbol: c.symbol,
          name: c.name || c.symbol,
          region: c.region || "US",
          category: cat,
          provider: c.provider || defaultProviderFor(cat),
          providerIds:
            Array.isArray(c.providerIds) && c.providerIds.length
              ? c.providerIds
              : providerIdsFor(c.provider || defaultProviderFor(cat)),
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
// Key ops are PER PROVIDER (NFR-008): setKey { providerId, apiKey }, clearKey
// { providerId }. registry (the provider adapter map) is used to validate that
// providerId is a known, key-requiring provider. Returns { ok, error?,
// cadenceChanged? }.
function applyConfigOps(dataDir, ops, registry) {
  const user = readUserConfig(dataDir);
  let cadenceChanged = false;

  function requireKeyedProvider(providerId, opName) {
    if (!providerId || typeof providerId !== "string") {
      return opName + " requires a providerId (a provider from the registry, e.g. twelvedata)";
    }
    if (registry && registry.adapters) {
      const a = registry.adapters[providerId];
      if (!a) return "unknown provider: " + providerId;
      if (!a.requiresKey) return "provider does not require an API key: " + providerId;
    }
    return null;
  }

  if (ops.setKey) {
    const providerId = ops.setKey.providerId || LEGACY_KEY_PROVIDER;
    const err = requireKeyedProvider(providerId, "setKey");
    if (err) return { ok: false, error: err };
    if (!ops.setKey.apiKey || typeof ops.setKey.apiKey !== "string") {
      return { ok: false, error: "setKey requires a non-empty apiKey string" };
    }
    setKey(dataDir, providerId, ops.setKey.apiKey);
  }
  if (ops.clearKey) {
    const providerId =
      typeof ops.clearKey === "string"
        ? ops.clearKey
        : ops.clearKey === true
          ? LEGACY_KEY_PROVIDER
          : (ops.clearKey && ops.clearKey.providerId) || LEGACY_KEY_PROVIDER;
    const err = requireKeyedProvider(providerId, "clearKey");
    if (err) return { ok: false, error: err };
    clearKey(dataDir, providerId);
  }

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
    const addCat = a.category || "stock";
    user.customInstruments.push({
      symbol: a.symbol,
      name: a.name || a.symbol,
      region: a.region || "US",
      category: addCat,
      provider: a.provider || defaultProviderFor(addCat),
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
// keyConfigured is PER PROVIDER (presence only, for the keyed providers) so
// the write ops, storage, and this read are all consistent with GET /api/health
// providers[].
function maskedConfig(dataDir, registry) {
  const cfg = getConfig(dataDir);
  return {
    thresholds: cfg.thresholds,
    watchlist: cfg.watchlist,
    customInstruments: cfg.customInstruments,
    cadence: cfg.cadence,
    keyConfigured: keyConfiguredMap(dataDir, registry)
  };
}

module.exports = {
  getConfig,
  readUserConfig,
  writeUserConfig,
  keyConfigured,
  keyConfiguredFor,
  keyConfiguredMap,
  getKey,
  setKey,
  clearKey,
  readSecrets,
  migrateSecrets,
  LEGACY_KEY_PROVIDER,
  readManifest,
  writeManifest,
  getUniverse,
  universeHash,
  applyConfigOps,
  maskedConfig
};
