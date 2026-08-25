"use strict";

// Loopback bridge to BOS's own Next.js server — the pattern every unbundled
// worker-thread service must use to reach VFS/integrations/secrets instead of
// importing a "@/" module directly (target-marketplace-item.md,
// docs/dev/apps/services.md §11). worker_threads inherit a copy of the parent
// thread's env at spawn time, and the Supervisor sets PORT on that same
// process (tools/supervisor/supervisor.mjs) — falls back to Next's own dev
// default (3000) when unset (plain `npm run dev`, no Supervisor).

const http = require("http");
const log = require("./log");

function bosBaseUrl() {
  const port = process.env.PORT || "3000";
  return `http://127.0.0.1:${port}`;
}

/** Plain JSON request/response over loopback HTTP. Resolves with
 *  {status, body} — never throws for a non-2xx status (callers inspect
 *  `status` themselves), only for a transport-level failure (connection
 *  refused, etc.). */
function bosJsonRequest(method, apiPath, bodyObj) {
  return new Promise((resolve, reject) => {
    const url = new URL(apiPath, bosBaseUrl());
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
          } catch (err) {
            log.debug(`non-JSON response body from ${method} ${apiPath} — passing through raw text`, err.message);
            body = raw;
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

/** Streams raw bytes from a BOS route (e.g. /api/fs/raw) into memory —
 *  acceptable for the text-extractable, moderately-sized documents this item
 *  targets (spec Non-Goals: binary-only / huge formats are out of scope);
 *  large uploads should be capped by the config UI, not buffered blindly. */
function bosRawGet(apiPath) {
  return new Promise((resolve, reject) => {
    const url = new URL(apiPath, bosBaseUrl());
    const request = http.request({ method: "GET", hostname: url.hostname, port: url.port, path: url.pathname + url.search }, (res) => {
      if (res.statusCode !== 200) {
        res.resume();
        return reject(new Error(`GET ${apiPath} -> HTTP ${res.statusCode}`));
      }
      const chunks = [];
      res.on("data", (c) => chunks.push(c));
      res.on("end", () => resolve(Buffer.concat(chunks)));
      res.on("error", reject);
    });
    request.on("error", reject);
    request.end();
  });
}

function vfsStat(vfsPath) {
  return bosJsonRequest("GET", `/api/fs?op=stat&path=${encodeURIComponent(vfsPath)}`);
}

/** Lists one VFS directory level — {status, body: {entries: VfsEntry[]}}
 *  (each entry's `type` is "file" | "dir"). Used by the local-folder source
 *  (lib/sources/folder.js) to walk a folder the same way lib/sources/drive.js
 *  walks a Drive folder, just over the local VFS instead of the Drive API. */
function vfsList(vfsPath) {
  return bosJsonRequest("GET", `/api/fs?op=list&path=${encodeURIComponent(vfsPath)}`);
}

function vfsReadBytes(vfsPath) {
  return bosRawGet(`/api/fs/raw?path=${encodeURIComponent(vfsPath)}`);
}

function vfsDelete(vfsPath) {
  return bosJsonRequest("POST", "/api/fs", { op: "delete", path: vfsPath });
}

/** Calls a BOS integration adapter method (e.g. gsuite/drive) over the
 *  invoke route — the same surface the assistant's own IntegrationActions use
 *  (src/app/api/integrations/[id]/services/[serviceId]/invoke/route.ts). */
async function integrationInvoke(integrationId, serviceId, method, args) {
  const res = await bosJsonRequest(
    "POST",
    `/api/integrations/${encodeURIComponent(integrationId)}/services/${encodeURIComponent(serviceId)}/invoke`,
    { method, args: args || {} },
  );
  if (res.status < 200 || res.status >= 300) {
    const message = (res.body && res.body.error && res.body.error.message) || `invoke ${method} -> HTTP ${res.status}`;
    const err = new Error(message);
    err.status = res.status;
    err.code = res.body && res.body.error && res.body.error.code;
    throw err;
  }
  return res.body && res.body.result;
}

module.exports = {
  bosBaseUrl,
  bosJsonRequest,
  bosRawGet,
  vfsStat,
  vfsList,
  vfsReadBytes,
  vfsDelete,
  integrationInvoke,
};
