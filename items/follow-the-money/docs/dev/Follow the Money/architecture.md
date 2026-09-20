# Follow the Money — Architecture

One marketplace item, three facets. Nothing lives in BOS source.

| Facet | What | Runs in |
|---|---|---|
| `app/` | React investment dashboard (bundled by `app_build`) — the **read surface** | BOS as an installed iframe app |
| `services/` | Plain-Node **CommonJS** worker-thread daemon — the **engine**: fetch → persist → compute → serve | Spawned by BOS `ServiceManager` (`new Worker(entry)`), binds its own HTTP port |
| `docs/` | These pages | Docs app overlay |

**The one load-bearing separation (ADR-d):** the service fetches OHLCV, persists bars, computes every signal **once per refresh**, and serves precomputed results over its own HTTP API. The app renders those results and does *no* signal math — only presentational formatting. Consequences: instant loads (< 2 s), reproducible deterministic signals, and graceful offline degradation (last persisted results + as-of + a stale banner).

The worker is **unbundled and self-contained**: it cannot and does not import any BOS-source module (grep `services/` for `@/` — zero hits). `services/package.json` pins `"type": "commonjs"` so the unbundled worker never mis-parses ESM syntax. The entry (`src/index.js`) has the `parentPort` guard first: loaded on the main thread (the manifest load check) it exits 0 silently.

## Provider layer (ADR-a)

Pluggable adapters behind one interface (`fetchDaily`, optional `fetchSpot`), registered in `providers/registry.js`. A new provider is a new module — not a refactor.

| Adapter | Role | Key | Notes |
|---|---|---|---|
| `nasdaq` | PRIMARY | no | api.nasdaq.com chart API. Requires browser-ish `User-Agent` + `Origin` + `Referer` headers. `ohlcv[].z` rows: string numbers with commas, `M/D/YYYY` dates. **assetclass is derived per instrument and is limited to `etf` (everything) and `index` (NDX)** — the endpoint accepts *no other value* (verified live: `assetclass=stock` and 10 others → "bad parameter"; a real stock under etf/index → "symbol not exists"). **Individual stocks are therefore not served by Nasdaq at all**; for a stock the adapter signals `NOT_FOUND` (before any request) so the chain falls through to the keyed, stock-capable fallback. NDX rows carry only `lastSalePrice` → price-only, volume 0. Raw (unadjusted) close. Paced 350 ms. |
| `twelvedata` | FALLBACK | yes | Global incl. Oslo (`EQNR.OL`) and `^` home-exchange indices. 1 credit/successful call, 8 req/min (paced ~7.5 s), `outputsize=800`, values are date-descending → reversed. |
| `cnbc` | HEARTBEAT | no | `fetchSpot` only, US symbols only. Feeds the 5-min liveness check, never signals. |

Per-symbol chain from `providerIds` (`primary → [nasdaq]`, `fallback → [twelvedata]`, `both → [nasdaq, twelvedata]`). Walk the chain: availability check (keyed provider without a key → skip) → fetch with retry (exponential backoff base 5 s × 2^attempt, max 3, honoring `Retry-After`; Nasdaq 429 → 5 s, one retry, fall through) → `NOT_FOUND` → next provider → success records `providerUsed`. Chain exhausted because a key is missing → the symbol is **"unavailable — data source not configured"**, prior data retained and stamped stale (ADR-e) — never silent, never fabricated.

Stooq and Yahoo are deliberately not used (IP-blocked from the deployment sandbox); Alpha Vantage/EODHD free tiers are below the 46-symbol daily need.

**Credit budget:** only `twelvedata` consumes credits. `creditsUsedToday` (UTC-midnight reset, persisted in the manifest) is capped by `dailyCreditBudget` (default 15; the default keyed set costs 9/day). Budget exhausted → remaining keyed symbols "deferred — credit budget", picked up next day.

**Hard gate:** the nine keyed symbols ship `enabled:false` until `scripts/probe-twelvedata.js` confirms each ticker with a live key (a wrong Oslo suffix would be a permanent `NOT_FOUND`). The product is fully correct no-key; the gate only adds data.

## Signal engine (deterministic, pure)

`services/src/signal/*` are pure functions of `(bars, thresholds)` — no `Date.now()`, no randomness, no I/O. S1 momentum per lookback, S2 money-flow ratio (recent window excluded from its own baseline), S3 **trailing-run** base detector — the base is the *longest recent contiguous tight run ending at the last bar*: scan backwards, stop at the first bar whose running width exceeds `baseMaxWidth` (or a gap flag, which is a series break); `durationDays` = that run's length, `tightness` = its final width (a 60-day tight band preceded by a wider move *is* a 60-day base — the earlier all-or-nothing reading, which required a full year of consolidation, made the Scanner dead), S4 breakout against the *preceding valid* base, S5 volume confirmation (≥ 1.5× trailing 20-day dollar volume), S6 composite 0–100 score (`50 + 50·tanh` blend), S7 state resolution with `unavailable` checked **first**, S8 cross-region pulse, S9 abnormal-gap detection (≥ 20 % single-day move → split/artifact guard on raw closes).

Determinism guardrail: signal/rollup/pulse objects are built with fixed key-insertion order and array-only iteration, so identical input produces **byte-identical** JSON (verified: re-running the pipeline on unchanged data leaves every signal file byte-identical). Unit suite: `node --test services/tests/` (no npm deps) — `signal.test.js` (engine + the trailing-run regression), `nasdaq.test.js` (assetclass resolution / stock fall-through), `config.test.js` (per-provider keys, secret migration, NFR-009, stock provider chain).

## Storage (ADR-c)

The worker is handed `configDirPath` (= `dataDir()/system/config/follow-the-money/`) and persists under its **`data/` subdirectory** — deliberately, because BOS's `GET /api/services/<id>/config` enumerates only *top-level* `*.json` in the config dir and returns values verbatim; keeping bars/signals **and the API key** one level down keeps them out of that route entirely. Not the VFS (bars are service state, not user documents), not the item's code folder (that's GitFS content). See `data-model.md` for the on-disk tree. Bars are upserted per symbol by `(instrument, date)` with atomic write-temp-then-rename; a failed symbol's file is never touched (NFR-003/005). `data/secret.json` is mode 0600 and presence-only in every response (NFR-009).

## Connectivity (ADR-b)

The service's config port defaults to **0** (OS-assigned) — never a fixed number (fixed defaults collide with BOS's reserved ranges; a service defaulting to 3001 once caused a real `EADDRINUSE` incident). The app resolves reachability in one place, `app/src/lib/serviceClient.ts`, exactly per BOS `docs/dev/apps/services.md` §11:

1. `GET /api/services/follow-the-money/config` (same-origin BOS route) → read only `runtime`, `httpPath`, `wsPath`, `values.{port,host}`.
2. `httpBaseUrl = httpPath ? origin + httpPath : protocol//hostname:runtime.port/`.
3. `runtime: null` is a transient mid-bind window → poll ~1 s for up to ~15 s before declaring offline.

That supports all three deployment scenarios: multi-user Bastion (`https://<host>/__supervisor/services/follow-the-money/`), Supervisor-only Docker (`http://<host>:<public-port>/__supervisor/...`), and standalone `npm run dev` (`http://localhost:<runtime.port>/`, which changes every restart). The service binds `127.0.0.1` and is reached same-origin via the Supervisor proxy in fronted deployments; its own responses carry permissive CORS headers so the standalone direct-port case (different origin) also works — no response ever contains key material.

Offline (NFR-004): the client caches the last successful response per route in `localStorage`; if the service is unreachable the app renders cached data + as-of + a visible "service offline / data is N hours old" banner — never an error page.

## Scheduling

In-worker `setTimeout`/`setInterval` (no external cron): daily full refresh at 17:05 UTC (configurable `cadence`), catch-up on worker start when `lastFullRefresh` is older than a trading day, first-run 5-yr backfill per symbol, 5-minute CNBC heartbeat (NDX spot) setting `pipelineAlive`/`lastHeartbeat`. A `refreshing` guard serializes refreshes.
