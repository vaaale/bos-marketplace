"use strict";
// The curated default universe — 46 Instruments (design §3, definitive list):
// 37 no-key via Nasdaq (US 23, Europe proxies 7, Asia proxies 7) + 9 keyed via
// Twelve Data (Norway 3, Europe home-exchange 3, Asia home-exchange 3).
//
// HARD GATE (design §8 / tasks T10): ALL 9 keyed symbols ship enabled:false.
// The research verified the Twelve Data ENDPOINT, not the exact Oslo tickers
// with a key — a wrong suffix would be NOT_FOUND and leave the one key-gated
// region permanently unavailable (fails SC-003). Run
// services/scripts/probe-twelvedata.js with a live key, record the confirmed
// tickers here, and flip enabled:true only for symbols the probe resolved.
// Until then they render "Awaiting Data" — itself the correct no-key behavior
// (FR-012 / NFR-006). Norway symbol spellings below (^OBX, EQNR.OL, DNB.OL —
// the .OL Oslo suffix) are authoritative per the design; mockup.html's Norway
// rows (EQNR.O, AKO.O, SAND.O) are illustrative only and do NOT define the
// universe.
//
// NDX is assetClass "index" on Nasdaq — price-only (no volume), so its
// dollarVolume/moneyFlowRatio are 0, it ranks on momentum only, and the app
// renders its flow as "—". QQQ carries the US-tech volume read.

function inst(symbol, name, region, category, provider, currency, extra) {
  const providerIds =
    provider === "both" ? ["nasdaq", "twelvedata"] :
    provider === "fallback" ? ["twelvedata"] :
    ["nasdaq"];
  return Object.assign(
    {
      symbol,
      name,
      region,
      category,
      provider,
      providerIds,
      currency,
      enabled: true,
      weight: null,
      source: "default"
    },
    extra || {}
  );
}

const DEFAULT_UNIVERSE = [
  // --- US broad (4) — Nasdaq, no key ---
  inst("SPY", "S&P 500 (SPDR)", "US", "broad", "primary", "USD"),
  inst("QQQ", "Nasdaq-100 (Invesco QQQ)", "US", "broad", "primary", "USD"),
  inst("IWM", "Russell 2000 (iShares)", "US", "broad", "primary", "USD"),
  inst("NDX", "Nasdaq-100 Index", "US", "broad", "primary", "USD", { assetClass: "index" }), // price-only

  // --- US sector ETFs (19) — Nasdaq, no key ---
  inst("XLK", "Technology Select", "US", "sector", "primary", "USD"),
  inst("XLE", "Energy Select", "US", "sector", "primary", "USD"),
  inst("XLF", "Financial Select", "US", "sector", "primary", "USD"),
  inst("XLV", "Health Care Select", "US", "sector", "primary", "USD"),
  inst("XLI", "Industrial Select", "US", "sector", "primary", "USD"),
  inst("XLY", "Consumer Discretionary Select", "US", "sector", "primary", "USD"),
  inst("XLP", "Consumer Staples Select", "US", "sector", "primary", "USD"),
  inst("XLU", "Utilities Select", "US", "sector", "primary", "USD"),
  inst("XLB", "Materials Select", "US", "sector", "primary", "USD"),
  inst("XLRE", "Real Estate Select", "US", "sector", "primary", "USD"),
  inst("XLC", "Communication Services Select", "US", "sector", "primary", "USD"),
  inst("SMH", "VanEck Semiconductor", "US", "sector", "primary", "USD"),
  inst("SOXX", "iShares Semiconductor", "US", "sector", "primary", "USD"),
  inst("XBI", "SPDR S&P Biotech", "US", "sector", "primary", "USD"),
  inst("XOP", "SPDR S&P Oil & Gas E&P", "US", "sector", "primary", "USD"),
  inst("XPH", "SPDR S&P Pharmaceuticals", "US", "sector", "primary", "USD"),
  inst("XME", "SPDR S&P Metals & Mining", "US", "sector", "primary", "USD"),
  inst("GDX", "VanEck Gold Miners", "US", "sector", "primary", "USD"),
  inst("ITB", "iShares U.S. Home Construction", "US", "sector", "primary", "USD"),

  // --- US-listed Europe proxies (7) — Nasdaq, no key (USD, full OHLCV) ---
  inst("EFA", "iShares MSCI EAFE", "Europe", "proxy", "primary", "USD"),
  inst("EWG", "iShares MSCI Germany", "Europe", "proxy", "primary", "USD"),
  inst("EWU", "iShares MSCI United Kingdom", "Europe", "proxy", "primary", "USD"),
  inst("EWI", "iShares MSCI Italy", "Europe", "proxy", "primary", "USD"),
  inst("EWP", "iShares MSCI Spain", "Europe", "proxy", "primary", "USD"),
  inst("EWN", "iShares MSCI Netherlands", "Europe", "proxy", "primary", "USD"),
  inst("FXN", "First Trust Energy AlphaDEX", "Europe", "proxy", "primary", "USD"), // per design §3 list

  // --- US-listed Asia proxies (7) — Nasdaq, no key (USD, full OHLCV) ---
  inst("EWJ", "iShares MSCI Japan", "Asia", "proxy", "primary", "USD"),
  inst("EWH", "iShares MSCI Hong Kong", "Asia", "proxy", "primary", "USD"),
  inst("FXI", "iShares China Large-Cap", "Asia", "proxy", "primary", "USD"),
  inst("EWA", "iShares MSCI Australia", "Asia", "proxy", "primary", "USD"),
  inst("IEMG", "iShares Core MSCI Emerging Markets", "Asia", "proxy", "primary", "USD"),
  inst("VWO", "Vanguard FTSE Emerging Markets", "Asia", "proxy", "primary", "USD"),
  inst("EEM", "iShares MSCI Emerging Markets", "Asia", "proxy", "primary", "USD"),

  // --- Keyed (Twelve Data) — 9 total, 9 credits/day. enabled:false until the
  // --- T10 hard-gate probe confirms each ticker live (see header comment). ---
  inst("^OBX", "OBX Total Return Index (Oslo)", "Norway", "broad", "fallback", "NOK", { enabled: false }),
  inst("EQNR.OL", "Equinor (Oslo)", "Norway", "stock", "fallback", "NOK", { enabled: false }),
  inst("DNB.OL", "DNB Bank (Oslo)", "Norway", "stock", "fallback", "NOK", { enabled: false }),
  inst("^GDAXI", "DAX (Deutsche Börse)", "Europe", "broad", "fallback", "EUR", { enabled: false }),
  inst("^FTSE", "FTSE 100 (LSE)", "Europe", "broad", "fallback", "GBP", { enabled: false }),
  inst("^FCHI", "CAC 40 (Euronext Paris)", "Europe", "broad", "fallback", "EUR", { enabled: false }),
  inst("^N225", "Nikkei 225 (Tokyo)", "Asia", "broad", "fallback", "JPY", { enabled: false }),
  inst("^HSI", "Hang Seng (HKEX)", "Asia", "broad", "fallback", "HKD", { enabled: false }),
  inst("^KS11", "KOSPI (KRX)", "Asia", "broad", "fallback", "KRW", { enabled: false })
];

module.exports = { DEFAULT_UNIVERSE };
