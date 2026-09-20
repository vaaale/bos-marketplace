# Follow the Money — Troubleshooting

## "Service offline — showing last saved data"

The app is a read surface over a background service. If the banner appears:

1. Check **Settings → Plugins → Services** (or the Services panel) — the `follow-the-money` service should be *running*. Start it if stopped.
2. On a branch preview, the service starts on preview boot; give it a few seconds after a rebuild — the app polls for up to ~15 s while the service binds its port.
3. The app still works offline: it renders the last persisted signals with their as-of timestamps and this banner. Nothing is lost; it reconnects automatically.

While the service is unreachable, the key chip in the health strip reads **key: unknown** (not "not configured") — the app has no fresh data to assert either way, and it says so rather than guessing. It flips to "configured" / "not configured" as soon as the service answers again. (This is distinct from a row saying "Awaiting Data," which is a per-instrument state that only applies once the service is reachable and a key is genuinely absent.)

## Rows say "Awaiting Data"

Those instruments need the keyed market-data provider (Twelve Data) and no key is configured — this is expected, not an error. Affected symbols: the whole **Norway** region (`^OBX`, `EQNR.OL`, `DNB.OL`), the home-exchange indices (`^GDAXI`, `^FTSE`, `^FCHI`, `^N225`, `^HSI`, `^KS11`), and any **individual stock** you add under Data & Config. Nasdaq (the no-key provider) serves only ETFs and indices — it has no stock assetclass — so a user-added stock can only be fetched by the keyed fallback; with no key it waits here rather than failing silently.

- Add a free Twelve Data key under **Data & Config → Market-Data API Key**; they are fetched on the next refresh (or press **Refresh now**).
- Everything else (US, Europe/Asia proxies — 37 instruments) is fully functional with **no key**.
- **Note (pending hard gate):** this build ships the nine keyed symbols *disabled by default* because their exact Oslo/exchange ticker spellings have not yet been confirmed against Twelve Data with a live key. After adding a key, run the probe script (`services/scripts/probe-twelvedata.js`, see the dev docs) — it verifies all nine tickers (9 credits), and the confirmed ones are then enabled in the universe. Until that gate passes they remain "Awaiting Data" by design; nothing is ever fabricated.

## The data looks stale / "data is N hours old"

- Every view shows an **as-of** date. On weekends and market holidays the most recent trading day is correct — a flat close on Saturday is not a "no-move" signal.
- The service refreshes daily at 17:05 UTC (after NYSE close) and runs a liveness heartbeat every 5 minutes (the pulsing dot in the health strip).
- If the service was stopped for a while, it runs a **catch-up refresh on start** — missed days reconcile automatically (bars are upserted by date, so nothing duplicates).
- A specific symbol marked *stale* means its last fetch failed; it retries on the next cycle and its prior data is retained, never zeroed.

## What works without a key?

All of US (23 instruments), the Europe proxies (7), and the Asia proxies (7) — the full dashboard, scanner, detail, watchlist, and pulse. The key *adds* Norway, exact home-exchange index levels, and any individual stock you add (those need the keyed provider, since Nasdaq doesn't serve individual stocks no-key).

## Rate limits / 429 events in the health events list

- **Nasdaq** (primary, no key): the service paces requests 350 ms apart; on a 429 it backs off 5 s, retries once, then falls through to the fallback provider for that symbol. Events are logged in the health record.
- **Twelve Data** (keyed): free tier is 8 requests/minute and 800 credits/day. The service paces ~7.5 s between calls, honors `Retry-After`, and enforces its own daily budget (default 15 credits; the default keyed set needs only 9). If the budget is ever exhausted, remaining keyed symbols are marked *deferred* and picked up the next day — that's graceful, not an error.

## NDX shows "—" for money flow

Expected. NDX is fetched as a price-only index (no volume data), so dollar-volume metrics can't be computed for it; it participates via momentum and its chart. QQQ carries the US-tech volume read.

## A refresh seems stuck / "refresh already running"

Only one refresh runs at a time. A full default-universe refresh takes well under a minute (the very first run backfills 5 years of history and takes slightly longer). Press **Refresh now** again after it completes; the health strip's *Last refresh* timestamp updates when it lands.
