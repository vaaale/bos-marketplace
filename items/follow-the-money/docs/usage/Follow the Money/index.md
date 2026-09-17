# Follow the Money

**Follow the Money** is a multi-market sector capital-rotation scanner. It operationalizes a specific investing workflow (modeled on Felix Prehn's "follow the money" method) rather than generic charting: find which industries money is flowing into, spot the long sideways "base level" consolidations that precede large moves, and flag breakouts that are confirmed by elevated buying volume.

> **Analytical tool, not an advisor.** Follow the Money presents signals and lets *you* apply judgment — position sizing, portfolio fit, exit timing. It shows a persistent "Not Financial Advice" notice, and it never emits stock alerts or recommendations.

## The four regions

The app tracks a curated universe of 46 indices and sector/industry ETFs across four regions. Switch regions with the segmented control in the header — the dashboard, scanner, and deep-dive all re-scope, and your choice persists across reloads.

| Region | Coverage | Data source |
|---|---|---|
| **US** (23) | SPY, QQQ, IWM, NDX + 19 sector/industry ETFs (XLK, XLE, XLF, XLV, XLI, XLY, XLP, XLU, XLB, XLRE, XLC, SMH, SOXX, XBI, XOP, XPH, XME, GDX, ITB) | No key needed |
| **Europe** (10) | 7 US-listed proxies (EFA, EWG, EWU, EWI, EWP, EWN, FXN) + 3 keyed home-exchange indices (DAX, FTSE 100, CAC 40) | Proxies: no key. Home-exchange indices: key |
| **Asia** (10) | 7 US-listed proxies (EWJ, EWH, FXI, EWA, IEMG, VWO, EEM) + 3 keyed home-exchange indices (Nikkei 225, Hang Seng, KOSPI) | Proxies: no key. Home-exchange indices: key |
| **Norway** (3) | ^OBX, Equinor (EQNR.OL), DNB Bank (DNB.OL) — Oslo Børs | **Key required** — there is no liquid US-listed Nordic proxy |

The US-listed proxies are USD-denominated MSCI country/region funds that track their home indices closely; the keyed `^` symbols add the exact home-exchange index levels.

## The three signals

1. **Money-flow ranking.** Every instrument gets a composite 0–100 score blending price momentum (default 3-month) with money flow — its recent aggregate *dollar volume* (share volume × close) versus its own trailing average. A rising sector with heavy dollar volume scores high; a rising sector on thin volume scores lower. That distinction — strong versus weak money flow — is the core weekly read: *which industries is the money actually moving into?*
2. **Base level ("heartbeat").** Before a large move, an instrument tends to trade sideways in a tight horizontal range for a long time. The detector finds the recent contiguous tight run (at most ~a trading year, never across a price gap): its lower/upper bounds, duration in trading days, and tightness. A base is a *candidate* once it is at least 60 trading days long. The longer and tighter the base, the more interesting.
3. **Breakout + volume confirmation.** The actionable event: the latest close moves **above** the upper bound of a valid base (or below the lower bound — a breakdown, shown separately). A breakout is marked **confirmed** only when the breakout bar's dollar volume is at least **1.5×** its trailing 20-day average — institutions buying. Without the volume, it's flagged but *unconfirmed*.

## Using the views

Work left to right through the rail:

- **Money Flow (dashboard)** — the primary daily/weekly view. Every instrument in the active region ranked by composite score, with direction, momentum % (over your chosen lookback: 3M / 6M / 1Y / 2Y), recent dollar volume, a flow-ratio meter, and a state chip. Click column headers to re-rank by momentum or money-flow; click a row to open the deep-dive; click the star to pin to your watchlist.
- **Scanner** — the signature signal surface. Left column: instruments **breaking out** right now, confirmed ones highlighted green with their `× VOL` badge, base range, duration, and breakout level. Right column: **in-base candidates**, ranked by duration then tightness — the future watchlist. Filter chips narrow to confirmed / unconfirmed / in-base only.
- **Instrument Detail** — the verification surface before acting: price + volume chart with the detected base range shaded (blue), the breakout level marked (amber dashed), the trailing-average-volume line, and the breakout bar marker; plus a stat grid with momentum over all four lookbacks, flow ratio, base geometry, and score components. The lookback switcher re-scopes the chart window and momentum figures. Instruments with too little history say "insufficient data for base detection" — the tool never fabricates a range.
- **Watchlist** — your pinned shortlist with live score, state, and 3M momentum. It's stored in the service, so it survives reloads and rebuilds.
- **Global Rotation Pulse** (the strip under the health bar on dashboard and scanner) — the whole method condensed to a glance: the top confirmed breakouts / strongest money-flow instruments **across all four regions** this refresh, each chip tagged with its region and clickable through to detail. Regions with no data simply contribute no chips.

The **health strip** at the top always shows the data as-of time, per-region fetch counts, and whether a market-data key is configured. Every view carries the as-of timestamp — on weekends and market holidays you're seeing the most recent trading day, labeled as such.

## Key setup (unlocks Norway + home-exchange indices)

Everything above works **without any API key** for US, Europe, and Asia (via the US-listed proxies). One optional free key unlocks the rest:

1. Get a free API key from [Twelve Data](https://twelvedata.com) (free tier: 800 credits/day — this app uses at most ~9/day).
2. Open **Data & Config** (header button, or click the key chip in the health strip).
3. Paste the key under **Market-Data API Key** and click **Save key**.

The key is stored only in the service's own configuration (file mode 0600), never in the app bundle, and never displayed or echoed back — the UI only ever shows *configured / not configured*. Norway and the home-exchange indices are fetched on the **next refresh** (use **Refresh now** in the drawer to trigger one immediately).

Until a key is configured, those instruments show as **"Awaiting Data"** — deliberately, instead of fake or unlabeled-stale numbers.

## Where the data comes from

A background service fetches daily OHLCV once per day (17:05 UTC, after the NYSE close) from the Nasdaq API (no key) with Twelve Data as the keyed fallback, persists everything, computes all signals once, and serves them to the app. The app itself never talks to market-data providers and never recomputes signals — it loads instantly from the last refresh, and keeps working (clearly labeled as stale) even when the service is offline.

*Not financial advice. This is an analytical/educational decision-support tool.*
