// _fake-bos.js — a tiny in-process stand-in for BOS's own /api/fs,
// /api/subagents/delegate and /api/events* routes, used by the unit tests
// below so vfs.js / executor.js / generate.js / handlers.js can be exercised
// against a real HTTP loopback server (matching how they actually run)
// without needing a live BOS instance. Mirrors the naming convention of BOS's
// own tests/services/_worker-fixtures.ts.

const http = require("http");
const { URL } = require("url");

/** A minimal in-memory VFS: Map<absolutePath, content:string>. */
function createMemoryFs(initial = {}) {
  const files = new Map(Object.entries(initial));

  function list(dir) {
    const prefix = dir.endsWith("/") ? dir : `${dir}/`;
    const seen = new Set();
    const entries = [];
    for (const p of files.keys()) {
      if (!p.startsWith(prefix)) continue;
      const rest = p.slice(prefix.length);
      const name = rest.split("/")[0];
      if (seen.has(name)) continue;
      seen.add(name);
      const isFile = rest.indexOf("/") === -1;
      entries.push({ name, path: `${prefix}${name}`, type: isFile ? "file" : "dir" });
    }
    return entries;
  }

  return { files, list };
}

/**
 * @param {object} opts
 * @param {Record<string,string>} [opts.vfs] initial file contents
 * @param {(body: object) => Array<object>} [opts.delegate] returns the NDJSON
 *   event array for a given /api/subagents/delegate request body; defaults
 *   to a stub that echoes the task as its output.
 * @param {object} [opts.events] BOS event-system stand-in (US17/US18):
 *   `handlers` — the grouped registry GET /api/events/handlers returns
 *   (default `{}`, i.e. nothing registered); `handlersStatus`/`handlersBody`
 *   — force an error response for that route; `emit` — `(body) => ({ status,
 *   body })` overriding the POST /api/events response (default 201 with a
 *   generated event id). Everything POSTed to /api/events is recorded on the
 *   returned `emitted` array.
 */
function startFakeBos({ vfs: initialVfs = {}, delegate, events = {} } = {}) {
  const mem = createMemoryFs(initialVfs);
  const delegateFn = delegate || ((body) => [{ type: "done", result: { output: `echo: ${body.task}` } }]);
  const emitted = [];
  let emitCount = 0;

  const server = http.createServer((req, res) => {
    const url = new URL(req.url, "http://internal");
    if (url.pathname === "/api/fs" && req.method === "GET") {
      const op = url.searchParams.get("op");
      const p = url.searchParams.get("path");
      if (op === "list") {
        return json(res, 200, { entries: mem.list(p) });
      }
      if (op === "read") {
        if (!mem.files.has(p)) return json(res, 404, { error: "not found" });
        return json(res, 200, { content: mem.files.get(p) });
      }
      if (op === "stat") {
        if (mem.files.has(p)) return json(res, 200, { entry: { name: p.split("/").pop(), path: p, type: "file" } });
        if (mem.list(p).length > 0 || p === "/") return json(res, 200, { entry: { name: p.split("/").pop(), path: p, type: "dir" } });
        return json(res, 404, { error: "not found" });
      }
      return json(res, 400, { error: `unknown op ${op}` });
    }
    if (url.pathname === "/api/fs" && req.method === "POST") {
      return readJsonBody(req).then((body) => {
        if (body.op === "write") {
          mem.files.set(body.path, body.content);
          return json(res, 200, { ok: true });
        }
        if (body.op === "mkdir") {
          return json(res, 200, { ok: true });
        }
        if (body.op === "delete") {
          const prefix = `${body.path}/`;
          for (const p of Array.from(mem.files.keys())) {
            if (p === body.path || p.startsWith(prefix)) mem.files.delete(p);
          }
          return json(res, 200, { ok: true });
        }
        if (body.op === "rename") {
          if (mem.files.has(body.path)) {
            mem.files.set(body.to, mem.files.get(body.path));
            mem.files.delete(body.path);
          }
          return json(res, 200, { ok: true });
        }
        return json(res, 400, { error: `unknown op ${body.op}` });
      });
    }
    if (url.pathname === "/api/events/handlers" && req.method === "GET") {
      const status = events.handlersStatus ?? 200;
      if (status !== 200) return json(res, status, events.handlersBody ?? { error: { code: "kernel-unavailable", message: "event kernel unavailable" } });
      const registry = typeof events.handlers === "function" ? events.handlers() : events.handlers || {};
      return json(res, 200, registry);
    }
    if (url.pathname === "/api/events" && req.method === "POST") {
      return readJsonBody(req).then((body) => {
        emitted.push(body);
        emitCount++;
        if (typeof events.emit === "function") {
          const override = events.emit(body) || {};
          return json(res, override.status ?? 201, override.body ?? { id: `evt_${emitCount}` });
        }
        return json(res, 201, { id: `evt_${emitCount}`, sequence: emitCount, processing: "processed", read: "unread", activeHandlers: 0 });
      });
    }
    if (url.pathname === "/api/subagents/delegate" && req.method === "POST") {
      return readJsonBody(req).then(async (body) => {
        const events = await delegateFn(body); // may never resolve, to simulate an in-flight run
        res.writeHead(200, { "Content-Type": "application/x-ndjson" });
        for (const ev of events) res.write(`${JSON.stringify(ev)}\n`);
        res.end();
      });
    }
    json(res, 404, { error: "no such route" });
  });

  return new Promise((resolve) => {
    server.listen(0, "127.0.0.1", () => {
      const port = server.address().port;
      resolve({
        port,
        origin: `http://127.0.0.1:${port}`,
        files: mem.files,
        emitted,
        // closeAllConnections is required, not just close(): a still-pending
        // request (e.g. a delegate call whose handler intentionally never
        // resolves, simulating an in-flight run) keeps a socket open forever,
        // and plain server.close() waits for every connection to end before
        // its callback fires — this would hang the test process indefinitely.
        close: () =>
          new Promise((r) => {
            server.closeAllConnections?.();
            server.close(() => r());
          }),
      });
    });
  });
}

function json(res, status, body) {
  const payload = JSON.stringify(body);
  res.writeHead(status, { "Content-Type": "application/json" });
  res.end(payload);
}

function readJsonBody(req) {
  return new Promise((resolve) => {
    let data = "";
    req.on("data", (c) => (data += c));
    req.on("end", () => {
      try {
        resolve(data ? JSON.parse(data) : {});
      } catch {
        resolve({});
      }
    });
  });
}

module.exports = { startFakeBos, createMemoryFs };
