"use strict";
// In-worker scheduling (FR-010) — setInterval/setTimeout, no external cron.
// * Daily full refresh at refreshHour:refreshMinute UTC (default 17:05,
//   post-NYSE close so the day's bar is final).
// * Catch-up on worker start when lastFullRefresh is older than one trading
//   day (also covers the very first boot / backfill).
// * Intraday heartbeat every heartbeatEveryMs (default 5 min): a single CNBC
//   spot quote (NDX, US-only provider) -> pipelineAlive / lastHeartbeat.
//   A failure just skips the cycle; completes < 2 s (NFR-002).
// The `refreshing` guard in refresh.js prevents overlap.

const cnbc = require("../providers/cnbc.js");
const { startRefresh } = require("./refresh.js");
const configMod = require("../config/config.js");

function nextRefreshAt(cadence, from) {
  const now = from instanceof Date ? from : new Date(from || Date.now());
  const next = new Date(Date.UTC(
    now.getUTCFullYear(), now.getUTCMonth(), now.getUTCDate(),
    cadence.refreshHour, cadence.refreshMinute, 0, 0
  ));
  if (next.getTime() <= now.getTime()) next.setUTCDate(next.getUTCDate() + 1);
  return next;
}

function startScheduler(ctx) {
  let dailyTimer = null;
  let heartbeatTimer = null;
  let stopped = false;

  async function heartbeat() {
    try {
      const spot = await cnbc.fetchSpot("NDX");
      if (spot) {
        ctx.state.pipelineAlive = true;
        ctx.state.lastHeartbeat = new Date().toISOString();
      } else {
        ctx.state.pipelineAlive = false; // skip the cycle, non-critical
      }
    } catch (err) {
      ctx.state.pipelineAlive = false;
    }
  }

  function armDaily() {
    if (stopped) return;
    const cadence = configMod.getConfig(ctx.dataDir).cadence;
    const next = nextRefreshAt(cadence, new Date());
    ctx.state.nextRefreshAt = next.toISOString();
    if (dailyTimer) clearTimeout(dailyTimer);
    dailyTimer = setTimeout(() => {
      startRefresh(ctx, "all");
      armDaily(); // arm the next day
    }, Math.max(1000, next.getTime() - Date.now()));
    if (dailyTimer.unref) dailyTimer.unref();
  }

  function armHeartbeat() {
    const cadence = configMod.getConfig(ctx.dataDir).cadence;
    if (heartbeatTimer) clearInterval(heartbeatTimer);
    heartbeatTimer = setInterval(heartbeat, cadence.heartbeatEveryMs);
    if (heartbeatTimer.unref) heartbeatTimer.unref();
    heartbeat(); // immediate first liveness check
  }

  // Catch-up on start: lastFullRefresh older than one trading day -> refresh
  // (also the first-boot backfill path — no history yet).
  const manifest = configMod.readManifest(ctx.dataDir);
  const last = manifest.lastFullRefresh ? Date.parse(manifest.lastFullRefresh) : 0;
  const oneTradingDayMs = 24 * 3600 * 1000;
  if (!last || Date.now() - last > oneTradingDayMs) {
    setTimeout(() => startRefresh(ctx, "all"), 2000); // let the HTTP server bind first
  }

  armDaily();
  armHeartbeat();

  return {
    // cadence PATCH re-arms both timers
    rearm() {
      armDaily();
      armHeartbeat();
    },
    stop() {
      stopped = true;
      if (dailyTimer) clearTimeout(dailyTimer);
      if (heartbeatTimer) clearInterval(heartbeatTimer);
    }
  };
}

module.exports = { startScheduler, nextRefreshAt };
