"use strict";
// PRIMARY provider — Nasdaq's own (undocumented) website API. No key.
// Endpoint: https://api.nasdaq.com/api/quote/{SYM}/chart?assetclass={etf|index}&fromdate=…&todate=…
// Requires browser-ish headers (User-Agent + Origin + Referer) or it 403s.
// Returns OHLCV rows in ohlcv[].z with string numbers containing commas and
// dateTime "M/D/YYYY". assetclass=index (NDX) is price-only -> volume 0.
// Raw (unadjusted) close only — the S9 gap detector is the split guard.
//
// assetclass is DERIVED PER INSTRUMENT (FR-017 / NFR-008): NDX (assetClass
// "index") -> "index"; individual stocks (category "stock") -> not served;
// everything else (broad/sector/proxy ETFs) -> "etf".
//
// IMPORTANT (verified live 2026-09-20): the chart endpoint accepts ONLY the
// assetclass values "etf" and "index". There is NO stock assetclass — any other
// value (including "stock") is rejected with "Bad or No parameter assetclass",
// and a real stock (AAPL/NFLX) returns "Symbol not exists" under both etf and
// index. Nasdaq therefore cannot serve individual stocks at all; the only
// stock-capable provider is the keyed fallback (Twelve Data). For a stock we
// signal NOT_FOUND so the per-symbol chain (FR-011) falls through to that
// provider instead of issuing an invalid request.

const { httpRequest, ProviderError } = require("./http.js");

const HEADERS = {
  "User-Agent":
    "Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/17.4 Safari/605.1.15",
  Origin: "https://www.nasdaq.com",
  Referer: "https://www.nasdaq.com/",
  Accept: "application/json, text/plain, */*"
};

function parseNumber(v) {
  if (v === null || v === undefined || v === "") return 0;
  if (typeof v === "number") return v;
  const n = Number(String(v).replace(/[,$\s]/g, ""));
  return Number.isNaN(n) ? 0 : n;
}

// "M/D/YYYY" -> "YYYY-MM-DD"
function parseDate(s) {
  const m = String(s).match(/^(\d{1,2})\/(\d{1,2})\/(\d{4})/);
  if (!m) return null;
  return m[3] + "-" + m[1].padStart(2, "0") + "-" + m[2].padStart(2, "0");
}

// Locate the ohlcv row array defensively (undocumented API).
function findRows(json) {
  const d = json && json.data;
  if (!d) return null;
  if (Array.isArray(d.chart)) return d.chart;
  if (Array.isArray(d.ohlcv)) return d.ohlcv;
  if (d.charts && Array.isArray(d.charts.chart)) return d.charts.chart;
  return null;
}

// Derive the assetclass for the chart endpoint from the instrument.
//   assetClass === "index"  -> "index"   (NDX; price-only, no volume)
//   category   === "stock"  -> "unsupported" (Nasdaq serves no individual
//                                  stocks; signal NOT_FOUND so the chain falls
//                                  through to the stock-capable provider)
//   anything else            -> "etf"       (broad / sector / proxy ETFs)
function resolveAssetClass(symbolRef) {
  if (symbolRef && symbolRef.assetClass === "index") return "index";
  if (symbolRef && symbolRef.category === "stock") return "unsupported";
  return "etf";
}

const nasdaq = {
  id: "nasdaq",
  name: "Nasdaq API",
  requiresKey: false,
  isAvailable() {
    return true;
  },
  // symbolRef: Instrument (uses .symbol, .category, optional .assetClass)
  async fetchDaily(symbolRef, range) {
    const assetclass = resolveAssetClass(symbolRef);
    if (assetclass === "unsupported") {
      // Nasdaq's chart endpoint has no stock assetclass; it cannot serve an
      // individual stock. Signal NOT_FOUND (before any network I/O) so the
      // per-symbol chain (FR-011) falls through to a stock-capable provider
      // rather than issuing a request the endpoint would reject.
      throw new ProviderError("NOT_FOUND", false, {
        cause: "Nasdaq chart endpoint does not serve individual stocks: " + symbolRef.symbol
      });
    }
    const url =
      "https://api.nasdaq.com/api/quote/" +
      encodeURIComponent(symbolRef.symbol) +
      "/chart?assetclass=" + assetclass +
      "&fromdate=" + range.from +
      "&todate=" + range.to;
    const res = await httpRequest(url, { headers: HEADERS });
    if (/Symbol not exists/i.test(res.text)) {
      throw new ProviderError("NOT_FOUND", false, { cause: "Symbol not exists: " + symbolRef.symbol });
    }
    const json = res.json();
    if (!json) throw new ProviderError("UNKNOWN", false, { cause: "non-JSON response" });
    const statusMsg =
      json.status && json.status.bCodeMessage && json.status.bCodeMessage[0] && json.status.bCodeMessage[0].errorMessage;
    if (statusMsg && /not exists|not found/i.test(statusMsg)) {
      throw new ProviderError("NOT_FOUND", false, { cause: statusMsg });
    }
    const rows = findRows(json);
    if (!rows) {
      if (json.data === null) throw new ProviderError("NOT_FOUND", false, { cause: "empty data for " + symbolRef.symbol });
      throw new ProviderError("UNKNOWN", false, { cause: "unrecognized chart payload" });
    }
    const bars = [];
    for (const row of rows) {
      const z = row && row.z ? row.z : row;
      if (!z) continue;
      const date = parseDate(z.dateTime || z.date);
      if (!date) continue;
      // assetclass=etf rows carry z.{open,high,low,close,volume};
      // assetclass=index rows carry only z.lastSalePrice (and row.y) — price-only.
      const close = parseNumber(
        z.close !== undefined ? z.close
          : z.value !== undefined ? z.value
            : z.lastSalePrice !== undefined ? z.lastSalePrice
              : row.y
      );
      if (!close) continue; // never persist a zero-close bar
      bars.push({
        date,
        open: z.open !== undefined ? parseNumber(z.open) : close,
        high: z.high !== undefined ? parseNumber(z.high) : close,
        low: z.low !== undefined ? parseNumber(z.low) : close,
        close,
        volume: assetclass === "index" ? 0 : parseNumber(z.volume), // index = price-only
        currency: "USD"
      });
    }
    bars.sort((a, b) => (a.date < b.date ? -1 : a.date > b.date ? 1 : 0));
    return bars;
  }
};

nasdaq.resolveAssetClass = resolveAssetClass;

module.exports = nasdaq;
