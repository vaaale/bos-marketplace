"use strict";
// The service's own HTTP API (FR-013, design §2.5) — plain node:http bound to
// the configured host/port (default 127.0.0.1:0 — OS-assigned, ADR-b).
// Every read endpoint serves the LAST PERSISTED results (instant,
// offline-capable — FR-009). All key handling is presence-only (NFR-009).
// CORS is permissive: in the standalone (no-Supervisor) scenario the app
// iframe is on the BOS origin while the service is on its own localhost port,
// so cross-origin fetch must be allowed; responses never contain key material.

const http = require("node:http");
const path = require("node:path");
const store = require("../storage/store.js");
const configMod = require("../config/config.js");
const { readBars } = require("../storage/bars.js");
const { readSignal, readRegionRollup, readPulse } = require("../storage/signals.js");
const { readRecords, latestByProvider } = require("../storage/refreshlog.js");
const { startRefresh, getBuffer, REGION_ORDER, UNAVAILABLE_REASON, NOT_FOUND_REASON, PENDING_PROBE_REASON, isKeyGated, isDisplayInstrument } = require("../pipeline/refresh.js");
const { nextRefreshAt } = require("../pipeline/scheduler.js");

const BODY_LIMIT = 1024 * 1024; // 1 MB

function sendJSON(res, status, obj) {
  const body = JSON.stringify(obj);
  res.writeHead(status, {
    "Content-Type": "application/json; charset=utf-8",
    "Content-Length": Buffer.byteLength(body),
    "Access-Control-Allow-Origin": "*",
    "Access-Control-Allow-Methods": "GET,POST,PATCH,OPTIONS",
    "Access-Control-Allow-Headers": "Content-Type"
  });
  res.end(body);
}

function readBody(req) {
  return new Promise((resolve, reject) => {
    let size = 0;
    const chunks = [];
    req.on("data", (c) => {
      size += c.length;
      if (size > BODY_LIMIT) {
        reject(new Error("body too large"));
        req.destroy();
        return;
      }
      chunks.push(c);
    });
    req.on("end", () => resolve(Buffer.concat(chunks).toString("utf8")));
    req.on("error", reject);
  });
}

// ---- health (FR-016 / US5) ----
function buildHealth(ctx) {
  const dataDir = ctx.dataDir;
  const keyConfigured = configMod.keyConfigured(dataDir);
  const cfg = configMod.getConfig(dataDir);
  const manifest = configMod.readManifest(dataDir);
  const latest = latestByProvider(dataDir);
  const universe = configMod.getUniverse(dataDir);

  const providerRows = [];
  const nas = latest.nasdaq;
  providerRows.push({
    id: "nasdaq",
    status: nas ? (nas.symbolsFailed === 0 ? "ok" : "limited") : "off",
    lastRefresh: nas ? nas.ts : null,
    symbolsOk: nas ? nas.symbolsOk : 0,
    symbolsFailed: nas ? nas.symbolsFailed : 0,
    keyRequired: false,
    keyConfigured: null
  });
  const td = latest.twelvedata;
  // Fix A: if the most recent keyed refresh recorded INVALID_KEY events, the
  // configured key was REJECTED (expired/rotated) — that is "auth_error", not
  // "ok"/"limited". The user has to re-enter/rotate the key, which is a
  // different action than "configure a missing data source".
  const tdEvents = (td && td.events) || [];
  const tdAuthError = tdEvents.some((e) => e.indexOf("INVALID_KEY") !== -1);
  const tdStatus = !keyConfigured
    ? "limited"
    : tdAuthError
      ? "auth_error"
      : td
        ? td.symbolsFailed === 0 ? "ok" : "limited"
        : "off";
  providerRows.push({
    id: "twelvedata",
    status: tdStatus,
    lastRefresh: td ? td.ts : null,
    symbolsOk: td ? td.symbolsOk : 0,
    symbolsFailed: td ? td.symbolsFailed : 0,
    keyRequired: true,
    keyConfigured,
    lastError: tdAuthError ? "401 Unauthorized — key invalid or expired" : undefined,
    creditsUsedToday: manifest.creditsUsedToday || 0,
    dailyCreditBudget: cfg.dailyCreditBudget
  });

  const regions = [];
  const unavailable = [];
  let asOf = null;
  const universeOverrides = cfg.universeOverrides || {};
  for (const region of REGION_ORDER) {
    const insts = universe.filter((i) => i.region === region && isDisplayInstrument(ctx.registry, i));
    let ok = 0;
    let stale = 0;
    let unav = 0;
    let regionAsOf = null;
    const regionReasons = new Set();
    for (const inst of insts) {
      const sig = readSignal(dataDir, region, inst.symbol);
      if (!sig) {
        // No signal yet (never refreshed / just installed). For a key-gated
        // symbol this is a pre-fetch estimate of the reason: no key at all, a
        // probe already confirmed the ticker doesn't exist (notFound), or the
        // T10 pending-probe state (key present, not yet enabled).
        if (isKeyGated(ctx.registry, inst) && (!keyConfigured || !inst.enabled)) {
          unav += 1;
          const o = universeOverrides[inst.symbol];
          const reason = !keyConfigured
            ? UNAVAILABLE_REASON
            : o && o.notFound
              ? NOT_FOUND_REASON
              : PENDING_PROBE_REASON;
          unavailable.push({ symbol: inst.symbol, region, reason });
          regionReasons.add(reason);
        }
        continue;
      }
      if (sig.state === "unavailable") {
        unav += 1;
        const reason = sig.unavailableReason || UNAVAILABLE_REASON;
        unavailable.push({ symbol: inst.symbol, region, reason });
        regionReasons.add(reason);
      } else if (sig.stale) {
        stale += 1;
      } else {
        ok += 1;
      }
      if (sig.asOf && (!regionAsOf || sig.asOf > regionAsOf)) regionAsOf = sig.asOf;
    }
    const row = {
      region,
      total: insts.length,
      ok,
      failed: Math.max(0, insts.length - ok - stale - unav),
      stale,
      asOf: regionAsOf
    };
    // When a whole region is unavailable, surface the reason. If every symbol
    // shares one reason, use it (so "key rejected" isn't masked by the generic
    // "not configured"); a mixed region falls back to the generic label.
    if (ok === 0 && unav > 0 && unav === insts.length) {
      row.reason = regionReasons.size === 1 ? Array.from(regionReasons)[0] : UNAVAILABLE_REASON;
    }
    regions.push(row);
    if (regionAsOf && (!asOf || regionAsOf > asOf)) asOf = regionAsOf;
  }

  const events = [];
  const records = readRecords(dataDir, 10);
  for (const r of records) {
    for (const e of r.events || []) events.push(r.ts + " " + e);
  }

  return {
    asOf,
    pipelineAlive: Boolean(ctx.state.pipelineAlive),
    lastHeartbeat: ctx.state.lastHeartbeat || null,
    // Why the last heartbeat failed (null when it succeeded / never ran). A dead
    // heartbeat with pipelineAlive:false and NO cause was the exact silence that
    // hid the missing-UA bug — surface the reason so it can't be mistaken for a
    // live-but-quiet pipeline.
    lastHeartbeatError: ctx.state.lastHeartbeatError || null,
    lastFullRefresh: manifest.lastFullRefresh || null,
    nextRefreshAt: ctx.state.nextRefreshAt || nextRefreshAt(cfg.cadence, new Date()).toISOString(),
    refreshing: Boolean(ctx.state.refreshing),
    providers: providerRows,
    regions,
    keyConfigured,
    unavailable,
    events: events.slice(-20)
  };
}

// ---- instrument detail (FR-008) ----
function buildInstrumentDetail(ctx, symbol, region, lookback) {
  const dataDir = ctx.dataDir;
  const cfg = configMod.getConfig(dataDir);
  const universe = configMod.getUniverse(dataDir);
  let inst = null;
  if (region) {
    inst = universe.find((i) => i.symbol === symbol && i.region === region) || null;
  } else {
    // cross-region lookup when region omitted
    inst = universe.find((i) => i.symbol === symbol) || null;
  }
  if (!inst) return null;
  const sig = readSignal(dataDir, inst.region, inst.symbol);
  const barsDoc = readBars(dataDir, inst);
  const lb = cfg.thresholds.lookbackDays[lookback] ? lookback : "3M";
  const k = cfg.thresholds.lookbackDays[lb];
  const series = barsDoc.bars.slice(-k).map((b) => ({
    date: b.date,
    close: b.close,
    volume: b.volume,
    dollarVolume: b.dollarVolume,
    gapFlag: b.gapFlag
  }));
  const emptyBase = { present: false, lowerBound: null, upperBound: null, durationDays: 0, tightness: null, sufficientData: false };
  const emptyBreakout = { present: false, level: null, direction: null, volumeRatio: 0, confirmed: false };
  return {
    instrument: inst,
    currency: (sig && sig.currency) || inst.currency,
    asOf: sig ? sig.asOf : null,
    lookback: lb,
    series,
    trailingAvgDollarVolume: sig ? sig.trailingAvgDollarVolume : 0,
    recentDollarVolume: sig ? sig.recentDollarVolume : 0,
    base: sig ? sig.base : emptyBase,
    breakout: sig ? sig.breakout : emptyBreakout,
    momentumPct: sig ? sig.momentumPct : { "3M": null, "6M": null, "1Y": null, "2Y": null },
    score: sig ? sig.score : { moneyFlowScore: 0, momentumScore: 0, flowScore: 0 },
    stale: sig ? sig.stale : false,
    state: sig ? sig.state : isKeyGated(ctx.registry, inst) ? "unavailable" : "insufficient-data"
  };
}

// ---- watchlist (FR-015) ----
function buildWatchlist(ctx) {
  const dataDir = ctx.dataDir;
  const cfg = configMod.getConfig(dataDir);
  const rollups = {};
  let asOf = null;
  for (const region of REGION_ORDER) {
    rollups[region] = readRegionRollup(dataDir, region);
    if (rollups[region] && rollups[region].asOf && (!asOf || rollups[region].asOf > asOf)) asOf = rollups[region].asOf;
  }
  const entries = [];
  for (const symbol of cfg.watchlist) {
    // config order preserved; symbols resolved across regions
    for (const region of REGION_ORDER) {
      const r = rollups[region];
      const found = r && (r.instruments || []).find((s) => s.symbol === symbol);
      if (found) {
        entries.push(found);
        break;
      }
    }
  }
  return { asOf, entries };
}

// ---- universe (FR-006) ----
function buildUniverse(ctx) {
  const dataDir = ctx.dataDir;
  const keyConfigured = configMod.keyConfigured(dataDir);
  const universeOverrides = configMod.getConfig(dataDir).universeOverrides || {};
  const instruments = configMod.getUniverse(dataDir).map((inst) => {
    const sig = readSignal(dataDir, inst.region, inst.symbol);
    let availability;
    if (!inst.enabled && !isKeyGated(ctx.registry, inst)) availability = "disabled";
    else if (sig && sig.state === "unavailable") availability = "unavailable";
    else if (isKeyGated(ctx.registry, inst) && (!keyConfigured || !inst.enabled)) availability = "unavailable";
    else if (sig && sig.stale) availability = "stale";
    else if (sig) availability = "ok";
    else availability = "pending";
    // Fix B: expose the probe's permanent-NOT_FOUND marker so the app can show
    // "ticker not found" (grey) distinct from the pending-probe (amber) state.
    return Object.assign({}, inst, {
      availability,
      notFound: Boolean(universeOverrides[inst.symbol] && universeOverrides[inst.symbol].notFound)
    });
  });
  return { instruments };
}

function createServer(ctx) {
  const server = http.createServer(async (req, res) => {
    try {
      const url = new URL(req.url, "http://localhost");
      const p = url.pathname.replace(/\/+$/, "") || "/";
      const method = req.method || "GET";

      if (method === "OPTIONS") {
        res.writeHead(204, {
          "Access-Control-Allow-Origin": "*",
          "Access-Control-Allow-Methods": "GET,POST,PATCH,OPTIONS",
          "Access-Control-Allow-Headers": "Content-Type"
        });
        res.end();
        return;
      }

      if (method === "GET" && p === "/api/health") {
        sendJSON(res, 200, buildHealth(ctx));
        return;
      }

      if (method === "GET" && p === "/api/signals") {
        const region = url.searchParams.get("region") || "US";
        if (REGION_ORDER.indexOf(region) === -1) {
          sendJSON(res, 404, { error: "unknown region: " + region });
          return;
        }
        const rollup = readRegionRollup(ctx.dataDir, region);
        sendJSON(res, 200, rollup || {
          region,
          currency: region === "Norway" ? "NOK" : "USD",
          asOf: null,
          instruments: [],
          counts: { total: 0, inBase: 0, breakingOutConfirmed: 0, breakingOutUnconfirmed: 0, trending: 0, unavailable: 0, insufficient: 0 }
        });
        return;
      }

      const instMatch = p.match(/^\/api\/instruments\/([^/]+)$/);
      if (method === "GET" && instMatch) {
        const symbol = decodeURIComponent(instMatch[1]);
        const region = url.searchParams.get("region") || null;
        const lookback = url.searchParams.get("lookback") || "3M";
        const detail = buildInstrumentDetail(ctx, symbol, region, lookback);
        if (!detail) {
          sendJSON(res, 404, { error: "unknown instrument: " + symbol });
          return;
        }
        sendJSON(res, 200, detail);
        return;
      }

      if (method === "GET" && p === "/api/pulse") {
        sendJSON(res, 200, readPulse(ctx.dataDir));
        return;
      }

      if (method === "GET" && p === "/api/watchlist") {
        sendJSON(res, 200, buildWatchlist(ctx));
        return;
      }

      if (method === "GET" && p === "/api/universe") {
        sendJSON(res, 200, buildUniverse(ctx));
        return;
      }

      // Refresh Console: the per-attempt log for the current (or most recent
      // completed) refresh. `?since=<seq>` tails only newer events; counts always
      // describe the whole current refresh. The bound service ALWAYS answers
      // this, so a 404 on the app side is mis-addressed/offline (core route) —
      // never a real "no such thing".
      if (method === "GET" && p === "/api/refresh/log") {
        const sinceRaw = url.searchParams.get("since");
        let since;
        if (sinceRaw !== null && sinceRaw !== "") {
          const n = Number(sinceRaw);
          if (Number.isFinite(n)) since = n;
        }
        sendJSON(res, 200, getBuffer(ctx).snapshot(since));
        return;
      }

      if (method === "POST" && p === "/api/refresh") {
        let body = {};
        try {
          const raw = await readBody(req);
          if (raw) body = JSON.parse(raw);
        } catch (err) {
          sendJSON(res, 400, { error: "invalid JSON body" });
          return;
        }
        const scope = body && body.scope ? String(body.scope) : "all";
        if (scope !== "all" && REGION_ORDER.indexOf(scope) === -1) {
          sendJSON(res, 400, { error: "invalid scope" });
          return;
        }
        const result = startRefresh(ctx, scope);
        const out = { started: result.started, refreshId: result.refreshId };
        if (result.reason) out.reason = result.reason;
        sendJSON(res, result.started ? 202 : 200, out);
        return;
      }

      if (method === "GET" && p === "/api/config") {
        sendJSON(res, 200, configMod.maskedConfig(ctx.dataDir, ctx.registry)); // key NEVER included
        return;
      }

      if (method === "PATCH" && p === "/api/config") {
        let ops = null;
        try {
          ops = JSON.parse(await readBody(req));
        } catch (err) {
          sendJSON(res, 400, { error: "invalid JSON body" });
          return;
        }
        const result = configMod.applyConfigOps(ctx.dataDir, ops || {}, ctx.registry);
        if (!result.ok) {
          sendJSON(res, 400, { ok: false, error: result.error });
          return;
        }
        if (result.cadenceChanged && ctx.scheduler) ctx.scheduler.rearm();
        // respond with new masked values — presence only, never echo the key
        sendJSON(res, 200, Object.assign({ ok: true }, configMod.maskedConfig(ctx.dataDir, ctx.registry)));
        return;
      }

      sendJSON(res, 404, { error: "not found" });
    } catch (err) {
      ctx.log("http error: " + String((err && err.stack) || err));
      sendJSON(res, 500, { error: "internal error" });
    }
  });
  return server;
}

module.exports = { createServer, buildHealth };
