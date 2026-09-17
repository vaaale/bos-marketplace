"use strict";
// Orchestrates S1–S6 into a full Signal (design §3 shape) with S7 state
// resolution. PURE function of (instrument, bars, thresholds, availability):
// no Date.now(), no randomness, no I/O (ADR-d / NFR-011).
//
// Determinism guardrail (SC-007): the Signal object is built with a FIXED
// key-insertion order and all iteration is over arrays — never for…in over
// object-keyed collections or Sets — so JSON output is byte-identical for
// identical input.

const { computeMomentum } = require("./momentum.js");
const { computeMoneyFlow } = require("./moneyflow.js");
const { detectBase } = require("./base.js");
const { detectBreakout } = require("./breakout.js");
const { computeScore } = require("./score.js");

const STATES = [
  "in-base",
  "breaking-out-confirmed",
  "breaking-out-unconfirmed",
  "trending",
  "no-base",
  "insufficient-data",
  "unavailable"
];

// S7 — state resolution in EXACT order; `unavailable` is checked FIRST (from
// the refresh record) so a fresh key-gated symbol with n=0 classifies as
// `unavailable`, not `insufficient-data` (FR-012 / NFR-006 / SC-003).
function resolveState({ unavailable, n, thresholds, base, breakout, momentumPct }) {
  if (unavailable) return "unavailable";
  if (n < thresholds.baseMinDuration + thresholds.baselineWindow) return "insufficient-data";
  if (breakout.present && breakout.confirmed) return "breaking-out-confirmed";
  if (breakout.present && !breakout.confirmed) return "breaking-out-unconfirmed";
  if (base.present && base.durationDays >= thresholds.baseMinDuration) return "in-base";
  const mom1Y = momentumPct["1Y"];
  if (!base.present && mom1Y !== null && Math.abs(mom1Y) > thresholds.noBaseDriftEpsilon) return "no-base";
  return "trending";
}

// Direction indicator: sign of momentumPct[lookback], flat when
// |value| < dirFlatEpsilon (percent).
function directionOf(momPct, dirFlatEpsilon) {
  if (momPct === null || momPct === undefined) return "flat";
  if (Math.abs(momPct) < dirFlatEpsilon) return "flat";
  return momPct > 0 ? "up" : "down";
}

// availability: { unavailable?: bool, stale?: bool, providerUsed?: string }
function computeSignal({ instrument, bars, thresholds, availability }) {
  const av = availability || {};
  const n = bars.length;
  const t = n - 1;
  const { momentumPct, momentum } = computeMomentum(bars, thresholds);
  const flow = computeMoneyFlow(bars, thresholds);
  const base = detectBase(bars, thresholds);
  const breakout = detectBreakout(bars, thresholds);
  const score = computeScore(momentumPct["3M"], flow.moneyFlowRatio, thresholds);
  const state = resolveState({
    unavailable: Boolean(av.unavailable),
    n,
    thresholds,
    base,
    breakout,
    momentumPct
  });
  // asOf = last good bar date (retained even when unavailable/stale); null with no data
  const asOf = n > 0 ? bars[t].date : null;
  return {
    symbol: instrument.symbol,
    region: instrument.region,
    asOf,
    currency: instrument.currency,
    providerUsed: av.providerUsed !== undefined ? av.providerUsed : null,
    momentumPct,
    momentum,
    moneyFlowRatio: flow.moneyFlowRatio,
    recentDollarVolume: flow.recentDollarVolume,
    trailingAvgDollarVolume: flow.trailingAvgDollarVolume,
    base,
    breakout,
    score,
    stale: Boolean(av.stale),
    state
  };
}

// SignalLite (design §2.5) — the row shape rollups / pulse / watchlist serve.
// Fixed key order; base/breakout are null when not present.
function toSignalLite(signal, instrument, thresholds) {
  return {
    symbol: signal.symbol,
    name: instrument.name,
    category: instrument.category,
    region: signal.region,
    direction: directionOf(signal.momentumPct["3M"], thresholds.dirFlatEpsilon),
    momentumPct: signal.momentumPct,
    moneyFlowScore: signal.score.moneyFlowScore,
    moneyFlowRatio: signal.moneyFlowRatio,
    recentDollarVolume: signal.recentDollarVolume,
    state: signal.state,
    base: signal.base.present
      ? {
          present: true,
          lowerBound: signal.base.lowerBound,
          upperBound: signal.base.upperBound,
          durationDays: signal.base.durationDays,
          tightness: signal.base.tightness
        }
      : null,
    breakout: signal.breakout.present
      ? {
          present: true,
          level: signal.breakout.level,
          direction: signal.breakout.direction,
          volumeRatio: signal.breakout.volumeRatio,
          confirmed: signal.breakout.confirmed
        }
      : null,
    asOf: signal.asOf
  };
}

module.exports = { computeSignal, toSignalLite, resolveState, directionOf, STATES };
