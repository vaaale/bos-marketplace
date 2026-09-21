"use strict";
// HEARTBEAT provider — CNBC spot quote. No key. US symbols ONLY (non-US
// symbol names collide — verified). Implements only fetchSpot(); it is the
// intraday liveness check (FR-010) and NEVER feeds signal computation.

const { httpRequest } = require("./http.js");

// CNBC fronts this endpoint on Akamai, which soft-blocks non-browser clients:
// Node's default fetch (undici) User-Agent returns HTTP 200 with an EMPTY body
// (`{}`) and literal "undici"/"curl" UAs return 403. A browser User-Agent is
// required for the real quote — the same lesson as nasdaq.js ("browser-ish
// headers or it 403s"). Verified live 2026-09-21.
const HEADERS = {
  "User-Agent":
    "Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/125.0.0.0 Safari/537.36",
  Referer: "https://www.cnbc.com/",
  Accept: "application/json, text/plain, */*"
};

function parseNumber(v) {
  if (v === null || v === undefined || v === "") return null;
  const n = Number(String(v).replace(/[,$%\s]/g, ""));
  return Number.isNaN(n) ? null : n;
}

const cnbc = {
  id: "cnbc",
  name: "CNBC Quote",
  requiresKey: false,
  // Last heartbeat failure cause (string), or null when the last heartbeat
  // succeeded. The adapter never throws, but a bare null with no cause is
  // exactly the no-cause-failure silence that hid the missing-UA bug — so every
  // failure path records a human-readable cause here for /api/health to surface.
  lastError: null,
  isAvailable() {
    return true;
  },
  // Returns { last, currency, time } | null. Never throws — a heartbeat
  // failure just skips the cycle (but leaves a visible lastError).
  async fetchSpot(symbolRef) {
    const sym = typeof symbolRef === "string" ? symbolRef : symbolRef.symbol;
    const url =
      "https://quote.cnbc.com/quote-html-webservice/restQuote/symbolType/symbol" +
      "?symbols=" + encodeURIComponent(sym) +
      "&requestMethod=itv&noform=1&partnerId=2&fund=1&exthrs=1&output=json";
    try {
      const res = await httpRequest(url, { headers: HEADERS, timeoutMs: 2000 }); // must complete < 2 s (NFR-002)
      const json = res.json();
      const wrap = json && (json.FormattedQuoteResult || json.QuickQuoteResult);
      let q = wrap && (wrap.FormattedQuote || wrap.QuickQuote);
      if (Array.isArray(q)) q = q[0];
      if (!q) {
        cnbc.lastError = "no quote for " + sym + " (empty or unexpected response)";
        return null;
      }
      const last = parseNumber(q.last);
      if (last === null) {
        cnbc.lastError = "no last price for " + sym;
        return null;
      }
      cnbc.lastError = null;
      return {
        last,
        currency: q.cur || q.currencyCode || "USD",
        time: Date.parse(q.last_time || q.last_time_msec || "") || Date.now()
      };
    } catch (err) {
      cnbc.lastError =
        err && err.code
          ? err.code + (err.cause ? " — " + err.cause : "")
          : String((err && err.message) || err);
      return null;
    }
  }
};

module.exports = cnbc;
