// vfs-bridge.js — loopback bridge to BOS's own VFS HTTP API (/api/fs), the
// sanctioned way for an unbundled worker-thread service to reach the VFS
// (docs/dev/os-shell/virtual-file-system.md, "Why this matters beyond the
// Files app"; seed/skills/build-studio/references/target-marketplace-item.md,
// "Reaching the VFS from a service"). A service can't `import "@/os/vfs"`
// directly, so every bundle read/write below goes through a plain loopback
// HTTP call instead of touching the host filesystem — mirrors the same
// http.request-based bridge the webdav-vfs-mount item already uses
// (services/index.js's vfsBaseUrl/vfsJsonRequest there).

const http = require("http");

// The Next.js server's own port is inherited via process.env.PORT — worker
// threads get a copy of the parent thread's env at spawn time, and both
// `next start -p <port>` and the Supervisor set PORT on that same process —
// falling back to Next's own dev default (3000) when unset.
function vfsBaseUrl() {
  const port = process.env.PORT || "3000";
  return `http://127.0.0.1:${port}`;
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

// /api/fs's `write` op (vfs.writeText -> writeFileAtomic) already creates any
// missing parent directory and writes crash-safely (temp file + rename) —
// callers never need to mkdir a parent before writing into it.
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

// ── binary (inline assets) ───────────────────────────────────────────────
//
// Inline non-HTML assets (images, video — spec FR-020/FR-021) are binary, and
// the text helpers above would corrupt them. /api/fs exposes a raw byte
// channel at /api/fs/raw: GET streams a file's bytes back with its
// content-type, PUT writes bytes straight from the request body. Both are
// used ONLY for raw/assets/** — every OKF `.md` artifact still goes through
// readText/writeText.
//
// The ingest path deliberately does NOT push large bytes through here: the
// okf-ingest agent calls `web_fetch(url, output_path: "<bundle>/raw/assets/
// <docId>/<name>")`, so the download streams to the VFS from the main process
// and this service never buffers a 100MB video in a worker thread (design.md
// Risk #1). readRaw/writeBinary exist for (a) the app's asset-proxy route,
// which must hand real bytes to an opaque-origin iframe, and (b) copying an
// asset a caller staged somewhere else into the bundle's immutable raw/ store.

const MAX_INLINE_BYTES = 24 * 1024 * 1024; // a buffered copy above this is a bug, not a slow path

function rawRequest(method, vfsPath, bodyBuf, contentType) {
  return new Promise((resolve, reject) => {
    const url = new URL(`/api/fs/raw?path=${encodeURIComponent(vfsPath)}`, vfsBaseUrl());
    const headers = {};
    if (bodyBuf) {
      headers["Content-Type"] = contentType || "application/octet-stream";
      headers["Content-Length"] = bodyBuf.length;
    }
    const request = http.request(
      { method, hostname: url.hostname, port: url.port, path: url.pathname + url.search, headers },
      (res) => {
        const chunks = [];
        let bytes = 0;
        res.on("data", (c) => {
          bytes += c.length;
          if (bytes > MAX_INLINE_BYTES) {
            request.destroy(new Error(`asset exceeds the ${MAX_INLINE_BYTES} byte inline limit: ${vfsPath}`));
            return;
          }
          chunks.push(c);
        });
        res.on("end", () =>
          resolve({
            status: res.statusCode || 500,
            buffer: Buffer.concat(chunks),
            contentType: res.headers["content-type"] || "application/octet-stream",
          }),
        );
      },
    );
    request.on("error", reject);
    if (bodyBuf) request.write(bodyBuf);
    request.end();
  });
}

/** Read a file's raw bytes + content-type (the app's asset-proxy source). */
async function readRaw(vfsPath) {
  const res = await rawRequest("GET", vfsPath);
  if (res.status !== 200) {
    const err = new Error(`raw read failed: ${vfsPath}`);
    err.status = res.status;
    throw err;
  }
  return { buffer: res.buffer, contentType: res.contentType };
}

/** Write raw bytes (a Buffer) to a VFS path. */
async function writeBinary(vfsPath, buffer, contentType) {
  if (!Buffer.isBuffer(buffer)) throw new Error("writeBinary requires a Buffer");
  if (buffer.length > MAX_INLINE_BYTES) {
    throw new Error(
      `refusing to buffer ${buffer.length} bytes through the worker — have the caller write directly with web_fetch(output_path) instead`,
    );
  }
  const res = await rawRequest("PUT", vfsPath, buffer, contentType);
  if (res.status !== 200 && res.status !== 201 && res.status !== 204) {
    const err = new Error(`raw write failed: ${vfsPath}`);
    err.status = res.status;
    throw err;
  }
}

module.exports = {
  list,
  stat,
  exists,
  readText,
  writeText,
  mkdir,
  remove,
  readRaw,
  writeBinary,
  vfsBaseUrl,
  MAX_INLINE_BYTES,
};
