# Feature Specification: Follow the Money

**Feature Branch**: `bos/follow-the-money`

**Created**: 2026-09-17

**Status**: Draft

**App Target**: `marketplace-item` — one installable item with an **app facet** (the investment dashboard), a **service facet** (a background Node worker that pulls daily OHLCV from market-data providers and computes money-flow / base-level / breakout signals), and a **docs facet** (usage + developer pages). The app facet talks to the service facet over the service's own HTTP API; nothing lives in BOS source.

**Input**: User description: "Build a multi-market (US, Europe, Norway, Asia) 'money flow' / sector capital-rotation scanner modeled on Felix Prehn's method: track which industries are going up or down via sector index/ETFs, detect the 'base level' / 'heartbeat' consolidation pattern, confirm breakouts with elevated buying volume, and rank money flow (aggregate dollar volume). As capable and high-quality as possible to support good investment decisions. App name: Follow the Money."

## Method (what the tool operationalizes)

The tool implements a specific, documented investing workflow rather than generic charting:

1. **Follow the money — sector rotation.** Money moves between industries. The core view ranks each region's sectors/industries by (a) price momentum and (b) money flow (aggregate dollar volume = share volume × close, so a $50B-day in semis is visible next to a $500M-day in utilities). This answers the weekly question "which industries are going up and which are going down?"
2. **Base level / heartbeat.** Before a large move, a sector or instrument tends to trade sideways in a horizontal range for a sustained period (the "heartbeat"); the longer the base, the more potential expansion. The tool detects that range, its duration, and its tightness.
3. **Breakout + volume confirmation.** The actionable event is a close above the upper bound of a detected base *with* elevated dollar volume versus the trailing baseline (institutions buying). Without the volume, it is not confirmed.
4. **Multi-region.** The same three signals are computed independently for US, Europe, Norway, and Asia, from a curated universe of indices + sector/industry ETFs per region.
5. **Cross-region rotation pulse.** Beyond the per-region views, a single always-visible strip surfaces the strongest confirmed money-flow moves *across all four regions* this refresh — the at-a-glance answer to "where is the money rotating globally?". This is the weekly read condensed to a glance.
6. **Analytical tool, not an advisor.** The product presents signals and lets the user apply judgment (position sizing, portfolio fit, exit timing). It displays a clear "not financial advice" notice and does not emit stock alerts.

The background service is the engine: it fetches, persists, computes, and serves. The app facet is the read surface. Separating them means signals are computed once per refresh (not on every view), the app loads instantly from cached results, and the app degrades gracefully when the service is offline.

## User Scenarios & Testing *(mandatory)*

### User Story 1 — Money-flow dashboard for a region (Priority: P1)

I open Follow the Money and see a dashboard for a region (US by default): every tracked sector/industry ranked by money flow, with a clear up/down/flat read, momentum over a lookback, and aggregate dollar volume so I can see where the money is actually going. This is the primary daily/weekly view.

**Why this priority**: This is the single most valuable view and the MVP. Standing alone (with the service computing signals for US) it delivers the core insight — "which industries is money flowing into?" — for the largest, most liquid market.

**Independent Test**: With the service having refreshed US data once, opening the app shows a ranked sector list for US, each row showing direction, momentum %, and dollar volume; the top rows are the strongest money-flow sectors. No other region or signal is required for this to be demonstrable.

**Acceptance Scenarios**:
1. **Given** the service has a completed US refresh, **When** I open the app, **Then** the US dashboard lists all US sector/industry instruments ranked by money-flow score, each row showing a direction indicator, momentum % over the default lookback, and recent dollar volume.
2. **Given** the US dashboard, **When** I sort by momentum or by dollar volume, **Then** the list re-ranks immediately.
3. **Given** the US dashboard, **When** a sector's momentum is positive but its dollar volume is low, **Then** it is visually distinguishable from a sector that is both rising and seeing high dollar volume (strong vs. weak money flow).

---

### User Story 2 — Base-level / breakout scanner (Priority: P1)

I switch to the scanner view, which lists instruments that are either (a) in a tight, long "base" (consolidating — a future candidate) or (b) have just broken out of a base with volume confirmation (the actionable "follow the money" signal). I can filter by region and by state (in-base vs. breaking-out).

**Why this priority**: This is the signature signal of the method — the "base level going out sideways to moving up" detector plus breakout-volume confirmation. It is what turns the dashboard from "what's happening now" into "what to watch / what just triggered."

**Independent Test**: With US data refreshed, the scanner lists US instruments in "in-base" and "breaking-out" states; a breaking-out row shows the base range, breakout level, and volume-ratio confirmation. Testable without the dashboard or other regions.

**Acceptance Scenarios**:
1. **Given** US data refreshed, **When** I open the scanner, **Then** it lists each instrument with its detected state: "in base" (with base duration and range width) or "breaking out" (with breakout level) or "trending"/"no base".
2. **Given** an instrument whose latest close is above its detected base's upper bound, **When** that breakout bar's dollar volume is at least the confirmation threshold × the trailing average dollar volume, **Then** it is flagged "breakout confirmed"; otherwise it is flagged "breakout unconfirmed".
3. **Given** the scanner, **When** I filter to "breaking out, confirmed" for a region, **Then** only confirmed breakouts for that region are shown.

---

### User Story 3 — Multi-market (US / Europe / Norway / Asia) (Priority: P2)

I switch the active region among US, Europe, Norway, and Asia. Each region has its own curated universe (indices + sector/industry ETFs/proxies) and the dashboard, scanner, and deep-dive all re-scope to that region.

**Why this priority**: The user explicitly wants multiple markets. It reuses the same signal engine over different universes, so it is high-value but depends on US working first.

**Independent Test**: After the service has refreshed at least two regions, switching the region control re-renders the dashboard and scanner for the newly selected region's instruments.

**Acceptance Scenarios**:
1. **Given** US and Europe data refreshed, **When** I switch the region from US to Europe, **Then** the dashboard and scanner re-scope to the Europe universe (e.g., DAX/EU sector proxies) and show Europe-specific rankings.
2. **Given** Europe and Asia have data but Norway has not been fetched (no key configured), **When** I switch to Norway, **Then** Norway shows its available instruments and clearly marks those requiring a data key as "awaiting data source" rather than failing silently.
3. **Given** any region, **When** I switch regions, **Then** the active-region choice persists across app reloads.

---

### User Story 4 — Instrument deep-dive (Priority: P2)

I click a sector/instrument to open its detail view: a price + volume chart with the detected base range overlaid, the breakout level marked, the trailing average dollar volume, and momentum figures over multiple lookbacks. This is where I verify a signal before acting.

**Why this priority**: Verification surface for the signals; adds trust and depth. Depends on the signal engine (US1/US2) but not on other regions.

**Independent Test**: With US data refreshed, clicking a US instrument in the dashboard/scanner opens its detail view showing the base range, breakout level, and volume chart; a "base" is visually drawn and the breakout is marked.

**Acceptance Scenarios**:
1. **Given** an instrument with a detected base, **When** I open its detail view, **Then** the chart shows the price series, the volume series, a shaded/bracketed base range, and a labeled breakout level.
2. **Given** the detail view, **When** I change the lookback (e.g., 3M / 6M / 1Y / 2Y), **Then** the chart window and the momentum figures update.
3. **Given** an instrument with insufficient history for the minimum lookback, **When** I open its detail view, **Then** it shows "insufficient data for base detection" instead of a fabricated range.

---

### User Story 5 — Background data & signal service (Priority: P1)

The service facet runs a scheduled pipeline: on a daily cadence it fetches OHLCV for the whole instrument universe from the primary provider (Nasdaq API, no key), falls back to the keyed provider (Twelve Data) for symbols the primary cannot serve, persists the bars, recomputes all signals, and serves them over its own HTTP API. A lightweight intraday liveness check confirms the pipeline is alive.

**Why this priority**: This is the engine that makes US1–US4 possible and correct. It must exist before any dashboard can show real data, and it is independently testable (it produces a correct signals JSON and persists bars).

**Independent Test**: Running the service's refresh once produces a persisted set of daily bars and a computed signals document for the universe; the HTTP API returns that signals document and a data-health record. No app UI required.

**Acceptance Scenarios**:
1. **Given** the service is configured, **When** a daily refresh runs, **Then** it fetches each instrument's latest daily OHLCV, upserts the bars keyed by (instrument, date), and recomputes each instrument's signal.
2. **Given** a symbol the primary provider cannot serve, **When** a refresh runs and a data key is configured, **Then** the symbol is fetched from the fallback (keyed) provider.
3. **Given** a symbol unavailable from both providers (e.g., Norway with no key), **When** a refresh runs, **Then** the symbol is marked "unavailable — data source not configured" in the health record and its prior signals (if any) are retained and stamped stale.
4. **Given** a provider returns a rate-limit/HTTP-429, **When** a refresh is mid-run, **Then** the service backs off and retries, then falls through to the next provider, and logs the event.
5. **Given** the service is running, **When** the app queries `GET /api/health` (on the service port), **Then** it returns last-refresh time per provider, symbols fetched/failed, credits used, and key-configured state.

---

### User Story 6 — Personal watchlist (Priority: P3)

I add instruments I care about to a watchlist; the dashboard offers a watchlist filter, and each watchlisted instrument shows its current money-flow score and state. This is a lightweight "my list" on top of the global universe.

**Why this priority**: Personalization and retention; depends on the signal engine and universe but is not needed for the core value.

**Independent Test**: With US data refreshed, adding a US instrument to the watchlist and toggling the watchlist filter shows only my instruments with their scores.

**Acceptance Scenarios**:
1. **Given** the dashboard, **When** I add an instrument to the watchlist, **Then** it persists and a watchlist filter/section shows it with its current score and state.
2. **Given** the watchlist, **When** I remove an instrument, **Then** it is no longer shown in the watchlist view (it remains in the global universe).

---

### User Story 7 — Data-source configuration & health (Priority: P2)

I can view data health (last refresh per provider, failures, whether a key is set) and add/remove the market-data API key and a custom instrument in the service's configuration. Without a key the app still works for the no-key regions.

**Why this priority**: The app's capability boundary (Norway, exact home-exchange indices) is gated by a key; the user needs a first-class way to configure it and see the consequence. Depends on the service (US5).

**Independent Test**: With the service running, reading and writing the service config (add a key, add an instrument) takes effect on the next refresh, and the health endpoint reflects key presence and per-provider status.

**Acceptance Scenarios**:
1. **Given** no key configured, **When** I view health, **Then** it reports key-not-configured and lists the instruments that are unavailable as a result.
2. **Given** I configure a data key, **When** the next refresh runs, **Then** previously-unavailable keyed instruments are fetched and their signals appear.
3. **Given** I add a custom instrument (symbol, region, category, provider), **When** the next refresh runs, **Then** the instrument is included in that provider's fetch list and appears in its region.

### Edge Cases

- **Primary provider returns "symbol not exists"**: fall back to the keyed provider for that symbol; if no key is configured, mark the symbol "unavailable — data source not configured" and retain its last-known signal stamped stale.
- **Market closed / weekend / holiday**: show the most recent trading day's data with an explicit "as-of" timestamp; do not treat the flat close as a "no-move" signal without the date context.
- **Provider HTTP 429 / rate limit**: exponential backoff + retry on the same provider, then fall through to the next provider for that symbol; log the event in the health record; never drop a partial batch that would corrupt prior data.
- **New / low-history instrument** (fewer bars than the minimum lookback): base detector returns "insufficient data" (no fabricated range, no false breakout); momentum uses whatever history exists and is labeled by length.
- **Currency differs by region** (EUR/GBP/JPY/NOK vs USD): momentum and base geometry are computed on the price series (currency-independent); dollar volume is reported in the instrument's native currency and labeled; cross-instrument money-flow ranking within a region uses each instrument's native-currency dollar volume.
- **Service down when the app opens**: the app serves the last-persisted signals with their "as-of" timestamps plus a visible "data is N hours old / service offline" warning, rather than an error page.
- **Split/dividend in the price series**: the pipeline detects abnormal single-bar price gaps and flags the bar; the base detector treats a flagged gap as a series break (resetting the base) rather than a fake breakout.
- **Partial refresh failure**: a successful refresh of the majority of symbols commits; failed symbols are logged and re-attempted on the next cycle; prior good data for failed symbols is retained, never zeroed.

## Requirements *(mandatory)*

### Functional Requirements

- **FR-001**: The app MUST present a **money-flow dashboard** for the active region that lists every tracked instrument ranked by a composite money-flow score, each row showing: a direction indicator (up/flat/down), price momentum % over the active lookback, and recent aggregate dollar volume.
- **FR-002**: The system MUST compute a **base-level / consolidation detector** per instrument: given a price series, it MUST report whether the recent series is in a horizontal base, and if so the base's lower bound, upper bound, duration (in trading days), and tightness (normalized range width).
- **FR-003**: The system MUST compute a **breakout detector** per instrument: flag an instrument when its latest close is above the upper bound of a detected base (and below the lower bound for a breakdown, reported as a separate state).
- **FR-004**: The system MUST compute **breakout volume confirmation**: the ratio of the breakout bar's dollar volume to the trailing average dollar volume over a configurable baseline window (default 20 trading days); a breakout MUST be marked "confirmed" only when the ratio meets or exceeds a configurable threshold (default 1.5×).
- **FR-005**: The system MUST compute a **composite money-flow score** per instrument combining momentum (default 3-month) and money flow (recent dollar volume versus its own trailing average), and the dashboard/scanner MUST rank by this score.
- **FR-006**: The system MUST support **four regions** — US, Europe, Norway, Asia — each with a curated, user-editable instrument universe of indices and sector/industry ETFs (or US-listed proxies), and the default universe MUST ship with a sensible coverage set per region.
- **FR-007**: The app MUST allow **switching the active region** among US/Europe/Norway/Asia, re-scoping the dashboard, scanner, and deep-dive to that region's universe; the choice MUST persist across reloads.
- **FR-008**: The app MUST provide an **instrument detail view**: a combined price + volume chart with the detected base range overlaid, the breakout level marked, the trailing average dollar volume shown, and momentum figures over multiple lookbacks (3M / 6M / 1Y / 2Y minimum).
- **FR-009**: The service MUST **persist** daily OHLCV bars and computed signals so the app reads precomputed results (no live recomputation on view) and so the app remains usable offline from its last refresh.
- **FR-010**: The service MUST run a **scheduled daily pipeline** that fetches the latest daily OHLCV for the whole universe, upserts the bars keyed by (instrument, date), and recomputes all signals; it MUST also run a lightweight **intraday liveness check** (single-symbol spot quote) to confirm the pipeline is alive.
- **FR-011**: The service MUST fetch from a **primary no-key provider** (Nasdaq API) and **fall back to a keyed provider** (Twelve Data) for symbols the primary cannot serve (Norway instruments and exact home-exchange indices), with per-symbol provider selection recorded.
- **FR-012**: The service MUST be configurable with an **optional market-data API key**; with no key configured, the app MUST remain fully functional for all instruments the no-key primary can serve (US, and Europe/Asia via US-listed proxy ETFs) and MUST clearly mark the instruments that require a key as "awaiting data source".
- **FR-013**: The service MUST expose an **HTTP API on its own port** providing: current signals for a region, a single instrument's detail (series + base + breakout + volume), data health/status, and a "refresh now" trigger.
- **FR-014**: The system MUST persist **user configuration**: active region, active lookback, base/breakout/volume thresholds, the instrument universe edits, and the watchlist.
- **FR-015**: The app MUST let the user **add/remove instruments from a personal watchlist** and show each watchlisted instrument's current money-flow score and state via a dedicated filter/section.
- **FR-016**: The app MUST show a **data-health indicator**: last successful refresh time per provider, count of symbols fetched vs. failed, credits used (keyed provider), and whether a key is configured.
- **FR-017**: The service MUST allow **adding a custom instrument** (symbol, region, category, provider) to the universe via configuration, which then participates in the next refresh.
- **FR-018**: The app MUST display a persistent **"not financial advice / analytical tool"** notice on the dashboard and detail views.
- **FR-019**: The service MUST **detect abnormal single-bar price gaps** (potential splits/corrections) in a fetched series and flag them; the base detector MUST treat a flagged gap as a series break, not a price move.
- **FR-020**: The app MUST **surface the "as-of" timestamp** of the underlying data on every region view and detail view.
- **FR-021**: The app MUST show a **cross-region money-flow pulse** — a compact, always-visible strip (on the dashboard and scanner) listing the top N (default 5) confirmed breakouts / strongest money-flow instruments across ALL four regions for the current refresh, each tagged with its region, so a user can see global rotation at a glance. The strip MUST be clickable through to each instrument's detail. Regions with no data (e.g., Norway without a key) MUST simply contribute no entries, not an error.

### Non-Functional Requirements

- **NFR-001 (Performance — load)**: The dashboard and scanner MUST render from cached service data in under 2 seconds under normal conditions.
- **NFR-002 (Performance — refresh)**: A full daily refresh of the default ~44-instrument universe MUST complete in under 5 minutes; the intraday liveness check MUST complete in under 2 seconds.
- **NFR-003 (Reliability — fallback)**: The service MUST retry with backoff on a rate-limited or errored provider call, then fall through to the next provider per symbol; a partial failure MUST NOT corrupt or zero previously-persisted good data.
- **NFR-004 (Reliability — availability)**: The app MUST remain usable when the service is offline, serving the last persisted signals with their "as-of" timestamps and a stale-data warning.
- **NFR-005 (Data integrity)**: Daily bars MUST be idempotently upserted by (instrument, date) so re-fetching a day does not duplicate or drift; the pipeline MUST detect and flag gaps in a series.
- **NFR-006 (Graceful degradation)**: With no API key configured, the app MUST label the exact set of instruments that are unavailable (Norway, home-exchange indices) and MUST NOT present them with fabricated or stale-without-label data.
- **NFR-007 (Cost)**: At the default universe, the keyed-provider consumption MUST stay at or below ~9 credits/day (within a free-tier budget of 800 credits/day).
- **NFR-008 (Extensibility)**: Regions, instruments, and providers MUST be addable via configuration without source changes; provider adapters MUST be isolated so a new provider is a new module, not a refactor.
- **NFR-009 (Security)**: The market-data API key MUST be stored in the service's configuration and MUST NOT be exposed in the app bundle or in API responses beyond a presence/absence indicator; the service MUST bind to its own configured port (default: OS-assigned).
- **NFR-010 (Correctness of signals)**: Given a synthetic instrument engineered to be in a known base and then to break out with a known volume ratio, the detectors MUST report the expected base bounds, the expected breakout state, and the expected confirmation state.
- **NFR-011 (Determinism)**: For an identical input series, the base/breakout/score computations MUST produce identical output (no hidden nondeterminism), so results are reproducible and testable.

### Key Entities

- **Instrument**: symbol, display name, region (US/Europe/Norway/Asia), category (broad-index / sector / proxy / stock), provider (primary / fallback / both), native currency, optional weight, enabled flag.
- **PriceBar**: instrument ref, date, open, high, low, close, volume (shares), dollarVolume (volume × close), gapFlag (split/anomaly marker).
- **Signal**: instrument ref, asOf date, momentumPct (per lookback: 3M/6M/1Y/2Y), moneyFlowRatio (recent dollar volume vs. trailing average), base { present, lowerBound, upperBound, durationDays, tightness, sufficientData }, breakout { present, level, direction (up/down), volumeRatio, confirmed }, moneyFlowScore (composite), state (in-base / breaking-out-confirmed / breaking-out-unconfirmed / trending / no-base / insufficient-data / unavailable).
- **RefreshRecord**: provider, timestamp, symbolsOk, symbolsFailed, creditsUsed, keyConfigured, events (list of rate-limit/fallback/gap notes).
- **Watchlist**: ordered list of instrument refs.
- **AppConfig**: activeRegion, activeLookback, thresholds { baseMinDuration, baseMaxWidth, breakoutVolumeRatio, baselineWindow }, universe edits, watchlist, keyConfigured.

## Success Criteria *(mandatory)*

### Measurable Outcomes

- **SC-001**: On the US region, the dashboard displays all default US sector/industry + broad instruments with direction, momentum %, and dollar volume, ranked by money-flow score, in under 2 seconds after a completed refresh.
- **SC-002**: On a curated backtest set of ≥ 10 real US instruments with known historical base-breakouts, the base + breakout + volume-confirmation detectors correctly identify ≥ 80% of the breakouts (confirmed state matches the engineered expectation).
- **SC-003**: All four regions are selectable; US, Europe, and Asia show full data with no key; Norway and home-exchange indices are correctly labeled "awaiting data source" with no key and show data once a free key is configured.
- **SC-004**: A full default-universe daily refresh completes in under 5 minutes with a per-provider health record; a partial provider failure leaves prior good data intact.
- **SC-005**: The app remains fully usable (last signals + "as-of" + stale warning) with the service stopped.
- **SC-006**: Keyed-provider consumption at the default universe is ≤ 9 credits/day.
- **SC-007**: For an identical synthetic input series, repeated runs of the signal computation produce byte-identical signal output (determinism).
- **SC-008**: A new region or a new instrument added via configuration appears in the app on the next refresh with no code change.
- **SC-009**: With at least two regions refreshed, the cross-region pulse lists the top N confirmed/strongest money-flow instruments across all regions, each correctly tagged with its region and clickable to detail; regions without data contribute no entries and cause no error.

## Assumptions

- The runtime environment has outbound internet, but some common free providers are IP-blocked from datacenter/sandbox ranges (verified: Stooq and Yahoo are blocked; the Nasdaq website's own API is open with no key). The design therefore MUST NOT hard-depend on a single provider and MUST support the no-key primary + keyed fallback split.
- The default instrument universe is a curated set of ~44 instruments: US broad + sector ETFs, US-listed Europe and Asia proxy ETFs, and (keyed) Norway + home-exchange indices. Exact symbols are chosen in the design/plan phase from the verified data-source research.
- Dollar volume (share volume × close) is an acceptable proxy for money flow for rotation purposes; it is reported in the instrument's native currency.
- The primary signal cadence is daily; intraday is used only as a liveness heartbeat, not for signal computation.
- The market-data API key (Twelve Data free tier) is optional; the product is fully functional for US, Europe, and Asia without it.
- This is an analytical/educational decision-support tool, not a trading-execution or investment-advisory product; it surfaces signals and a "not financial advice" notice.
- The app facet consumes the service facet's HTTP API and does not talk to external data providers directly.
