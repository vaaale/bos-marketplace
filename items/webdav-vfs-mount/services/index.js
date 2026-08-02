"use strict";

// WebDAV VFS Mount — background service daemon (037-webdav-vfs-mount).
//
// Self-contained: only Node.js built-ins (worker_threads, http, crypto, path,
// fs). No "@/" imports, no Next.js, no webpack — this file is import()ed
// directly by src/core/service/manifestValidator.ts's at-start check (from
// the MAIN thread, where parentPort is null) and spawned as a worker_thread
// by src/core/service/ServiceManager.ts (docs/dev/apps/services.md §6). Every
// top-level use of parentPort must stay guarded for that reason.
//
// It binds its own real http.Server (never a fixed port — see NET-001) and
// reaches BOS's own infrastructure the same way any unbundled worker thread
// must: plain loopback HTTP calls, never by importing a "@/" module
// directly. Two such bridges are used here — /api/fs + /api/fs/raw for VFS
// operations, and /api/secrets/<service>/verify for auth (see the Auth
// section below) — the same pattern for both.

const { parentPort } = require("worker_threads");
const http = require("http");
const path = require("path");
const fs = require("fs");

// ---------------------------------------------------------------------------
// Auth (T-02) — verifies a presented Bearer token via BOS's own Generic
// Secrets loopback bridge (docs/dev/features/headless-client-auth.md,
// "Worker-thread services"). This worker thread never generates, hashes, or
// stores a token itself — minting/listing/revoking happens entirely in the
// browser-facing Settings config page (templates/config.html), which calls
// /api/secrets/webdav-vfs-mount directly (a session-authenticated,
// browser-only surface — see that route for why). This file only ever
// forwards whatever candidate the client presented to the loopback verify
// endpoint; it never has to think about token generation, hashing, or
// storage at all.
//
// An earlier version of this file hashed and stored its own token entirely
// inside this config file, bypassing BOS's shared secrets mechanism
// (credentials-index.json) — which meant Bastion's headless Basic-auth
// routing rejected every request at the front door before it ever reached
// this check, no matter how correct the check itself was. See
// docs/dev/apps/services.md's "Multi-user (Bastion) auth composes for free"
// section for the full incident.
// ---------------------------------------------------------------------------

function extractBearerToken(req) {
  const header = req.headers["authorization"];
  if (typeof header !== "string") return null;
  const match = /^Bearer\s+(.+)$/i.exec(header.trim());
  return match ? match[1].trim() : null;
}

/** POSTs the candidate to BOS's own loopback verify route and resolves to
 *  whether it's currently a valid, unrevoked secret for this service — never
 *  throws for a simple mismatch (the route itself never does either; see
 *  src/app/api/secrets/[service]/verify/route.ts). */
function verifyCandidate(serviceId, candidate) {
  return vfsJsonRequest("POST", `/api/secrets/${encodeURIComponent(serviceId)}/verify`, { candidate }).then(
    (res) => !!(res.body && res.body.valid === true),
  );
}

async function validateAuth(req, serviceId) {
  const token = extractBearerToken(req);
  if (!token) return false;
  try {
    return await verifyCandidate(serviceId, token);
  } catch {
    // The loopback call itself failed (BOS's own server unreachable) — fail
    // closed, never open.
    return false;
  }
}

// ---------------------------------------------------------------------------
// Path validation (T-05) — sanitize and confine every WebDAV request path to
// the VFS root, defense-in-depth alongside the VFS's own resolveSafe() (SEC-001/002).
// ---------------------------------------------------------------------------

function sanitizePath(requestPath) {
  let p = requestPath || "/";
  const qIndex = p.indexOf("?");
  if (qIndex !== -1) p = p.slice(0, qIndex);
  try {
    p = decodeURIComponent(p);
  } catch {
    // Malformed percent-encoding — fall through with the raw (still-safe) text.
  }
  if (!p.startsWith("/")) p = "/" + p;
  // path.posix.normalize on an absolute path can never leave a leading ".."
  // behind (excess ".." above root are dropped, not accumulated), which is
  // exactly the confinement SEC-001/002 require.
  p = path.posix.normalize(p);
  return p === "." ? "/" : p;
}

function isPathSafe(resolvedPath) {
  if (typeof resolvedPath !== "string" || !resolvedPath.startsWith("/")) return false;
  return !resolvedPath.split("/").includes("..");
}

function validatePath(requestPath) {
  const sanitized = sanitizePath(requestPath);
  return isPathSafe(sanitized) ? sanitized : null;
}

// ---------------------------------------------------------------------------
// VFS API mapping (T-04) — plain loopback HTTP calls to BOS's own /api/fs +
// /api/fs/raw routes (the mechanism documented in target-marketplace-item.md
// for a worker thread that can't `import "@/os/vfs"` directly). The Next.js
// server's own port is inherited via process.env.PORT — worker_threads get a
// copy of the parent thread's env at spawn time, and the Supervisor sets PORT
// on that same process (tools/supervisor/supervisor.mjs) — falling back to
// Next's own dev default (3000) when unset (plain `npm run dev`, no Supervisor).
// Also used by the Auth section above for the /api/secrets/.../verify bridge —
// same base URL, same plain-JSON request/response shape.
// ---------------------------------------------------------------------------

function vfsBaseUrl() {
  const port = process.env.PORT || "3000";
  return `http://127.0.0.1:${port}`;
}

function vfsJsonRequest(method, apiPath, bodyObj) {
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

function vfsList(vfsPath) {
  return vfsJsonRequest("GET", `/api/fs?op=list&path=${encodeURIComponent(vfsPath)}`);
}

function vfsStat(vfsPath) {
  return vfsJsonRequest("GET", `/api/fs?op=stat&path=${encodeURIComponent(vfsPath)}`);
}

function vfsMkdir(vfsPath) {
  return vfsJsonRequest("POST", "/api/fs", { op: "mkdir", path: vfsPath });
}

function vfsDelete(vfsPath) {
  return vfsJsonRequest("POST", "/api/fs", { op: "delete", path: vfsPath });
}

// ---------------------------------------------------------------------------
// WebDAV protocol handlers (T-03)
// ---------------------------------------------------------------------------

const MIME_TYPES = {
  ".txt": "text/plain; charset=utf-8",
  ".md": "text/markdown; charset=utf-8",
  ".json": "application/json; charset=utf-8",
  ".html": "text/html; charset=utf-8",
  ".htm": "text/html; charset=utf-8",
  ".css": "text/css; charset=utf-8",
  ".js": "text/javascript; charset=utf-8",
  ".mjs": "text/javascript; charset=utf-8",
  ".png": "image/png",
  ".jpg": "image/jpeg",
  ".jpeg": "image/jpeg",
  ".gif": "image/gif",
  ".webp": "image/webp",
  ".svg": "image/svg+xml",
  ".pdf": "application/pdf",
  ".mp3": "audio/mpeg",
  ".mp4": "video/mp4",
  ".wav": "audio/wav",
  ".webm": "video/webm",
};

function mimeFor(name) {
  return MIME_TYPES[path.posix.extname(name || "").toLowerCase()] || "application/octet-stream";
}

function xmlEscape(value) {
  return String(value)
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;");
}

// Hrefs MUST be relative references (RFC 3986 §4.2), never paths absolute
// from this server's own root. This service is always reached through a
// proxy that strips its own path prefix before forwarding (the Supervisor's
// /__supervisor/services/<id>/ mount, or a future different prefix) — the
// service itself has no way to know what external prefix a client used to
// reach it, so an absolute href like "/Documents/" is meaningless to the
// client: RFC 4918 resolves a response's hrefs against the Request-URI the
// CLIENT actually used, not this server's internal view. A relative href
// resolves correctly regardless of any prefix, which an absolute one cannot.
// This is not a hypothetical: a real WebDAV client (davfs2) mounted
// successfully and authenticated fine, but silently showed an empty
// directory — it correctly determined that this server's absolute hrefs
// weren't children of the collection it had mounted, and discarded them all.
//
// The entry being PROPFIND'd (`isSelf`) gets "." — a non-empty relative
// reference that still resolves to "this same resource" per RFC 3986's
// dot-segment removal (§5.2.4: a lone "." segment is removed, leaving the
// base collection unchanged), at any nesting depth. Deliberately not an
// empty string: functionally equivalent per spec, but some WebDAV client
// XML parsers are less forgiving of a genuinely empty <D:href> element, and
// "." avoids that risk for zero cost. A CHILD entry gets just its own name
// (never the full VFS path) — relative to the collection the client
// requested, which is what the Request-URI already denotes.
function hrefForEntry(entry, isSelf) {
  if (isSelf) return ".";
  const isDir = entry.type === "dir";
  const encoded = encodeURIComponent(entry.name || "");
  return isDir ? `${encoded}/` : encoded;
}

// A weak ETag derived from size+mtime — cheap, deterministic, and good
// enough for cache-validation purposes (we never claim strong/byte-exact
// equality). Several WebDAV clients treat a missing getetag as a signal the
// server's PROPFIND response is incomplete/malformed rather than simply
// "no etag available" — including it is cheap insurance.
function etagFor(entry) {
  return `W/"${entry.size}-${Math.floor(entry.modified)}"`;
}

function propResponseXml(entry, isSelf) {
  const isDir = entry.type === "dir";
  const href = xmlEscape(hrefForEntry(entry, isSelf));
  const lastModified = xmlEscape(new Date(entry.modified).toUTCString());
  const displayName = xmlEscape(entry.name || "/");
  const etag = xmlEscape(etagFor(entry));
  const resourceType = isDir ? "<D:resourcetype><D:collection/></D:resourcetype>" : "<D:resourcetype/>";
  const fileProps = isDir
    ? ""
    : `<D:getcontentlength>${entry.size}</D:getcontentlength>` +
      `<D:getcontenttype>${xmlEscape(mimeFor(entry.name))}</D:getcontenttype>`;
  return (
    "<D:response>" +
    `<D:href>${href}</D:href>` +
    "<D:propstat><D:prop>" +
    resourceType +
    `<D:displayname>${displayName}</D:displayname>` +
    `<D:getlastmodified>${lastModified}</D:getlastmodified>` +
    `<D:getetag>${etag}</D:getetag>` +
    fileProps +
    "</D:prop><D:status>HTTP/1.1 200 OK</D:status></D:propstat>" +
    "</D:response>"
  );
}

// The first entry is always the resource PROPFIND itself named (handlePROPFIND
// always builds `resources` with the self-entry first, children after) — see
// the isSelf/relative-href note on hrefForEntry above for why this matters.
function multistatusXml(entries) {
  return (
    '<?xml version="1.0" encoding="utf-8"?>' +
    '<D:multistatus xmlns:D="DAV:">' +
    entries.map((entry, i) => propResponseXml(entry, i === 0)).join("") +
    "</D:multistatus>"
  );
}

function sendError(res, status, message) {
  const body = message || "";
  res.writeHead(status, {
    "Content-Type": "text/plain; charset=utf-8",
    "Content-Length": Buffer.byteLength(body),
  });
  res.end(body);
}

async function handlePROPFIND(vfsPath, depthHeader, res) {
  const statRes = await vfsStat(vfsPath);
  if (statRes.status !== 200 || !statRes.body || !statRes.body.entry) {
    return sendError(res, 404, "Not Found");
  }
  const entry = statRes.body.entry;
  const resources = [entry];
  // SEC-004: no pagination — every entry is returned in one response, even
  // for a large directory. Depth: 0 means "this resource only".
  if (entry.type === "dir" && depthHeader !== "0") {
    const listRes = await vfsList(vfsPath);
    if (listRes.status === 200 && listRes.body && Array.isArray(listRes.body.entries)) {
      resources.push(...listRes.body.entries);
    }
  }
  const xml = multistatusXml(resources);
  // Unquoted charset param — matches every other Content-Type this file
  // sends (see MIME_TYPES). A quoted charset="utf-8" is technically legal
  // (HTTP allows a quoted-string here) but is a needlessly nonstandard
  // formatting choice that risks tripping up a stricter media-type parser
  // for no benefit — found during investigation of a client that rejected
  // this response outright.
  res.writeHead(207, {
    "Content-Type": "application/xml; charset=utf-8",
    "Content-Length": Buffer.byteLength(xml),
  });
  res.end(xml);
}

// Parses a single "bytes=start-end" Range header (the only form a real
// client sends for a plain buffered file read — multi-range is not
// supported). Returns null for an absent/unparseable/unsatisfiable header,
// in which case the caller falls back to a full 200 response — a server is
// always allowed to ignore Range and return the whole entity, so this is a
// safe default, not a partial fix.
function parseRange(rangeHeader, totalSize) {
  if (typeof rangeHeader !== "string") return null;
  const match = /^bytes=(\d*)-(\d*)$/.exec(rangeHeader.trim());
  if (!match) return null;
  const [, startStr, endStr] = match;
  if (startStr === "" && endStr === "") return null;
  let start;
  let end;
  if (startStr === "") {
    // Suffix range: "bytes=-500" means "the last 500 bytes".
    const suffixLength = Number(endStr);
    if (!Number.isFinite(suffixLength) || suffixLength <= 0) return null;
    start = Math.max(0, totalSize - suffixLength);
    end = totalSize - 1;
  } else {
    start = Number(startStr);
    end = endStr === "" ? totalSize - 1 : Number(endStr);
  }
  if (!Number.isFinite(start) || !Number.isFinite(end) || start < 0 || end < start || start >= totalSize) {
    return null;
  }
  return { start, end: Math.min(end, totalSize - 1) };
}

async function handleGETorHEAD(vfsPath, method, res, rangeHeader) {
  const statRes = await vfsStat(vfsPath);
  if (statRes.status !== 200 || !statRes.body || !statRes.body.entry) {
    return sendError(res, 404, "Not Found");
  }
  const entry = statRes.body.entry;

  if (entry.type === "dir") {
    res.writeHead(200, { "Content-Type": "httpd/unix-directory", "Content-Length": "0" });
    return res.end();
  }

  const totalSize = entry.size;
  // Range support (RFC 7233) — several real WebDAV clients (davfs2's
  // buf_size-based buffered reads among them) issue ranged GETs by default
  // for ordinary file access, not just resumable downloads. This service
  // used to always respond 200 with the full body regardless of any Range
  // header, which is spec-legal but broke a real client outright (a
  // connection abort reading any file) — some clients handle an unexpected
  // 200-instead-of-206 far worse than the spec's "MAY ignore Range" implies.
  const range = parseRange(rangeHeader, totalSize);
  const baseHeaders = {
    "Content-Type": mimeFor(entry.name),
    "Last-Modified": new Date(entry.modified).toUTCString(),
    "Accept-Ranges": "bytes",
  };
  const headers = range
    ? {
        ...baseHeaders,
        "Content-Range": `bytes ${range.start}-${range.end}/${totalSize}`,
        "Content-Length": String(range.end - range.start + 1),
      }
    : { ...baseHeaders, "Content-Length": String(totalSize) };
  const status = range ? 206 : 200;

  if (method === "HEAD") {
    res.writeHead(status, headers);
    return res.end();
  }

  // Streamed, not buffered — /api/fs/raw's GET streams the file end to end
  // (vfs.ts's readStream), satisfying the "don't buffer large files" goal.
  // /api/fs/raw has no Range support of its own (always the full body), so a
  // ranged request here is satisfied by streaming the full upstream body and
  // skipping/limiting locally — loopback traffic, so the bytes discarded
  // before `range.start` are cheap, and we still never buffer the whole
  // file in memory (only ever hold one in-flight chunk at a time).
  const url = new URL(`/api/fs/raw?path=${encodeURIComponent(vfsPath)}`, vfsBaseUrl());
  const upstreamReq = http.request(
    { method: "GET", hostname: url.hostname, port: url.port, path: url.pathname + url.search },
    (upstream) => {
      if (upstream.statusCode !== 200) {
        upstream.resume();
        return sendError(res, 404, "Not Found");
      }
      res.writeHead(status, headers);

      if (!range) {
        upstream.pipe(res);
        return;
      }

      const wanted = range.end - range.start + 1;
      let pos = 0;
      let sent = 0;
      upstream.on("data", (chunk) => {
        if (sent >= wanted) return; // already satisfied — draining until upstream ends/destroys
        const chunkStart = pos;
        pos += chunk.length;
        if (pos <= range.start) return; // entirely before the range
        const sliceStart = Math.max(0, range.start - chunkStart);
        const sliceEnd = Math.min(chunk.length, sliceStart + (wanted - sent));
        if (sliceEnd > sliceStart) {
          res.write(chunk.subarray(sliceStart, sliceEnd));
          sent += sliceEnd - sliceStart;
        }
        if (sent >= wanted) upstream.destroy();
      });
      upstream.on("end", () => res.end());
      upstream.on("error", () => res.end());
    },
  );
  upstreamReq.on("error", () => sendError(res, 502, "Bad Gateway"));
  upstreamReq.end();
}

async function handlePUT(vfsPath, req, res) {
  const existsRes = await vfsStat(vfsPath);
  const existed = existsRes.status === 200;

  const url = new URL(`/api/fs/raw?path=${encodeURIComponent(vfsPath)}`, vfsBaseUrl());
  const upstreamReq = http.request(
    {
      method: "PUT",
      hostname: url.hostname,
      port: url.port,
      path: url.pathname + url.search,
      headers: { "Content-Type": "application/octet-stream" },
    },
    (upstream) => {
      upstream.resume();
      upstream.on("end", () => {
        if (upstream.statusCode === 200) {
          res.writeHead(existed ? 204 : 201);
          res.end();
        } else {
          sendError(res, 500, "Failed to write file");
        }
      });
    },
  );
  upstreamReq.on("error", () => sendError(res, 502, "Bad Gateway"));
  // Streamed straight through — /api/fs/raw's PUT never buffers the whole
  // body either (vfs.ts's writeStream).
  req.pipe(upstreamReq);
}

async function handleDELETE(vfsPath, res) {
  const statRes = await vfsStat(vfsPath);
  if (statRes.status !== 200) return sendError(res, 404, "Not Found");
  const delRes = await vfsDelete(vfsPath);
  if (delRes.status !== 200) return sendError(res, 500, "Failed to delete");
  res.writeHead(204);
  res.end();
}

async function handleMKCOL(vfsPath, req, res) {
  const contentLength = Number(req.headers["content-length"] || 0);
  if (contentLength > 0) {
    req.resume(); // drain the rejected body so a keep-alive socket doesn't desync
    return sendError(res, 415, "Unsupported Media Type");
  }
  const mkdirRes = await vfsMkdir(vfsPath);
  if (mkdirRes.status !== 200) return sendError(res, 409, "Conflict");
  res.writeHead(201);
  res.end();
}

// ---------------------------------------------------------------------------
// Locking (no-op) — several real-world WebDAV clients (davfs2, GVFS, Finder,
// Windows Explorer's mini-redirector) require the SERVER to at least
// acknowledge LOCK/UNLOCK to behave correctly, even without real distributed
// locking — a server that just 405s them (SUPPORTED_METHODS previously
// didn't include either) is a known source of client-side connection
// aborts/hangs on some clients, since they interpret "no lock support" as
// "this collection can't be trusted for write caching" and give up rather
// than degrading gracefully. This always grants an exclusive write lock,
// never actually tracked or contended anywhere — correct for the
// single-mount-at-a-time scenario this service is built for, not a general
// concurrent-access guarantee.
// ---------------------------------------------------------------------------

function generateLockToken() {
  return `urn:uuid:${Date.now().toString(16)}-${Math.random().toString(16).slice(2)}`;
}

function handleLOCK(req, res) {
  req.resume(); // drain the lockinfo request body — never inspected, always granted
  const token = generateLockToken();
  const body =
    '<?xml version="1.0" encoding="utf-8"?>' +
    '<D:prop xmlns:D="DAV:"><D:lockdiscovery><D:activelock>' +
    "<D:locktype><D:write/></D:locktype>" +
    "<D:lockscope><D:exclusive/></D:lockscope>" +
    "<D:depth>0</D:depth>" +
    "<D:timeout>Second-3600</D:timeout>" +
    `<D:locktoken><D:href>${token}</D:href></D:locktoken>` +
    "</D:activelock></D:lockdiscovery></D:prop>";
  res.writeHead(200, {
    "Content-Type": "application/xml; charset=utf-8",
    "Content-Length": Buffer.byteLength(body),
    "Lock-Token": `<${token}>`,
  });
  res.end(body);
}

function handleUNLOCK(req, res) {
  req.resume();
  res.writeHead(204);
  res.end();
}

// ---------------------------------------------------------------------------
// Main daemon (T-06, T-07) — config loading, auth gate, dispatch.
// ---------------------------------------------------------------------------

const SUPPORTED_METHODS = ["OPTIONS", "PROPFIND", "GET", "HEAD", "PUT", "DELETE", "MKCOL", "LOCK", "UNLOCK"];

function loadConfig(configDirPath, serviceId) {
  const file = path.join(configDirPath, `${serviceId}.json`);
  try {
    const raw = fs.readFileSync(file, "utf8");
    const parsed = JSON.parse(raw);
    return {
      port: typeof parsed.port === "number" ? parsed.port : 0,
      host: typeof parsed.host === "string" ? parsed.host : "127.0.0.1",
    };
  } catch {
    // No config file yet (or unreadable) — port/host default to
    // OS-assigned + loopback-only.
    return { port: 0, host: "127.0.0.1" };
  }
}

function createRequestListener(serviceId) {
  return async function requestListener(req, res) {
    // Auth gate runs before anything else, for every method including
    // OPTIONS — "no token minted yet" must 401 on ALL requests (NET-003/US3),
    // not just the WebDAV verbs. Verified via a loopback call to BOS's own
    // Generic Secrets bridge (see the Auth section above) — never a locally
    // stored hash, so a token generated/regenerated from Settings takes
    // effect immediately, with no restart and nothing re-read from disk here.
    if (!(await validateAuth(req, serviceId))) {
      res.writeHead(401, { "WWW-Authenticate": "Bearer", "Content-Type": "text/plain; charset=utf-8" });
      res.end("Unauthorized");
      return;
    }

    const method = (req.method || "GET").toUpperCase();

    if (method === "OPTIONS") {
      // DAV: "1, 2" — class 2 advertises locking support (LOCK/UNLOCK below);
      // some clients only ATTEMPT to lock at all if the server claims class 2
      // here, so this header and the LOCK/UNLOCK handlers must agree.
      res.writeHead(200, { DAV: "1, 2", Allow: SUPPORTED_METHODS.join(", "), "Content-Length": "0" });
      res.end();
      return;
    }

    // LOCK/UNLOCK don't need a resolved+validated VFS path the way every
    // other method below does (a LOCK can legitimately target a resource
    // that doesn't exist yet, to create a "lock-null resource" per RFC 4918
    // §7.3) — dispatch them before path validation, same as OPTIONS above.
    if (method === "LOCK") return handleLOCK(req, res);
    if (method === "UNLOCK") return handleUNLOCK(req, res);

    const vfsPath = validatePath(req.url || "/");
    if (vfsPath === null) {
      sendError(res, 403, "Forbidden");
      return;
    }

    try {
      switch (method) {
        case "PROPFIND":
          await handlePROPFIND(vfsPath, req.headers["depth"], res);
          break;
        case "GET":
          await handleGETorHEAD(vfsPath, "GET", res, req.headers["range"]);
          break;
        case "HEAD":
          await handleGETorHEAD(vfsPath, "HEAD", res, req.headers["range"]);
          break;
        case "PUT":
          await handlePUT(vfsPath, req, res);
          break;
        case "DELETE":
          await handleDELETE(vfsPath, res);
          break;
        case "MKCOL":
          await handleMKCOL(vfsPath, req, res);
          break;
        default:
          res.writeHead(405, { Allow: SUPPORTED_METHODS.join(", ") });
          res.end();
      }
    } catch (err) {
      sendError(res, 500, (err && err.message) || "Internal Server Error");
    }
  };
}

// ---------------------------------------------------------------------------
// Worker lifecycle — the IPC contract every BOS service follows
// (docs/dev/apps/services.md §6). Every top-level parentPort use is guarded:
// this file is also import()ed from the MAIN thread (parentPort === null) by
// validateManifestAtStart's load check.
// ---------------------------------------------------------------------------

let server = null;

function startServer(configDirPath, serviceId) {
  const config = loadConfig(configDirPath, serviceId);
  server = http.createServer(createRequestListener(serviceId));
  server.on("error", (err) => {
    console.error(`[webdav-vfs-mount] server error: ${err.message}`);
    process.exit(1);
  });
  server.listen(config.port, config.host, () => {
    const addr = server.address();
    const boundPort = addr && typeof addr === "object" ? addr.port : config.port;
    if (parentPort) {
      parentPort.postMessage({ type: "initialized" });
      parentPort.postMessage({ type: "bound", port: boundPort, host: config.host });
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

// Exported for the item's own unit/integration tests (tests/ — plain Node,
// no BOS test harness involved).
module.exports = {
  extractBearerToken,
  verifyCandidate,
  validateAuth,
  sanitizePath,
  isPathSafe,
  validatePath,
  mimeFor,
  xmlEscape,
  hrefForEntry,
  etagFor,
  parseRange,
  propResponseXml,
  multistatusXml,
  loadConfig,
  createRequestListener,
  vfsBaseUrl,
};
