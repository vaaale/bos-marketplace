"use strict";
// S9 — abnormal single-bar gap detection (FR-019, NFR-005). Pure.
// A >= gapThreshold (default 20%) single-day |Δclose| flags the bar as a
// probable split / data artifact; the base detector (S3) treats a flagged
// bar as a series break, never a price move.

// Returns a boolean array aligned with `closes` (index 0 is never flagged).
function flagGaps(closes, gapThreshold) {
  const flags = new Array(closes.length);
  for (let i = 0; i < closes.length; i++) {
    if (i === 0) { flags[i] = false; continue; }
    const prev = closes[i - 1];
    const pct = prev !== 0 ? Math.abs(closes[i] / prev - 1) : 0;
    flags[i] = pct >= gapThreshold;
  }
  return flags;
}

module.exports = { flagGaps };
