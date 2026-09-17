"use strict";
// FALLBACK provider — Twelve Data (keyed). Global coverage incl. Norway
// (^OBX, EQNR.OL, DNB.OL) and home-exchange indices. 1 credit per successful
// time_series call; 8 req/min (paced ~7.5 s by the registry); 800 credits/day
// free tier — the pipeline enforces its own dailyCreditBudget on top.

const { httpRequest, ProviderError } = require("./http.js");

const twelvedata = {
  id: "twelvedata",
  name: "Twelve Data",
  requiresKey: true,
  isAvailable(keyConfigured) {
    return Boolean(keyConfigured);
  },
  // opts: { apiKey, onCredit } — onCredit() is invoked once per successful
  // (credit-consuming) call so the pipeline can enforce the daily budget.
  async fetchDaily(symbolRef, range, opts) {
    const o = opts || {};
    if (!o.apiKey) throw new ProviderError("NO_KEY", false, { cause: "no API key configured" });
    const url =
      "https://api.twelvedata.com/time_series?symbol=" +
      encodeURIComponent(symbolRef.symbol) +
      "&interval=1day&outputsize=800&apikey=" +
      encodeURIComponent(o.apiKey);
    const res = await httpRequest(url);
    const json = res.json();
    if (!json) throw new ProviderError("UNKNOWN", false, { cause: "non-JSON response" });
    if (json.status === "error" || json.code) {
      const code = Number(json.code);
      if (code === 401) throw new ProviderError("NO_KEY", false, { cause: json.message || "401" });
      if (code === 429) {
        throw new ProviderError("RATE_LIMITED", true, { retryAfterMs: 60000, cause: json.message || "429" });
      }
      throw new ProviderError("NOT_FOUND", false, { cause: json.message || "status error" });
    }
    if (!Array.isArray(json.values)) {
      throw new ProviderError("NOT_FOUND", false, { cause: "no values for " + symbolRef.symbol });
    }
    if (typeof o.onCredit === "function") o.onCredit(); // 1 credit per successful call
    const currency = (json.meta && json.meta.currency) || symbolRef.currency || "USD";
    const bars = json.values.map((v) => ({
      date: String(v.datetime).slice(0, 10),
      open: Number(v.open),
      high: Number(v.high),
      low: Number(v.low),
      close: Number(v.close),
      volume: v.volume !== undefined && v.volume !== null ? Number(v.volume) : 0,
      currency
    }));
    bars.sort((a, b) => (a.date < b.date ? -1 : a.date > b.date ? 1 : 0)); // API is date-descending
    return bars;
  }
};

module.exports = twelvedata;
