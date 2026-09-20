"use strict";
// Unit tests for the pure signal engine (NFR-010 / NFR-011 / SC-002 / SC-007).
// Run with Node's built-in runner — no npm deps, CommonJS:
//   node --test services/tests/signal.test.js
// Synthetic engineered series only: no I/O, no network, no Date.now().

const test = require("node:test");
const assert = require("node:assert/strict");

const defaults = require("../src/config/defaults.js");
const { flagGaps } = require("../src/signal/gaps.js");
const { computeMomentum } = require("../src/signal/momentum.js");
const { computeMoneyFlow } = require("../src/signal/moneyflow.js");
const { detectBase } = require("../src/signal/base.js");
const { detectBreakout } = require("../src/signal/breakout.js");
const { computeScore } = require("../src/signal/score.js");
const { computeSignal, toSignalLite } = require("../src/signal/engine.js");
const { computePulse } = require("../src/signal/pulse.js");

const T = defaults.thresholds;

const INSTRUMENT = { symbol: "TEST", name: "Test Instrument", category: "sector", region: "US", currency: "USD" };

// deterministic date sequence: d(0) = 2025-01-01, +1 day each (weekends fine for tests)
function dateAt(i) {
  const d = new Date(Date.UTC(2025, 0, 1));
  d.setUTCDate(d.getUTCDate() + i);
  return d.toISOString().slice(0, 10);
}

// Build bars from parallel closes/volumes; dollarVolume = volume*close, gapFlag via S9.
function makeBars(closes, volumes) {
  const flags = flagGaps(closes, T.gapThreshold);
  return closes.map((close, i) => ({
    date: dateAt(i),
    open: close,
    high: close,
    low: close,
    close,
    volume: volumes[i],
    dollarVolume: volumes[i] * close,
    gapFlag: flags[i]
  }));
}

// (a) base + breakout + confirmation at an engineered volume ratio.
// 139 bars alternating in a known tight band (99.5 / 100.5 — width 1% of mid),
// then a final bar closing above the band with dollarVolume = ratio × the
// trailing 20-bar average dollar volume.
function baseBreakoutSeries(ratio) {
  const closes = [];
  const volumes = [];
  for (let i = 0; i < 139; i++) {
    closes.push(i % 2 === 0 ? 99.5 : 100.5);
    volumes.push(1000000);
  }
  const finalClose = 103;
  // trailing 20 bars before the final bar (indices 119..138)
  let trail = 0;
  for (let i = 119; i <= 138; i++) trail += closes[i] * volumes[i];
  trail /= 20;
  const finalVolume = (ratio * trail) / finalClose; // dollarVolume[t] = ratio × trailing avg
  closes.push(finalClose);
  volumes.push(finalVolume);
  return makeBars(closes, volumes);
}

test("S3+S4+S5: base detected with exact bounds; confirmed breakout at 2.5× volume", () => {
  const bars = baseBreakoutSeries(2.5);
  const basePrev = detectBase(bars.slice(0, bars.length - 1), T);
  assert.equal(basePrev.present, true);
  assert.equal(basePrev.lowerBound, 99.5);
  assert.equal(basePrev.upperBound, 100.5);
  assert.ok(basePrev.durationDays >= T.baseMinDuration, "base duration >= 60");
  assert.equal(basePrev.durationDays, 139);
  assert.ok(Math.abs(basePrev.tightness - 1 / 100) < 1e-12, "tightness ~1%");

  const breakout = detectBreakout(bars, T);
  assert.equal(breakout.present, true);
  assert.equal(breakout.direction, "up");
  assert.equal(breakout.level, 100.5);
  assert.ok(Math.abs(breakout.volumeRatio - 2.5) < 1e-9, "volume ratio ~2.5");
  assert.equal(breakout.confirmed, true);

  const signal = computeSignal({ instrument: INSTRUMENT, bars, thresholds: T, availability: {} });
  assert.equal(signal.state, "breaking-out-confirmed");

  // exact S6 score, recomputed in-test (design §2.3 formulas)
  const t = bars.length - 1;
  const mom3M = (bars[t].close / bars[t - T.lookbackDays["3M"]].close - 1) * 100;
  const flow = computeMoneyFlow(bars, T);
  const momentumScore = 50 + 50 * Math.tanh(mom3M / T.momentumScale);
  const flowScore = 50 + 50 * Math.tanh((flow.moneyFlowRatio - 1) / T.flowScale);
  const expected = Math.min(100, Math.max(0, Math.round(T.momentumWeight * momentumScore + T.flowWeight * flowScore)));
  assert.equal(signal.score.moneyFlowScore, expected);
  assert.ok(Math.abs(signal.score.momentumScore - momentumScore) < 1e-12);
  assert.ok(Math.abs(signal.score.flowScore - flowScore) < 1e-12);
});

// S3 REGRESSION (trailing-run base, not all-or-nothing):
// The defect: detectBase accumulated lower/upper over the WHOLE scan window
// and set present=false at the first width violation, so present=true only if
// the entire trailing window (up to baseScanWindow=252 bars) stayed within
// baseMaxWidth=10% — i.e. a full year of consolidation. A real base is a
// 60-day tight run PRECEDED by a wider move. That reading also made the
// Scanner structurally dead (S4 needs a valid preceding base) and forced every
// instrument to "trending"/"no-base" after a backfill.
// The invariant (design §2.3): "the loop stops at the first violation — the
// base is exactly the longest recent contiguous tight run ending at t".
// Run with: node --test services/tests/signal.test.js
test("S3 trailing-run: a 90-day tight band preceded by a wider run IS a 90-day base", () => {
  // 150 bars of a ~12% single-day oscillation (width 11.3% of mid > baseMaxWidth
  // 10%, but < 20% so S9 does NOT flag a gap), then 90 bars inside a ~2% band
  // (width 1.98% <= 5% <= 10%). The tight run ends exactly at the last bar.
  const closes = [];
  const volumes = [];
  for (let i = 0; i < 150; i++) { closes.push(i % 2 === 0 ? 100 : 112); volumes.push(1000000); }
  for (let i = 150; i < 240; i++) { closes.push(i % 2 === 0 ? 100 : 102); volumes.push(1000000); }
  const bars = makeBars(closes, volumes);
  // sanity: no gap flags anywhere (max single-day move is ~12%)
  assert.ok(bars.every((b) => b.gapFlag === false), "no gap flags in the synthetic series");

  const base = detectBase(bars, T);
  assert.equal(base.present, true, "a trailing tight run is a base (was all-or-nothing: present=false)");
  assert.equal(base.durationDays, 90, "duration = length of the tight run, not the whole window");
  assert.ok(base.tightness <= 0.05, "tightness is the final (tight-run) width, <= 5%");
  assert.ok(base.sufficientData, "240 bars >= baseMinDuration + baselineWindow");
});

test("S5: same geometry at 1.2× volume -> breakout unconfirmed", () => {
  const bars = baseBreakoutSeries(1.2);
  const breakout = detectBreakout(bars, T);
  assert.equal(breakout.present, true);
  assert.ok(Math.abs(breakout.volumeRatio - 1.2) < 1e-9);
  assert.equal(breakout.confirmed, false);
  const signal = computeSignal({ instrument: INSTRUMENT, bars, thresholds: T, availability: {} });
  assert.equal(signal.state, "breaking-out-unconfirmed");
});

test("S9+S3: a -66% gap bar flags, resets the base, and prevents a fake breakout", () => {
  // 100 tight bars at ~100, then a -66% gap, then 40 tight bars at ~34,
  // then a final bar above the small band. Without the gap guard the long
  // pre-gap history could seed a base; with it, the post-gap run (40 bars)
  // is under baseMinDuration -> NO breakout.
  const closes = [];
  const volumes = [];
  for (let i = 0; i < 100; i++) { closes.push(i % 2 === 0 ? 99.5 : 100.5); volumes.push(1000000); }
  closes.push(34); volumes.push(1000000); // the gap bar (index 100): -66%
  for (let i = 0; i < 40; i++) { closes.push(i % 2 === 0 ? 33.9 : 34.1); volumes.push(1000000); }
  closes.push(36); volumes.push(5000000); // would-be "breakout" over the small band
  const bars = makeBars(closes, volumes);

  assert.equal(bars[100].gapFlag, true, "gap bar flagged");
  assert.equal(bars[99].gapFlag, false);
  assert.equal(bars[101].gapFlag, false);

  // base over bars[0..t-1] cannot cross the gap: run starts at index 101
  const basePrev = detectBase(bars.slice(0, bars.length - 1), T);
  assert.equal(basePrev.present, true);
  assert.equal(basePrev.durationDays, 40, "base cut at the gap");
  assert.ok(basePrev.durationDays < T.baseMinDuration);

  const breakout = detectBreakout(bars, T);
  assert.equal(breakout.present, false, "no fake breakout across the gap");
});

test("insufficient data: 30 bars -> sufficientData false, state insufficient-data", () => {
  const closes = [];
  const volumes = [];
  for (let i = 0; i < 30; i++) { closes.push(100 + (i % 2)); volumes.push(1000); }
  const bars = makeBars(closes, volumes);
  const base = detectBase(bars, T);
  assert.equal(base.sufficientData, false);
  const signal = computeSignal({ instrument: INSTRUMENT, bars, thresholds: T, availability: {} });
  assert.equal(signal.state, "insufficient-data");
});

test("short-circuits: n=0 -> momentum null + score 0; n=1 -> 0%; zero baseline -> ratios 0", () => {
  // n = 0
  const s0 = computeSignal({ instrument: INSTRUMENT, bars: [], thresholds: T, availability: {} });
  assert.equal(s0.momentumPct["3M"], null);
  assert.equal(s0.momentumPct["2Y"], null);
  assert.equal(s0.score.moneyFlowScore, 0);
  assert.equal(s0.moneyFlowRatio, 0);
  assert.equal(s0.asOf, null);

  // n = 1
  const one = makeBars([100], [1000]);
  const m1 = computeMomentum(one, T);
  assert.equal(m1.momentumPct["3M"], 0);
  assert.equal(m1.momentumPct["1Y"], 0);

  // zero trailing baseline (all volumes 0, like NDX price-only)
  const closes = [];
  const volumes = [];
  for (let i = 0; i < 140; i++) { closes.push(i % 2 === 0 ? 99.5 : 100.5); volumes.push(0); }
  closes.push(103); volumes.push(0);
  const ndxLike = makeBars(closes, volumes);
  const flow = computeMoneyFlow(ndxLike, T);
  assert.equal(flow.moneyFlowRatio, 0);
  const bo = detectBreakout(ndxLike, T);
  assert.equal(bo.present, true);
  assert.equal(bo.volumeRatio, 0);
  assert.equal(bo.confirmed, false, "no volume -> never confirmed");
});

test("S7: unavailable is resolved FIRST — a no-data key-gated symbol is unavailable, not insufficient-data", () => {
  const s = computeSignal({
    instrument: { symbol: "^OBX", name: "OBX", category: "broad", region: "Norway", currency: "NOK" },
    bars: [],
    thresholds: T,
    availability: { unavailable: true }
  });
  assert.equal(s.state, "unavailable");

  // with prior bars retained: still unavailable, stale stamped, asOf = last good date
  const bars = baseBreakoutSeries(2.5);
  const s2 = computeSignal({
    instrument: INSTRUMENT,
    bars,
    thresholds: T,
    availability: { unavailable: true, stale: true }
  });
  assert.equal(s2.state, "unavailable");
  assert.equal(s2.stale, true);
  assert.equal(s2.asOf, bars[bars.length - 1].date);
});

test("determinism (SC-007): identical input -> byte-identical JSON, twice", () => {
  const bars = baseBreakoutSeries(2.5);
  const a = JSON.stringify(computeSignal({ instrument: INSTRUMENT, bars, thresholds: T, availability: {} }));
  const b = JSON.stringify(computeSignal({ instrument: INSTRUMENT, bars, thresholds: T, availability: {} }));
  assert.equal(a, b);

  const liteA = JSON.stringify(toSignalLite(computeSignal({ instrument: INSTRUMENT, bars, thresholds: T, availability: {} }), INSTRUMENT, T));
  const liteB = JSON.stringify(toSignalLite(computeSignal({ instrument: INSTRUMENT, bars, thresholds: T, availability: {} }), INSTRUMENT, T));
  assert.equal(liteA, liteB);
});

test("S8 pulse: no-data regions contribute nothing; tie-break (score desc, region asc, symbol asc); top-N", () => {
  function lite(symbol, region, score, state) {
    return {
      symbol, region,
      moneyFlowScore: score,
      state,
      momentumPct: { "3M": 10, "6M": 10, "1Y": 10, "2Y": 10 },
      moneyFlowRatio: 1.5,
      recentDollarVolume: 1e9,
      asOf: "2026-09-16"
    };
  }
  const lites = [
    lite("AAA", "US", 92, "breaking-out-confirmed"),
    lite("BBB", "US", 88, "trending"),
    lite("CCC", "US", 88, "in-base"),
    lite("DDD", "US", 70, "trending"),
    lite("EEE", "US", 60, "trending"), // 5th US data-bearing, beyond per-region K=3 and out of top-5 anyway
    lite("FFF", "Europe", 90, "breaking-out-confirmed"),
    lite("GGG", "Europe", 88, "trending"),
    lite("NOR", "Norway", 0, "unavailable"),       // excluded: not data-bearing
    lite("NEW", "Asia", 95, "insufficient-data"),  // excluded: not data-bearing
    lite("HHH", "Asia", 85, "no-base")
  ];
  const pulse = computePulse(lites, T);
  assert.equal(pulse.length, 5, "top N = 5");
  assert.deepEqual(pulse.map((e) => e.symbol), ["AAA", "FFF", "GGG", "BBB", "CCC"]);
  // no Norway / insufficient entries
  assert.ok(pulse.every((e) => e.region !== "Norway"));
  assert.ok(pulse.every((e) => e.symbol !== "NEW"));
  // GGG (Europe, 88) sorts before BBB/CCC (US, 88): region asc; BBB before CCC: symbol asc
  const again = computePulse(lites, T);
  assert.equal(JSON.stringify(pulse), JSON.stringify(again), "pulse deterministic");
});

test("S1 momentum: exact windows + incomplete labeling", () => {
  const closes = [];
  const volumes = [];
  for (let i = 0; i < 100; i++) { closes.push(100 + i); volumes.push(1000); }
  const bars = makeBars(closes, volumes);
  const { momentumPct, momentum } = computeMomentum(bars, T);
  // n=100 > 63: 3M complete, close[99]/close[99-63]-1
  assert.ok(Math.abs(momentumPct["3M"] - ((199 / 136 - 1) * 100)) < 1e-12);
  assert.deepEqual(momentum["3M"], { complete: true, barsUsed: 63 });
  // n=100 <= 126: 6M incomplete, uses close[0]
  assert.ok(Math.abs(momentumPct["6M"] - ((199 / 100 - 1) * 100)) < 1e-12);
  assert.deepEqual(momentum["6M"], { complete: false, barsUsed: 99 });
});

test("S2 money-flow ratio: recent window excluded from its own baseline", () => {
  // 25 bars of dollarVolume 100 (volume 1 × close 100), then 5 bars of 200
  const closes = new Array(30).fill(100);
  const volumes = new Array(30).fill(1);
  for (let i = 25; i < 30; i++) volumes[i] = 2;
  const bars = makeBars(closes, volumes);
  const flow = computeMoneyFlow(bars, T);
  // recent = mean(last 5) = 200; trailing = mean(20 bars before them) = 100
  assert.ok(Math.abs(flow.moneyFlowRatio - 2) < 1e-12);
  assert.ok(Math.abs(flow.recentDollarVolume - 200) < 1e-12);
  assert.ok(Math.abs(flow.trailingAvgDollarVolume - 100) < 1e-12);
});
