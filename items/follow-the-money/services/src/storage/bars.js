"use strict";
// Per-symbol daily-bar persistence (FR-009 / NFR-005).
// One file per instrument: data/bars/<region>/<symbol>.json
//   { symbol, currency, bars: [ PriceBar … ] }  (date-ascending)
// Upsert by (instrument, date): index existing bars by date, overwrite/insert,
// re-sort ascending, ATOMIC write via store.js. A failed symbol's file is
// never touched — this module is only called after a fully successful fetch.
// On ingest the service derives dollarVolume = volume × close (never
// provider-provided, design §2.1) and gapFlag via S9 over the merged series,
// so re-fetching a day is idempotent (no duplicate, no drift).

const path = require("node:path");
const store = require("./store.js");
const { flagGaps } = require("../signal/gaps.js");

function barsPath(dataDir, instrument) {
  return path.join(dataDir, "bars", instrument.region, instrument.symbol + ".json");
}

function readBars(dataDir, instrument) {
  const doc = store.readJSON(barsPath(dataDir, instrument), null);
  if (!doc || !Array.isArray(doc.bars)) return { symbol: instrument.symbol, currency: instrument.currency, bars: [] };
  return doc;
}

// rawBars: RawBar[] { date, open, high, low, close, volume, currency }
// Returns the merged, fully-derived bar array (date-ascending).
function upsertBars(dataDir, instrument, rawBars, thresholds) {
  const existing = readBars(dataDir, instrument);
  const byDate = {};
  for (const b of existing.bars) byDate[b.date] = b;
  for (const rb of rawBars) {
    byDate[rb.date] = {
      date: rb.date,
      open: rb.open,
      high: rb.high,
      low: rb.low,
      close: rb.close,
      volume: rb.volume,
      dollarVolume: 0, // recomputed below
      gapFlag: false
    };
  }
  const dates = Object.keys(byDate).sort();
  const bars = dates.map((d) => byDate[d]);
  const flags = flagGaps(bars.map((b) => b.close), thresholds.gapThreshold);
  for (let i = 0; i < bars.length; i++) {
    bars[i].dollarVolume = bars[i].volume * bars[i].close;
    bars[i].gapFlag = flags[i];
  }
  const currency = (rawBars.length && rawBars[rawBars.length - 1].currency) || existing.currency || instrument.currency;
  store.writeJSON(barsPath(dataDir, instrument), { symbol: instrument.symbol, currency, bars });
  return bars;
}

module.exports = { barsPath, readBars, upsertBars };
