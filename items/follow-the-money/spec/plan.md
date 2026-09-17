# Implementation Plan — Follow the Money

> Builds **on** the final `design.md` (all 8 review MAJORs resolved) — this plan does not re-open design decisions. It sequences the build into vertical, independently-verifiable milestones and names the exact files (design §4), formulas (design §2.3), and endpoints (design §2.1/§2.5) each milestone must produce.
>
> **Item:** `follow-the-money` (3 facets: app / service / docs) · **Item root:** `data/user-apps/items/follow-the-money/` · **Install:** one `app_build({ name:"Follow the Money", dir, icon })` on an active feature branch (elicit via `dev_branch_request` first). `service.json.id` = `follow-the-money` = item dir name (BOS rejects a mismatch).
>
> **Build model:** the Developer stages files into a fresh dir (trigger: "write a BOS app project … staging directory"; React importable for the app facet, not npm-installed) and re-runs `app_build` at the end of each service milestone (M0, M1, M2, M3) — the branch preview starts the service on boot, so each rebuild is how the milestone gets verified live. The service is plain Node **CommonJS, unbundled, no BOS-source imports** (Constraint 1): the worker cannot `import @/…`; it is self-contained with `require()`.

---

## M0 — Service scaffolding

**Goal:** the service process reaches `running` in BOS and answers `/api/health` with 200 + empty data. Nothing else works yet — but the process, storage primitive, config, and worker IPC are all real.

**Files (design §4):**
| File | What |
|---|---|
| `services/service.json` | `{ id:"follow-the-money", entry:"src/index.js", configSchema:{ port:{default:0}, host:{default:"127.0.0.1"} }, settingsRegistration:{ label:"Follow the Money" } }` |
| `services/package.json` | `{ "type": "commonjs" }` — pins CommonJS so the unbundled worker never default-misparses ESM `import` syntax |
| `config/follow-the-money.json` | BOS-seeded defaults: `{ "port": 0, "host": "127.0.0.1" }` (ADR-b: port 0 = OS-assigned, never a fixed number) |
| `services/src/storage/store.js` | atomic read/write: `writeJSON` = write temp file in same dir → `fs.renameSync`; `readJSON`; `mkdir -p` on demand. Every persistence file in the item goes through this. |
| `services/src/config/defaults.js` | **every** §2.3 default verbatim: `lookbackDays {"3M":63,"6M":126,"1Y":252,"2Y":504}`, `flowWindow 5`, `baselineWindow 20`, `baseMinDuration 60`, `baseMaxWidth 0.10`, `baseScanWindow 252`, `breakoutVolumeRatio 1.5`, `gapThreshold 0.20`, `momentumScale 15`, `flowScale 0.75`, `momentumWeight 0.5`, `flowWeight 0.5`, `pulseTopN 5`, `pulsePerRegionK 3`, `dirFlatEpsilon 0.5`, `noBaseDriftEpsilon 5`; plus cadence `{ refreshHour:17, refreshMinute:5, heartbeatEveryMs:300000 }`, `dailyCreditBudget 15`, pacing `{ nasdaqMs:350, twelvedataMs:7500 }`, host/port. |
| `services/src/http/server.js` | skeleton only: `http.createServer` on `127.0.0.1:port`, JSON body parse, route table with `GET /api/health` (returns the full Health shape, all fields empty/null: `asOf:null, pipelineAlive:false, providers:[], regions:[], keyConfigured:false, unavailable:[], events:[]`) and a 404 fallback. No other routes yet. |
| `services/src/index.js` | worker entry: **parentPort guard first** (CH-011 — if `typeof parentPort === 'undefined'` or no `process.env` worker context, `process.exit(0)` silently so the manifest's main-thread `import()` load check passes); `parentPort.on('message')` for `initialize { configDirPath, logsPath, serviceId }` → resolve data dir = `configDirPath/data/` (ADR-c) → read `follow-the-money.json` (port/host) + `defaults.js` → start `http/server.js` → `postMessage({ initialized:true })` then on bind `postMessage({ bound:true, port, host })`; handle `dispose` (close server, clear timers, exit); `process.on('uncaughtException'/'unhandledRejection')` → log + `postMessage({ crashed: true, message })`. |

**Key notes:** data dir is `configDirPath/data/` — a **subdirectory**, deliberately, so BOS's config-route enumeration (top-level `*.json` only) never exposes bars or the key (ADR-c). Do not create `data/` contents yet beyond an empty `data/` dir.

**Verify:**
1. Stage item (service + config facets only), `app_build` on the feature branch.
2. Service status reaches **`running`** (top-bar / Services panel; `runtime.json` written by BOS with the actually-bound port).
3. `curl http://127.0.0.1:<runtime.port>/api/health` → **200**, valid JSON, empty data as above.
4. Kill/restart survives (BOS crash recovery respawns).

**Acceptance mapping:** FR-013 (HTTP API on own port — skeleton), FR-012 foundation, NFR-009 (bind host/port from config), US5 (process existence), ADR-a/b/c.

---

## M1 — Provider layer + universe + fetch/persist pipeline

**Goal:** a real no-key refresh fetches the **37 Nasdaq symbols**, persists bars, and logs a RefreshRecord. Keyed (Oslo) symbols remain **disabled/unavailable** until the hard gate passes.

**Files:**
| File | What |
|---|---|
| `services/src/providers/http.js` | shared fetch: browser-ish headers, per-request timeout (10 s), response → structured `ProviderError` mapping: HTTP 429 → `{code:"RATE_LIMITED", retryable:true, retryAfterMs}` (parse `Retry-After` header/field), 401/403 → `UNAUTHORIZED`/`NO_KEY`, provider-specific not-found → `NOT_FOUND`, network/5xx → `TRANSIENT` (retryable), else `UNKNOWN`. Never throws unstructured. |
| `services/src/providers/nasdaq.js` | PRIMARY, `requiresKey:false`. Endpoint: `https://api.nasdaq.com/api/quote/{SYM}/chart?assetclass={etf\|index}&fromdate=YYYY-MM-DD&todate=YYYY-MM-DD`. **Required headers:** `User-Agent` (desktop Safari string), `Origin: https://www.nasdaq.com`, `Referer: https://www.nasdaq.com/`. Parse `ohlcv[].z`: `dateTime "M/D/YYYY"` → `YYYY-MM-DD`; `open/high/low/close/volume` are **strings with commas** → strip commas → `Number`. `assetclass=index` (NDX) returns price-only → `volume:0`. Body `"Symbol not exists"` → `NOT_FOUND`. Output: date-ascending `RawBar[] {date,open,high,low,close,volume,currency:"USD"}`. Pace 350 ms between calls. |
| `services/src/providers/twelvedata.js` | FALLBACK, `requiresKey:true`, `isAvailable: keyConfigured`. Endpoint: `https://api.twelvedata.com/time_series?symbol={SYM}&interval=1day&outputsize=800&apikey={KEY}`. Map `values[]` (date-descending → reverse to ascending); fields already numeric. 401 `{"code":401,…}` → `NO_KEY`; `status:"ERROR"` → `NOT_FOUND`; 429 → `RATE_LIMITED` with `retry-after`. Pace ~7.5 s (8 req/min). **1 credit per successful call** — report credit via a counter callback so refresh.js can enforce the budget. |
| `services/src/providers/cnbc.js` | HEARTBEAT, `requiresKey:false`. Endpoint: `https://quote.cnbc.com/quote-html-webservice/restQuote/symbolType/symbol`. Implements **only `fetchSpot(symbol)`** → `{last, currency, time} | null`. US symbols only (verified: non-US collides). Never feeds signals. |
| `services/src/providers/registry.js` | `id → adapter` map (`nasdaq, twelvedata, cnbc`); `chainFor(instrument)` from `providerIds` (`both → [nasdaq, twelvedata]`, `primary → [nasdaq]`, `fallback → [twelvedata]`); `available(adapter, keyConfigured)`; single pacing gate per adapter (no two concurrent calls to the same adapter). |
| `services/src/universe/default-universe.js` | The curated **46 Instruments** (design §3, definitive list): US broad 4 (`SPY, QQQ, IWM, NDX` — NDX `provider:"primary"`, `assetclass=index`, price-only); US sector 19 (`XLK, XLE, XLF, XLV, XLI, XLY, XLP, XLU, XLB, XLRE, XLC, SMH, SOXX, XBI, XOP, XPH, XME, GDX, ITB`); Europe proxies 7 (`EFA, EWG, EWU, EWI, EWP, EWN, FXN`); Asia proxies 7 (`EWJ, EWH, FXI, EWA, IEMG, VWO, EEM`) — all 37 no-key via `provider:"primary"`. **Keyed 9, `provider:"fallback"`, `providerIds:["twelvedata"]`: Norway `^OBX, EQNR.OL, DNB.OL`; Europe `^GDAXI, ^FTSE, ^FCHI`; Asia `^N225, ^HSI, ^KS11`** — all nine with `enabled:false` **until the hard gate (task in M1) confirms Oslo tickers live**; the 6 home-exchange indices may be enabled at gate time with the same probe. `source:"default"` throughout. Merged with user instruments (FR-017) on read: `universe/instruments.json` = defaults + `customInstruments`. |
| `services/src/signal/gaps.js` | **S9 (created here, tested in M2)** — pure: per new bar `i>0`, `gapFlag[i] = abs(close[i]/close[i-1]-1) >= gapThreshold` (0.20). Split/dividend guard on raw close. |
| `services/src/storage/bars.js` | per-symbol file `data/bars/<region>/<symbol>.json {symbol, currency, bars:[…]}`; upsert by `(instrument, date)` — index existing by date, overwrite/insert, re-sort ascending, **atomic write via store.js**; on ingest compute `dollarVolume = volume × close` (design §2.1: never provider-provided) and `gapFlag` via `gaps.js`; a failed symbol's file is never touched (written only after full fetch success). |
| `services/src/storage/refreshlog.js` | `data/refresh/log.jsonl` append; one `RefreshRecord` JSON line per provider-per-refresh; bounded to last 500 lines (trim on append). |
| `services/src/pipeline/backfill.js` | one-time per symbol: if `data/bars/<region>/<symbol>.json` absent/empty → fetch 5-yr range (`fromdate` = today − 5 y) and upsert. |
| `services/src/pipeline/refresh.js` | full-refresh orchestration, the core of US5/NFR-003: for each enabled instrument — (1) backfill if no history; else incremental fetch of latest bars; (2) walk `chainFor` in order: availability check (`NO_KEY` → next provider) → fetch with retry (backoff base 5 s × 2^attempt, max 3, honor `retryAfterMs`; Nasdaq 429 → back off 5 s, retry once, then fall through); `NOT_FOUND` → next provider; success → record `providerUsed`; (3) upsert bars; (4) **twelvedata credit accounting**: `creditsUsedToday` reset at UTC midnight, cap `dailyCreditBudget` (15) — when exhausted, remaining keyed symbols marked `"deferred — credit budget"` (not an error, picked up next day); (5) chain exhausted + cause was missing key → symbol **unavailable — data source not configured**, retain prior bars/signal stamped `stale`, log event. Partial failure never zeros prior data (per-symbol atomicity). Produces one `RefreshRecord` per provider (ok/failed counts, credits, events, asOf). |
| `services/src/pipeline/scheduler.js` | `setInterval`/`setTimeout` in-worker: daily full refresh at `refreshHour:17, refreshMinute:5` UTC (post-NYSE close); on worker start, if `lastFullRefresh` older than one trading day → catch-up (latest few bars per symbol); heartbeat every 5 min: single CNBC spot quote (`NDX`) → `pipelineAlive`/`lastHeartbeat` (failure just skips the cycle; completes < 2 s, NFR-002). `refreshing` guard prevents overlap. Persist `lastFullRefresh` in `data/manifest.json` (`{schemaVersion, createdAt, lastFullRefresh, universeHash, backfillDone}`). |

**Key notes:**
- NFR-002 budget at default universe: Nasdaq 37 × 350 ms ≈ 13 s; Twelve Data 9 × 7.5 s ≈ 68 s → well under 5 min.
- **HARD GATE (design §8):** the research verified the Twelve Data endpoint, **not** the exact Oslo tickers with a key. Wrong suffix = `NOT_FOUND` = the one key-gated region permanently `unavailable` (fails SC-003). Oslo symbols stay `enabled:false` until a **live keyed probe** (a real `time_series` call with a user key for each of `^OBX`, `EQNR.OL`, `DNB.OL` — and the 6 home-exchange indices) returns real bars; confirmed tickers are recorded in `default-universe.js` (comment + values) and the symbols enabled. Until then they render "Awaiting Data" — which is itself the correct no-key behavior (FR-012/NFR-006).

**Verify:**
1. Rebuild (`app_build`), service `running`.
2. Trigger a refresh (`POST /api/refresh` not built yet → either a tiny `node -e` harness calling `refresh.js` with the data dir, or add a temporary trigger; prefer the harness to keep M3's API surface clean — but the simplest verifiable path is running the worker's refresh directly from the staging dir against the preview's data dir).
3. Assert: **37/37 no-key symbols ok**; `data/bars/US/*.json` etc. exist, date-ascending, `dollarVolume` populated, NDX bars `volume:0`; `data/refresh/log.jsonl` has a `nasdaq` `RefreshRecord` with `symbolsOk:37, symbolsFailed:0`; keyed symbols absent from the fetch (disabled) and no twelvedata record yet.
4. Re-run refresh → idempotent upsert: no duplicate dates, no drift (NFR-005).

**Acceptance mapping:** FR-006 (universe), FR-009 (persist bars), FR-010 (pipeline + heartbeat), FR-011 (primary/fallback + per-symbol `providerUsed`), FR-012 (no-key functional set), FR-019 (gap flag on ingest), NFR-002/003/005/007, US5 SC-004, SC-003 (partial — labeling side).

---

## M2 — Signal engine (pure) + persistence + RegionRollup + Pulse

**Goal:** every instrument has a computed `Signal`; regions have rollups; there is a cross-region pulse. Deterministic and unit-tested.

**Files (all `services/src/signal/*.js` are PURE functions of `(bars, config)` — no `Date.now()`, no randomness, no I/O — per ADR-d):**
| File | What (design §2.3 formulas — implement verbatim) |
|---|---|
| `momentum.js` — S1 | For lookback `L`, `k=lookbackDays[L]`: `n>k → momentumPct[L]=(close[t]/close[t-k]-1)*100, complete=true, barsUsed=k`; else `(close[t]/close[0]-1)*100, complete=false, barsUsed=n-1`. Short-circuits: `n=0` → all `null`, `moneyFlowScore=0`; `n=1` → `0`; every window index floored at 0. |
| `moneyflow.js` — S2 | `recent = mean(dollarVolume[t-flowWindow+1 … t])` (last 5 incl.); `trailing = mean(dollarVolume[t-flowWindow-baselineWindow+1 … t-flowWindow])` (the 20 before the recent window — a breakout day must not inflate its own baseline); `moneyFlowRatio = trailing>0 ? recent/trailing : 0`. |
| `base.js` — S3 | Backwards-scan from `t` over `start=max(0,t-baseScanWindow+1)`; reset at gap flags: `effStart = max(start, g+1)` where `g` = largest index ≤ t with `gapFlag`; track `lower=min`, `upper=max` of closes; `width=(upper-lower)/mid`; first `width > baseMaxWidth` → `present=false` (band broke open); else `present=true, durationDays = t-effStart+1, tightness=width`. Insufficient: `n < baseMinDuration + baselineWindow` → `sufficientData=false`. |
| `breakout.js` — S4+S5 | `basePrev = detectBase(bars[0..t-1])` (same routine, t→t-1). Breakout iff `basePrev.present && basePrev.durationDays >= baseMinDuration && n-1 >= baseMinDuration`: `close[t] > basePrev.upperBound → {present:true, level:upperBound, direction:"up"}`; `< lowerBound → direction:"down"` (breakdown, separate state). S5: `trailingAvg = mean(dollarVolume[t-baselineWindow … t-1])`; `volumeRatio = trailingAvg>0 ? dollarVolume[t]/trailingAvg : 0`; `confirmed = volumeRatio >= breakoutVolumeRatio` (1.5). |
| `score.js` — S6 | `momentumScore = 50 + 50*tanh(momentumPct["3M"]/momentumScale)`; `flowScore = 50 + 50*tanh((moneyFlowRatio-1.0)/flowScale)`; `moneyFlowScore = clamp(round(momentumWeight*momentumScore + flowWeight*flowScore), 0, 100)`. Persist components for the detail view. |
| `engine.js` — S7 | orchestrates S1–S6 → full `Signal` (design §3 shape); **state resolution in exact order** (unavailable **first**, from the refresh record, so a fresh no-key Norway symbol with `n=0` is `unavailable`, not `insufficient-data`): 0 unavailable → 1 `n < baseMinDuration+baselineWindow` → insufficient-data → 2 breakout+confirmed → 3 breakout unconfirmed → 4 valid in-base (`present && durationDays>=baseMinDuration`) → 5 `!base.present && |momentumPct["1Y"]| > noBaseDriftEpsilon` → no-base → 6 else trending. `direction` = sign of `momentumPct[activeLookback]`, flat when `|v| < dirFlatEpsilon`. **Determinism guardrail:** emit JSON with fixed key-insertion order; iterate only over arrays — never `for…in`/`Set` (SC-007 "byte-identical" must actually hold). |
| `pulse.js` — S8 | `dataBearing` = states excluding `unavailable` and `insufficient-data` (a no-data region contributes zero by construction); `pool = all breaking-out-confirmed (any region) ∪ per region top-`pulsePerRegionK`(3)-by-moneyFlowScore from that region's dataBearing not already in pool`; sort `(moneyFlowScore desc, region asc, symbol asc)`; `top pulseTopN (5)`. Entry: `{symbol, region, moneyFlowScore, state, momentumPct3M, moneyFlowRatio, asOf}`. |
| `storage/signals.js` | writers (fixed key order, atomic via store.js): `data/signals/<region>/<symbol>.json` (Signal), `data/signals/regions/<region>.json` (RegionRollup: ranked `SignalLite[]` by score desc + `counts` + `asOf` + region `currency`), `data/signals/pulse.json`. |

Wire into `refresh.js`: after the fetch/upsert phase, recompute every instrument's Signal, then RegionRollups, then Pulse — fully derived, rewritten each refresh (FR-009).

**Verify:**
1. Unit tests (see Testing strategy) pass: base bounds, breakout state, confirmation, determinism byte-identical, gap reset, insufficient-data, n=0/n=1 short-circuits.
2. Run a refresh (M1 path): `data/signals/US/*.json`, `Europe/`, `Asia/` exist with `state` ∈ enum; `regions/US.json` ranked; `pulse.json` has ≤ 5 entries, each region-tagged, drawn only from US/Europe/Asia (Norway empty → zero entries, no error — SC-009 partial).
3. **Determinism in production:** run the signal phase twice on unchanged data → `diff` of all signal files empty (byte-identical, SC-007).

**Acceptance mapping:** FR-002/003/004/005/019/021, NFR-010/011, US2, SC-002 (test-set accuracy target), SC-007, SC-009 (engine side).

---

## M3 — Full service API

**Goal:** every endpoint in design §2.5 exists with the exact response shapes; config is readable (masked) and writable (key, thresholds, cadence, watchlist, instruments).

**Files:** `services/src/http/server.js` (full route table — replace M0 skeleton), plus small config read/write helpers in `services/src/config/` (reuse `defaults.js`; `data/config.json` for durable user config; `data/secret.json` mode 0600 for the key).

**Routes (exact shapes, design §2.5):**
| Route | Notes |
|---|---|
| `GET /api/health` | full `Health`: `asOf, pipelineAlive, lastHeartbeat, lastFullRefresh, nextRefreshAt`, `providers[]` (per id: status ok/limited/off, lastRefresh, symbolsOk/Failed, keyRequired, keyConfigured, creditsUsedToday, dailyCreditBudget), **`regions[]`** (per region: total/ok/failed/stale/asOf, `reason` when 0 ok — the source HealthStrip + config-drawer cards render, FR-016), `keyConfigured`, `unavailable[]`, `events[]` (from the bounded refresh log). |
| `GET /api/signals?region=US` | `RegionRollup` straight from `data/signals/regions/<region>.json` (ranked `SignalLite[]` + `counts` + `asOf` + `currency`). Unknown region → 404. |
| `GET /api/instruments/{symbol}?region=US&lookback=3M` | `InstrumentDetail`: `instrument`, `currency`, `asOf`, `series[]` **windowed by lookback** (`lookbackDays` bars: `{date, close, volume, dollarVolume, gapFlag}`), `trailingAvgDollarVolume`, `recentDollarVolume`, `base`, `breakout`, `momentumPct` (all four), `score` (3 components), `state`. Cross-region symbol lookup when `region` omitted. |
| `GET /api/pulse` | `Pulse` from `data/signals/pulse.json`. |
| `GET /api/watchlist` | `{asOf, entries:[SignalLite…]}` — watchlist symbols resolved across regions, **config order**, empty array if empty. |
| `GET /api/universe` | `{instruments:[Instrument…]}` — merged default + user, with per-symbol availability state (for the config-drawer picker). |
| `POST /api/refresh` | body `{scope?: "all"\|region}`; starts the M1 pipeline (respect `refreshing` guard) → `{started, refreshId, reason?}` (`started:false` when one is already running). |
| `GET /api/config` | **masked** `ServiceConfig`: `thresholds` (full §2.3 set incl. `dirFlatEpsilon`, `noBaseDriftEpsilon`, `gapThreshold`, scales/weights, pulse params), `watchlist`, `customInstruments` (source:"user"), `cadence`, `keyConfigured: boolean`. **The key value is never included** (NFR-009). |
| `PATCH /api/config` | partial, idempotent, independent ops: `setKey {apiKey}` → write `data/secret.json` (0600), respond `{ok, keyConfigured:true}` (presence only, never echo); `clearKey:true` → delete secret; `thresholds {…partial}` merge; `cadence {…partial}` merge (re-arms scheduler); `watchlistAdd/Remove symbol`; `instrumentAdd Instrument` (source:"user", joins next refresh — FR-017/SC-008); `instrumentEdit {symbol, …}` (name/category/region/enabled/weight); `instrumentRemove symbol` (**custom only** — defaults can only be disabled); `instrumentDisable {symbol, enabled:false}`. |

**Key notes:** key changes take effect **on the next refresh** (FR-012/US7). The service binds to its configured host/port (default `127.0.0.1:0`) — never a fixed number in code. Read endpoints always serve the **last persisted** results (instant, offline-capable — FR-009).

**Verify:**
1. Rebuild; service `running`.
2. `curl` every endpoint against the preview's data dir; assert shapes match §2.5 field-for-field (health has `regions[]`; signals ranked desc; instruments windowed by lookback; watchlist order = config order).
3. `PATCH setKey` with a test key → `data/secret.json` exists mode 0600; `GET /api/config` returns `keyConfigured:true` and **no key material anywhere in the response**; `clearKey` → `false`.
4. `PATCH instrumentAdd` a US-listed ETF (e.g. `XSD`) → appears in `GET /api/universe` (source:"user") → next refresh fetches it and it appears in `GET /api/signals?region=US` (SC-008, no code change).
5. `POST /api/refresh` twice back-to-back → second returns `started:false`.

**Acceptance mapping:** FR-012/013/014/016/017, US5 (API side), US7, SC-003 (labeling via health/unavailable), SC-006 (credits surfaced), SC-008.

---

## M4 — App facet (read surface)

**Goal:** the installed app loads live service data and matches `mockup.html` exactly (dark terminal theme, token palette, color semantics: **green=up/inflow, red=down/outflow, amber=neutral/unconfirmed, blue=in-base**).

**Files (design §4, all under `app/src/`):**
| File | Notes |
|---|---|
| `main.tsx` | mounts into `document.getElementById("root")`. |
| `index.css` | mockup's CSS token palette verbatim (`--bg:#0a0c10`, `--up:#37d67a`, `--dn:#ff5d5d`, `--am:#f5b84a`, `--cy:#5b9dff`, mono/sans stacks, panel/table/chip/drawer classes) — the mockup is the visual contract. |
| `lib/types.ts` | TS types mirroring the service contract: `Health, ProviderStatus, RegionSummary, SignalLite, Signal, InstrumentDetail, Instrument, PulseEntry, ServiceConfig, RefreshRecord` (§2.5 + §3). |
| `lib/format.ts` | presentational only (ADR-d: **no signal math in the app**): `fmtFlow` (currency-prefixed, `$X.XB`, `—` for 0/NDX), `fmtMom` (`+X.X%`/`—`), `momClass` (pos/neg/flat), `ratioClass/ratioColor/ratioText` (≥1.5 green, ≥1.0 amber, else red), `meterW` (`max(6, min(100, round(r/3*100)))`), date/as-of formatting. |
| `lib/serviceClient.ts` | **the only app→service path** (§2.6): bootstrap `GET /api/services/follow-the-money/config` → use only `runtime`, `httpPath`, `wsPath`, `values.{port,host}`; if `runtime` is `null` (mid-bind) **poll ~1 s for up to ~15 s** before offline; `httpBaseUrl = httpPath ? origin+httpPath : protocol//hostname:runtime.port` (supports all 3 deployment scenarios — never a hardcoded port); typed fetchers for every §2.5 endpoint; **client-side cache of last successful fetches** per (route, region) for the cold-open offline story (NFR-004). |
| `App.tsx` | shell: header (brand + "Not Financial Advice" pill — FR-018, `RegionBar`, "Data & Config" button), always-visible `HealthStrip`, `PulseStrip` beneath it, left rail (Money Flow / Scanner / Instrument Detail / Watchlist / Data Health), main view router, footer with as-of. |
| `components/HealthStrip.tsx` | as-of + live dot, per-region dots with ok/failed counts (from `health.regions[]`), key chip ("key: not configured" amber / "key: configured" green) → opens ConfigDrawer. (FR-016) |
| `components/PulseStrip.tsx` | **Build from the design §2.7 bullet, not the mockup** (mockup predates it — the bullet is the binding visual spec): horizontal strip pinned under HealthStrip on dashboard **and** scanner; up to `pulseTopN` chips left-to-right by score from `GET /api/pulse`; each chip = uppercase region tag (region color) + symbol + money-flow score + mini state glyph (green dot = confirmed breakout, amber = strong flow); **clickable → detail**; a region with no data contributes no chips (no placeholder, no error). (FR-021/SC-009) |
| `components/RegionBar.tsx` | region + lookback segmented controls (mockup `.seg`); writes `localStorage` `{activeRegion, activeLookback, sortKey, sortDir, schemaVersion}` — FR-007 persistence; region switch re-scopes dashboard/scanner/detail. |
| `components/Dashboard.tsx` | ranked money-flow table for the active region (`GET /api/signals`): columns `#`, instrument (sym+name), category chip, dir (▲/▼/▶ colored), momentum % (active lookback, sortable), money-flow (recent $ volume, native-currency label), flow-ratio meter, state chip (base/bo-c/bo-u/trend/nobase/await), watchlist star (→ `PATCH watchlistAdd/Remove`). Row left-border by direction. Awaiting rows rendered muted (`await-row`). Sort by score/momentum/flow with header arrows. (FR-001/SC-001) |
| `components/Scanner.tsx` | two columns: **Breaking Out** (confirmed rows highlighted; `CONFIRMED/UNCONFIRMED X.X× VOL` badge; base range, duration, breakout level, volume ratio) and **In Base — Candidates** (ranked duration desc then width asc; "tightest in region" / "longest base" tags). Filter chips: All / Confirmed / Unconfirmed / In Base. Both feed detail on click. (FR-002/003/004) |
| `components/Detail.tsx` + `Chart.tsx` | `GET /api/instruments/{symbol}`. Head: symbol, name, tags (category/region/as-of), big score (0–100, colored bar), state chip, watchlist button. `Chart.tsx`: **SVG** price line + volume bars + base range band (blue, dashed bounds) + breakout level (amber dashed, labeled "BO") + trailing-avg-volume line + breakout-bar marker (▲ + ratio) + last-price tag; legend per mockup; tooltip-ready points. Stat grid: momentum ×4 lookbacks, recent $ volume, flow ratio, base duration/width, breakout level. Lookback switcher re-scopes window + momentum. `sufficientData:false` → "insufficient data for base detection" placeholder (no fabricated range). (FR-008, US4) |
| `components/Watchlist.tsx` | `GET /api/watchlist`: rows with score + state chip + 3M momentum, remove (×), click → detail; empty state per mockup. (FR-015) |
| `components/ConfigDrawer.tsx` | overlay + right drawer: **Provider Health** cards (from `health.providers[]` — name, role, key requirement, ok counts, status OK/LIMITED/AWAITING), **per-region cards** (from `health.regions[]`, "awaiting" reason shown), **API key** entry (password input, presence-only display, Save → `PATCH setKey`, note "no key required for US/Europe/Asia"), **Add Instrument** form (symbol/region/category/provider → `PATCH instrumentAdd`), **Detection Thresholds** inputs (→ `PATCH thresholds`). Toasts for actions. (FR-012/016/017, US7) |

**Key notes:**
- Offline (NFR-004): service unreachable after the 15 s poll → render last cached signals + `asOf` + visible **"data is N hours old / service offline"** banner — never an error page.
- Load budget (NFR-001/SC-001): all reads are one persisted file per endpoint → render < 2 s.
- The app never talks to external providers and never recomputes signals (ADR-d).

**Verify:**
1. Rebuild (`app_build` — now all three facets staged: app, service, config; docs may still be absent until M5).
2. Open the app in the preview: dashboard shows **live US data** (≥ 20 rows: 23 US instruments), ranked by score, with dir/momentum/flow/ratio/state columns; HealthStrip shows as-of + region counts + key chip; PulseStrip shows ≤ 5 region-tagged chips.
3. Region switch US → Europe → Asia re-scopes (Europe 10, Asia 10 incl. keyed-if-enabled or 7 proxies + labeled awaiting); **Norway** shows its 3 instruments as "Awaiting Data" (no key) with a footer note — no error (SC-003).
4. Reload → active region/lookback persisted (FR-007).
5. Click a row → Detail opens with SVG chart (base band + breakout line for a base instrument; "insufficient data" for a short-history one).
6. Stop the service → app still shows last data + stale banner (SC-005).
7. ConfigDrawer: key entry toggles the health chip between "not configured" / "configured" (FR-012).

**Acceptance mapping:** FR-001/007/008/015/016/018/020/021, NFR-001/004/006, US1/US3/US4/US6, SC-001/003/005/009 (app side).

---

## M5 — Docs facet

**Goal:** end-user and developer pages render in the Docs overlay under the **spaced display name** `Follow the Money` (the folder name is rendered verbatim — do not use the slug).

**Files:**
| File | Content |
|---|---|
| `docs/usage/Follow the Money/index.md` | What it is (sector capital-rotation scanner, Felix Prehn method), the 4 regions + what each covers, the 3 signals (money-flow ranking, base/heartbeat, breakout + volume confirmation) explained in plain terms, how to use the views (dashboard → scanner → detail → watchlist → pulse strip), **key setup** (free Twelve Data key from the config drawer → unlocks Norway + home-exchange indices; nothing else needs a key), and the "analytical tool, not an advisor / not financial advice" notice. |
| `docs/usage/Follow the Money/troubleshooting.md` | Service not running (check Services panel, preview boot), "Awaiting Data" rows (add a key; which symbols it unlocks), stale-data warning (what "as-of" means, market holidays/weekends, catch-up on restart), no-key behavior (what works without a key), rate-limit/429 events in the health strip. |
| `docs/dev/Follow the Money/architecture.md` | The three facets and the load-bearing separation (service = engine, app = read surface, ADR-d); provider adapters + primary/fallback/heartbeat split (ADR-a); storage layout under `configDirPath/data/` (ADR-c); deterministic pure signal engine; connectivity per services.md §11 (ADR-b, port 0, `httpPath` preference, 3 deployment scenarios); key handling (secret.json 0600, presence-only, NFR-009). |
| `docs/dev/Follow the Money/data-model.md` | Design §3 verbatim: Instrument, PriceBar, Signal, RegionRollup, Pulse, RefreshRecord, AppConfig split (client `localStorage` vs service `config.json` vs `secret.json`), the on-disk tree, the 46-instrument default universe with the NDX price-only note. |
| `docs/dev/Follow the Money/service-api.md` | Design §2.5 verbatim: every route, method, request/response shape, the `PATCH` op table, auth note (same-origin 127.0.0.1; future headless via the loopback `/api/secrets/<service>` bridge, out of scope v1). |

**Verify:** rebuild; Docs app shows `Follow the Money` under both Usage and Dev with all five pages rendering (no broken relative links); content matches the shipped implementation (spot-check the universe counts and thresholds against `defaults.js` / `default-universe.js`).

**Acceptance mapping:** spec "docs facet" requirement; supports US7 (key setup discoverability) and NFR-006 (clear capability boundary).

---

## M6 — E2E test + final polish

**Goal:** an automated end-to-end proof that the installed item works, and the Definition of Done is fully satisfied.

**Files:** `e2e/follow-the-money.spec.ts` (item root — test asset, not a facet; run via the repo's Playwright setup against the branch preview).

**Test (one spec, sequential steps — mirrors the plan's top-line risk areas):**
1. **App loads service data:** open the app in the preview (resolve the installed app's iframe), wait for the dashboard table; assert ≥ 20 US rows, each with a state chip and momentum cell; HealthStrip shows an as-of date; PulseStrip shows ≥ 1 region-tagged chip.
2. **Region switch works:** click Europe → title/table re-scope (Europe symbols, e.g. `EFA`/`EWG` visible); click Norway → rows render as "Awaiting Data" (no key) with no error; region persists across a reload (FR-007).
3. **Dashboard shows rows + sort:** click the Momentum header → order changes (first row's momentum is max).
4. **Detail opens with chart:** click a US row (one with a base, e.g. from the pulse strip) → detail view: SVG chart present with a base-range rect and breakout line (when the instrument has one) and the 6-stat grid populated.
5. **Config drawer toggles key presence:** open Data & Config → key field shows "not configured" state → (if a test key is available in env) set it via the UI → health chip flips to "configured"; then clear. (Guard the key-write step on an env var so CI without a key still passes the presence-toggle assertion with a dummy round-trip on a throwaway key.)

**Final polish:**
- Confirm `service.json.id === "follow-the-money" === item dir name`.
- Confirm all three facets present (`app/`, `services/`, `docs/`) and the config file.
- Confirm `GET /api/config` and every API response contain no key material (grep the live responses).
- Confirm refresh < 5 min (NFR-002) and credits ≤ 9/day at default universe (NFR-007/SC-006) from the refresh log.
- Run the M2 unit tests + this e2e as the item's test suite; fix findings; re-verify determinism (SC-007) one last time.

**Verify:** `npx playwright test e2e/follow-the-money.spec.ts` (or the BOS preview test harness) green; Definition of Done (tasks.md) fully ticked.

**Acceptance mapping:** SC-001/003/005/009 (automated), whole-item acceptance.

---

## Testing strategy

1. **Unit — pure signal functions** (`services/tests/signal.test.js`, run with Node's built-in `node --test` — no npm deps, CommonJS): synthetic engineered series, no I/O, no network.
   - *Base + breakout + confirmation (NFR-010, SC-002):* e.g. 140 bars — 120 alternating closes in a known tight band (width ~1 % of mid) with moderate volume, then a final bar closing above the band's upper bound with `dollarVolume = 2.5×` the trailing 20-bar average → assert `base.present`, exact `lowerBound`/`upperBound`, `durationDays ≥ 60`, `breakout {present:true, direction:"up", level≈upperBound, volumeRatio≈2.5, confirmed:true}`, `state:"breaking-out-confirmed"`, and the score formula's exact value (recompute `tanh` expected in the test).
   - *Unconfirmed variant:* same geometry, final-bar volume `1.2×` → `confirmed:false`, state `breaking-out-unconfirmed`.
   - *Gap reset (FR-019):* inject a −66 % bar mid-series → `gapFlag` true at that index; a base that would otherwise "end now" is cut at the gap; **no fake breakout** across the gap.
   - *Insufficient data:* 30 bars → `sufficientData:false`, state `insufficient-data`, no base bounds fabricated.
   - *Short-circuits:* `n=0` → `momentumPct` all null, score 0; `n=1` → 0 %s; zero trailing baseline → ratios 0.
   - *Determinism (NFR-011/SC-007):* run `engine.js` twice on an identical synthetic series → `JSON.stringify` outputs **byte-identical** (this is where the fixed-key-order / arrays-only guardrail gets proven).
   - *Pulse:* mixed-region synthetic signals → no-data region contributes nothing; tie-break order `(score desc, region asc, symbol asc)` holds; top-N respected.
2. **Live no-key refresh smoke (SC-004):** one real refresh against the sandbox network: assert 37/37 Nasdaq ok, bars persisted (ascending, `dollarVolume` set, NDX volume 0), a `nasdaq` RefreshRecord logged, idempotent on re-run, whole run ≪ 5 min. (This is the M1 verification, re-run as a regression.)
3. **Playwright e2e (M6):** the single spec above — app loads service data, region switch + persistence, dashboard rows + sort, detail with chart, config-drawer key-presence toggle.

## Data & known limitations (documented in the docs facet, surfaced in UI)

- **Nasdaq API is undocumented** (internal nasdaq.com API, no SLA/changelog; verified 2026-09-17). A schema break is contained to `providers/nasdaq.js` (NFR-008); Twelve Data covers every critical symbol; `providerUsed` + `/api/health` make breakage visible. Conservative 350 ms pacing.
- **NDX is price-only** (`assetclass=index`, no volume) → `dollarVolume`/`moneyFlowRatio` are 0, app renders its flow as "—", it ranks on momentum only; QQQ carries the US-tech volume read.
- **Norway is fully key-gated** — no no-key substitute exists (no liquid US Nordic ETF; `EQNR` NYSE ADR has no Nasdaq history). Without a key: 3 rows "Awaiting Data", zero pulse entries, no error (NFR-006). **HARD GATE:** Oslo tickers (`^OBX`, `EQNR.OL`, `DNB.OL`) are enabled only after a live keyed probe; the mockup's Norway rows (`EQNR.O`, `AKO.O`, `SAND.O`) are illustrative and do **not** define the universe.
- **Raw (unadjusted) close from Nasdaq** — no adjusted close anywhere no-key. The S9 gap detector (≥ 20 % single-day move) flags splits/artifacts and the base detector resets there, so a split never fabricates a breakout; sector-ETF splits in-window are rare (research caveat 4). Twelve Data `adj_close=1` is the documented future upgrade.
- **Credit budget:** keyed consumption = 9 credits/day at the default universe (1 per symbol); `dailyCreditBudget` cap 15 turns any overrun into graceful "deferred — credit budget" (not an error); Twelve Data free tier 800 credits/day, 8 req/min (~7.5 s pacing).
- **International ETFs are USD-denominated proxies** (MSCI country indices, >0.95 correlation with home indices over 3 yr); exact home-exchange levels require the keyed `^` symbols.
- **Stooq and Yahoo are IP-blocked** from the datacenter sandbox — explicitly not used (research §1).

## Plan-level risks (beyond design §7)

| Risk | Mitigation |
|---|---|
| Repeated `app_build` per service milestone is slow | Acceptable: 4 service-side rebuilds total (M0–M3) + app (M4) + docs (M5). Each rebuild is the verification vehicle — the preview boots the service. |
| Playwright e2e must reach the app through the BOS preview UI (dynamic service port, iframe) | The e2e resolves the app the same way a user does (open installed app in preview; service URL resolution stays inside `serviceClient.ts` — the test never hardcodes a port). Key-write step guarded on an env var. |
| Hard gate may slip (no user key during build) | Keyed symbols ship `enabled:false` — the product is fully correct no-key (US/Europe/Asia). The gate only *adds* data; it never blocks the other 37. Documented in troubleshooting. |
| First backfill of 37 × 5-yr series on first boot of a fresh preview | One-time ≈ 13 s at 350 ms pace; `manifest.json.backfillDone` guards re-runs; refresh is guarded against overlap so a second boot won't double-fetch. |
