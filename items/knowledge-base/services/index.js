"use strict";

// Knowledge Base — worker-thread service entry (038-knowledge-base). Plain
// Node, no "@/" imports, no bundler — this file is import()ed directly by
// src/core/service/manifestValidator.ts's at-start check (from the MAIN
// thread, where parentPort is null) and spawned as a worker_thread by
// src/core/service/ServiceManager.ts (docs/dev/apps/services.md §6). Every
// top-level use of parentPort stays guarded for that reason.
//
// Binds one real http.Server (never a fixed port — see service.json) that
// serves two things by path prefix:
//   - /mcp        the MCP endpoint (kb_search/kb_retrieve) BOS agents reach
//                 once the user adds it in Settings -> MCP Servers.
//   - /api/*      the JSON bridge the config UI (config/config.html) uses
//                 for KB/source CRUD, Drive status, and ad-hoc queries.

const { parentPort } = require("worker_threads");
const http = require("http");
const path = require("path");

const state = require("./lib/state");
const graphiti = require("./lib/graphiti");
const pipeline = require("./lib/pipeline");
const mcpServerModule = require("./lib/mcpServer");
const apiServer = require("./lib/apiServer");
const log = require("./lib/log");

const IN_PROGRESS_STATUSES = new Set(["pending", "indexing", "crawling", "connecting"]);

// A source's queue position is in-memory (pipeline.js's `queue`/`running`) —
// it doesn't survive a worker restart/crash. Without this, a source that was
// mid-ingest when the process stopped is left stuck showing "Indexing"/
// "Crawling" forever, since nothing else re-enqueues it (FR-011: ingestion
// must never silently stall).
function resumeInFlightSources() {
  const resumed = state.listSources().filter((source) => IN_PROGRESS_STATUSES.has(source.status));
  if (resumed.length > 0) log.info(`resuming ${resumed.length} in-flight source(s) after restart`, resumed.map((s) => s.id));
  for (const source of resumed) pipeline.enqueue(source.id);
}

function loadRuntimeConfig(configDirPath, serviceId) {
  try {
    const raw = require("fs").readFileSync(path.join(configDirPath, `${serviceId}.json`), "utf8");
    const parsed = JSON.parse(raw);
    return {
      port: typeof parsed.port === "number" ? parsed.port : 0,
      host: typeof parsed.host === "string" ? parsed.host : "127.0.0.1",
    };
  } catch (err) {
    // ENOENT (fresh install, no config saved yet) is expected — falling back
    // to an OS-assigned port/loopback host is correct there. Anything else
    // (corrupt JSON, permission error) silently binding to the wrong
    // host/port would otherwise be invisible, so it's logged.
    if (err && err.code === "ENOENT") log.debug(`no runtime config yet at ${path.join(configDirPath, `${serviceId}.json`)} — using defaults`);
    else log.warn(`failed to read runtime config for "${serviceId}" — using defaults (port 0, host 127.0.0.1)`, err && err.message);
    return { port: 0, host: "127.0.0.1" };
  }
}

let server = null;
let mcpEndpoint = null;

function startServer(configDirPath, serviceId) {
  // The item's own data/ directory (item root, sibling of services/) — see
  // lib/state.js for why this exact path matters (src/lib/agent/kb-catalog.ts
  // reads <itemPath>/data/kbs.json directly).
  state.init(path.join(__dirname, "..", "data"));
  graphiti.init(configDirPath, serviceId);
  log.info(`configured Graphiti MCP endpoint: ${graphiti.currentEndpoint()}`);
  mcpEndpoint = mcpServerModule.createMcpEndpoint();
  resumeInFlightSources();

  const { port, host } = loadRuntimeConfig(configDirPath, serviceId);

  server = http.createServer((req, res) => {
    const pathname = (req.url || "/").split("?")[0];
    if (pathname === "/mcp" || pathname.startsWith("/mcp/")) {
      mcpEndpoint.handleRequest(req, res).catch((err) => {
        log.error(`unhandled error handling ${req.method} ${pathname}`, err);
        try {
          res.writeHead(500, { "Content-Type": "text/plain" }).end((err && err.message) || "Internal error");
        } catch (writeErr) {
          // Response already sent/destroyed — nothing left to do; the
          // original error is already logged above, but this secondary
          // failure is still worth a trace of its own.
          log.debug(`could not write error response for ${req.method} ${pathname}`, writeErr && writeErr.message);
        }
      });
      return;
    }
    if (pathname.startsWith("/api/")) {
      apiServer.handleRequest(req, res).catch((err) => {
        log.error(`unhandled error handling ${req.method} ${pathname}`, err);
        try {
          res.writeHead(500, { "Content-Type": "text/plain" }).end((err && err.message) || "Internal error");
        } catch (writeErr) {
          // Response already sent/destroyed — nothing left to do; the
          // original error is already logged above, but this secondary
          // failure is still worth a trace of its own.
          log.debug(`could not write error response for ${req.method} ${pathname}`, writeErr && writeErr.message);
        }
      });
      return;
    }
    res.writeHead(200, { "Content-Type": "text/plain" }).end("Knowledge Base service — see /api and /mcp");
  });

  server.on("error", (err) => {
    log.error("server error", err);
    process.exit(1);
  });

  server.listen(port, host, () => {
    const addr = server.address();
    const boundPort = addr && typeof addr === "object" ? addr.port : port;
    log.info(`listening on ${host}:${boundPort}`);
    if (parentPort) {
      parentPort.postMessage({ type: "initialized" });
      parentPort.postMessage({ type: "bound", port: boundPort, host });
    }
  });
}

function stopServer() {
  return new Promise((resolve) => {
    if (!server) return resolve();
    const s = server;
    server = null;
    s.close(() => resolve());
  });
}

if (parentPort) {
  parentPort.on("message", async (msg) => {
    if (!msg || typeof msg !== "object") return;
    if (msg.type === "initialize") {
      startServer(msg.configDirPath, msg.serviceId);
    } else if (msg.type === "dispose") {
      await stopServer();
      parentPort.postMessage({ type: "disposed" });
    } else if (msg.type === "restart") {
      await stopServer();
      startServer(msg.configDirPath, msg.serviceId);
    }
  });
}

module.exports = { startServer, stopServer };
