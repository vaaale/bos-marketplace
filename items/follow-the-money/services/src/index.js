"use strict";
// Worker entry for the follow-the-money background service.
// Self-contained plain Node (CommonJS) — NO BOS-source imports (Constraint 1).
//
// IPC contract (ServiceManager, src/core/service/types.ts WorkerToMainMessage —
// every worker→main message carries a `type` field):
//   <- { type: "initialize", configDirPath, logsPath, serviceId }
//   -> { type: "initialized" }
//   -> { type: "bound", port, host }      (after the HTTP server is listening)
//   <- { type: "dispose" }                -> close server, clear timers,
//   -> { type: "disposed" }                  then exit the worker thread
//   -> { type: "crash", error, stack }    (uncaughtException/unhandledRejection)

// CH-011: parentPort guard FIRST — when loaded outside a worker thread (e.g.
// a load-check import of this entry), do NOTHING: no side effects, no
// handlers, no exports. NEVER call process.exit() here — outside a worker,
// `process` is the HOST process, so exiting would take down the whole server
// that imported this module, not just this module. (Top-level `return` is
// valid in CommonJS: module code runs inside the module wrapper function.)
let parentPort = null;
try {
  parentPort = require("node:worker_threads").parentPort;
} catch (err) {
  parentPort = null;
}
if (!parentPort) {
  return;
}

const fs = require("node:fs");
const path = require("node:path");
const store = require("./storage/store.js");
const defaults = require("./config/defaults.js");
const { createRegistry } = require("./providers/registry.js");
const { createServer } = require("./http/server.js");
const { startScheduler } = require("./pipeline/scheduler.js");

let ctx = null;
let server = null;

function makeLogger(logsPath, serviceId) {
  let logFile = null;
  try {
    if (logsPath) {
      const stat = fs.existsSync(logsPath) ? fs.statSync(logsPath) : null;
      if (stat && stat.isDirectory()) logFile = path.join(logsPath, (serviceId || "service") + ".log");
      else if (/\.(log|txt)$/i.test(logsPath)) logFile = logsPath;
      else {
        fs.mkdirSync(logsPath, { recursive: true });
        logFile = path.join(logsPath, (serviceId || "service") + ".log");
      }
    }
  } catch (err) {
    logFile = null;
  }
  return function log(msg) {
    const line = new Date().toISOString() + " " + msg + "\n";
    if (logFile) {
      try { fs.appendFileSync(logFile, line); } catch (err) { /* best effort */ }
    }
  };
}

function crashed(message, stack) {
  try {
    parentPort.postMessage({ type: "crash", error: String(message), stack: stack ? String(stack) : undefined });
  } catch (err) { /* channel gone */ }
}

process.on("uncaughtException", (err) => {
  if (ctx) ctx.log("uncaughtException: " + String((err && err.stack) || err));
  crashed(String((err && err.stack) || err));
});
process.on("unhandledRejection", (reason) => {
  if (ctx) ctx.log("unhandledRejection: " + String((reason && reason.stack) || reason));
  crashed(String((reason && reason.stack) || reason));
});

function initialize(msg) {
  const configDirPath = msg.configDirPath;
  const logsPath = msg.logsPath || null;
  const serviceId = msg.serviceId || "follow-the-money";

  // ADR-c: the service persists under a data/ SUBDIRECTORY of its config dir —
  // outside BOS's config-route enumeration (top-level *.json only), so bars
  // and the API key are never exposed through the BOS config route.
  const dataDir = path.join(configDirPath, "data");
  store.ensureDir(dataDir);
  store.ensureDir(path.join(dataDir, "universe"));
  store.ensureDir(path.join(dataDir, "bars"));
  store.ensureDir(path.join(dataDir, "signals", "regions"));
  store.ensureDir(path.join(dataDir, "refresh"));

  // BOS-owned config file: { port, host } — port 0 = OS-assigned (ADR-b)
  const bosConfig = store.readJSON(path.join(configDirPath, serviceId + ".json"), {}) || {};
  const host = typeof bosConfig.host === "string" && bosConfig.host ? bosConfig.host : defaults.host;
  const port = Number.isInteger(bosConfig.port) && bosConfig.port >= 0 ? bosConfig.port : defaults.port;

  ctx = {
    serviceId,
    configDirPath,
    dataDir,
    log: makeLogger(logsPath, serviceId),
    registry: createRegistry(defaults.pacing),
    scheduler: null,
    state: {
      refreshing: false,
      pipelineAlive: false,
      lastHeartbeat: null,
      nextRefreshAt: null,
      lastRefreshFinished: null
    }
  };

  server = createServer(ctx);
  parentPort.postMessage({ type: "initialized" });
  server.listen(port, host, () => {
    const addr = server.address();
    const boundPort = addr && typeof addr === "object" ? addr.port : port;
    ctx.log("bound on " + host + ":" + boundPort);
    parentPort.postMessage({ type: "bound", port: boundPort, host });
    ctx.scheduler = startScheduler(ctx);
  });
  server.on("error", (err) => {
    ctx.log("server error: " + String((err && err.stack) || err));
    crashed(String((err && err.message) || err));
  });
}

function dispose() {
  try {
    if (ctx && ctx.scheduler) ctx.scheduler.stop();
    if (server) server.close();
  } catch (err) { /* best effort */ }
  try {
    parentPort.postMessage({ type: "disposed" });
  } catch (err) { /* channel gone */ }
  // In a worker thread this exits ONLY the worker, never the host process —
  // and this line is only reachable with parentPort set (guard at the top).
  process.exit(0);
}

parentPort.on("message", (msg) => {
  if (!msg) return;
  const type = typeof msg === "string" ? msg : msg.type;
  if (type === "initialize" || (msg && msg.configDirPath && !type)) {
    try {
      initialize(typeof msg === "object" ? msg : {});
    } catch (err) {
      if (ctx) ctx.log("initialize failed: " + String((err && err.stack) || err));
      crashed(String((err && err.stack) || err));
    }
    return;
  }
  if (type === "dispose") dispose();
});
