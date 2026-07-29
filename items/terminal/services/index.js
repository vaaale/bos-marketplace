// Terminal Service — reference/example worker for user-specs/002-service-daemons.
// Spawns a shell per WebSocket connection and pipes stdin/stdout/stderr over it.
// Follows the spec's IPC protocol exactly: initialize/dispose/restart in,
// initialized/bound/error/disposed/log/crash out.
//
// IMPORTANT: this file is loaded in two very different contexts —
//   1. As a real worker thread (`new Worker(entryPath, ...)`), where
//      `parentPort` is a live MessagePort and `workerData` is populated.
//   2. Dynamically `import()`ed from the MAIN thread by
//      validateManifestAtStart (CH-011's "entrypoint must be loadable"
//      check), where `parentPort` is `null`.
// Every top-level use of `parentPort` MUST be guarded, or case 2 throws and
// every start attempt fails manifest validation before a worker even spawns.

const { parentPort } = require("worker_threads");
const fs = require("fs");
const path = require("path");
const { spawn } = require("child_process");
const { WebSocketServer } = require("ws");

let wss = null;
const shells = new Map(); // ws -> child process

function log(level, message) {
  if (parentPort) parentPort.postMessage({ type: "log", level, message });
}

function loadConfig(configDirPath, serviceId) {
  const configPath = path.join(configDirPath, `${serviceId}.json`);
  try {
    return JSON.parse(fs.readFileSync(configPath, "utf8"));
  } catch {
    return {};
  }
}

function startServer(configDirPath, serviceId) {
  const config = loadConfig(configDirPath, serviceId);
  const host = typeof config.host === "string" ? config.host : "127.0.0.1";
  const port = typeof config.port === "number" ? config.port : 3001;
  const shellCmd = typeof config.shell === "string" ? config.shell : process.platform === "win32" ? "cmd.exe" : "/bin/bash";

  return new Promise((resolve, reject) => {
    const server = new WebSocketServer({ host, port });

    server.once("listening", () => {
      const address = server.address();
      const actualPort = typeof address === "object" && address ? address.port : port;
      resolve({ server, port: actualPort, host });
    });
    server.once("error", (err) => reject(err));

    server.on("connection", (ws) => {
      log("info", "terminal client connected");
      const child = spawn(shellCmd, [], { env: process.env });
      shells.set(ws, child);

      child.stdout.on("data", (chunk) => {
        if (ws.readyState === ws.OPEN) ws.send(chunk.toString("utf8"));
      });
      child.stderr.on("data", (chunk) => {
        if (ws.readyState === ws.OPEN) ws.send(chunk.toString("utf8"));
      });
      child.on("exit", (code) => {
        if (ws.readyState === ws.OPEN) {
          ws.send(`\r\n[shell exited with code ${code}]\r\n`);
          ws.close();
        }
      });
      child.on("error", (err) => {
        log("error", `shell spawn failed: ${err.message}`);
        if (ws.readyState === ws.OPEN) ws.close();
      });

      ws.on("message", (data) => {
        try {
          child.stdin.write(data);
        } catch {
          // Shell already exited — nothing to write to.
        }
      });
      ws.on("close", () => {
        const c = shells.get(ws);
        if (c && c.exitCode === null) c.kill();
        shells.delete(ws);
        log("info", "terminal client disconnected");
      });
      ws.on("error", (err) => log("warn", `websocket error: ${err.message}`));
    });
  });
}

if (parentPort) {
  parentPort.on("message", async (msg) => {
    if (!msg || typeof msg.type !== "string") return;

    if (msg.type === "initialize") {
      try {
        const { server, port, host } = await startServer(msg.configDirPath, msg.serviceId);
        wss = server;
        parentPort.postMessage({ type: "initialized" });
        parentPort.postMessage({ type: "bound", port, host });
        log("info", `terminal service listening on ${host}:${port}`);
      } catch (err) {
        parentPort.postMessage({ type: "crash", error: err.message, stack: err.stack });
      }
      return;
    }

    if (msg.type === "dispose") {
      for (const [ws, child] of shells) {
        if (child.exitCode === null) child.kill();
        try {
          ws.close();
        } catch {
          // Already closed.
        }
      }
      shells.clear();
      if (wss) {
        wss.close(() => parentPort.postMessage({ type: "disposed" }));
      } else {
        parentPort.postMessage({ type: "disposed" });
      }
      return;
    }

    if (msg.type === "restart") {
      log("info", `restart requested: ${msg.reason || "no reason given"}`);
    }
  });
}
