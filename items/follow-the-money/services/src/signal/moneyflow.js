"use strict";
// S2 — money-flow ratio. Pure.
// recent   = mean(dollarVolume[t-flowWindow+1 .. t])            (last 5 bars)
// trailing = mean(dollarVolume[t-flowWindow-baselineWindow+1 .. t-flowWindow])
// The recent window is excluded from its own trailing baseline so a
// breakout-day spike does not inflate its own reference.
// Ratio is 0 when the baseline is zero or absent.

function mean(values) {
  if (values.length === 0) return 0;
  let sum = 0;
  for (const v of values) sum += v;
  return sum / values.length;
}

function computeMoneyFlow(bars, thresholds) {
  const n = bars.length;
  const t = n - 1;
  if (n === 0) {
    return { moneyFlowRatio: 0, recentDollarVolume: 0, trailingAvgDollarVolume: 0 };
  }
  const fw = thresholds.flowWindow;
  const bw = thresholds.baselineWindow;
  const recentStart = Math.max(0, t - fw + 1);
  const recentValues = [];
  for (let i = recentStart; i <= t; i++) recentValues.push(bars[i].dollarVolume);
  const recent = mean(recentValues);

  const trailEnd = t - fw; // inclusive
  let trailing = 0;
  if (trailEnd >= 0) {
    const trailStart = Math.max(0, t - fw - bw + 1);
    const trailValues = [];
    for (let i = trailStart; i <= trailEnd; i++) trailValues.push(bars[i].dollarVolume);
    trailing = mean(trailValues);
  }
  const moneyFlowRatio = trailing > 0 ? recent / trailing : 0;
  return { moneyFlowRatio, recentDollarVolume: recent, trailingAvgDollarVolume: trailing };
}

module.exports = { computeMoneyFlow };
