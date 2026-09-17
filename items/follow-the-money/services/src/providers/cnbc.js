"use strict";
// HEARTBEAT provider — CNBC spot quote. No key. US symbols ONLY (non-US
// symbol names collide — verified). Implements only fetchSpot(); it is the
// intraday liveness check (FR-010) and NEVER feeds signal computation.

const { httpRequest } = require("./http.js");

function parseNumber(v) {
  if (v === null || v === undefined || v === "") return null;
  const n = Number(String(v).replace(/[,$%\s]/g, ""));
  return Number.isNaN(n) ? null : n;
}

const cnbc = {
  id: "cnbc",
  name: "CNBC Quote",
  requiresKey: false,
  isAvailable() {
    return true;
  },
  // Returns { last, currency, time } | null. Never throws — a heartbeat
  // failure just skips the cycle.
  async fetchSpot(symbolRef) {
    const sym = typeof symbolRef === "string" ? symbolRef : symbolRef.symbol;
    const url =
      "https://quote.cnbc.com/quote-html-webservice/restQuote/symbolType/symbol" +
      "?symbols=" + encodeURIComponent(sym) +
      "&requestMethod=itv&noform=1&partnerId=2&fund=1&exthrs=1&output=json";
    try {
      const res = await httpRequest(url, { timeoutMs: 2000 }); // must complete < 2 s (NFR-002)
      const json = res.json();
      const wrap = json && (json.FormattedQuoteResult || json.QuickQuoteResult);
      let q = wrap && (wrap.FormattedQuote || wrap.QuickQuote);
      if (Array.isArray(q)) q = q[0];
      if (!q) return null;
      const last = parseNumber(q.last);
      if (last === null) return null;
      return {
        last,
        currency: q.cur || q.currencyCode || "USD",
        time: Date.parse(q.last_time || q.last_time_msec || "") || Date.now()
      };
    } catch (err) {
      return null;
    }
  }
};

module.exports = cnbc;
