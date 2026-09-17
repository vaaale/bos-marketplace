# Design — Follow the Money

> Multi-region money-flow / sector capital-rotation scanner.
> Companion to `spec.md` (requirements) and `mockup.html` (visual contract).
> This document is **implementation-ready**: the Developer builds from it plus `spec.md`. It contains no source code — only component design, data model, module plan, API contract, connectivity design, ADRs, and risks.

**Item id:** `follow-the-money` (the service facet's `service.json` `id` MUST equal this — BOS's `installService()` rejects a mismatch; every `/api/services/<id>/...` and `__supervisor/services/<id>/...` path below uses `follow-the-money`).
**Display name (docs facet folder, both audiences):** `Follow the Money` — the folder name is a UI label rendered verbatim in the Docs sidebar; use the spaced display name, not the slug.

---

## 1. Classification & context

**App Target: `marketplace-item`** — one installable item in the user's own `user-apps` marketplace, installed by a **single** `app_build` call with **three facets**. Nothing lives in BOS source; no `dev_delegate`; no `src/` change.

| Facet | What it is | Runs in |
|---|---|---|
| **app** | The investment dashboard — an iframe UI (React allowed for the app facet; the Developer bundles it). The **read surface**: renders precomputed signals, offers region/lookback switching, watchlist, detail, and a config drawer. | The Next.js app process as an installed app (iframe). |
| **service** | A **background Node worker-thread daemon** — plain Node, **CommonJS** (committed — see §4), **unbundled, outside Next.js entirely**. It fetches OHLCV from providers, persists bars, computes all signals, and serves them over **its own HTTP API on its own port**. | A worker-thread service process spawned by `ServiceManager.ts` via `new Worker(entryPath)`, bound to its own configurable port. |
| **docs** | End-user + developer pages, shipped inside the item under `docs/usage/<Name>` and `docs/dev/<Name>`. | Rendered by the Docs app overlay at read time. |

**The one load-bearing separation:** the **service is the engine** (fetch → persist → compute → serve), the **app is the read surface**. The app never talks to external providers and never recomputes signals on view. This gives instant loads (FR load < 2 s), deterministic signals computed once per refresh, and graceful offline degradation (last persisted signals + as-of + stale warning, NFR-004).

**The service's container is a worker thread, not a Next.js route.** This sidesteps every "Next.js can't do X" limitation: it runs continuously (cron), makes outbound provider calls, and serves an arbitrary JSON HTTP API — none of which require `src/` involvement. The worker entry is **unbundled** and therefore **cannot `import` any BOS-source TypeScript module** (e.g. `@/lib/secrets/*`, `@/os/vfs`). It is self-contained plain Node with no BOS imports. (Constraint 1.)

---

## 2. Component design

### 2.1 Provider adapters (NFR-008)

Providers are **pluggable modules** behind one interface. A new provider is a **new module registered in the provider registry — not a refactor**.

**Adapter interface (canonical, normalized output):**

```
interface ProviderAdapter {
  id: string;                      // "nasdaq" | "twelvedata" | "cnbc" | <future>
  name: string;
  requiresKey: boolean;            // twelvedata=true; nasdaq/cnbc=false
  isAvailable(keyConfigured: boolean): boolean;   // twelvedata -> keyConfigured
  fetchDaily(symbol: SymbolRef, range: { from: string; to: string }): Promise<RawBar[]>;
  //   Returns date-ascending normalized bars. Throws a structured ProviderError.
  fetchSpot?(symbol: SymbolRef): Promise<{ last: number; currency: string; time: number } | null>;
  //   Optional — only cnbc implements (heartbeat). Heartbeat only, never for signals.
}
```

`RawBar` (normalized, date-ascending, currency-independent geometry):
```
{ date: "YYYY-MM-DD", open: number, high: number, low: number,
  close: number, volume: number (shares), currency: string }
```
`dollarVolume` is **not** provided by the adapter — it is computed in the service (`volume × close`) so the data layer stays provider-agnostic (research caveat: volume is raw shares; the service derives dollar volume).

**`ProviderError` (structured, drives retry/fall-through):**
```
{ code: "RATE_LIMITED" | "NOT_FOUND" | "UNAUTHORIZED" | "NO_KEY"
        | "TRANSIENT" | "UNKNOWN",
  retryable: boolean,
  retryAfterMs?: number,           // present on RATE_LIMITED (honor provider's Retry-After)
  cause?: string }
```

**The three adapters (per the verified research report, 2026-09-17):**

| Adapter | `id` | Key | Endpoint | Notes |
|---|---|---|---|---|
| Nasdaq (PRIMARY, no-key) | `nasdaq` | no | `https://api.nasdaq.com/api/quote/{SYM}/chart?assetclass=etf&fromdate=…&todate=…` | Requires **User-Agent + Origin + Referer** headers (`https://www.nasdaq.com`). Returns JSON OHLCV in `ohlcv[].z` (string numbers with commas → parse). 5-yr history verified. **No adjusted close** (raw close only). `assetclass=index` is price-only (no volume) — use only where volume is not needed. |
| Twelve Data (FALLBACK, keyed) | `twelvedata` | yes | `https://api.twelvedata.com/time_series?symbol=…&interval=1day&outputsize=800&apikey=…` | Global incl. Norway (`EQNR.OL`, `DNB.OL`) + OBX (`^OBX`) + home-exchange indices (`^GDAXI`,`^FTSE`,`^FCHI`,`^N225`,`^HSI`,`^KS11`). 1 credit/call; 8 req/min; 800 credits/day. `adj_close=1` available (future use). |
| CNBC (HEARTBEAT, no-key) | `cnbc` | no | `https://quote.cnbc.com/quote-html-webservice/restQuote/symbolType/symbol` | Spot only (`last`, `cur`, `exchange`, `last_time`). **US symbols only** (non-US collides — verified). Used solely as the liveness heartbeat; never feeds signals. |

**Explicitly NOT used:** Stooq and Yahoo (IP-blocked from this sandbox — verified). Alpha Vantage (25/day) and EODHD (20/day) free tiers are below the 46-symbol daily need. (Constraint 5.)

### 2.2 Fetch / persist pipeline

**Per-symbol provider resolution + fallback + retry (FR-011, NFR-003):**

Each `Instrument` declares a **provider chain** (ordered), derived from its `providerIds`:
- `both` → `[nasdaq, twelvedata]`
- `primary` → `[nasdaq]`
- `fallback` → `[twelvedata]`

For a symbol, walk the chain in order:
1. **Availability check:** if the provider `requiresKey` and no key is configured → `NO_KEY` → skip to next provider.
2. **Fetch with retry/backoff:** on `TRANSIENT`/`RATE_LIMITED` → exponential backoff (default base 5 s × 2^attempt, honoring `retryAfterMs` on 429), max 3 attempts. `RATE_LIMITED` on Nasdaq → back off 5 s, retry once, then fall through. `RATE_LIMITED` on Twelve Data → wait `Retry-After`, retry, max 3, then fall through.
3. **`NOT_FOUND`** (e.g. Nasdaq "Symbol not exists") → fall through to the next provider for that symbol.
4. On success → record `providerUsed` for the symbol (FR-011 "per-symbol provider selection recorded") and proceed to upsert + signal.
5. If the chain is exhausted with no success and no provider was available due to missing key → mark the symbol **"unavailable — data source not configured"**, retain prior signal stamped **stale**, log to the refresh event list. (US5/Edge cases.)

**Credit accounting (NFR-007, ≤ 9 credits/day):** only the keyed provider (`twelvedata`) consumes credits — 1 per successful `time_series` call. The pipeline tracks `creditsUsedToday` (reset at local UTC midnight) and enforces a **`dailyCreditBudget`** (default 15, far under the 800 free tier). When the budget is exhausted for the day, remaining keyed symbols are marked **"deferred — credit budget"** (not an error) and picked up the next day. At the default universe the keyed set is exactly 9 symbols (`^OBX`, `EQNR.OL`, `DNB.OL`, `^GDAXI`, `^FTSE`, `^FCHI`, `^N225`, `^HSI`, `^KS11`) → **9 credits/day**, satisfying NFR-007.

**Rate-limit pacing (NFR-003):**
- Nasdaq: **350 ms** spacing between requests (verified clean for 30+ sequential). A 37-symbol no-key refresh ≈ 13 s — far under any hidden limit.
- Twelve Data: **~7.5 s** spacing (8 req/min ceiling). 9 keyed symbols ≈ 68 s.

**Atomicity / no data corruption (NFR-003, NFR-005):** bars are upserted **per symbol** and each symbol's file is rewritten **only after a fully successful fetch** for that symbol (atomic write: write temp → rename). A failed symbol leaves its prior file untouched — **never zeroed**. A partial refresh commits the successful majority and re-attempts failures next cycle.

**Cadence (FR-010, NFR-002):**
- **Daily full refresh:** scheduled after market close — default **17:05 UTC** (≈ 1:05 pm ET, post-NYSE close, so the day's bar is final; configurable `refreshHour`/`refreshMinute`). On worker start, if `lastFullRefresh` is older than one trading day, run a **catch-up** (fetch each symbol's latest few bars, upsert). A full backfill (one-time, 5 yr per symbol) runs when a symbol has no persisted history yet.
- **Intraday heartbeat:** every **5 min**, a single CNBC spot quote (NDX) → sets `pipelineAlive` and `lastHeartbeat`. Non-critical: a failure just skips the cycle. Completes < 2 s (NFR-002).
- Scheduling is `setInterval`/`setTimeout` in the worker (no external cron). An in-process `refreshing` guard prevents overlap; a file lock under the data dir is optional cross-version safety.

**NFR-002 budget check (default universe, 46 instruments = 37 no-key + 9 keyed):** Nasdaq 37 symbols × 350 ms ≈ 13 s; Twelve Data 9 symbols × 7.5 s ≈ 68 s; backfill only on first run. Total well under 5 min.

### 2.3 Signal engine (the core IP)

All signal modules are **pure functions** of `(bars[], config)` — no `Date.now()`, no randomness, no external I/O. This is what makes them deterministic (NFR-011) and testable on synthetic series (NFR-010). The engine runs **in the service**, once per refresh (ADR-d).

**Canonical inputs (per instrument):** bars sorted **date-ascending**; each bar has `close`, `volume`, `dollarVolume (= volume×close)`, `gapFlag`. Let `t` be the index of the last bar, `bars.length = n`.

**Config defaults (all overridable via config, §2.6 / ADR):**

| Key | Default | Meaning |
|---|---|---|
| `lookbackDays` | `{"3M":63,"6M":126,"1Y":252,"2Y":504}` | trading-day window per lookback |
| `flowWindow` | `5` | "recent" bars for money-flow ratio |
| `baselineWindow` | `20` | trailing baseline bars (FR-004 / flow) |
| `baseMinDuration` | `60` | min trading days for a valid base |
| `baseMaxWidth` | `0.10` | max normalized width (10 % of mid) for a base |
| `baseScanWindow` | `252` | max history a base may span |
| `breakoutVolumeRatio` | `1.5` | min volume ratio to confirm a breakout (FR-004) |
| `gapThreshold` | `0.20` | single-day |Δclose| that flags a gap (FR-019) |
| `momentumScale` | `15` | tanh scale for momentum score |
| `flowScale` | `0.75` | tanh scale for flow score |
| `momentumWeight` / `flowWeight` | `0.5` / `0.5` | composite blend |
| `pulseTopN` | `5` | cross-region pulse size (FR-021) |
| `pulsePerRegionK` | `3` | per-region strongest added to pulse pool |
| `dirFlatEpsilon` | `0.5` | |momentum %| below which the direction indicator is "flat" (percent) |
| `noBaseDriftEpsilon` | `5` | |1Y momentum %| above which a no-base instrument is "no-base" vs "trending" (percent) |

---

**S1. Momentum per lookback.** For lookback `L` with `k = lookbackDays[L]`:
```
if n > k:  momentumPct[L] = (close[t] / close[t-k] - 1) * 100;  complete = true; barsUsed = k
else:      momentumPct[L] = (close[t] / close[0] - 1) * 100;     complete = false; barsUsed = n-1
```
"Uses whatever history exists, labeled by length" (Edge case). `t-k` and `0`-indexed; no sub-sampling. **Short-circuit:** `n=0` → all `momentumPct[L] = null` and `moneyFlowScore = 0` (no fabrication); `n=1` → `momentumPct[L] = 0`; every window index is floored at `0`; an empty or zero trailing baseline → ratio `0` (S2) / confirmation ratio `0` (S5).

**S2. Money-flow ratio** (the "Flow Ratio" column; recent dollar volume vs its own trailing baseline):
```
recent = mean( dollarVolume[t-flowWindow+1 … t] )            // last 5 bars, inclusive
trailing = mean( dollarVolume[t-flowWindow-baselineWindow+1 … t-flowWindow] )  // 20 bars before the recent window
moneyFlowRatio = trailing > 0 ? recent / trailing : 0
```
Exclude the last bar from its own trailing baseline so a breakout-day spike doesn't inflate its own reference. `0` when baseline is zero/absent.

**S3. Base-level detector** (FR-002) — "recent horizontal consolidation ending now." Deterministic backwards-scan:
```
// Work over the trailing window [start..t], start = max(0, t - baseScanWindow + 1)
// Reset at gap flags: let g = largest index ≤ t with gapFlag; base may not extend before g.
effStart = max(start, g+1)
lower = +inf, upper = -inf
present = false
for i from t down to effStart:
    lower = min(lower, close[i]); upper = max(upper, close[i])
    mid = (upper + lower) / 2
    width = mid > 0 ? (upper - lower) / mid : 1          // normalized, currency-independent
    if width > baseMaxWidth: present = false; break       // band broke open -> not in base
    present = true
if present:
    duration = t - effStart + 1                            // trading days in the tight run
    tightness = width                                       // final (widest) width of the run
    base = { present:true, lowerBound:lower, upperBound:upper,
             durationDays:duration, tightness, sufficientData: true }
    // A base is "valid" (a candidate/scannable base) iff duration >= baseMinDuration
else:
    base = { present:false, …, sufficientData:true }
```
Invariant: extending the window backwards only grows `width`, so the loop stops at the first violation — the base is exactly the longest recent contiguous tight run ending at `t`, and it cannot cross a `gapFlag` (FR-019: a flagged gap is a **series break**, resetting the base, never a fake breakout).

**Insufficient data:** if `n < baseMinDuration + baselineWindow` → `sufficientData=false` → state **insufficient-data** (no fabricated range, no false breakout; US4).

**S4. Breakout detector** (FR-003) — test the last close against a **valid preceding** base (base detected over `[.. t-1]`, i.e. the bar before the current one):
```
basePrev = detectBase(bars[0..t-1])          // same routine, t replaced by t-1
if basePrev.present && basePrev.durationDays >= baseMinDuration && n-1 >= baseMinDuration:
    if close[t] > basePrev.upperBound:  breakout = { present:true, level:basePrev.upperBound, direction:"up",   … }
    elif close[t] < basePrev.lowerBound: breakout = { present:true, level:basePrev.lowerBound, direction:"down", … }   // breakdown, separate state
    else:  breakout = { present:false, … }
else: breakout = { present:false, … }
```
A breakout **up** requires the close to have crossed the upper bound; a **down** (breakdown) crosses the lower bound. The preceding base must have satisfied `baseMinDuration` so that a one-bar "base" can't manufacture a breakout.

**S5. Breakout volume confirmation** (FR-004):
```
trailingAvg = mean( dollarVolume[t-baselineWindow … t-1] )     // 20 bars before the breakout bar
breakout.volumeRatio = trailingAvg > 0 ? dollarVolume[t] / trailingAvg : 0
breakout.confirmed   = breakout.volumeRatio >= breakoutVolumeRatio   // default 1.5×
```
Confirmed only when the breakout bar's dollar volume is ≥ threshold × its own trailing average (institutions buying). No volume → not confirmed.

**S6. Composite money-flow score (0–100)** (FR-005) — bounded, monotonic in both inputs, deterministic:
```
momentumScore = 50 + 50 * tanh( momentumPct["3M"] / momentumScale )      // 0..100, 50 at 0%
flowScore     = 50 + 50 * tanh( (moneyFlowRatio - 1.0) / flowScale )     // 0..100, 50 at 1.0×
moneyFlowScore = clamp( round( momentumWeight*momentumScore + flowWeight*flowScore ), 0, 100 )
```
`Math.tanh` is available in plain Node. Components (`momentumScore`, `flowScore`) are persisted for transparency/detail view. A rising sector with high volume scores high; a rising sector with thin volume scores lower — the "strong vs weak money flow" distinction (US1, SC).

**S7. State (enum) — resolution order (deterministic).** The per-symbol availability flag comes from the refresh record (was a bar fetched this cycle?) and MUST be checked **FIRST**, so a fresh key-gated symbol (no prior data, `n=0`) classifies as `unavailable`, not `insufficient-data` — the default no-key Norway case the UI renders as "Awaiting Data" (FR-012 / NFR-006 / SC-003):
```
0. if symbol unavailable this refresh (no provider data this cycle)
       -> "unavailable"      // if prior bars exist: retain them + stamp `stale` + asOf = last good date
1. elif n < baseMinDuration + baselineWindow                    -> "insufficient-data"
2. elif breakout.present && breakout.confirmed                 -> "breaking-out-confirmed"
3. elif breakout.present && !breakout.confirmed                -> "breaking-out-unconfirmed"
4. elif base.present && base.durationDays >= baseMinDuration   -> "in-base"
5. elif base.present == false and abs(momentumPct["1Y"]) > noBaseDriftEpsilon -> "no-base"
6. else                                                       -> "trending"   // moving, not a tight base
```
`noBaseDriftEpsilon` defaults to `5` (percent): a `base.present==false` instrument with a clear 1Y directional drift is `no-base`, otherwise `trending`.
`direction` (up/flat/down indicator) = sign of `momentumPct[activeLookback]` (flat when |value| < `dirFlatEpsilon`, default `0.5` percent).

**S8. Cross-region pulse** (FR-021) — computed in the service (ADR-f), persisted each refresh:
```
dataBearing = instruments whose state ∈ { breaking-out-confirmed, breaking-out-unconfirmed, in-base, trending, no-base }
             // i.e. EXCLUDES "unavailable" and "insufficient-data" (a no-data region contributes zero, by construction)
pool = every instrument with state == "breaking-out-confirmed" (any region)
     ∪ per region, the top-pulsePerRegionK-by-moneyFlowScore from that region's dataBearing instruments not already in pool
sort pool by (moneyFlowScore desc, region asc, symbol asc)   // deterministic tie-break
pulse = top pulseTopN
```
Each entry: `{ symbol, region, moneyFlowScore, state, momentumPct3M, moneyFlowRatio, asOf }`. **Regions with no data contribute no entries and cause no error** (SC-009).

**S9. Abnormal-gap detection** (FR-019, NFR-005) — on ingest, per new bar `i>0`:
```
pct = abs( close[i]/close[i-1] - 1 )
gapFlag[i] = pct >= gapThreshold          // default 0.20
```
A ≥ 20% single-day move in an ETF is almost always a split or a data artifact (a 3:1 split shows as ≈ −66%); a modest dividend (< ~5%) does **not** flag. Because Nasdaq returns **raw (unadjusted)** close, this is the split/dividend guard. `gapFlag` bars reset the base detector (S3) — a flagged gap is a series break, not a price move, so it never produces a fake breakout.

**Testability (NFR-010 / SC-007 / SC-002):** because S1–S9 are pure, the test suite feeds a synthetic series engineered to sit in a known base then break out with a known volume ratio, and asserts the exact base bounds, breakout state, confirmation state, and score. Re-running on an identical input must yield byte-identical signal JSON (determinism). **Determinism guardrail:** the Signal / RegionRollup / Pulse builders MUST emit JSON with a **fixed key-insertion order** and iterate only over **arrays** (never `for…in` over object-keyed or `Set` collections, whose iteration order is not guaranteed) so "byte-identical" actually holds. This is implemented in the service (`services/src/signal/`), not the app.

### 2.4 Storage layout (on-disk)

The service persists to a **durable, per-item data dir** inside the item's own config subtree. The worker is handed `configDirPath` (= `dataDir()/system/config/follow-the-money/`) in its `initialize` IPC; it stores data under a **`data/` subdirectory** there (ADR-c). Storing under `data/` (a subdirectory) — and **not** as loose top-level `*.json` — is deliberate: BOS's `GET /api/services/<id>/config` enumerates only top-level `*.json` files in the config dir and returns their values **verbatim**, so keeping data + the API key in a `data/` subdir means none of it is exposed through the BOS config route.

```
dataDir()/system/config/follow-the-money/
├── follow-the-money.json          # BOS-owned, seeded from item config/ defaults: { port: 0, host: "127.0.0.1" }
├── runtime.json                   # BOS-written by ServiceManager after the worker's "bound" IPC: { port, host }. Manager-owned; never edited by the service.
└── data/                          # SERVICE-OWNED, durable (not read by the BOS config route)
    ├── config.json                # service-managed: thresholds, universe edits, watchlist, activeRegion/activeLookback defaults, keyConfigured
    ├── secret.json                # the market-data API key (chmod 0600); NEVER returned by any app-facing response (NFR-009)
    ├── manifest.json              # { schemaVersion, createdAt, lastFullRefresh, universeHash, backfillDone }
    ├── universe/
    │   └── instruments.json       # merged default (46) + user-added Instruments (FR-006/FR-017)
    ├── bars/
    │   └── <region>/<symbol>.json # { symbol, currency, bars: [ PriceBar … ] }  (date-ascending, upserted by date)
    ├── signals/
    │   ├── <region>/<symbol>.json # Signal (per instrument, §3)
    │   ├── regions/<region>.json  # RegionRollup (ranked list + asOf + counts)
    │   └── pulse.json             # cross-region pulse (S8)
    └── refresh/
        └── log.jsonl              # append-only RefreshRecord lines, bounded (keep last 500)
```

- **Bars:** one JSON file per symbol. Upsert by `(instrument, date)`: load the existing array, index by date, overwrite/insert, re-sort ascending, atomic write. Idempotent — re-fetching a day does not duplicate or drift (NFR-005).
- **Signals / rollups / pulse:** rewritten atomically each refresh (they are fully derived). The app reads these precomputed — no live recomputation on view (FR-009).
- **Refresh log:** JSONL, one `RefreshRecord` per provider-per-refresh; bounded so it can't grow unbounded.
- **Durations/keys use UTC ISO-8601** strings; `secret.json` is mode `0600`.

**Why not VFS / why not the item code folder:** VFS is the user's sandbox/docs content root — bars are service-internal state, not user documents, so VFS (and its loopback `/api/fs`) is the wrong home. The item code folder (`data/user-apps/items/follow-the-money/`) is the user's GitFS repo and is read-only-ish content (the `app/`, `services/`, `docs/` facets) — runtime data doesn't belong in it. The `data/` subdir under the item's config subtree is durable, per-user isolated, and branch-coupled (a preview build gets its own `dataDir()`, so the preview's service has its own data — the correct behavior).

### 2.5 Service HTTP API contract (on the service's own port)

All responses JSON, served by the worker's own HTTP server. Paths are appended to the base URL the app resolves (§2.6 / §5). All read endpoints return the **last persisted** results (instant, offline-capable).

| Method + path | Purpose | Returns |
|---|---|---|
| `GET /api/health` | Data-health / liveness (FR-016, US5) | `Health` (§3) |
| `GET /api/signals?region=US` | Region money-flow ranking (FR-001) | `RegionRollup` (ranked `SignalLite[]` by score desc) |
| `GET /api/instruments/{symbol}?region=US&lookback=3M` | Instrument detail (FR-008) | `InstrumentDetail` (series + base + breakout + volume + momentum) |
| `GET /api/pulse` | Cross-region pulse (FR-021) | `Pulse` |
| `GET /api/watchlist` | The user's watchlist, each symbol resolved to its cross-region `SignalLite` (FR-015) | `{ asOf, entries: [ SignalLite, … ] }` (config order) |
| `GET /api/universe` | Universe + per-symbol availability (FR-006, config drawer picker) | `{ instruments: Instrument[] }` |
| `POST /api/refresh` | Trigger a refresh now (FR-013) | `{ started: boolean, refreshId, reason? }` (body: `{ scope?: "all" \| region }`) |
| `GET /api/config` | Service config — **masked** (thresholds, universe, watchlist, `keyConfigured`) (FR-014) | `ServiceConfig` (key never returned) |
| `PATCH /api/config` | Set/clear the market-data key · thresholds · cadence · watchlist add/remove · add, edit, disable or remove a custom instrument | `{ ok: true }` + new masked values (`keyConfigured` presence only) |

**Request/response shapes:**

```
GET /api/health ->
{ asOf: "2026-09-16", pipelineAlive: true, lastHeartbeat: "2026-09-17T17:05:00Z",
  lastFullRefresh: "2026-09-17T17:05:11Z", nextRefreshAt: "2026-09-18T17:05:00Z",
  providers: [
     { id:"nasdaq",    status:"ok",     lastRefresh:"…", symbolsOk:37, symbolsFailed:0, keyRequired:false, keyConfigured:null },
     { id:"twelvedata",status:"limited",lastRefresh:"…", symbolsOk:9,  symbolsFailed:0, keyRequired:true,  keyConfigured:false, creditsUsedToday:9, dailyCreditBudget:15 } ],
  regions: [                                  // per-region summary — the source the HealthStrip + config-drawer region cards render (FR-016)
     { region:"US",      total:23, ok:23, failed:0, stale:0, asOf:"2026-09-16" },
     { region:"Europe",  total:10, ok:10, failed:0, stale:0, asOf:"2026-09-16" },
     { region:"Asia",    total:10, ok:10, failed:0, stale:0, asOf:"2026-09-16" },
     { region:"Norway",  total:3,  ok:0,  failed:0, stale:0, asOf:null, reason:"data source not configured" } ],
  keyConfigured: false,
  unavailable: [ { symbol:"^OBX", region:"Norway", reason:"data source not configured" }, … ],
  events: [ "2026-09-17T17:05:11Z twelvedata 429 retry-after 60s (EQNR.OL)" ] }

GET /api/signals?region=US ->
{ region:"US", currency:"USD", asOf:"2026-09-16",
  instruments: [ SignalLite (ranked by moneyFlowScore desc), … ],
  counts: { total:23, inBase:6, breakingOutConfirmed:3, breakingOutUnconfirmed:2, trending:10, unavailable:0, insufficient:2 } }

SignalLite ->
{ symbol, name, category, region, direction:"up"|"down"|"flat",
  momentumPct: { "3M","6M","1Y","2Y" }, moneyFlowScore, moneyFlowRatio,
  recentDollarVolume, state, base: {present,lowerBound,upperBound,durationDays,tightness} | null,
  breakout: {present,level,direction,volumeRatio,confirmed} | null, asOf }

GET /api/instruments/SMH ->
{ instrument: Instrument, currency:"USD", asOf:"2026-09-16",
  series: [ { date, close, volume, dollarVolume, gapFlag } … ],   // windowed by lookback
  trailingAvgDollarVolume, recentDollarVolume,
  base: { present, lowerBound, upperBound, durationDays, tightness, sufficientData },
  breakout: { present, level, direction, volumeRatio, confirmed },
  momentumPct: { "3M","6M","1Y","2Y" },
  score: { moneyFlowScore, momentumScore, flowScore },
  state }

GET /api/pulse ->
{ asOf:"2026-09-16",
  entries: [ { symbol:"SMH", region:"US", moneyFlowScore:92, state:"breaking-out-confirmed", momentumPct3M:18.4, moneyFlowRatio:2.1 }, … ] }   // top N, all regions

GET /api/watchlist ->
{ asOf:"2026-09-16",
  entries: [ SignalLite, … ] }   // each watchlisted symbol resolved across regions, in config order; empty array if the watchlist is empty

GET /api/config ->
{ thresholds: { baseMinDuration, baseMaxWidth, breakoutVolumeRatio, baselineWindow, flowWindow,
                lookbackDays, gapThreshold, dirFlatEpsilon, noBaseDriftEpsilon,
                momentumScale, flowScale, momentumWeight, flowWeight, pulseTopN, pulsePerRegionK },
  watchlist: [ symbol, … ],
  customInstruments: [ Instrument (source:"user") ],
  cadence: { refreshHour, refreshMinute, heartbeatEveryMs },
  keyConfigured: boolean }          // presence only — the key value is NEVER included

PATCH /api/config — body is a partial op object; each op is idempotent and independent:
{ "setKey": { "apiKey": "…" } }            -> writes data/secret.json (mode 0600); response { ok, keyConfigured:true }
{ "clearKey": true }                        -> deletes data/secret.json; response { ok, keyConfigured:false }
{ "thresholds": { …partial… } }             -> merge into data/config.json thresholds
{ "cadence": { …partial… } }                -> merge into cadence
{ "watchlistAdd": symbol } / { "watchlistRemove": symbol }
{ "instrumentAdd": Instrument }             -> add a custom (source:"user") instrument to the universe
{ "instrumentEdit": { symbol, …fields } }   -> edit name / category / region / enabled / weight
{ "instrumentRemove": symbol }              -> remove a CUSTOM instrument (defaults cannot be removed, only disabled)
{ "instrumentDisable": { symbol, enabled:false } }
Key ops return presence only — the key value is NEVER echoed back (NFR-009).
```

**Auth:** the service binds to `127.0.0.1` and is reached by the same-origin app (via the Supervisor proxy under deployment, or directly in standalone) — no separate token is required for the app↔service calls (the app is same-container, same-user). If a future headless/non-browser client needs authenticated access, that uses BOS's loopback `/api/secrets/<service>` bridge (mint in-browser, verify per-request) — **not** a hand-rolled worker-thread token scheme (which would fail Bastion routing). Out of scope for v1.

### 2.6 App ↔ service connectivity (how the app resolves the port / proxy path)

**This follows `docs/dev/apps/services.md` §11 exactly — no invented URL/path.** The service binds its **own** port; the app must not hardcode it.

**Step 1 — reachability bootstrap (BOS API, same-origin):** the app calls
```
GET /api/services/follow-the-money/config
```
which returns:
```
{ configFiles: [ { name:"follow-the-money", values:{ port:0, host:"127.0.0.1" } } ],
  runtime:   { port: 44231, host: "127.0.0.1" },   // the ACTUALLY-bound port (OS-assigned since config port=0); null only mid-bind
  readOnly: false,
  configSchema: { … },
  wsPath:   "/__supervisor/services/follow-the-money/ws",   // present when supervisorEnabled(), else null
  httpPath: "/__supervisor/services/follow-the-money/" }    // present when supervisorEnabled(), else null
```
The app uses **only** `runtime`, `httpPath`, `wsPath` (and the non-sensitive `values.port`/`host`) from this endpoint — it does **not** surface the sensitive config files here (the service's own `data/`-dir config is read via the service's masked `/api/config`).

**Step 2 — build the service base URL, preferring the proxy path, falling back to the raw port.** (If `data.runtime` is `null` — the worker is mid-bind after a fresh install/restart — **poll** the same `GET /api/services/follow-the-money/config` every ~1 s for up to ~15 s before treating the service as offline; this is a transient binding window, not an error.)
```
const httpBaseUrl = data.httpPath
  ? `${location.origin}${data.httpPath}`          // Supervisor-fronted (Bastion / Docker / Dokploy)
  : `${location.protocol}//${location.hostname}:${data.runtime.port}/`;  // standalone (plain npm run dev)
```
(For completeness the WS variant mirrors the doc: `data.wsPath ? wsScheme://location.host+data.wsPath : wsScheme://location.hostname:runtime.port` — this service is plain HTTP, so `httpPath`/the HTTP form is what the app uses.)

All subsequent app→service calls are `fetch(\`${httpBaseUrl}api/health\`)`, `…/api/signals?region=…`, etc.

**The three deployment scenarios (must be supported, not just one):**

| Scenario | Service base URL the app builds | Why |
|---|---|---|
| **Multi-user Bastion** (reverse-proxied) | `https://<external-hostname>/__supervisor/services/follow-the-money/` | Only the Supervisor's public port is TLS-terminated/exposed; `httpPath` proxies to the service's dynamic port. The external host:port is whatever the operator's front door publishes (typically `:443`) — never the internal `8090`. |
| **Supervisor only, no Bastion** (single-user Docker/Dokploy) | `http://<hostname>:<public-port>/__supervisor/services/follow-the-money/` | `<public-port>` = `BOS_PUBLIC_PORT` if set (else Supervisor default `8080`) — confirm per deployment, never assume. |
| **Standalone, no Supervisor** (plain `npm run dev` / `next start`) | `http://localhost:<runtime.port>/` | `httpPath`/`wsPath` are both `null`; fall back to `location.hostname:runtime.port`. **`runtime.port` is never a fixed number** — with config `port:0` it is OS-assigned and changes every restart; never write a specific port into the app or docs as if stable. |

**Graceful offline (NFR-004):** if the service is unreachable (worker stopped, or `runtime` null after the poll window), the app **still** works — it was served its last persisted data on its previous open, and on a cold open it shows the last persisted signals it can read + their `asOf` + a visible **"data is N hours old / service offline"** banner, rather than an error page. (The app keeps a small client-side cache of the last successful fetches to enable the cold-open case; the primary offline story is the service persisting results it then serves.)

### 2.7 App facet design (read surface)

React (allowed for the app facet). The mockup is the visual contract — dark terminal theme, the exact CSS token palette, and the color semantics: **green = up / inflow, red = down / outflow, amber = neutral / unconfirmed, blue = in-base**. The app is a pure client of the service API; all formatting is presentational (currency label, momentum sign, ratio meter), all signal logic lives in the service.

- **Shell** (`App.tsx`): header (brand, "Not Financial Advice" pill — FR-018, region + lookback segmented controls — FR-007, "Data & Config" button), the always-visible **HealthStrip**, the **PulseStrip** beneath it, left rail (4 views + Data Health), main view router.
- **Views:**
  - **Dashboard** (`Dashboard.tsx`, FR-001/SC-001): ranked money-flow table for the active region — `#`, instrument, category, dir, momentum % (active lookback, sortable), money-flow (recent $ volume), flow-ratio meter, state chip, watchlist star. Sort by score / momentum / flow.
  - **Scanner** (`Scanner.tsx`, FR-002/003/004): two columns — **Breaking Out** (confirmed + unconfirmed, with base range, duration, breakout level, volume ratio) and **In Base — Candidates** (ranked by duration desc then width asc; "tightest in region" / "longest base" tags). Filter chips by state.
  - **Instrument Detail** (`Detail.tsx` + `Chart.tsx`, FR-008): price + volume SVG chart with the base range shaded/bracketed (blue), the breakout level dashed (amber), the trailing-avg-volume line, the breakout-bar marker; a stat grid (momentum ×4 lookbacks, recent $ volume, flow ratio, base duration/width, breakout level); lookback switcher re-scopes the window + momentum; "insufficient data" placeholder when `sufficientData=false`.
  - **Watchlist** (`Watchlist.tsx`, FR-015): personal list with score + state + 3M momentum, add/remove.
  - **PulseStrip** (`PulseStrip.tsx`, FR-021/SC-009): a compact, always-visible horizontal strip pinned just under the HealthStrip on both the **dashboard** and **scanner** views — the app's signature element, the at-a-glance "where is the money rotating globally" read. Renders up to `pulseTopN` chips from `GET /api/pulse`, left-to-right by score: each chip = uppercase region tag (region color) + symbol + money-flow score + a mini state glyph (green dot = confirmed breakout, amber = strong flow). Chips are clickable → the instrument's detail view. A region with no data contributes no chips (no placeholder, no error). NOTE: `mockup.html` predates this strip; **this bullet is the binding visual spec for it** — the app Developer builds this element from this description, not from the mockup.
- **ConfigDrawer** (`ConfigDrawer.tsx`, FR-012/016/017): provider health + per-region cards (from `/api/health.regions`), market-data key entry (presence-only display; write via service `/api/config`), add-instrument form, detection-threshold inputs.
- **State & persistence:** UI prefs (active region, active lookback, sort) in the app's own `localStorage` (persist across reloads — FR-007). Watchlist/thresholds/universe/key are **server-side** (service `data/config.json`), so they survive app rebuilds and are the source of truth the service reads on refresh.
- **`serviceClient.ts`** is the single place that does the reachability bootstrap (§2.6) and exposes typed fetchers; every component goes through it.

---

## 3. Data model

### Entities & on-disk representation

**Instrument** — `data/universe/instruments.json` (array). Merges the curated default universe (from research §6) with user-added instruments (FR-006/FR-017).
```
{ "symbol":"XLK", "name":"Technology Select", "region":"US", "category":"sector",
  "provider":"primary",            // "primary" | "fallback" | "both"
  "providerIds":["nasdaq"],        // ordered chain; derived from provider but overridable
  "currency":"USD", "enabled":true, "weight":null,
  "source":"default" }             // "default" | "user"
```
Region ∈ {US, Europe, Norway, Asia}. Category ∈ {broad, sector, proxy, stock}. `providerIds` is the source of the per-symbol chain (§2.2).

**PriceBar** — inside `data/bars/<region>/<symbol>.json` (one file per instrument; array date-ascending).
```
{ "symbol":"XLK", "currency":"USD",
  "bars":[ { "date":"2026-09-16", "open":179.5, "high":181.2, "low":178.9, "close":180.4,
             "volume":51234000, "dollarVolume":9242633600, "gapFlag":false }, … ] }
```
`dollarVolume = volume × close` (computed by the service). `gapFlag` set by S9 on ingest. Upserted by `(instrument, date)`.

**Signal** — `data/signals/<region>/<symbol>.json`.
```
{ "symbol":"SMH", "region":"US", "asOf":"2026-09-16", "currency":"USD", "providerUsed":"nasdaq",
  "momentumPct":{ "3M":18.4,"6M":24.1,"1Y":41.3,"2Y":58.9 },
  "momentum":{ "3M":{"complete":true,"barsUsed":63}, … },
  "moneyFlowRatio":2.1, "recentDollarVolume":1.4e10, "trailingAvgDollarVolume":6.7e9,
  "base":{ "present":true,"lowerBound":41.20,"upperBound":44.90,
           "durationDays":412,"tightness":0.085,"sufficientData":true },
  "breakout":{ "present":true,"level":44.90,"direction":"up","volumeRatio":2.1,"confirmed":true },
  "score":{ "moneyFlowScore":92,"momentumScore":88,"flowScore":79 },
  "stale":false,
  "state":"breaking-out-confirmed" }
```
`state` ∈ { `in-base`, `breaking-out-confirmed`, `breaking-out-unconfirmed`, `trending`, `no-base`, `insufficient-data`, `unavailable` }. `stale` is true when the symbol's last successful fetch is older than one trading day (FR-012 / ADR-e).

**RegionRollup** — `data/signals/regions/<region>.json` (the ranked list the dashboard reads).
```
{ "region":"US","currency":"USD","asOf":"2026-09-16",
  "instruments":[ SignalLite, … (ranked by moneyFlowScore desc) ],
  "counts":{ … } }
```

**Pulse** — `data/signals/pulse.json`. `{ "asOf":"2026-09-16", "entries":[ {symbol, region, moneyFlowScore, state, momentumPct3M, moneyFlowRatio}, … ] }`.

**RefreshRecord** — `data/refresh/log.jsonl` (one JSON line each; bounded to last 500).
```
{"ts":"2026-09-17T17:05:11Z","scope":"all","provider":"twelvedata","symbolsOk":9,"symbolsFailed":0,
 "creditsUsedToday":9,"keyConfigured":false,"asOf":"2026-09-16",
 "events":["429 retry-after 60s (EQNR.OL)","budget cap not reached"]}
```

**AppConfig (split by home, by design):**
- **Client-side (app `localStorage`)** — UI prefs only: `activeRegion`, `activeLookback`, `sortKey`, `sortDir`, `schemaVersion`. Persist across reloads (FR-007).
- **Server-side (service `data/config.json`)** — the durable, refresh-relevant config (FR-014/017): `thresholds` (the full set in §2.3 incl. `dirFlatEpsilon`, `noBaseDriftEpsilon`, `gapThreshold`, the score scales/weights, and the pulse params), `cadence { refreshHour, refreshMinute, heartbeatEveryMs }`, `watchlist [symbol]`, `customInstruments [Instrument]`, `keyConfigured: boolean`. Managed via the service's masked `/api/config` GET/PATCH.
- **The market-data API key** — `data/secret.json` (0600), **presence-only** in every app-facing response (NFR-009).

**Default universe (46 instruments = 37 no-key + 9 keyed; definitive list, counts reconciled across §2.2/§3/§4):**
- US broad (4): SPY, QQQ, IWM, NDX — Nasdaq. **NDX is `assetclass=index` → price-only (no volume)**, so `dollarVolume`/`moneyFlowRatio` are `0` and the app renders its flow as "—"; NDX ranks on momentum only. QQQ (an ETF) carries the US-tech volume read.
- US sector ETFs (19): XLK, XLE, XLF, XLV, XLI, XLY, XLP, XLU, XLB, XLRE, XLC, SMH, SOXX, XBI, XOP, XPH, XME, GDX, ITB (all verified reachable) — Nasdaq.
- US-listed Europe proxies (7): EFA, EWG, EWU, EWI, EWP, EWN, FXN — Nasdaq (USD, full OHLCV).
- US-listed Asia proxies (7): EWJ, EWH, FXI, EWA, IEMG, VWO, EEM — Nasdaq (USD, full OHLCV).
  - **No-key total: 4 + 19 + 7 + 7 = 37** (US 23, Europe 7, Asia 7, Norway 0).
- **Keyed (Twelve Data) — 9 total, 9 credits/day:** Norway: `^OBX`, `EQNR.OL`, `DNB.OL`; Europe home-exchange: `^GDAXI`, `^FTSE`, `^FCHI`; Asia home-exchange: `^N225`, `^HSI`, `^KS11`.
  - Region assignment for keyed indices: `^GDAXI/^FTSE/^FCHI` → Europe; `^N225/^HSI/^KS11` → Asia; `^OBX`/`EQNR.OL`/`DNB.OL` → Norway. Norway has **no** no-key substitute (no liquid US Nordic ETF) — it is fully key-gated.
  - **Per-region totals (keyed added):** US 23, Europe 10, Asia 10, Norway 3 → **46**.
  - **Norway symbol spellings are authoritative here** (`^OBX`, `EQNR.OL`, `DNB.OL` — the `.OL` Oslo suffix per the research report). The `mockup.html` Norway rows (`EQNR.O`, `AKO.O`, `SAND.O`) are **illustrative only** and do **not** define the universe. **HARD GATE (see §8):** before the first backfill, a live keyed probe MUST confirm each Oslo ticker resolves on Twelve Data; a wrong suffix = `NOT_FOUND` = the symbol permanently `unavailable`, which would fail the one key-gated region (SC-003).

---

## 4. File / module plan (ONLY what this item creates)

```
follow-the-money/                                  # item root → data/user-apps/items/follow-the-money/
├── app/                                           # ---- APP FACET (React, bundled by app_build) ----
│   └── src/
│       ├── main.tsx                               # entry; mounts into document.getElementById("root")
│       ├── App.tsx                                # shell: header + HealthStrip + PulseStrip + rail + view router
│       ├── index.css                              # dark terminal theme (mockup token palette)
│       ├── lib/
│       │   ├── serviceClient.ts                   # reachability bootstrap (§2.6) + typed fetchers; the ONLY app→service path
│       │   ├── types.ts                           # TS types mirroring the service contract (§2.5, §3)
│       │   └── format.ts                          # currency / momentum / ratio / date formatting
│       └── components/
│           ├── HealthStrip.tsx                    # as-of + per-region dots + key chip (FR-016)
│           ├── PulseStrip.tsx                     # cross-region pulse strip (FR-021/SC-009)
│           ├── RegionBar.tsx                      # region + lookback segmented controls (FR-007)
│           ├── Dashboard.tsx                      # ranked money-flow table (FR-001)
│           ├── Scanner.tsx                        # breaking-out + in-base columns (FR-002/003/004)
│           ├── Detail.tsx                         # instrument detail view (FR-008)
│           ├── Chart.tsx                          # SVG price+volume+base+breakout chart
│           ├── Watchlist.tsx                      # personal list (FR-015)
│           └── ConfigDrawer.tsx                   # providers / region cards / key / add instrument / thresholds
│
├── services/                                      # ---- SERVICE FACET (plain Node, UNBUNDLED) ----
│   ├── service.json                               # { id:"follow-the-money", entry:"src/index.js",
│   │                                                #   configSchema:{ port:{default:0}, host:{default:"127.0.0.1"} },
│   │                                                #   settingsRegistration:{ label:"Follow the Money" } }
│   ├── package.json                               # { "type": "commonjs" } — pins CommonJS so the unbundled worker does not default-misparse ESM `import` syntax
│   └── src/                                       # CommonJS (require); NO BOS-source imports; self-contained
│       ├── index.js                               # worker entry: parentPort guard (CH-011),
│       │                                          #   initialize → read configDirPath + follow-the-money.json → bind
│       │                                          #   HTTP → postMessage {initialized} then {bound,port,host}; dispose; crash-safe
│       ├── http/
│       │   └── server.js                          # route table → /api/health,signals,instruments,pulse,watchlist,universe,refresh,config
│       ├── pipeline/
│       │   ├── scheduler.js                       # daily cron (17:05 UTC default) + 5-min heartbeat (setInterval/timeout)
│       │   ├── refresh.js                         # full-refresh orchestration: per-symbol chain resolve → fetch → upsert → signal; partial-failure isolation
│       │   └── backfill.js                        # initial / catch-up history (5 yr per symbol, one-time)
│       ├── providers/
│       │   ├── registry.js                        # id→adapter map; resolve per-symbol chain + availability
│       │   ├── nasdaq.js                          # PRIMARY no-key (headers, assetclass, parse ohlcv[].z, map errors)
│       │   ├── twelvedata.js                      # FALLBACK keyed (apikey, outputsize, credits, 8/min pacing)
│       │   ├── cnbc.js                            # HEARTBEAT spot (US only)
│       │   └── http.js                            # shared fetch: headers, timeout, 429/retry-after, ProviderError mapping
│       ├── signal/                                # PURE functions of (bars, config) — deterministic, testable
│       │   ├── engine.js                          # orchestrates S1–S9 → Signal; state resolution; fixed-key JSON emit
│       │   ├── momentum.js                        # S1
│       │   ├── moneyflow.js                       # S2
│       │   ├── base.js                            # S3
│       │   ├── breakout.js                        # S4 + S5 (confirmation)
│       │   ├── score.js                           # S6 (composite 0–100)
│       │   ├── pulse.js                           # S8 (cross-region)
│       │   └── gaps.js                            # S9 (abnormal-gap detection)
│       ├── storage/
│       │   ├── store.js                           # atomic read/write (write-temp → rename); mkdir -p
│       │   ├── bars.js                            # per-symbol bar upsert by (instrument,date)
│       │   ├── signals.js                         # Signal / RegionRollup / Pulse writers (fixed key order)
│       │   └── refreshlog.js                      # bounded JSONL append
│       ├── config/
│       │   └── defaults.js                        # all §2.3 defaults + cadence + budget + host/port
│       └── universe/
│           └── default-universe.js                # the curated 46 Instruments (research §6; 37 no-key + 9 keyed)
│
├── config/
│   └── follow-the-money.json                      # BOS-seeded config defaults: { "port": 0, "host": "127.0.0.1" }
│
└── docs/
    ├── usage/Follow the Money/
    │   ├── index.md                               # what it is, the 4 regions, the 3 signals, how to use, key setup, NFA
    │   └── troubleshooting.md                     # service not running, awaiting-data, stale warning, no key
    └── dev/Follow the Money/
        ├── architecture.md                        # facets, provider/signal/storage design, connectivity
        ├── data-model.md                          # §3 entities + on-disk layout
        └── service-api.md                         # §2.5 HTTP contract
```

**Build/install (for the architect's own record — the Developer only stages this):** `agent_delegate(developer, contentOnly:true)` stages the above into a fresh dir (trigger phrase "write a BOS app project … staging directory"; React importable for the app facet, not npm-installed), then `app_build({ name:"Follow the Money", dir, icon })` — the **one** call installs all three facets, commits to the active feature branch, creates the `system/follow-the-money` symlink, esbuild-bundles the app entry, and registers + validates the service (the branch's preview starts it on boot). A feature branch is required (elicit via `dev_branch_request` first). `service.json.id` and the item dir name are both `follow-the-money`.

---

## 5. Integration points (existing BOS mechanisms this item merely CALLS)

The item **calls** these; it does not modify them.

1. **`GET /api/services/follow-the-money/config`** (Next.js API route) — the reachability bootstrap: the app reads `runtime.port` (actually-bound port), `httpPath`/`wsPath` (Supervisor proxy, non-null under `supervisorEnabled()`), and the non-sensitive `values.{port,host}`. **Source of truth for app→service connectivity** (services.md §10/§11/§12). The app reads only these fields; it does not surface sensitive config from here.
2. **Service lifecycle** (`ServiceManager.ts` / `src/core/service/*`) — BOS spawns the worker via `new Worker(entryPath)`, sends `initialize { configDirPath, logsPath, serviceId }`, expects `initialized` then `bound {port,host}` (→ writes `runtime.json`), handles `dispose`, and does crash recovery. The item's `service.json` is what gets registered. No `service_install` call — `app_build` registers + validates it.
3. **BOS-owned config file** `dataDir()/system/config/follow-the-money/follow-the-money.json` — seeded from the item's `config/` defaults at install (035-install-by-symlink); managed by the Settings → Plugins → Services panel / the config route PATCH. Holds **only** `port` (default `0`) and `host`.
4. **`dataDir()`** (`@/os/data-dir`) — resolves to `BOS_DATA_DIR` override or `<cwd>/data`. The item derives its service data dir from the `configDirPath` it is handed (which is already under `dataDir()/system/config/follow-the-money/`), so it inherits the correct per-version/per-branch root with no extra wiring. (Under a Supervisor preview, `BOS_DATA_DIR` points at the branch clone → the preview's service has its own data — intended.)
5. **(Not used by design, for the record):** the item does **not** use the VFS (`/api/fs`) for bars — service-internal state doesn't belong in the user's VFS; it does **not** use the `/api/secrets/<service>` headless-auth bridge in v1 (the app is same-origin/same-container); it does **not** opt into `deploymentMode:"tools"` (no native assistant tools required by the spec).

---

## 6. ADRs

**ADR-a — Provider primary/fallback split (Nasdaq primary + Twelve Data keyed fallback).**
Nasdaq API is the primary because it is open (no key), verified reachable from this sandbox, returns full OHLCV **with volume** (required for dollar-volume flow), and has 5-yr history. Stooq/Yahoo are IP-blocked (verified); Alpha Vantage (25/day) and EODHD (20/day) free tiers are below the 46-symbol daily need. Norway and home-exchange indices have **no no-key source** (no liquid US-listed Nordic ETF), so they must come from a keyed, global, well-documented provider → Twelve Data (free, 800 credits/day, 8 req/min) as the **fallback**. The split keeps the product **fully functional with no key** (US + Europe/Asia via US-listed proxy ETFs) and makes the key optional — unlocking only the one region that can't otherwise be covered (Norway) plus exact home-exchange index levels. Adapter isolation (NFR-008) means the split is a configuration of the chain, not a fork.

**ADR-b — Service port defaults to `0` + proxy-path connectivity.**
A configurable port MUST default to **`0`** (OS-assigned), never a fixed number: a fixed default collides with BOS's reserved ranges (dev `3000`; Supervisor `BOS_PUBLIC_PORT` `8080/8090` + the base/preview pool **3000–3020**) — this exact collision (a service defaulting to `3001`, the first preview-pool slot) caused a real production `EADDRINUSE` incident. `0` lands in the OS ephemeral range, never in those. Because the service binds its **own** port and that port is **not directly reachable** once BOS is behind a reverse proxy, the app resolves the actually-bound port from `runtime` and **prefers `httpPath`/`wsPath`** (Supervisor proxy) when present, falling back to direct `host:port` only in standalone (services.md §11 — no invented URL). This is the documented, production-correct pattern.

**ADR-c — Bars/signals persist in the service's own per-item data dir (not VFS, not the app).**
The worker is handed `configDirPath`; it persists under `configDirPath/data/` — durable, per-user isolated, branch-coupled (a preview gets its own `dataDir()`), and reachable with no BOS imports. Two deliberate sub-decisions: (1) a **`data/` subdirectory** keeps bars/signals/**and the API key** out of BOS's config-route enumeration (which returns top-level `*.json` verbatim) — the key must never leak (NFR-009), and (2) **not** the VFS, because bars are service-internal state, not user sandbox/documents content, and the VFS loopback (`/api/fs`) is the wrong tool for it. The app is a read-only surface and persists nothing signal-related (only UI prefs in `localStorage`).

**ADR-d — Deterministic signal computation lives in the service, not the app.**
NFR-011 (byte-identical output for identical input) and NFR-010 (synthetic-series testability) require isolated **pure** functions of `(bars, config)` with no I/O, `Date.now()`, or randomness — the app's runtime is the wrong home (provider timing, bundling, and view-frequency would defeat determinism and the < 2 s load NFR). Computing once per refresh in the worker means signals are persisted, served instantly, and available offline (NFR-004). The app renders cached results and does **no** signal math — only presentational formatting.

**ADR-e — Norway / key-gating degrades to a labeled "awaiting data source," never silent or fabricated.**
When no key is configured, the keyed provider is unavailable. Norway instruments (and any home-exchange index) are marked **`unavailable`** with reason "data source not configured", **contribute no pulse entries**, and their prior signals (if any) are **retained and stamped stale** (`stale:true` on the Signal) — not dropped, not zeroed, never presented without the label (NFR-006, FR-012, US3). The rest of the product (US, Europe, Asia via proxies) is fully functional no-key. Adding a key via the config drawer unlocks them on the next refresh (FR-012, US7).

**ADR-f — Cross-region pulse computed in the service and persisted.**
The pulse (FR-021/SC-009) is a function of **all four regions'** signals. Computing it in the service makes it part of the persisted, deterministic signal set (NFR-011), so it loads instantly, is available offline (NFR-004), and the app doesn't have to fetch and merge all four regions client-side (which would also be fragile to a mid-merge offline). The app just renders `GET /api/pulse`. Regions without data contribute no entries and cause no error.

---

## 7. Risks & mitigations

| Risk | Likelihood / impact | Mitigation |
|---|---|---|
| **Nasdaq API is undocumented** (internal nasdaq.com API; no SLA/changelog) — could break or change schema at any time | Medium / high | Adapter isolation → a Nasdaq schema break is one module to fix. Twelve Data fallback covers every critical symbol. Per-symbol `providerUsed` logging + `/api/health` make breakage visible fast. Conservative 350 ms pace avoids triggering hidden limits. |
| **Twelve Data free-tier limits** (8 req/min, 800 credits/day) | Low / medium | Only 9 keyed symbols by default → 9 credits/day (NFR-007). ~7.5 s spacing honors 8/min. Honor `Retry-After` on 429. A `dailyCreditBudget` (15) cap turns an overrun into a graceful "deferred" (not an error). Keyed symbols are the fallback-only set, so a limit hit never touches the no-key 37. |
| **Market holidays / weekends** | High / low | Refresh runs post-close; the **as-of** timestamp is surfaced on every view (FR-020). A flat close is **not** treated as a "no-move" signal without the date context — the signal engine operates on the last trading bar, and `asOf` carries the date. If the latest bar date < the expected last trading day, health flags the region **stale**. |
| **Data freshness** (stale bars if a refresh is missed) | Medium / medium | Intraday heartbeat (5 min) confirms the pipeline is alive. `asOf` per region/instrument always shown. Offline → "data is N hours old / service offline" banner (NFR-004). Catch-up on worker start reconciles missed days. |
| **Raw (unadjusted) close from Nasdaq** — splits/dividends distort the series | Low / medium | Gap detector (S9) flags ≥ 20% single-day moves as `gapFlag` → base detector resets there (FR-019), so a split never fabricates a breakout. Research: sector ETFs rarely split in-window (non-issue), but it's detected anyway. Twelve Data `adj_close=1` is available as a future total-return upgrade. |
| **Partial refresh failure** corrupts prior good data | Medium / high | Per-symbol **atomic** upsert; a symbol's file is rewritten only on full success; failed symbols keep prior data, are retried next cycle, and are **never zeroed** (NFR-003/005). Majority commits; failures logged to the refresh event list. |
| **API key leakage** into app bundle or responses | Low / severe (NFR-009) | Key lives **only** in `data/secret.json` (0600), inside the `data/` subdir (outside the BOS config route's enumeration). Every app-facing response returns **presence only** (`keyConfigured`). The app bundle contains no key. |
| **Supervisor proxy path misunderstood / hardcoded URL** (the documented past failure) | Low / high | Connectivity is defined once in `serviceClient.ts` strictly per services.md §11 (`httpPath` present → proxy; else `location.hostname:runtime.port`), supporting all three deployment scenarios. No URL/path is invented. |
| **Worker silently not starting under `next dev`** (Turbopack `new Worker` gotcha) | Low / high | This is a **BOS-side** concern handled by `ServiceManager` (`createNodeWorker` via `new Function`), not the item. The item's only obligation is the `parentPort` guard in `index.js` (CH-011) so the manifest's main-thread `import()` load check passes. Verify by actually reaching `running` + a live API call, not just unit tests. |

---

## 8. Open items for the plan/tasks phase (not design decisions)

- **[HARD GATE — blocks the first backfill of any keyed symbol]** Confirm the Twelve Data Oslo/Nordic suffixes (`^OBX` vs `OBX`; `EQNR.OL` vs `EQNR.O`) with a live keyed probe and record the confirmed tickers in `default-universe.js` before enabling the Norway region. (The research verified the endpoint, not the exact Oslo tickers with a key.)
- Tune `dirFlatEpsilon` (default 0.5 %) and `noBaseDriftEpsilon` (default 5 %) against the synthetic test set (SC-002).
- Confirm the app's `localStorage` `schemaVersion` value and migration path for UI prefs (region/lookback/sort).
- The exact 19-symbol US sector set is fixed above (§3); plan may trim only if a symbol fails the no-key probe, in which case note the removal in the plan.

*Design authored against `spec.md`, `mockup.html`, the verified data-research report (2026-09-17), and BOS's own `docs/dev/apps/services.md` §3/§6/§10/§11/§12 plus `src/app/api/services/[id]/config/route.ts`, `src/core/service/ServiceManager.ts`, `src/system/items/installed.ts`, and `src/os/data-dir.ts` (verified against source, not doc drift). All eight architect-review MAJOR findings resolved: S7 state ordering (unavailable first) + no-base epsilon; S1 short-circuit; S8 dataBearing exclusion; determinism guardrail; `GET /api/watchlist` + full `PATCH /api/config` ops; health `regions[]`; universe counts reconciled to 46 (37 no-key + 9 keyed) with NDX price-only note and Norway-symbol hard gate; PulseStrip binding visual spec; worker committed to CommonJS with `package.json`; mid-bind runtime polling.*
