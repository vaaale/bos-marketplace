"use strict";
// Every default from design.md §2.3, verbatim, plus cadence, credit budget,
// provider pacing, and host/port. All values are overridable via the service's
// own data/config.json (PATCH /api/config).
module.exports = {
  thresholds: {
    lookbackDays: { "3M": 63, "6M": 126, "1Y": 252, "2Y": 504 },
    flowWindow: 5,
    baselineWindow: 20,
    baseMinDuration: 60,
    baseMaxWidth: 0.10,
    baseScanWindow: 252,
    breakoutVolumeRatio: 1.5,
    gapThreshold: 0.20,
    momentumScale: 15,
    flowScale: 0.75,
    momentumWeight: 0.5,
    flowWeight: 0.5,
    pulseTopN: 5,
    pulsePerRegionK: 3,
    dirFlatEpsilon: 0.5,
    noBaseDriftEpsilon: 5
  },
  cadence: {
    refreshHour: 17,   // 17:05 UTC — post-NYSE close, the day's bar is final
    refreshMinute: 5,
    heartbeatEveryMs: 300000
  },
  dailyCreditBudget: 15, // twelvedata credits/day cap (default keyed set uses 9)
  pacing: {
    nasdaqMs: 350,       // verified clean for 30+ sequential requests
    twelvedataMs: 7500   // 8 req/min free-tier ceiling
  },
  host: "127.0.0.1",
  port: 0 // ADR-b: OS-assigned, never a fixed number
};
