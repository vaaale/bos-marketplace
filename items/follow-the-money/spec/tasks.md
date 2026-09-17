# Tasks — Follow the Money

> Atomic, top-to-bottom task list for the Developer. Each task = one coherent unit of work: files, a concrete "do this" (references the final `design.md` section), a "verify" line, and FR/SC tags. A partial stop at any point leaves a **working** service (or a working install of what exists so far).
>
> **Working model:** stage all files into the item dir `data/user-apps/items/follow-the-money/` (trigger: "write a BOS app project … staging directory"; React importable, not npm-installed). The service is plain Node **CommonJS, unbundled, no BOS-source imports** (`require()` only). Re-run `app_build({ name:"Follow the Money", dir, icon })` at each **★ rebuild** checkpoint on the active feature branch — the preview boots the service, which is how service tasks get verified. `service.json.id` = `follow-the-money` = item dir name.

---

## M0 — Service scaffolding

### T1. Worker entry + package manifest — ★ rebuild checkpoint
- **Files:** `services/service.json`, `services/package.json`, `services/src/index.js`, `config/follow-the-money.json`
- **Do this:** `service.json` exactly `{ id:"follow-the-money", entry:"src/index.js", configSchema:{ port:{default:0}, host:{default:"127.0.0.1"} }, settingsRegistration:{ label:"Follow the Money" } }` (design §4). `package.json` `{ "type":"commonjs" }` — pins CommonJS (design §4 note). `index.js`: parentPort guard **first** (CH-011 — no `parentPort` → `process.exit(0)` silently, so the manifest main-thread `import()` load check passes); on `initialize { configDirPath, … }` → data dir = `configDirPath/data/` (ADR-c) → read `follow-the-money.json` port/host → (task T3 adds the server; for now bind a bare `http.createServer` that 404s) → `postMessage({initialized:true})` → on listen `postMessage({bound:true, port, host})`; `dispose` → close + exit; `uncaughtException`/`unhandledRejection` → log + `postMessage({crashed:true, message})`. `config/follow-the-money.json` `{ "port":0, "host":"127.0.0.1" }` (ADR-b: 0 = OS-assigned, never fixed).
- **Verify:** `app_build` on the feature branch; service status reaches **`running`**; `runtime.json` exists under the config dir with a real port; restart the preview → still `running` (crash recovery).
- **Tags:** FR-013, NFR-009

### T2. Storage primitive + defaults
- **Files:** `services/src/storage/store.js`, `services/src/config/defaults.js`
- **Do this:** `store.js`: `writeJSON(path, obj)` = write temp file in the same dir → `fs.renameSync` (atomic, NFR-003); `readJSON(path, fallback)`; `ensureDir(path)`. `defaults.js`: **every** value from design §2.3 verbatim — `lookbackDays {"3M":63,"6M":126,"1Y":252,"2Y":504}`, `flowWindow 5`, `baselineWindow 20`, `baseMinDuration 60`, `baseMaxWidth 0.10`, `baseScanWindow 252`, `breakoutVolumeRatio 1.5`, `gapThreshold 0.20`, `momentumScale 15`, `flowScale 0.75`, `momentumWeight 0.5`, `flowWeight 0.5`, `pulseTopN 5`, `pulsePerRegionK 3`, `dirFlatEpsilon 0.5`, `noBaseDriftEpsilon 5` — plus cadence `{refreshHour:17, refreshMinute:5, heartbeatEveryMs:300000}`, `dailyCreditBudget 15`, pacing `{nasdaqMs:350, twelvedataMs:7500}`.
- **Verify:** `node -e "require('./services/src/config/defaults.js')"` prints the full defaults object with all 15 signal keys + cadence + budget; a quick script using `store.writeJSON`/`readJSON` round-trips an object with no temp file left behind.
- **Tags:** FR-014 (foundation)

### T3. HTTP skeleton with /api/health
- **Files:** `services/src/http/server.js` (wire into `index.js` startup in place of the T1 bare server)
- **Do this:** `http.createServer` bound to configured host/port (default `127.0.0.1:0`); JSON body parse (limit 1 MB); route table with `GET /api/health` returning the full Health shape empty (`asOf:null, pipelineAlive:false, lastHeartbeat:null, lastFullRefresh:null, nextRefreshAt:null, providers:[], regions:[], keyConfigured:false, unavailable:[], events:[]`) and a 404 JSON fallback; on the server's `listening` event, fire the `bound` postMessage.
- **Verify:** ★ rebuild; `curl http://127.0.0.1:<runtime.port>/api/health` → **200** with the empty Health JSON; `curl …/api/nope` → 404 JSON.
- **Tags:** FR-013, US5

---

## M1 — Providers + universe + pipeline

### T4. Shared HTTP + ProviderError
- **Files:** `services/src/providers/http.js`
- **Do this:** one fetch wrapper (global `fetch`, 10 s timeout, caller-supplied headers) → maps failures to the structured `ProviderError` (design §2.1): 429 → `{code:"RATE_LIMITED", retryable:true, retryAfterMs}` (parse `Retry-After` header **and** JSON `retry-after`); 401/403 → `UNAUTHORIZED`/`NO_KEY`; provider not-found body → `NOT_FOUND`; network error/5xx → `TRANSIENT` (retryable); else `UNKNOWN`. Export a `sleep(ms)` and a per-adapter pacing helper (a simple serialized queue per provider id).
- **Verify:** unit-style script: call against a local `http` server you spin up for 429/500/timeout cases → assert each error code + `retryAfterMs` parsed; no unstructured throws.
- **Tags:** NFR-003

### T5. Nasdaq adapter (PRIMARY, no-key)
- **Files:** `services/src/providers/nasdaq.js`
- **Do this:** implement the adapter interface (design §2.1): `id:"nasdaq"`, `requiresKey:false`. `fetchDaily(symbol, range)` → `GET https://api.nasdaq.com/api/quote/{SYM}/chart?assetclass={etf|index}&fromdate=…&todate=…` with **required headers** `User-Agent` (desktop Safari), `Origin: https://www.nasdaq.com`, `Referer: https://www.nasdaq.com/`. Parse `ohlcv[].z`: `dateTime` `"M/D/YYYY"` → `YYYY-MM-DD`; strip commas from `open/high/low/close/volume` strings → numbers; **date-ascending** `RawBar[]` (`currency:"USD"`); `assetclass=index` → `volume:0` (NDX price-only). Body containing `"Symbol not exists"` → `NOT_FOUND`. Pace 350 ms.
- **Verify:** live script (sandbox has outbound net): `fetchDaily({symbol:"SPY"}, 5-yr range)` → ~1254 ascending bars with volume > 0; `NDX` → price-only (volume 0); a garbage symbol → `NOT_FOUND`; 5 back-to-back calls with no 429.
- **Tags:** FR-011, NFR-003, NFR-002

### T6. Twelve Data adapter (FALLBACK, keyed) + CNBC heartbeat
- **Files:** `services/src/providers/twelvedata.js`, `services/src/providers/cnbc.js`
- **Do this:** `twelvedata.js`: `requiresKey:true`, `isAvailable: keyConfigured`; `GET https://api.twelvedata.com/time_series?symbol=…&interval=1day&outputsize=800&apikey=…`; `values[]` is date-**descending** → reverse to ascending; 401 → `NO_KEY`; `status:"ERROR"` → `NOT_FOUND`; 429 → `RATE_LIMITED` with `retry-after`; pace ~7.5 s (8 req/min); accept a credit-counter callback invoked on each success (1 credit/call). `cnbc.js`: `id:"cnbc"`, `requiresKey:false`, **only `fetchSpot`** → `GET https://quote.cnbc.com/quote-html-webservice/restQuote/symbolType/symbol` → `{last, currency, time} | null`; US symbols only; never feeds signals (design §2.1).
- **Verify:** `cnbc` live: `fetchSpot("NDX")` → last price ≈ market, < 2 s. `twelvedata`: no-key call → `NO_KEY`; with a key (if available; else deferred — the M1 hard-gate task exercises it) `EQNR.OL`/`^GDAXI` → ascending bars.
- **Tags:** FR-010 (heartbeat), FR-011, NFR-007

### T7. Registry + default universe (46 instruments)
- **Files:** `services/src/providers/registry.js`, `services/src/universe/default-universe.js`
- **Do this:** `registry.js`: id→adapter map; `chainFor(instrument)` from `providerIds` (`both → [nasdaq,twelvedata]`, `primary → [nasdaq]`, `fallback → [twelvedata]`); `available(adapter, keyConfigured)`. `default-universe.js` (design §3, definitive): 46 `Instrument` objects, `source:"default"`. **37 no-key** (`provider:"primary"`, `providerIds:["nasdaq"]`, USD): US broad 4 `SPY,QQQ,IWM,NDX` (NDX `assetclass=index`), US sector 19 `XLK,XLE,XLF,XLV,XLI,XLY,XLP,XLU,XLB,XLRE,XLC,SMH,SOXX,XBI,XOP,XPH,XME,GDX,ITB`, Europe proxies 7 `EFA,EWG,EWU,EWI,EWP,EWN,FXN`, Asia proxies 7 `EWJ,EWH,FXI,EWA,IEMG,VWO,EEM`. **9 keyed** (`provider:"fallback"`, `providerIds:["twelvedata"]`, **`enabled:false` until T10's hard gate passes**): Norway `^OBX,EQNR.OL,DNB.OL`; Europe `^GDAXI,^FTSE,^FCHI`; Asia `^N225,^HSI,^KS11`. Note in a comment that mockup.html's Norway rows are illustrative only.
- **Verify:** script: `defaultUniverse.length === 46`; counts by region (US 23, Europe 10, Asia 10, Norway 3); 37 with `providerIds ["nasdaq"]`, 9 with `["twelvedata"]` and all 9 `enabled:false`; every symbol appears exactly once.
- **Tags:** FR-006, FR-012, NFR-008

### T8. Gap detector (S9) + bar upsert
- **Files:** `services/src/signal/gaps.js`, `services/src/storage/bars.js`
- **Do this:** `gaps.js` (pure, design §2.3 S9): `flagGaps(bars, gapThreshold)` → per bar `i>0`: `gapFlag[i] = abs(close[i]/close[i-1]-1) >= gapThreshold` (0.20). `bars.js`: file per symbol `data/bars/<region>/<symbol>.json {symbol, currency, bars:[…]}`; **upsert by (instrument, date)** — index existing by date, overwrite/insert, re-sort ascending, atomic write via `store.js`; on ingest compute `dollarVolume = volume × close` (service-derived, design §2.1) and `gapFlag` via `gaps.js`; **never write a symbol's file unless its fetch fully succeeded** (failed → prior file untouched).
- **Verify:** script: upsert same date twice → one bar, no drift (NFR-005); synthetic series with a −66 % bar → `gapFlag` true only at that index; `dollarVolume` = volume×close on every bar; NDX-style volume-0 bars → `dollarVolume 0`.
- **Tags:** FR-009, FR-019, NFR-005

### T9. Backfill + refresh pipeline + scheduler — ★ rebuild checkpoint
- **Files:** `services/src/pipeline/backfill.js`, `services/src/pipeline/refresh.js`, `services/src/pipeline/scheduler.js`, `services/src/storage/refreshlog.js`, wire into `index.js` (start scheduler after `bound`; create `data/manifest.json`)
- **Do this:** `backfill.js`: if a symbol has no persisted bars → fetch 5-yr range once. `refresh.js` (design §2.2, the core of US5): per enabled instrument → backfill-or-incremental; walk `chainFor` in order: availability check (`NO_KEY` → next provider) → retry with exponential backoff (base 5 s × 2^attempt, max 3, honor `retryAfterMs`; Nasdaq 429 → 5 s back off, retry once, then fall through) → `NOT_FOUND` → next provider → on success record `providerUsed` → upsert bars. **Credit accounting:** `creditsUsedToday` (reset at UTC midnight, persisted in manifest) capped at `dailyCreditBudget` (15); exhausted → remaining keyed symbols marked `"deferred — credit budget"` (not an error). Chain exhausted from missing key → symbol **unavailable — data source not configured**, prior bars/signals retained (signal staleness stamped in M2), event logged. One `RefreshRecord` per provider → `refreshlog.js` (`data/refresh/log.jsonl`, append, bounded to last 500). `scheduler.js`: daily refresh at 17:05 UTC (`refreshHour`/`refreshMinute`); on worker start, if `lastFullRefresh` older than one trading day → catch-up; heartbeat every 5 min = one CNBC spot (`NDX`) → `pipelineAlive` + `lastHeartbeat` (failure skips the cycle); `refreshing` guard against overlap; update `manifest.json` (`lastFullRefresh`, `universeHash`, `backfillDone`).
- **Verify:** ★ rebuild; trigger one refresh (temporary script calling `refresh.js` against the preview data dir, or `POST` hook — keep M3's API clean). Assert: **37/37 no-key symbols ok**; `data/bars/US/*.json` etc. exist ascending with `dollarVolume`; `data/refresh/log.jsonl` has a `nasdaq` record `symbolsOk:37, symbolsFailed:0`; run time ≪ 5 min; keyed symbols not fetched (disabled); re-run → idempotent (no duplicate dates).
- **Tags:** FR-010, FR-011, NFR-002, NFR-003, NFR-005, NFR-007, US5, SC-004

### T10. HARD GATE — live keyed probe, then enable Oslo/home-exchange symbols
- **Files:** edit `services/src/universe/default-universe.js` (+ a probe script `services/scripts/probe-twelvedata.js`)
- **Do this:** the research verified the Twelve Data **endpoint**, not the exact Oslo tickers with a key (design §8). With a user-provided free key, run a live `time_series` probe for each of the 9 keyed symbols — especially the Oslo spellings `^OBX` / `EQNR.OL` / `DNB.OL` (wrong suffix = `NOT_FOUND` = the one key-gated region permanently unavailable, which would fail SC-003). Record the **confirmed** tickers in `default-universe.js` (values + a comment citing the probe date/result) and set `enabled:true` for those that resolve. **If no key is available at build time: leave all 9 `enabled:false`** — the product is fully correct no-key and this gate only adds data; note the pending gate in the troubleshooting doc.
- **Verify:** probe script output shows 9/9 resolved bars (or an explicit record of which resolved); `default-universe.js` reflects confirmed tickers only; a refresh with the key now fetches the enabled keyed symbols and logs a `twelvedata` RefreshRecord with `creditsUsedToday` ≤ 9.
- **Tags:** SC-003, NFR-007, FR-012

---

## M2 — Signal engine

### T11. Pure signal functions S1–S6
- **Files:** `services/src/signal/momentum.js` (S1), `moneyflow.js` (S2), `base.js` (S3), `breakout.js` (S4+S5), `score.js` (S6)
- **Do this:** implement the design §2.3 formulas **verbatim** (pure functions of `(bars, config)`; no `Date.now()`, no randomness, no I/O — ADR-d): S1 momentum per lookback with the `n>k` / `n≤k` split, `complete`/`barsUsed`, and short-circuits (`n=0` → all null; `n=1` → 0; window indices floored at 0); S2 `moneyFlowRatio` with the recent window **excluded from its own** trailing baseline, `0` on zero/absent baseline; S3 backwards-scan base detector with `effStart = max(start, g+1)` gap reset, `width = (upper-lower)/mid`, stop at first `width > baseMaxWidth`, `durationDays = t-effStart+1`, `sufficientData = n ≥ baseMinDuration + baselineWindow`; S4 breakout against the **preceding** base (`bars[0..t-1]`, must satisfy `baseMinDuration`, `n-1 ≥ baseMinDuration`) up over the upper bound / down under the lower; S5 `volumeRatio = dollarVolume[t] / mean(dollarVolume[t-baselineWindow … t-1])` (0 on zero baseline), `confirmed = volumeRatio ≥ breakoutVolumeRatio`; S6 `momentumScore = 50+50*tanh(mom3M/15)`, `flowScore = 50+50*tanh((ratio-1)/0.75)`, `moneyFlowScore = clamp(round(0.5*a+0.5*b),0,100)`.
- **Verify:** each function returns the hand-computed expected value on a 20-bar toy series (write the assertions as the seed of the T12 test file).
- **Tags:** FR-002, FR-003, FR-004, FR-005, NFR-011

### T12. Unit tests for the signal engine
- **Files:** `services/tests/signal.test.js` (Node built-in `node --test`, CommonJS, no npm deps)
- **Do this:** synthetic engineered series (NFR-010/SC-002): (a) **base-breakout-confirmed** — ~120 bars in a known tight band (width ~1 % of mid, ≥ 60 days), final bar above the upper bound at 2.5× trailing 20-bar dollar volume → assert exact `lowerBound`/`upperBound`, `durationDays ≥ 60`, `breakout {present, direction:"up", level≈upperBound, volumeRatio≈2.5, confirmed:true}`, `state:"breaking-out-confirmed"`, and the exact S6 score (recomputed in-test); (b) same geometry at 1.2× → `confirmed:false`, `breaking-out-unconfirmed`; (c) **gap reset** — inject a −66 % bar mid-series → flagged, base cannot cross it, **no fake breakout**; (d) **insufficient data** — 30 bars → `sufficientData:false`, `insufficient-data`, no fabricated bounds; (e) short-circuits `n=0`, `n=1`, zero-baseline; (f) **determinism (SC-007)** — run the full engine twice on an identical series → `JSON.stringify` outputs byte-identical.
- **Verify:** `node --test services/tests/signal.test.js` → all pass. (This suite is the SC-002 ≥ 80 % accuracy vehicle on engineered expectations; SC-002 on a real 10-instrument backtest set is a post-release follow-up noted in docs.)
- **Tags:** NFR-010, NFR-011, SC-002, SC-007

### T13. Engine orchestrator (S7 state) + pulse (S8)
- **Files:** `services/src/signal/engine.js`, `services/src/signal/pulse.js`
- **Do this:** `engine.js`: S1–S6 → full `Signal` (design §3 shape: `momentumPct`, `momentum` {complete,barsUsed} per lookback, `moneyFlowRatio`, `recentDollarVolume`, `trailingAvgDollarVolume`, `base`, `breakout`, `score` (3 components), `stale`, `state`, `asOf`, `providerUsed`, `currency`). **State resolution in exact order** (S7) — 0. `unavailable` **first** (from the refresh record: no provider data this cycle; prior bars retained + `stale:true` + `asOf` = last good date — so a fresh no-key Norway symbol with `n=0` is `unavailable`, not `insufficient-data`) → 1. `insufficient-data` → 2. `breaking-out-confirmed` → 3. `breaking-out-unconfirmed` → 4. `in-base` → 5. `no-base` (`!base.present && |mom 1Y| > noBaseDriftEpsilon`) → 6. `trending`. `direction` = sign of `momentumPct[activeLookback]`, flat when `|v| < dirFlatEpsilon`. **Determinism guardrail:** fixed key-insertion order in emitted JSON; iterate only arrays — never `for…in`/`Set`. `pulse.js` (S8, ADR-f): `dataBearing` = states excluding `unavailable`/`insufficient-data`; pool = all `breaking-out-confirmed` ∪ per-region top-`pulsePerRegionK`(3)-by-score dataBearing not already in pool; sort `(moneyFlowScore desc, region asc, symbol asc)`; top `pulseTopN`(5); entry `{symbol, region, moneyFlowScore, state, momentumPct3M, moneyFlowRatio, asOf}`.
- **Verify:** engine on a no-data symbol (refresh record says unavailable) → state `unavailable` even with prior bars; on the T12 synthetic set → states match; pulse over mixed synthetic regions → no-data region contributes zero entries, ordering + top-N hold.
- **Tags:** FR-012, FR-021, NFR-006, NFR-011, SC-009

### T14. Signal persistence (RegionRollup + Pulse) — ★ rebuild checkpoint
- **Files:** `services/src/storage/signals.js`, wire into `refresh.js` (compute phase after upsert)
- **Do this:** `signals.js` writers (fixed key order, atomic via `store.js`): `data/signals/<region>/<symbol>.json` (Signal); `data/signals/regions/<region>.json` (RegionRollup: `region, currency, asOf`, `instruments` = ranked `SignalLite[]` by `moneyFlowScore desc`, `counts` {total, inBase, breakingOutConfirmed, breakingOutUnconfirmed, trending, unavailable, insufficient}); `data/signals/pulse.json`. In `refresh.js`, after fetch/upsert: recompute every instrument's Signal, then each RegionRollup, then the Pulse — fully derived, rewritten each refresh (FR-009). Stamp `stale` on symbols not fetched this cycle.
- **Verify:** ★ rebuild; run a refresh: `signals/US`, `Europe`, `Asia` dirs populated; `regions/US.json` ranked desc with correct `counts`; `pulse.json` ≤ 5 entries, each region-tagged, **only US/Europe/Asia** (Norway empty → zero entries, no error); **run the compute phase twice on unchanged data → `diff -r` of `data/signals/` empty** (production determinism, SC-007).
- **Tags:** FR-009, FR-021, NFR-011, SC-007, SC-009

---

## M3 — Full service API

### T15. Read endpoints
- **Files:** `services/src/http/server.js` (full route table replacing the T3 skeleton)
- **Do this:** implement design §2.5 read routes exactly (all serve last-persisted results): `GET /api/signals?region=` → RegionRollup (404 unknown region); `GET /api/instruments/{symbol}?region=&lookback=` → InstrumentDetail with `series[]` **windowed by `lookbackDays[lookback]`** (`{date, close, volume, dollarVolume, gapFlag}`), `trailingAvgDollarVolume`, `recentDollarVolume`, `base`, `breakout`, `momentumPct` ×4, `score` ×3, `state` (cross-region symbol lookup when `region` omitted); `GET /api/pulse`; `GET /api/watchlist` → `{asOf, entries:[SignalLite…]}` in **config order** (empty array if empty); `GET /api/universe` → `{instruments:[…]}` merged default+user with per-symbol availability. Extend `GET /api/health` to the full live shape: `providers[]` (status ok/limited/off, lastRefresh, symbolsOk/Failed, keyRequired, keyConfigured, creditsUsedToday, dailyCreditBudget) + **`regions[]`** (total/ok/failed/stale/asOf, `reason` when 0 ok) + `unavailable[]` + `events[]` (from the bounded refresh log) + `pipelineAlive`/`lastHeartbeat`/`nextRefreshAt`.
- **Verify:** ★ rebuild; `curl` every read endpoint; assert shapes field-for-field against §2.5 (health has `regions[]` with Norway `reason:"data source not configured"`; signals ranked; instruments windowed — 3M returns ~63 bars, 2Y ~504; watchlist order = config order).
- **Tags:** FR-001, FR-008, FR-013, FR-015, FR-016, FR-020, FR-021

### T16. Write endpoints (refresh + config)
- **Files:** `services/src/http/server.js`, `services/src/config/` (small `config.js` reader/writer for `data/config.json` + `secret.json`)
- **Do this:** `POST /api/refresh` `{scope?: "all"|region}` → start the M1 pipeline respecting the `refreshing` guard → `{started, refreshId, reason?}`. `GET /api/config` → **masked** ServiceConfig (`thresholds` full §2.3 set, `watchlist`, `customInstruments` source:"user", `cadence`, `keyConfigured` boolean — **key value never included**, NFR-009). `PATCH /api/config` — partial, idempotent, independent ops (design §2.5): `setKey {apiKey}` → write `data/secret.json` **mode 0600**, respond `{ok, keyConfigured:true}` (presence only, never echo); `clearKey:true` → delete; `thresholds {…partial}` / `cadence {…partial}` merge (cadence change re-arms the scheduler); `watchlistAdd/Remove symbol`; `instrumentAdd Instrument` (source:"user", joins next refresh); `instrumentEdit {symbol, …}` (name/category/region/enabled/weight); `instrumentRemove` (**custom only** — defaults cannot be removed, only disabled); `instrumentDisable {symbol, enabled:false}`. Key/threshold changes take effect on the next refresh (FR-012/US7).
- **Verify:** ★ rebuild; `PATCH setKey` with a test key → `stat` shows `secret.json` 0600; `GET /api/config` → `keyConfigured:true` and **grep every response for the key string → absent**; `clearKey` → `false`. `instrumentAdd {symbol:"XSD", region:"US", category:"sector", provider:"primary"}` → in `GET /api/universe` (source:"user") → next refresh → in `GET /api/signals?region=US` (SC-008, no code change). `POST /api/refresh` twice back-to-back → second `started:false`.
- **Tags:** FR-012, FR-013, FR-014, FR-017, NFR-009, US7, SC-006, SC-008

---

## M4 — App facet

### T17. Service client + types + formatting
- **Files:** `app/src/lib/types.ts`, `app/src/lib/serviceClient.ts`, `app/src/lib/format.ts`, `app/src/main.tsx`, `app/src/index.css`
- **Do this:** `types.ts`: TS types mirroring the contract (`Health, ProviderStatus, RegionSummary, SignalLite, Signal, InstrumentDetail, Instrument, PulseEntry, ServiceConfig`). `serviceClient.ts` — the **only** app→service path (design §2.6): bootstrap `GET /api/services/follow-the-money/config` → use only `runtime`, `httpPath`, `wsPath`, `values.{port,host}`; `runtime:null` (mid-bind) → **poll ~1 s, up to ~15 s** before treating as offline; `httpBaseUrl = data.httpPath ? `${location.origin}${data.httpPath}` : `${location.protocol}//${location.hostname}:${data.runtime.port}/`` (all 3 deployment scenarios; never a hardcoded port); typed fetchers for every §2.5 endpoint; **client-side cache** of last successful fetches per (route, region) for the cold-open offline story. `format.ts`: presentational only (ADR-d — no signal math in the app): `fmtFlow` (`$X.XB`, `—` for 0/NDX), `fmtMom` (`+X.X%`/`—`), `momClass`, `ratioClass/ratioColor/ratioText` (≥1.5 green / ≥1.0 amber / else red), `meterW = max(6, min(100, round(r/3*100)))`, as-of/date formatting. `index.css`: the mockup's token palette verbatim. `main.tsx`: mount into `#root`.
- **Verify:** in the preview devtools, `serviceClient` resolves a base URL and `fetchHealth()` returns the live Health JSON in all cases tested (proxy present → `httpPath` form; standalone → `hostname:runtime.port` form).
- **Tags:** FR-007 (foundation), NFR-004, ADR-b

### T18. Shell: App + HealthStrip + PulseStrip + RegionBar
- **Files:** `app/src/App.tsx`, `components/HealthStrip.tsx`, `components/PulseStrip.tsx`, `components/RegionBar.tsx`
- **Do this:** `App.tsx` shell per design §2.7: header (brand + "Not Financial Advice" pill — FR-018), `RegionBar`, "Data & Config" button; always-visible `HealthStrip`; `PulseStrip` beneath it; left rail (Money Flow / Scanner / Instrument Detail / Watchlist / Data Health); view router; footer with as-of. `HealthStrip`: as-of + live dot, per-region dots with ok/failed counts from `health.regions[]`, key chip (amber "key: not configured" / green "key: configured") → opens ConfigDrawer. `PulseStrip`: **build from the design §2.7 bullet, not the mockup** (mockup predates it — the bullet is binding): horizontal strip pinned under HealthStrip on dashboard **and** scanner; up to `pulseTopN` chips left-to-right by score; chip = uppercase region tag (region color) + symbol + money-flow score + mini state glyph (green dot = confirmed breakout, amber = strong flow); **clickable → detail**; no-data region → no chips, no placeholder, no error. `RegionBar`: region + lookback segmented controls; writes `localStorage` `{activeRegion, activeLookback, sortKey, sortDir, schemaVersion}` (FR-007 persistence).
- **Verify:** ★ rebuild (all facets staged now); open the app: HealthStrip shows live as-of + 4 region dots + key chip; PulseStrip shows ≤ 5 region-tagged chips (only US/Europe/Asia with no key); clicking a chip opens that instrument's detail; region switch re-scopes; reload → choice persisted.
- **Tags:** FR-007, FR-016, FR-018, FR-020, FR-021, SC-009

### T19. Dashboard
- **Files:** `app/src/components/Dashboard.tsx`
- **Do this:** ranked money-flow table for the active region from `GET /api/signals` (design §2.7): columns `#`, instrument (sym + name), category chip (broad/sector/proxy/stock styling), dir (▲ green / ▼ red / ▶ amber), momentum % (active lookback, sortable header), money-flow (recent $ volume, native-currency label; NDX price-only → "—"), flow-ratio (value + meter), state chip (in-base blue / breakout-confirmed green / breakout-unconfirmed amber / trending / no-base red / awaiting dashed-muted), watchlist star → `PATCH watchlistAdd/Remove`. Row left-border colored by direction; awaiting rows muted (`await-row`); sort by score/momentum/flow with header arrows; footer note when the region has awaiting instruments ("N instrument(s) awaiting a data source — see Data & Config").
- **Verify:** US dashboard shows all 23 US instruments ranked by score with every column populated (or "—"/awaiting where appropriate); momentum sort re-ranks; a star toggles and persists (visible after reload).
- **Tags:** FR-001, FR-015, SC-001, US1

### T20. Scanner
- **Files:** `app/src/components/Scanner.tsx`
- **Do this:** two columns (design §2.7): **Breaking Out** — confirmed rows highlighted (green border/glow), `CONFIRMED/UNCONFIRMED X.X× VOL` badge, meta grid: base range, base duration, breakout level, volume ratio; sorted by volume ratio desc. **In Base — Candidates** — ranked by duration desc then width asc, with "tightest in region" (min width) and "longest base" (max duration) tags. Filter chips: All / Confirmed / Unconfirmed / In Base (filtering per the mockup logic: confirmed/unconfirmed show only that column; In Base shows only the in-base column). Rows click → detail.
- **Verify:** on US data: both columns render from `state` values; "breaking out, confirmed" filter shows only confirmed rows (US2 scenario 3); an in-base row shows its duration + width; clicking a row opens detail.
- **Tags:** FR-002, FR-003, FR-004, US2

### T21. Instrument Detail + Chart
- **Files:** `app/src/components/Detail.tsx`, `app/src/components/Chart.tsx`
- **Do this:** `Detail.tsx` from `GET /api/instruments/{symbol}` (design §2.7): head with symbol, name, tags (category/region/as-of), big 0–100 score (colored: ≥70 green, ≥45 amber, else red) with bar + state chip, watchlist button. `Chart.tsx`: **SVG** (no chart lib needed) per the mockup `drawChart` geometry — price line (green/red by direction), volume bars (green when ≥ trailing avg, muted otherwise), base range band (blue, dashed bounds) when `base.present`, breakout level (amber dashed, "BO" label tag), trailing-avg-volume dashed line, breakout-bar marker (▲ + ratio) when `breakout.present`, last-price tag, legend (Price / Base range / Breakout level / Volume / Trailing avg vol), grid + axis labels. Stat grid (6-col): Momentum 3M/6M/1Y/2Y, Recent $ Volume, Flow Ratio, Base Duration, Base Width, Breakout Level. Lookback switcher re-scopes the window + momentum (re-fetch with `lookback=`). `sufficientData:false` → "insufficient data for base detection" placeholder (no fabricated range). Awaiting (no key) → "Awaiting data source" panel (no chart).
- **Verify:** open SMH (or any base instrument from the data): chart shows base band + breakout line; lookback 3M → 2Y changes the window length and momentum figures; open a short-history symbol → placeholder, no fabricated range; open an awaiting Norway symbol → awaiting panel.
- **Tags:** FR-008, US4

### T22. Watchlist + ConfigDrawer
- **Files:** `app/src/components/Watchlist.tsx`, `app/src/components/ConfigDrawer.tsx`
- **Do this:** `Watchlist.tsx` (design §2.7): `GET /api/watchlist` rows — `#`, symbol + name + region, score (colored), state chip, 3M momentum, remove (× → `PATCH watchlistRemove`); click → detail; empty state per mockup ("No instruments pinned yet"). `ConfigDrawer.tsx`: overlay + right drawer with four sections (design §2.7): **Provider Health** cards from `health.providers[]` (name, role · key requirement · ok counts, status OK/LIMITED/AWAITING); **per-region cards** from `health.regions[]` (total/ok/failed/asOf, awaiting `reason` shown); **API key** — password input, presence-only current state, Save → `PATCH setKey` (toast "Key saved — Norway unlocks on next refresh"), clear → `clearKey`, note that no key is required for US/Europe/Asia; **Add Instrument** form (symbol/region/category/provider → `PATCH instrumentAdd`); **Detection Thresholds** inputs (base min duration / breakout vol ratio / baseline window → `PATCH thresholds`).
- **Verify:** add a symbol from the dashboard star → appears in Watchlist with score/state; remove → gone (still in universe). Open drawer: provider cards show Nasdaq OK + Twelve Data LIMITED (no key); entering a key flips the HealthStrip chip to "configured" (FR-012 scenario); add-instrument form round-trips into `GET /api/universe`.
- **Tags:** FR-012, FR-014, FR-015, FR-016, FR-017, US6, US7

### T23. Offline degradation + polish
- **Files:** edits across `serviceClient.ts` / `App.tsx`
- **Do this:** service unreachable after the 15 s mid-bind poll → render the **last cached** signals + `asOf` + a visible **"data is N hours old / service offline"** banner (NFR-004) — never an error page; confirm the NFA notice (FR-018) is present on dashboard and detail; verify no console errors and render < 2 s on a warm load (NFR-001).
- **Verify:** stop the service (Services panel) → app still shows data + stale banner; restart → live again; measure dashboard render on a fresh open (should be well under 2 s — single persisted-file reads).
- **Tags:** NFR-001, NFR-004, FR-018, SC-005

---

## M5 — Docs facet

### T24. Usage docs
- **Files:** `docs/usage/Follow the Money/index.md`, `docs/usage/Follow the Money/troubleshooting.md`
- **Do this:** folder uses the **spaced display name** `Follow the Money` (rendered verbatim in the Docs sidebar). `index.md`: what it is (sector capital-rotation scanner implementing the follow-the-money / base / breakout method), the 4 regions + what each covers (US 23, Europe 10, Asia 10, Norway 3), the three signals in plain terms, a view-by-view usage guide (dashboard → scanner → detail → watchlist → pulse strip), **key setup** (free Twelve Data key via the config drawer → unlocks Norway + home-exchange indices; nothing else needs a key), and the "analytical tool, not an advisor" notice. `troubleshooting.md`: service not running; "Awaiting Data" rows (add a key — which symbols it unlocks); the stale-data warning (as-of, market holidays/weekends, catch-up on restart); no-key behavior (what works without a key); 429/rate-limit events.
- **Verify:** ★ rebuild; Docs app shows `Follow the Money` under Usage with both pages rendering; a first-time user could set up a key from the doc alone.
- **Tags:** docs facet, FR-012 (discoverability)

### T25. Dev docs
- **Files:** `docs/dev/Follow the Money/architecture.md`, `data-model.md`, `service-api.md`
- **Do this:** `architecture.md`: the three facets + the load-bearing separation (service = engine, app = read surface; ADR-d), provider adapters + primary/fallback/heartbeat split (ADR-a), storage under `configDirPath/data/` (ADR-c), pure deterministic signal engine, connectivity per services.md §11 (ADR-b: port 0, `httpPath` preference, 3 deployment scenarios), key handling (secret.json 0600, presence-only, NFR-009). `data-model.md`: design §3 verbatim (all entities + on-disk tree + the 46-instrument universe with the NDX price-only note). `service-api.md`: design §2.5 verbatim (every route/shape, the PATCH op table, the auth note — same-origin 127.0.0.1; future headless via the loopback `/api/secrets/<service>` bridge, out of scope v1).
- **Verify:** Docs app shows the three dev pages; spot-check the universe counts, thresholds, and endpoint shapes against `defaults.js` / `default-universe.js` / `server.js` (no drift between docs and code).
- **Tags:** docs facet, FR-013 (contract)

---

## M6 — E2E + final verification

### T26. Playwright e2e
- **Files:** `e2e/follow-the-money.spec.ts`
- **Do this:** one spec, sequential steps, against the branch preview (the test resolves the installed app the way a user does — it never hardcodes the service port; resolution lives inside `serviceClient.ts`): (1) **app loads service data** — open the app, wait for the dashboard table, assert ≥ 20 US rows each with a state chip + momentum cell, HealthStrip has an as-of, PulseStrip has ≥ 1 region-tagged chip; (2) **region switch** — Europe → table re-scopes (e.g. `EFA`/`EWG` visible), Norway → rows "Awaiting Data" with no error, reload → region persisted; (3) **dashboard rows + sort** — click Momentum header → order changes (top row = max momentum); (4) **detail with chart** — click a US row → detail: SVG present with base-range rect and breakout line (for a base instrument) and the stat grid populated; (5) **config drawer key toggle** — open drawer → key state visible → set/clear round-trip flips the HealthStrip chip (guard the real key-write on an env var so CI without a key still passes).
- **Verify:** the e2e run is green end-to-end against the preview.
- **Tags:** SC-001, SC-003, SC-005, SC-009 (automated), US1–US4

### T27. Definition of Done sweep
- **Files:** (verification only — no new files)
- **Do this:** run the full checklist below, item by item, in the preview; fix anything that fails (a service fix re-runs `app_build`); then run `node --test services/tests/signal.test.js` and the e2e as the final suite.
- **Verify:** every checklist item below ticked.
- **Tags:** whole-item acceptance

---

## Definition of Done

- [ ] **All three facets present** in the item: `app/` (15 files per design §4), `services/` (service.json + package.json + 24 src files), `docs/` (5 pages under `docs/usage/Follow the Money/` and `docs/dev/Follow the Money/`), plus `config/follow-the-money.json`.
- [ ] **`service.json.id === "follow-the-money"`** and equals the item dir name; `package.json` pins `"type":"commonjs"`; no BOS-source imports anywhere in `services/` (grep for `@/` and `require("@/` → zero hits).
- [ ] **Service reaches `running`** in the preview; `GET /api/health` returns live data (`pipelineAlive`, `providers[]`, `regions[]`).
- [ ] **App opens with live US data:** ≥ 23 US rows ranked by score; HealthStrip + PulseStrip render; no-key US/Europe/Asia fully functional; Norway labeled "Awaiting Data" (no fabricated data, NFR-006).
- [ ] **A real no-key refresh completed:** 37/37 Nasdaq symbols ok, bars persisted (ascending, `dollarVolume` populated, NDX price-only), a `nasdaq` RefreshRecord in `log.jsonl`, run ≪ 5 min (SC-004); re-run idempotent (NFR-005).
- [ ] **Keyed symbols gated correctly:** all 9 `enabled:false` **or** enabled with tickers confirmed by the T10 live keyed probe (hard gate — design §8); with a key, a refresh fetches them and `creditsUsedToday ≤ 9` (SC-006).
- [ ] **Signals deterministic:** unit suite green (base/breakout/confirmation/gap/insufficient/short-circuits + byte-identical re-run — SC-002/SC-007); production compute phase diff-empty on unchanged data.
- [ ] **API complete & masked:** all 9 §2.5 routes respond with the exact shapes; `keyConfigured` is presence-only in every response (grep a live `GET /api/config` for the key string → absent, NFR-009); custom instrument add → appears next refresh with no code change (SC-008).
- [ ] **App behaviors:** region + lookback persist across reload (FR-007); detail chart shows base band + breakout line (FR-008); watchlist add/remove persists (FR-015); NFA notice on dashboard + detail (FR-018); service stopped → last data + stale banner, no error page (SC-005); load < 2 s (NFR-001).
- [ ] **Docs present** under the spaced display name `Follow the Money` (usage 2 pages, dev 3 pages) and consistent with the shipped code.
- [ ] **`e2e/follow-the-money.spec.ts` in place and green.**
