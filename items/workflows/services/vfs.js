// vfs.js — loopback bridge to BOS's own VFS HTTP API (/api/fs), the sanctioned
// way for this unbundled worker-thread service to reach the real VFS (ADR-2 /
// NFR-004). Everything the engine persists — workflows and run logs — goes
// through here; nothing ever touches a host path derived from the service's
// own config directory (that class of bug is exactly what migration.js exists
// to recover from).
//
// Origin resolution (ADR-6): there is no BOS_PORT in workerData, so this
// prefers process.env.PORT — the Next.js process's own internal bind port,
// set by the Supervisor when it spawns base (tools/supervisor/lib/base.mjs)
// and inherited by this worker thread — before falling back to BOS's own
// origin-resolution pattern (src/lib/integrations/oauth/origin.ts):
// NEXT_PUBLIC_APP_ORIGIN, then APP_ORIGIN, then http://localhost:3000.
// NEXT_PUBLIC_APP_ORIGIN/APP_ORIGIN are documented as the PUBLIC-facing
// address (used to build OAuth redirect URIs) — deliberately allowed to
// differ from the internal port behind any reverse proxy or the Supervisor
// itself, which is exactly why using them here is wrong whenever one is in
// front: this is a same-container loopback call, so it needs the internal
// port, not the public one. The loopback HOST is always 127.0.0.1 regardless
// of what hostname the resolved origin names; only its port is used.
const http = require("http");

function resolvePort() {
  if (process.env.PORT && process.env.PORT.trim()) return process.env.PORT.trim();
  const raw = (process.env.NEXT_PUBLIC_APP_ORIGIN || process.env.APP_ORIGIN || "http://localhost:3000").trim();
  try {
    const url = new URL(raw);
    if (url.port) return url.port;
    return url.protocol === "https:" ? "443" : "80";
  } catch {
    return "3000";
  }
}

function vfsBaseUrl() {
  return `http://127.0.0.1:${resolvePort()}`;
}

function jsonRequest(method, apiPath, bodyObj) {
  return new Promise((resolve, reject) => {
    const url = new URL(apiPath, vfsBaseUrl());
    const bodyStr = bodyObj !== undefined ? JSON.stringify(bodyObj) : undefined;
    const headers = {};
    if (bodyStr !== undefined) {
      headers["Content-Type"] = "application/json";
      headers["Content-Length"] = Buffer.byteLength(bodyStr);
    }
    const request = http.request(
      { method, hostname: url.hostname, port: url.port, path: url.pathname + url.search, headers },
      (res) => {
        const chunks = [];
        res.on("data", (c) => chunks.push(c));
        res.on("end", () => {
          const raw = Buffer.concat(chunks).toString("utf8");
          let body = null;
          try {
            body = raw ? JSON.parse(raw) : null;
          } catch {
            body = null;
          }
          resolve({ status: res.statusCode || 500, body });
        });
      },
    );
    request.on("error", reject);
    if (bodyStr !== undefined) request.write(bodyStr);
    request.end();
  });
}

function errorFor(res, fallback) {
  const message = (res.body && res.body.error) || fallback;
  const err = new Error(message);
  err.status = res.status;
  return err;
}

async function list(vfsPath) {
  const res = await jsonRequest("GET", `/api/fs?op=list&path=${encodeURIComponent(vfsPath)}`);
  if (res.status !== 200) throw errorFor(res, `list failed: ${vfsPath}`);
  return res.body.entries;
}

async function stat(vfsPath) {
  const res = await jsonRequest("GET", `/api/fs?op=stat&path=${encodeURIComponent(vfsPath)}`);
  if (res.status !== 200) throw errorFor(res, `stat failed: ${vfsPath}`);
  return res.body.entry;
}

async function exists(vfsPath) {
  try {
    await stat(vfsPath);
    return true;
  } catch {
    return false;
  }
}

async function readText(vfsPath) {
  const res = await jsonRequest("GET", `/api/fs?op=read&path=${encodeURIComponent(vfsPath)}`);
  if (res.status !== 200) throw errorFor(res, `read failed: ${vfsPath}`);
  return res.body.content;
}

// write's /api/fs handler auto-creates missing parent dirs and writes
// crash-safely (temp file + rename) — callers never need to mkdir first.
async function writeText(vfsPath, content) {
  const res = await jsonRequest("POST", "/api/fs", { op: "write", path: vfsPath, content });
  if (res.status !== 200) throw errorFor(res, `write failed: ${vfsPath}`);
}

async function mkdir(vfsPath) {
  const res = await jsonRequest("POST", "/api/fs", { op: "mkdir", path: vfsPath });
  if (res.status !== 200) throw errorFor(res, `mkdir failed: ${vfsPath}`);
}

async function remove(vfsPath) {
  const res = await jsonRequest("POST", "/api/fs", { op: "delete", path: vfsPath });
  if (res.status !== 200) throw errorFor(res, `delete failed: ${vfsPath}`);
}

async function rename(vfsPath, to) {
  const res = await jsonRequest("POST", "/api/fs", { op: "rename", path: vfsPath, to });
  if (res.status !== 200) throw errorFor(res, `rename failed: ${vfsPath} -> ${to}`);
}

// `jsonRequest` is exported too, because the VFS is not the only BOS API this
// service reaches over the same loopback: the event surface (US17/US18 —
// GET /api/events/handlers, POST /api/events) is a plain JSON request against
// the SAME origin, so it reuses this one origin-resolution + request helper
// rather than re-deriving the port anywhere else. Callers get the raw
// { status, body } pair and decide what a non-2xx means for them.
module.exports = { list, stat, exists, readText, writeText, mkdir, remove, rename, vfsBaseUrl, resolvePort, jsonRequest };
