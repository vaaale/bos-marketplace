# Follow the Money — Data Model

## On-disk layout

All service state lives under the item's config subtree, in a `data/` subdirectory (outside BOS's config-route enumeration — see `architecture.md`):

```
dataDir()/system/config/follow-the-money/
├── follow-the-money.json          # BOS-owned, seeded from the item's config/: { port: 0, host: "127.0.0.1" }
├── runtime.json                   # BOS-written after the worker's "bound" IPC: { port, host } — manager-owned
└── data/                          # SERVICE-OWNED, durable
    ├── config.json                # thresholds/cadence overrides, watchlist, customInstruments, universeOverrides
    ├── secret.json                # market-data API keys, keyed BY PROVIDER: { providers: { <id>: key } }
    │                              # (mode 0600); NEVER in any response. Legacy flat shapes
    │                              # (a bare string or { apiKey }) are migrated to the keyed
    │                              # provider's slot on startup.
    ├── manifest.json              # { schemaVersion, createdAt, lastFullRefresh, universeHash, backfillDone,
    │                              #   creditsUsedToday, creditsDate, lastOkFetch }
    ├── universe/instruments.json  # merged default (46) + user instruments, snapshotted each refresh
    ├── bars/<region>/<symbol>.json     # { symbol, currency, bars: [PriceBar…] } date-ascending, upserted by date
    ├── signals/<region>/<symbol>.json  # Signal (below)
    ├── signals/regions/<region>.json   # RegionRollup
    ├── signals/pulse.json              # cross-region Pulse
    └── refresh/log.jsonl               # append-only RefreshRecord lines, bounded to the last 500
```

Dates/timestamps are UTC ISO-8601. Signals, rollups, and the pulse are fully derived — rewritten atomically each refresh.

## Entities

**Instrument** (`universe/instruments.json`, and `universe/default-universe.js` for the shipped 46):

```json
{ "symbol": "XLK", "name": "Technology Select", "region": "US", "category": "sector",
  "provider": "primary", "providerIds": ["nasdaq"], "currency": "USD",
  "enabled": true, "weight": null, "source": "default" }
```

`region ∈ {US, Europe, Norway, Asia}`, `category ∈ {broad, sector, proxy, stock}`, `source ∈ {default, user}`. `providerIds` is the ordered fetch chain. NDX additionally carries `"assetClass": "index"` (Nasdaq price-only — volume 0, flow metrics 0, app renders "—"; it ranks via its momentum component). A user-added `category: "stock"` instrument defaults to `provider: "both"` (`providerIds: ["nasdaq", "twelvedata"]`): Nasdaq serves only ETFs and indices (its chart endpoint accepts just those two assetclasses — there is no stock assetclass), so the chain must include the keyed, stock-capable fallback for a stock to fetch; without a key a stock degrades to a labeled `unavailable`, exactly like the key-gated regions.

**Default universe (46 = 37 no-key + 9 keyed):** US broad 4 (SPY, QQQ, IWM, NDX) + US sector 19 (XLK, XLE, XLF, XLV, XLI, XLY, XLP, XLU, XLB, XLRE, XLC, SMH, SOXX, XBI, XOP, XPH, XME, GDX, ITB) + Europe proxies 7 (EFA, EWG, EWU, EWI, EWP, EWN, FXN) + Asia proxies 7 (EWJ, EWH, FXI, EWA, IEMG, VWO, EEM); keyed: Norway `^OBX, EQNR.OL, DNB.OL` + Europe `^GDAXI, ^FTSE, ^FCHI` + Asia `^N225, ^HSI, ^KS11`. Per-region totals: US 23, Europe 10, Asia 10, Norway 3. The nine keyed ship `enabled:false` pending the live-probe hard gate.

**PriceBar** (inside `bars/<region>/<symbol>.json`):

```json
{ "date": "2026-09-16", "open": 179.5, "high": 181.2, "low": 178.9, "close": 180.4,
  "volume": 51234000, "dollarVolume": 9242633600, "gapFlag": false }
```

`dollarVolume = volume × close`, computed by the service (never provider-supplied). `gapFlag` set on ingest when |Δclose| ≥ 20 % (split/artifact guard on the raw, unadjusted close).

**Signal** (`signals/<region>/<symbol>.json`) — fixed key order:

```json
{ "symbol": "SMH", "region": "US", "asOf": "2026-09-16", "currency": "USD", "providerUsed": "nasdaq",
  "momentumPct": { "3M": 18.4, "6M": 24.1, "1Y": 41.3, "2Y": 58.9 },
  "momentum": { "3M": { "complete": true, "barsUsed": 63 } },
  "moneyFlowRatio": 2.1, "recentDollarVolume": 1.4e10, "trailingAvgDollarVolume": 6.7e9,
  "base": { "present": true, "lowerBound": 41.2, "upperBound": 44.9,
            "durationDays": 187, "tightness": 0.085, "sufficientData": true },
  "breakout": { "present": true, "level": 44.9, "direction": "up", "volumeRatio": 2.1, "confirmed": true },
  "score": { "moneyFlowScore": 92, "momentumScore": 88, "flowScore": 79 },
  "stale": false,
  "state": "breaking-out-confirmed" }
```

`state ∈ { in-base, breaking-out-confirmed, breaking-out-unconfirmed, trending, no-base, insufficient-data, unavailable }`, resolved in exactly that priority order with **unavailable checked first** (from the refresh record — so a fresh key-gated symbol with zero bars is `unavailable`, not `insufficient-data`). `stale` is stamped when the symbol wasn't successfully fetched this cycle but prior bars exist.

**RegionRollup** (`signals/regions/<region>.json`): `{ region, currency, asOf, instruments: [SignalLite… ranked by moneyFlowScore desc, symbol-asc tie-break], counts: { total, inBase, breakingOutConfirmed, breakingOutUnconfirmed, trending, unavailable, insufficient } }` (`trending` includes `no-base`). **SignalLite** = `{ symbol, name, category, region, direction, momentumPct, moneyFlowScore, moneyFlowRatio, recentDollarVolume, state, base|null, breakout|null, asOf }`.

**Pulse** (`signals/pulse.json`): `{ asOf, entries: [{ symbol, region, moneyFlowScore, state, momentumPct3M, moneyFlowRatio, asOf }…] }` — all `breaking-out-confirmed` plus each region's top-3 data-bearing by score, sorted (score desc, region asc, symbol asc), top 5. `unavailable`/`insufficient-data` never contribute.

**RefreshRecord** (one JSONL line per provider per refresh):

```json
{ "ts": "2026-09-17T17:05:11Z", "refreshId": "r…", "scope": "all", "provider": "nasdaq",
  "symbolsOk": 37, "symbolsFailed": 0, "keyConfigured": false, "asOf": "2026-09-17",
  "events": ["twelvedata 429 retry-after 60s (EQNR.OL)"] }
```

## AppConfig — split by home, by design

- **Client (app `localStorage`)** — UI prefs only: `{ schemaVersion, activeRegion, activeLookback, sortKey, sortDir }` (key `ftm.prefs`), plus a per-route response cache (`ftm.cache.v2:*`) for cold-open offline. (Bumped to v2 when `ServiceConfig.keyConfigured` became a per-provider map — a stale v1 cache with the old flat boolean shape would mis-render the key fields on a cold open.)
- **Server (service `data/config.json`)** — the durable, refresh-relevant config: `thresholds` (all 16 §2.3 keys: `lookbackDays {3M:63, 6M:126, 1Y:252, 2Y:504}`, `flowWindow 5`, `baselineWindow 20`, `baseMinDuration 60`, `baseMaxWidth 0.10`, `baseScanWindow 252`, `breakoutVolumeRatio 1.5`, `gapThreshold 0.20`, `momentumScale 15`, `flowScale 0.75`, `momentumWeight/flowWeight 0.5`, `pulseTopN 5`, `pulsePerRegionK 3`, `dirFlatEpsilon 0.5`, `noBaseDriftEpsilon 5`), `cadence { refreshHour 17, refreshMinute 5, heartbeatEveryMs 300000 }`, `watchlist`, `customInstruments`, `universeOverrides`.
- **The API keys** — `data/secret.json` (0600), keyed by provider (`{ providers: { <id>: key } }`), presence-only in every app-facing response: `GET /api/config` `keyConfigured` is a per-provider map and `GET /api/health` `providers[]` carry per-provider `keyConfigured`. Key values never leave the service (NFR-009).
