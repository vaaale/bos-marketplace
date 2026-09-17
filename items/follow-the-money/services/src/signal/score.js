"use strict";
// S6 — composite money-flow score (FR-005). Pure, bounded 0..100,
// monotonic in both inputs, deterministic.
// momentumScore = 50 + 50*tanh(momentumPct3M / momentumScale)   (50 at 0%)
// flowScore     = 50 + 50*tanh((moneyFlowRatio - 1) / flowScale) (50 at 1.0×)
// moneyFlowScore = clamp(round(wM*momentumScore + wF*flowScore), 0, 100)
// S1 short-circuit: momentumPct3M null (n=0) -> moneyFlowScore 0.

function computeScore(momentumPct3M, moneyFlowRatio, thresholds) {
  if (momentumPct3M === null || momentumPct3M === undefined) {
    return { moneyFlowScore: 0, momentumScore: 0, flowScore: 0 };
  }
  const momentumScore = 50 + 50 * Math.tanh(momentumPct3M / thresholds.momentumScale);
  const flowScore = 50 + 50 * Math.tanh((moneyFlowRatio - 1.0) / thresholds.flowScale);
  const raw = Math.round(thresholds.momentumWeight * momentumScore + thresholds.flowWeight * flowScore);
  const moneyFlowScore = Math.min(100, Math.max(0, raw));
  return { moneyFlowScore, momentumScore, flowScore };
}

module.exports = { computeScore };
