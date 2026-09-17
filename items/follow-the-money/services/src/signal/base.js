"use strict";
// S3 — base-level detector (FR-002). Pure. Deterministic backwards-scan:
// work over [start..t], start = max(0, t - baseScanWindow + 1); a gap flag at
// index g resets the scan (effStart = max(start, g+1)) — a flagged gap is a
// series break, never a price move (FR-019). Extending the window backwards
// only grows width, so the first width violation means "band broke open ->
// not in base" (present=false). Otherwise the base is the tight run
// [effStart..t]: durationDays = t-effStart+1, tightness = final width.
// Insufficient data: n < baseMinDuration + baselineWindow -> sufficientData=false.

function detectBase(bars, thresholds) {
  const n = bars.length;
  const t = n - 1;
  const sufficientData = n >= thresholds.baseMinDuration + thresholds.baselineWindow;
  if (n === 0) {
    return { present: false, lowerBound: null, upperBound: null, durationDays: 0, tightness: null, sufficientData: false };
  }
  const start = Math.max(0, t - thresholds.baseScanWindow + 1);
  // largest index <= t with gapFlag; the base may not extend to or before g
  let g = -1;
  for (let i = t; i >= start; i--) {
    if (bars[i].gapFlag) { g = i; break; }
  }
  const effStart = Math.max(start, g + 1);
  let lower = Infinity;
  let upper = -Infinity;
  let width = 1;
  let present = false;
  for (let i = t; i >= effStart; i--) {
    if (bars[i].close < lower) lower = bars[i].close;
    if (bars[i].close > upper) upper = bars[i].close;
    const mid = (upper + lower) / 2;
    width = mid > 0 ? (upper - lower) / mid : 1; // normalized, currency-independent
    if (width > thresholds.baseMaxWidth) { present = false; break; } // band broke open
    present = true;
  }
  if (present) {
    return {
      present: true,
      lowerBound: lower,
      upperBound: upper,
      durationDays: t - effStart + 1,
      tightness: width,
      sufficientData
    };
  }
  return { present: false, lowerBound: null, upperBound: null, durationDays: 0, tightness: null, sufficientData };
}

module.exports = { detectBase };
