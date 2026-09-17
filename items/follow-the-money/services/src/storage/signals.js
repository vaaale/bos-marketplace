"use strict";
// Signal / RegionRollup / Pulse writers + readers (FR-009).
// Fully derived artifacts, rewritten atomically each refresh. The emitted
// objects come from the signal engine with fixed key-insertion order, so
// re-running the compute phase on unchanged data is byte-identical (SC-007).

const path = require("node:path");
const store = require("./store.js");

function signalPath(dataDir, region, symbol) {
  return path.join(dataDir, "signals", region, symbol + ".json");
}
function rollupPath(dataDir, region) {
  return path.join(dataDir, "signals", "regions", region + ".json");
}
function pulsePath(dataDir) {
  return path.join(dataDir, "signals", "pulse.json");
}

function writeSignal(dataDir, signal) {
  store.writeJSON(signalPath(dataDir, signal.region, signal.symbol), signal);
}

function readSignal(dataDir, region, symbol) {
  return store.readJSON(signalPath(dataDir, region, symbol), null);
}

function listSignalSymbols(dataDir, region) {
  return store
    .listFiles(path.join(dataDir, "signals", region))
    .filter((f) => f.endsWith(".json"))
    .map((f) => f.slice(0, -5));
}

// lites: SignalLite[] for the region (any order) -> ranked rollup.
function writeRegionRollup(dataDir, region, currency, lites) {
  const ranked = lites.slice().sort((a, b) => {
    if (b.moneyFlowScore !== a.moneyFlowScore) return b.moneyFlowScore - a.moneyFlowScore;
    return a.symbol < b.symbol ? -1 : a.symbol > b.symbol ? 1 : 0; // deterministic tie-break
  });
  let asOf = null;
  for (const s of ranked) {
    if (s.asOf && (!asOf || s.asOf > asOf)) asOf = s.asOf;
  }
  const counts = {
    total: ranked.length,
    inBase: 0,
    breakingOutConfirmed: 0,
    breakingOutUnconfirmed: 0,
    trending: 0,
    unavailable: 0,
    insufficient: 0
  };
  for (const s of ranked) {
    if (s.state === "in-base") counts.inBase += 1;
    else if (s.state === "breaking-out-confirmed") counts.breakingOutConfirmed += 1;
    else if (s.state === "breaking-out-unconfirmed") counts.breakingOutUnconfirmed += 1;
    else if (s.state === "unavailable") counts.unavailable += 1;
    else if (s.state === "insufficient-data") counts.insufficient += 1;
    else counts.trending += 1; // trending + no-base (matches design §2.5 example)
  }
  const rollup = { region, currency, asOf, instruments: ranked, counts };
  store.writeJSON(rollupPath(dataDir, region), rollup);
  return rollup;
}

function readRegionRollup(dataDir, region) {
  return store.readJSON(rollupPath(dataDir, region), null);
}

function writePulse(dataDir, asOf, entries) {
  store.writeJSON(pulsePath(dataDir), { asOf, entries });
}

function readPulse(dataDir) {
  return store.readJSON(pulsePath(dataDir), { asOf: null, entries: [] });
}

module.exports = {
  writeSignal,
  readSignal,
  listSignalSymbols,
  writeRegionRollup,
  readRegionRollup,
  writePulse,
  readPulse
};
