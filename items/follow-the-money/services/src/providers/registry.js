"use strict";
// Provider registry (NFR-008): id -> adapter map, per-instrument provider
// chain resolution, availability check, and a single pacing gate per adapter
// (no two concurrent calls to the same provider; minimum spacing enforced).
// A new provider is a new module registered here — not a refactor.

const nasdaq = require("./nasdaq.js");
const twelvedata = require("./twelvedata.js");
const cnbc = require("./cnbc.js");
const { makePacer } = require("./http.js");

function createRegistry(pacing) {
  const adapters = { nasdaq, twelvedata, cnbc };
  const pacers = {
    nasdaq: makePacer((pacing && pacing.nasdaqMs) || 350),
    twelvedata: makePacer((pacing && pacing.twelvedataMs) || 7500),
    cnbc: makePacer(1000)
  };

  function get(id) {
    return adapters[id] || null;
  }

  // Ordered provider chain from the instrument's providerIds (derived from
  // provider: both -> [nasdaq, twelvedata]; primary -> [nasdaq];
  // fallback -> [twelvedata]) — providerIds is the source of truth.
  function chainFor(instrument) {
    const ids =
      Array.isArray(instrument.providerIds) && instrument.providerIds.length
        ? instrument.providerIds
        : instrument.provider === "both"
          ? ["nasdaq", "twelvedata"]
          : instrument.provider === "fallback"
            ? ["twelvedata"]
            : ["nasdaq"];
    return ids.map(get).filter(Boolean);
  }

  function available(adapter, keyConfigured) {
    return adapter.isAvailable(keyConfigured);
  }

  // Serialize + pace a call to the given provider.
  function paced(providerId, fn) {
    const pacer = pacers[providerId] || ((f) => f());
    return pacer(fn);
  }

  return { adapters, get, chainFor, available, paced };
}

module.exports = { createRegistry };
