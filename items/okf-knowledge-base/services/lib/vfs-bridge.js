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

module.exports = { list, stat, exists, readText, writeText, mkdir, remove, vfsBaseUrl };
