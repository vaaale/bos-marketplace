"use strict";
// S4 + S5 — breakout detector + volume confirmation (FR-003/FR-004). Pure.
// The last close is tested against a VALID PRECEDING base (detected over
// bars[0..t-1] and satisfying baseMinDuration), so a one-bar "base" can never
// manufacture a breakout. Up = close over the upper bound; down (breakdown,
// separate state) = close under the lower bound.
// Confirmation: volumeRatio = dollarVolume[t] / mean(dollarVolume[t-baselineWindow..t-1]);
// confirmed iff volumeRatio >= breakoutVolumeRatio (default 1.5×). Zero /
// absent baseline -> ratio 0 -> not confirmed.

const { detectBase } = require("./base.js");

function mean(values) {
  if (values.length === 0) return 0;
  let sum = 0;
  for (const v of values) sum += v;
  return sum / values.length;
}

function detectBreakout(bars, thresholds) {
  const none = { present: false, level: null, direction: null, volumeRatio: 0, confirmed: false };
  const n = bars.length;
  const t = n - 1;
  if (n < 2) return none;
  const basePrev = detectBase(bars.slice(0, t), thresholds);
  const validPrev =
    basePrev.present &&
    basePrev.durationDays >= thresholds.baseMinDuration &&
    n - 1 >= thresholds.baseMinDuration;
  if (!validPrev) return none;

  let direction = null;
  let level = null;
  if (bars[t].close > basePrev.upperBound) {
    direction = "up";
    level = basePrev.upperBound;
  } else if (bars[t].close < basePrev.lowerBound) {
    direction = "down";
    level = basePrev.lowerBound;
  } else {
    return none;
  }

  const fromIdx = Math.max(0, t - thresholds.baselineWindow);
  const trailValues = [];
  for (let i = fromIdx; i <= t - 1; i++) trailValues.push(bars[i].dollarVolume);
  const trailingAvg = mean(trailValues);
  const volumeRatio = trailingAvg > 0 ? bars[t].dollarVolume / trailingAvg : 0;
  const confirmed = volumeRatio >= thresholds.breakoutVolumeRatio;
  return { present: true, level, direction, volumeRatio, confirmed };
}

module.exports = { detectBreakout };
