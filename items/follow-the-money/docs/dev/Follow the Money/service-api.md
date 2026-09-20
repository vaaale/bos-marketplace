# Follow the Money — Service HTTP API

Served by the worker's own HTTP server on its own port (config default `{ port: 0, host: "127.0.0.1" }` — port 0 = OS-assigned). The app resolves the base URL via `GET /api/services/follow-the-money/config` (BOS route): prefer `httpPath` (Supervisor proxy) when present, else `hostname:runtime.port` (standalone). All responses are JSON. Read endpoints always return the **last persisted** results — instant and offline-capable.

**Auth:** the service binds `127.0.0.1` and is reached by the same-container, same-user app (via the Supervisor proxy under deployment, or directly in standalone) — no separate token. A future headless/non-browser client would use BOS's loopback `/api/secrets/<service>` bridge, not a hand-rolled token scheme; out of scope in v1. Key material never appears in any response (presence booleans only).

## Read endpoints

### `GET /api/health`

```json
{ "asOf": "2026-09-16", "pipelineAlive": true, "lastHeartbeat": "…", "lastFullRefresh": "…",
  "nextRefreshAt": "…", "refreshing": false,
  "providers": [
    { "id": "nasdaq", "status": "ok", "lastRefresh": "…", "symbolsOk": 37, "symbolsFailed": 0,
      "keyRequired": false, "keyConfigured": null },
    { "id": "twelvedata", "status": "limited", "lastRefresh": null, "symbolsOk": 0, "symbolsFailed": 0,
      "keyRequired": true, "keyConfigured": false, "creditsUsedToday": 0, "dailyCreditBudget": 15 } ],
  "regions": [
    { "region": "US", "total": 23, "ok": 23, "failed": 0, "stale": 0, "asOf": "2026-09-16" },
    { "region": "Europe", "total": 10, "ok": 7, "failed": 0, "stale": 0, "asOf": "2026-09-16" },
    { "region": "Norway", "total": 3, "ok": 0, "failed": 0, "stale": 0, "asOf": null,
      "reason": "data source not configured" },
    { "region": "Asia", "total": 10, "ok": 7, "failed": 0, "stale": 0, "asOf": "2026-09-16" } ],
  "keyConfigured": false,
  "unavailable": [ { "symbol": "^OBX", "region": "Norway", "reason": "data source not configured" } ],
  "events": [ "2026-09-17T17:05:11Z twelvedata 429 retry-after 60s (EQNR.OL)" ] }
```

`regions[]` is what the HealthStrip and the config-drawer region cards render. `reason` appears when a region has zero fetched instruments and all of them are key-gated.

### `GET /api/signals?region=US`

The RegionRollup, straight from disk (see `data-model.md`): `{ region, currency, asOf, instruments: [SignalLite… ranked by moneyFlowScore desc], counts }`. Unknown region → **404**.

### `GET /api/instruments/{symbol}?region=US&lookback=3M`

Instrument deep-dive. `region` optional (cross-region symbol lookup when omitted); `lookback ∈ {3M, 6M, 1Y, 2Y}` (default `3M`) windows the series to `lookbackDays[lookback]` bars. Unknown symbol → **404**. Symbols with special characters must be URL-encoded (`%5EOBX`, `EQNR.OL`).

```json
{ "instrument": { "symbol": "SMH", "…": "…" }, "currency": "USD", "asOf": "2026-09-16", "lookback": "3M",
  "series": [ { "date": "…", "close": 0, "volume": 0, "dollarVolume": 0, "gapFlag": false } ],
  "trailingAvgDollarVolume": 0, "recentDollarVolume": 0,
  "base": { "present": true, "lowerBound": 0, "upperBound": 0, "durationDays": 0, "tightness": 0, "sufficientData": true },
  "breakout": { "present": true, "level": 0, "direction": "up", "volumeRatio": 0, "confirmed": true },
  "momentumPct": { "3M": 0, "6M": 0, "1Y": 0, "2Y": 0 },
  "score": { "moneyFlowScore": 0, "momentumScore": 0, "flowScore": 0 },
  "stale": false, "state": "breaking-out-confirmed" }
```

### `GET /api/pulse`

`{ asOf, entries: [ { symbol, region, moneyFlowScore, state, momentumPct3M, moneyFlowRatio, asOf } … ] }` — top-N cross-region entries; a region with no data contributes none.

### `GET /api/watchlist`

`{ asOf, entries: [ SignalLite … ] }` — each watchlisted symbol resolved across regions, **in config order**; empty array when the watchlist is empty.

### `GET /api/universe`

`{ instruments: [ Instrument … ] }` — merged defaults + user instruments, each with an added `availability ∈ { ok, stale, unavailable, disabled, pending }` for the config-drawer picker.

## Write endpoints

### `POST /api/refresh`

Body `{ "scope"?: "all" | "US" | "Europe" | "Norway" | "Asia" }` (default `all`). Starts the pipeline respecting the `refreshing` guard. → `{ "started": true, "refreshId": "…" }` (HTTP 202), or `{ "started": false, "refreshId": null, "reason": "refresh already running" }`.

### `GET /api/config`

**Masked** service config: `{ thresholds (full set), watchlist, customInstruments (source:"user"), cadence, keyConfigured }`. `keyConfigured` is a **per-provider** presence map over the keyed providers — e.g. `{ "twelvedata": false }` (a second keyed provider would just add a key). The key **value** is **never** included (NFR-009); this read is consistent with `GET /api/health` `providers[]`.

### `PATCH /api/config`

Body is a partial op object; each op is idempotent and independent. Responds `{ ok: true, …masked config }` (presence only — the key is never echoed) or `{ ok: false, error }` (HTTP 400).

| Op | Effect |
|---|---|
| `{ "setKey": { "providerId": "twelvedata", "apiKey": "…" } }` | writes that provider's slot in `data/secret.json` (mode 0600); response `keyConfigured` shows `{ "twelvedata": true }`. `providerId` must name a key-requiring provider from the registry (400 otherwise) |
| `{ "clearKey": { "providerId": "twelvedata" } }` | deletes that provider's slot (the secret file is removed when it was the last one) |
| `{ "thresholds": { …partial } }` | merged into the durable config; applied on the next refresh |
| `{ "cadence": { …partial } }` | merged; re-arms the in-worker scheduler immediately |
| `{ "watchlistAdd": "SMH" }` / `{ "watchlistRemove": "SMH" }` | watchlist membership |
| `{ "instrumentAdd": { symbol, region, category, provider, … } }` | adds a `source:"user"` instrument — joins the next refresh with no code change. A `category: "stock"` instrument defaults to `provider: "both"` (chain `[nasdaq, twelvedata]`) because Nasdaq serves only ETFs/indices, not individual stocks (it has no stock assetclass); the keyed, stock-capable fallback is therefore in the chain. Non-stocks default to `provider: "primary"` |
| `{ "instrumentEdit": { symbol, name?/category?/region?/enabled?/weight? } }` | edits a custom instrument, or overlays a default one |
| `{ "instrumentDisable": { "symbol": "…", "enabled": false } }` | disable/enable |
| `{ "instrumentRemove": "…" }` | **custom instruments only** — defaults can only be disabled (400 otherwise) |

Key/threshold/universe changes take effect on the **next refresh** (trigger one with `POST /api/refresh`).
