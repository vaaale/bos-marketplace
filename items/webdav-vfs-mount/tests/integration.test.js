"use strict";

// End-to-end integration test (T-09): a fake BOS server stands in for both
// BOS's own /api/fs + /api/fs/raw routes (same contract, in-memory) AND its
// /api/secrets/<service>/verify loopback bridge (same contract — a set of
// currently-valid raw secrets, checked by exact match), since the real
// daemon now calls both over the same loopback base URL. The real WebDAV
// request listener from services/index.js is driven with actual HTTP
// requests over a loopback socket — no mocking of the daemon itself.

const { test, before, after } = require("node:test");
const assert = require("node:assert/strict");
const http = require("node:http");
const os = require("node:os");
const fs = require("node:fs/promises");
const path = require("node:path");
const crypto = require("node:crypto");
const daemon = require("../services/index.js");

const SERVICE_ID = "webdav-vfs-mount";

// ---- Fake BOS server: VFS API (mirrors src/app/api/fs + /api/fs/raw) ------
// plus the secrets verify bridge (mirrors src/app/api/secrets/[service]/verify) --

function makeFakeBosServer() {
  /** @type {Map<string, {type: "file"|"dir", size: number, modified: number, content: Buffer}>} */
  const store = new Map();
  store.set("/", { type: "dir", size: 0, modified: Date.now(), content: Buffer.alloc(0) });
  /** @type {Set<string>} */
  const validSecrets = new Set();

  function entryFor(p) {
    const node = store.get(p);
    if (!node) return null;
    return { name: path.posix.basename(p) || "/", path: p, type: node.type, size: node.size, modified: node.modified };
  }

  const server = http.createServer((req, res) => {
    const url = new URL(req.url, "http://localhost");
    const send = (status, body) => {
      const s = JSON.stringify(body);
      res.writeHead(status, { "Content-Type": "application/json" });
      res.end(s);
    };

    if (url.pathname === `/api/secrets/${SERVICE_ID}/verify` && req.method === "POST") {
      let body = "";
      req.on("data", (c) => (body += c));
      req.on("end", () => {
        const parsed = JSON.parse(body || "{}");
        return send(200, { valid: validSecrets.has(parsed.candidate) });
      });
      return;
    }

    if (url.pathname === "/api/fs" && req.method === "GET") {
      const op = url.searchParams.get("op");
      const p = url.searchParams.get("path") || "/";
      if (op === "stat") {
        const entry = entryFor(p);
        return entry ? send(200, { entry }) : send(400, { error: "not found" });
      }
      if (op === "list") {
        if (!store.has(p)) return send(400, { error: "not found" });
        const prefix = p === "/" ? "/" : p + "/";
        const entries = [];
        for (const key of store.keys()) {
          if (key === p || !key.startsWith(prefix)) continue;
          const rest = key.slice(prefix.length);
          if (rest.includes("/")) continue; // only direct children
          entries.push(entryFor(key));
        }
        return send(200, { entries });
      }
      return send(400, { error: "unknown op" });
    }

    if (url.pathname === "/api/fs" && req.method === "POST") {
      let body = "";
      req.on("data", (c) => (body += c));
      req.on("end", () => {
        const parsed = JSON.parse(body || "{}");
        if (parsed.op === "mkdir") {
          if (!store.has(parsed.path)) store.set(parsed.path, { type: "dir", size: 0, modified: Date.now(), content: Buffer.alloc(0) });
          return send(200, { ok: true });
        }
        if (parsed.op === "delete") {
          if (!store.has(parsed.path)) return send(400, { error: "not found" });
          store.delete(parsed.path);
          return send(200, { ok: true });
        }
        return send(400, { error: "unknown op" });
      });
      return;
    }

    if (url.pathname === "/api/fs/raw" && req.method === "GET") {
      const p = url.searchParams.get("path");
      const node = store.get(p);
      if (!node || node.type !== "file") return send(404, { error: "not found" });
      res.writeHead(200, { "Content-Type": "application/octet-stream", "Content-Length": String(node.content.length) });
      return res.end(node.content);
    }

    if (url.pathname === "/api/fs/raw" && req.method === "PUT") {
      const p = url.searchParams.get("path");
      const chunks = [];
      req.on("data", (c) => chunks.push(c));
      req.on("end", () => {
        const content = Buffer.concat(chunks);
        store.set(p, { type: "file", size: content.length, modified: Date.now(), content });
        send(200, { ok: true });
      });
      return;
    }

    send(404, { error: "no such route" });
  });

  return { server, store, validSecrets };
}

function httpRequest(port, method, reqPath, opts = {}) {
  return new Promise((resolve, reject) => {
    const req = http.request(
      { method, hostname: "127.0.0.1", port, path: reqPath, headers: opts.headers || {} },
      (res) => {
        const chunks = [];
        res.on("data", (c) => chunks.push(c));
        res.on("end", () => resolve({ status: res.statusCode, headers: res.headers, body: Buffer.concat(chunks) }));
      },
    );
    req.on("error", reject);
    if (opts.body !== undefined) req.write(opts.body);
    req.end();
  });
}

let fakeBos;
let webdavServer;
let webdavPort;
let configDir;
let token;
let restorePort;

before(async () => {
  fakeBos = makeFakeBosServer();
  await new Promise((resolve) => fakeBos.server.listen(0, "127.0.0.1", resolve));
  restorePort = process.env.PORT;
  process.env.PORT = String(fakeBos.server.address().port);

  configDir = await fs.mkdtemp(path.join(os.tmpdir(), "webdav-vfs-mount-test-"));
  // No hashedToken written here anymore — auth is entirely BOS-side now
  // (the fake server's validSecrets set stands in for the real
  // /api/secrets/<service> mint/verify mechanism). Config only ever carries
  // port/host.
  token = crypto.randomBytes(32).toString("hex");
  fakeBos.validSecrets.add(token);
  await fs.writeFile(path.join(configDir, `${SERVICE_ID}.json`), JSON.stringify({ port: 0, host: "127.0.0.1" }));

  webdavServer = http.createServer(daemon.createRequestListener(SERVICE_ID));
  await new Promise((resolve) => webdavServer.listen(0, "127.0.0.1", resolve));
  webdavPort = webdavServer.address().port;
});

after(async () => {
  await new Promise((resolve) => webdavServer.close(resolve));
  await new Promise((resolve) => fakeBos.server.close(resolve));
  await fs.rm(configDir, { recursive: true, force: true });
  if (restorePort === undefined) delete process.env.PORT;
  else process.env.PORT = restorePort;
});

function auth() {
  return { Authorization: `Bearer ${token}` };
}

test("unauthenticated request is rejected with 401 + WWW-Authenticate", async () => {
  const res = await httpRequest(webdavPort, "PROPFIND", "/", { headers: { Depth: "0" } });
  assert.equal(res.status, 401);
  assert.equal(res.headers["www-authenticate"], "Bearer");
});

test("wrong token is rejected with 401", async () => {
  const res = await httpRequest(webdavPort, "GET", "/anything", { headers: { Authorization: "Bearer nope" } });
  assert.equal(res.status, 401);
});

test("directory traversal is rejected with 403", async () => {
  const res = await httpRequest(webdavPort, "GET", "/../../etc/passwd", { headers: auth() });
  // path.posix.normalize collapses this to a safe in-root path, so it 404s
  // (nothing there) rather than 403 — either way it must NOT succeed or leak
  // anything outside the VFS root.
  assert.ok([403, 404].includes(res.status));
});

test("PROPFIND on root returns a 207 multistatus", async () => {
  const res = await httpRequest(webdavPort, "PROPFIND", "/", { headers: { ...auth(), Depth: "1" } });
  assert.equal(res.status, 207);
  assert.match(res.body.toString("utf8"), /<D:multistatus/);
});

test("MKCOL creates a collection", async () => {
  const res = await httpRequest(webdavPort, "MKCOL", "/Documents", { headers: auth() });
  assert.equal(res.status, 201);
});

test("MKCOL is a no-op when the collection already exists", async () => {
  const res = await httpRequest(webdavPort, "MKCOL", "/Documents", { headers: auth() });
  assert.equal(res.status, 201);
});

test("PUT creates a file (201) and GET reads it back", async () => {
  const putRes = await httpRequest(webdavPort, "PUT", "/Documents/hello.txt", {
    headers: auth(),
    body: "hello webdav",
  });
  assert.equal(putRes.status, 201);

  const getRes = await httpRequest(webdavPort, "GET", "/Documents/hello.txt", { headers: auth() });
  assert.equal(getRes.status, 200);
  assert.equal(getRes.body.toString("utf8"), "hello webdav");
  assert.equal(getRes.headers["content-type"], "text/plain; charset=utf-8");
  assert.equal(getRes.headers["accept-ranges"], "bytes");
});

// Regression: a real client (davfs2) issues ranged GETs by default for
// ordinary file reads (its buf_size-driven buffered reads), and this
// service used to always answer 200 + the full body regardless — spec-legal,
// but it broke that client outright (a connection abort on any file read).
test("GET with a Range header returns 206 + Content-Range + exactly the requested bytes", async () => {
  // "hello webdav" is 12 bytes; request bytes 6-11 ("webdav").
  const res = await httpRequest(webdavPort, "GET", "/Documents/hello.txt", {
    headers: { ...auth(), Range: "bytes=6-11" },
  });
  assert.equal(res.status, 206);
  assert.equal(res.headers["content-range"], "bytes 6-11/12");
  assert.equal(res.headers["content-length"], "6");
  assert.equal(res.body.toString("utf8"), "webdav");
});

test("GET with an open-ended Range header ('bytes=6-') returns everything from that byte on", async () => {
  const res = await httpRequest(webdavPort, "GET", "/Documents/hello.txt", {
    headers: { ...auth(), Range: "bytes=6-" },
  });
  assert.equal(res.status, 206);
  assert.equal(res.headers["content-range"], "bytes 6-11/12");
  assert.equal(res.body.toString("utf8"), "webdav");
});

test("GET with an unsatisfiable Range header falls back to a full 200 response", async () => {
  const res = await httpRequest(webdavPort, "GET", "/Documents/hello.txt", {
    headers: { ...auth(), Range: "bytes=1000-2000" },
  });
  assert.equal(res.status, 200);
  assert.equal(res.body.toString("utf8"), "hello webdav");
});

test("PUT overwriting an existing file returns 204", async () => {
  const res = await httpRequest(webdavPort, "PUT", "/Documents/hello.txt", {
    headers: auth(),
    body: "updated",
  });
  assert.equal(res.status, 204);
});

test("HEAD returns headers with no body", async () => {
  const res = await httpRequest(webdavPort, "HEAD", "/Documents/hello.txt", { headers: auth() });
  assert.equal(res.status, 200);
  assert.equal(res.body.length, 0);
  assert.equal(res.headers["content-length"], "7"); // "updated".length
});

test("GET on a missing file returns 404", async () => {
  const res = await httpRequest(webdavPort, "GET", "/Documents/nope.txt", { headers: auth() });
  assert.equal(res.status, 404);
});

test("PROPFIND on a directory lists its children", async () => {
  const res = await httpRequest(webdavPort, "PROPFIND", "/Documents", { headers: { ...auth(), Depth: "1" } });
  assert.equal(res.status, 207);
  const xml = res.body.toString("utf8");
  assert.match(xml, /hello\.txt/);
});

test("DELETE removes a file", async () => {
  const res = await httpRequest(webdavPort, "DELETE", "/Documents/hello.txt", { headers: auth() });
  assert.equal(res.status, 204);
  const getRes = await httpRequest(webdavPort, "GET", "/Documents/hello.txt", { headers: auth() });
  assert.equal(getRes.status, 404);
});

test("DELETE on a missing resource returns 404", async () => {
  const res = await httpRequest(webdavPort, "DELETE", "/Documents/hello.txt", { headers: auth() });
  assert.equal(res.status, 404);
});

test("OPTIONS advertises class 2 (locking) compliance and the supported methods", async () => {
  const res = await httpRequest(webdavPort, "OPTIONS", "/", { headers: auth() });
  assert.equal(res.status, 200);
  assert.equal(res.headers["dav"], "1, 2");
  assert.match(res.headers["allow"], /PROPFIND/);
  assert.match(res.headers["allow"], /LOCK/);
  assert.match(res.headers["allow"], /UNLOCK/);
});

// Regression: several real clients (davfs2, GVFS, Finder, Windows Explorer)
// require LOCK/UNLOCK to be acknowledged, even without real distributed
// locking, or they misbehave (connection aborts requiring a remount). This
// always grants — never tracked/contended — which is correct for the
// single-mount-at-a-time scenario this service targets.
test("LOCK always grants an exclusive write lock and returns a Lock-Token", async () => {
  const res = await httpRequest(webdavPort, "LOCK", "/Documents/hello.txt", { headers: auth(), body: "" });
  assert.equal(res.status, 200);
  assert.match(res.headers["lock-token"], /^<urn:uuid:/);
  const xml = res.body.toString("utf8");
  assert.match(xml, /<D:locktype><D:write\/><\/D:locktype>/);
  assert.match(xml, /<D:lockscope><D:exclusive\/><\/D:lockscope>/);
});

test("UNLOCK always succeeds with 204, regardless of the presented token", async () => {
  const res = await httpRequest(webdavPort, "UNLOCK", "/Documents/hello.txt", {
    headers: { ...auth(), "Lock-Token": "<urn:uuid:whatever>" },
  });
  assert.equal(res.status, 204);
});

test("an unsupported method returns 405", async () => {
  const res = await httpRequest(webdavPort, "COPY", "/Documents", { headers: auth() });
  assert.equal(res.status, 405);
});

test("regenerating the token immediately revokes the old one (no restart) — proven via the shared secrets set, exactly as BOS's real revoke would", async () => {
  const oldToken = token;
  const newToken = crypto.randomBytes(32).toString("hex");
  fakeBos.validSecrets.add(newToken);
  fakeBos.validSecrets.delete(oldToken);

  const withOld = await httpRequest(webdavPort, "GET", "/", { headers: { Authorization: `Bearer ${oldToken}` } });
  assert.equal(withOld.status, 401);

  const withNew = await httpRequest(webdavPort, "PROPFIND", "/", {
    headers: { Authorization: `Bearer ${newToken}`, Depth: "0" },
  });
  assert.equal(withNew.status, 207);

  // Restore for any tests appended after this one.
  token = newToken;
});
