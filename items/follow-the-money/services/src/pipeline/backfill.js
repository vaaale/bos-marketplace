"use strict";
// Backfill / incremental range resolution. A symbol with no persisted history
// gets a one-time 5-yr backfill; otherwise the fetch is incremental from a
// few days before its last persisted bar (upsert makes the overlap harmless).

const { readBars } = require("../storage/bars.js");

function isoDate(d) {
  return d.toISOString().slice(0, 10);
}

// Returns { from, to, backfill } for the instrument's next fetch.
function neededRange(dataDir, instrument, now) {
  const nowDate = now instanceof Date ? now : new Date(now);
  const to = isoDate(nowDate);
  const existing = readBars(dataDir, instrument);
  if (!existing.bars.length) {
    const from = new Date(nowDate.getTime());
    from.setUTCFullYear(from.getUTCFullYear() - 5); // one-time 5-yr backfill
    return { from: isoDate(from), to, backfill: true };
  }
  const lastDate = existing.bars[existing.bars.length - 1].date;
  const from = new Date(lastDate + "T00:00:00Z");
  from.setUTCDate(from.getUTCDate() - 7); // overlap a week; upsert is idempotent
  return { from: isoDate(from), to, backfill: false };
}

module.exports = { neededRange, isoDate };
