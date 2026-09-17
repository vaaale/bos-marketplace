"use strict";
// S8 — cross-region money-flow pulse (FR-021 / SC-009). Pure.
// dataBearing EXCLUDES `unavailable` and `insufficient-data`, so a no-data
// region (e.g. Norway without a key) contributes zero entries by construction.
// pool = all breaking-out-confirmed (any region)
//      ∪ per region, top-pulsePerRegionK-by-score from that region's
//        dataBearing instruments not already in the pool
// sort (moneyFlowScore desc, region asc, symbol asc) — deterministic tie-break
// pulse = top pulseTopN.

const DATA_BEARING = [
  "breaking-out-confirmed",
  "breaking-out-unconfirmed",
  "in-base",
  "trending",
  "no-base"
];

function cmp(a, b) {
  if (b.moneyFlowScore !== a.moneyFlowScore) return b.moneyFlowScore - a.moneyFlowScore;
  if (a.region !== b.region) return a.region < b.region ? -1 : 1;
  if (a.symbol !== b.symbol) return a.symbol < b.symbol ? -1 : 1;
  return 0;
}

// lites: SignalLite[] across all regions (arrays only — no Sets/for…in).
function computePulse(lites, thresholds) {
  const dataBearing = lites.filter((s) => DATA_BEARING.indexOf(s.state) !== -1);
  const pool = [];
  const inPool = {};
  const keyOf = (s) => s.region + "|" + s.symbol;

  for (const s of dataBearing) {
    if (s.state === "breaking-out-confirmed") {
      pool.push(s);
      inPool[keyOf(s)] = true;
    }
  }
  const regions = [];
  for (const s of dataBearing) {
    if (regions.indexOf(s.region) === -1) regions.push(s.region);
  }
  regions.sort(); // region asc — deterministic
  for (const region of regions) {
    const candidates = dataBearing.filter((s) => s.region === region && !inPool[keyOf(s)]);
    candidates.sort(cmp);
    const top = candidates.slice(0, thresholds.pulsePerRegionK);
    for (const s of top) {
      pool.push(s);
      inPool[keyOf(s)] = true;
    }
  }
  pool.sort(cmp);
  return pool.slice(0, thresholds.pulseTopN).map((s) => ({
    symbol: s.symbol,
    region: s.region,
    moneyFlowScore: s.moneyFlowScore,
    state: s.state,
    momentumPct3M: s.momentumPct["3M"],
    moneyFlowRatio: s.moneyFlowRatio,
    asOf: s.asOf
  }));
}

module.exports = { computePulse, DATA_BEARING };
