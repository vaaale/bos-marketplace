"use strict";
// S1 — momentum per lookback. Pure function of (bars, thresholds).
// n > k:  (close[t]/close[t-k] - 1) * 100, complete, barsUsed = k
// else:   (close[t]/close[0]  - 1) * 100, incomplete, barsUsed = n-1
// Short-circuits: n=0 -> all null; n=1 -> 0.

const LOOKBACK_ORDER = ["3M", "6M", "1Y", "2Y"];

function computeMomentum(bars, thresholds) {
  const n = bars.length;
  const t = n - 1;
  const momentumPct = {};
  const momentum = {};
  for (const L of LOOKBACK_ORDER) {
    const k = thresholds.lookbackDays[L];
    if (n === 0) {
      momentumPct[L] = null;
      momentum[L] = { complete: false, barsUsed: 0 };
    } else if (n === 1) {
      momentumPct[L] = 0;
      momentum[L] = { complete: false, barsUsed: 0 };
    } else if (n > k) {
      const v = (bars[t].close / bars[t - k].close - 1) * 100;
      momentumPct[L] = Number.isFinite(v) ? v : null; // zero-close guard: no NaN in output
      momentum[L] = { complete: true, barsUsed: k };
    } else {
      const v = (bars[t].close / bars[0].close - 1) * 100;
      momentumPct[L] = Number.isFinite(v) ? v : null;
      momentum[L] = { complete: false, barsUsed: n - 1 };
    }
  }
  return { momentumPct, momentum };
}

module.exports = { computeMomentum, LOOKBACK_ORDER };
