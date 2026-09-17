#!/usr/bin/env node
"use strict";
// HARD GATE probe (design §8 / tasks T10).
// The research verified the Twelve Data ENDPOINT, not the exact Oslo tickers
// with a key. This script runs a live `time_series` probe for each of the 9
// keyed symbols (especially ^OBX / EQNR.OL / DNB.OL — a wrong suffix is
// NOT_FOUND and would leave Norway permanently unavailable, failing SC-003).
//
// Usage:  node services/scripts/probe-twelvedata.js <TWELVE_DATA_API_KEY>
//    or:  TWELVEDATA_API_KEY=… node services/scripts/probe-twelvedata.js
//
// After a successful probe: record the confirmed tickers (values + a comment
// citing the probe date/result) in services/src/universe/default-universe.js
// and set enabled:true for the symbols that resolved. Symbols that do NOT
// resolve stay enabled:false. Cost: 9 credits (one per symbol), paced 7.5 s
// apart to respect the 8 req/min free tier.

const twelvedata = require("../src/providers/twelvedata.js");
const { sleep } = require("../src/providers/http.js");

const KEYED_SYMBOLS = [
  { symbol: "^OBX", region: "Norway" },
  { symbol: "EQNR.OL", region: "Norway" },
  { symbol: "DNB.OL", region: "Norway" },
  { symbol: "^GDAXI", region: "Europe" },
  { symbol: "^FTSE", region: "Europe" },
  { symbol: "^FCHI", region: "Europe" },
  { symbol: "^N225", region: "Asia" },
  { symbol: "^HSI", region: "Asia" },
  { symbol: "^KS11", region: "Asia" }
];

async function main() {
  const apiKey = process.argv[2] || process.env.TWELVEDATA_API_KEY;
  if (!apiKey) {
    console.error("No key. Usage: node probe-twelvedata.js <API_KEY>  (or TWELVEDATA_API_KEY env var)");
    process.exit(2);
  }
  const today = new Date().toISOString().slice(0, 10);
  const results = [];
  let credits = 0;
  for (const s of KEYED_SYMBOLS) {
    try {
      const bars = await twelvedata.fetchDaily(
        { symbol: s.symbol, currency: "USD" },
        { from: "", to: today },
        { apiKey, onCredit: () => { credits += 1; } }
      );
      const last = bars[bars.length - 1];
      results.push({ symbol: s.symbol, region: s.region, ok: true, bars: bars.length, lastDate: last && last.date, lastClose: last && last.close });
      console.log(`OK        ${s.symbol.padEnd(8)} ${s.region.padEnd(7)} ${bars.length} bars, last ${last && last.date} close ${last && last.close}`);
    } catch (err) {
      results.push({ symbol: s.symbol, region: s.region, ok: false, error: (err && err.code) || String(err) });
      console.log(`FAILED    ${s.symbol.padEnd(8)} ${s.region.padEnd(7)} ${(err && err.code) || err}`);
    }
    await sleep(7500); // 8 req/min ceiling
  }
  const okCount = results.filter((r) => r.ok).length;
  console.log(`\nProbe ${today}: ${okCount}/9 resolved, ${credits} credits used.`);
  console.log("Next step: record the confirmed tickers in services/src/universe/default-universe.js");
  console.log("(comment with this probe date + result) and set enabled:true ONLY for the resolved symbols.");
  process.exit(okCount === 9 ? 0 : 1);
}

main();
