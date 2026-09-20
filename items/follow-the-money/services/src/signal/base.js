"use strict";
// S3 — base-level detector (FR-002). Pure. Deterministic trailing-run scan:
// work over [start..t], start = max(0, t - baseScanWindow + 1); a gap flag at
// index g resets the scan (effStart = max(start, g+1)) — a flagged gap is a
// series break, never a price move (FR-019).
//
// The base is the LONGEST RECENT CONTIGUOUS TIGHT RUN ENDING AT t (the
// invariant in design §2.3): scan backwards from t, growing the running
// (low..high) range; the first bar that pushes the normalized width past
// baseMaxWidth is a violation and the base does NOT include it — so a
// 60-day tight band preceded by a wider move IS a 60-day base. Extending the
// window backwards only grows width, so stopping at the first violation yields
// exactly that longest tight suffix. durationDays = length of the suffix,
// tightness = its final (widest) width. (The earlier all-or-nothing reading —
// present=true only if the whole scan window stayed tight — was a defect.)
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
  // Trailing-run scan: commit lower/upper/width only for bars that keep the
  // running range within baseMaxWidth; stop at the first violation (bar i is
  // excluded from the base). baseStart is the earliest committed index, so the
  // base is [baseStart..t].
  let baseStart = -1;
  let lower = Infinity;
  let upper = -Infinity;
  let width = 1;
  for (let i = t; i >= effStart; i--) {
    const lo = Math.min(lower, bars[i].close);
    const hi = Math.max(upper, bars[i].close);
    const mid = (hi + lo) / 2;
    const w = mid > 0 ? (hi - lo) / mid : 1; // normalized, currency-independent
    if (w > thresholds.baseMaxWidth) break; // first violation: base stops before bar i
    lower = lo; upper = hi; width = w; baseStart = i;
  }
  const present = baseStart >= effStart;
  if (present) {
    return {
      present: true,
      lowerBound: lower,
      upperBound: upper,
      durationDays: t - baseStart + 1,
      tightness: width,
      sufficientData
    };
  }
  return { present: false, lowerBound: null, upperBound: null, durationDays: 0, tightness: null, sufficientData };
}

module.exports = { detectBase };
