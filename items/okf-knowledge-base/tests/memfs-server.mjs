// memfs-server.mjs — an in-memory stand-in for BOS's /api/fs route.
//
// okf-core reaches the VFS ONLY through lib/vfs-bridge's loopback HTTP calls
// (see that file's header), and vfs-bridge resolves its base from
// process.env.PORT at call time. So pointing PORT at this server is enough to
// exercise the real okf-core storage paths — the real writes, the real
// listings, the real frontmatter round-trip — with no BOS running.
//
// It implements exactly the ops vfs-bridge uses: list / stat / read / write /
// mkdir / delete — and reports `size` and `modified` on list/stat the way
// /api/fs does (src/os/vfs.ts: `modified` is the file's mtime in ms), because
// the service's freshness check (design.md ADR-016) is built on exactly those.
//
// For the scaling and failure tests it also COUNTS requests per op and path
// (`counts()`, `resetCounts()`), and can fail the next matching request
// (`failNext(op, pathPredicate)`) — so "a write issues O(1) reads" and "a
// failed listing is an error" are asserted, not estimated.

import http from "node:http";

export async function startMemFs() {
  /** @type {Map<string, string|null>} path -> content (null = directory) */
  const files = new Map([["/", null]]);
  /** path -> modified (ms). Strictly increasing, so two writes in the same
   *  millisecond still differ — the real filesystem's coarser clock is a
   *  documented limit (ADR-016), not something these tests exercise. */
  const mtimes = new Map([["/", 0]]);
  let clock = 0;
  const touch = (p) => {
    clock = Math.max(Date.now(), clock + 1);
    mtimes.set(p, clock);
  };
  /** op -> path -> count */
  const tally = new Map();
  const count = (op, p) => {
    if (!tally.has(op)) tally.set(op, new Map());
    const byPath = tally.get(op);
    byPath.set(p, (byPath.get(p) || 0) + 1);
  };
  const failures = [];
  // Concurrency per op+path: how many requests are being served at once, and
  // the most ever seen. `delayWrites(ms)` holds every write open that long, the
  // way a real /api/fs write of a large file is not instantaneous — which is
  // the only condition under which two writes of the same file can overlap.
  const inFlight = new Map();
  const peakInFlight = new Map();
  let writeDelayMs = 0;
  const enter = (key) => {
    const n = (inFlight.get(key) || 0) + 1;
    inFlight.set(key, n);
    peakInFlight.set(key, Math.max(peakInFlight.get(key) || 0, n));
  };
  const leave = (key) => inFlight.set(key, inFlight.get(key) - 1);
  const takeFailure = (op, p) => {
    const i = failures.findIndex((f) => f.op === op && f.match(p));
    if (i === -1) return false;
    failures.splice(i, 1);
    return true;
  };
  const entryOf = (key, name) => {
    const content = files.get(key);
    return { name, type: content === null ? "dir" : "file", size: content ? Buffer.byteLength(content) : 0, modified: mtimes.get(key) || 0 };
  };

  const norm = (p) => {
    const cleaned = String(p || "/").replace(/\/+$/, "");
    return cleaned.startsWith("/") ? cleaned || "/" : `/${cleaned}`;
  };
  const mkdirp = (p) => {
    const parts = norm(p).split("/").filter(Boolean);
    let cur = "";
    for (const part of parts) {
      cur += `/${part}`;
      if (!files.has(cur)) {
        files.set(cur, null);
        touch(cur);
      }
    }
  };

  const server = http.createServer((req, res) => {
    const url = new URL(req.url, "http://127.0.0.1");
    const send = (status, body) => {
      const payload = JSON.stringify(body);
      res.writeHead(status, { "Content-Type": "application/json", "Content-Length": Buffer.byteLength(payload) });
      res.end(payload);
    };

    if (req.method === "GET" && url.pathname === "/api/fs") {
      const op = url.searchParams.get("op");
      const p = norm(url.searchParams.get("path"));
      count(op, p);
      if (takeFailure(op, p)) return send(500, { error: `injected failure: ${op} ${p}` });
      if (op === "stat") {
        if (!files.has(p)) return send(404, { error: `not found: ${p}` });
        return send(200, { entry: entryOf(p, p.split("/").pop() || "/") });
      }
      if (op === "read") {
        const content = files.get(p);
        if (typeof content !== "string") return send(404, { error: `not found: ${p}` });
        return send(200, { content });
      }
      if (op === "list") {
        if (!files.has(p) || files.get(p) !== null) return send(404, { error: `not a directory: ${p}` });
        const prefix = p === "/" ? "/" : `${p}/`;
        const entries = [];
        for (const [key, content] of files) {
          if (key === p || !key.startsWith(prefix)) continue;
          if (key.slice(prefix.length).includes("/")) continue;
          entries.push(entryOf(key, key.slice(prefix.length)));
        }
        return send(200, { entries });
      }
      return send(400, { error: `unknown op: ${op}` });
    }

    if (req.method === "POST" && url.pathname === "/api/fs") {
      let data = "";
      req.on("data", (c) => (data += c));
      req.on("end", () => {
        let body = {};
        try {
          body = JSON.parse(data || "{}");
        } catch {
          return send(400, { error: "invalid JSON" });
        }
        const p = norm(body.path);
        count(body.op, p);
        if (takeFailure(body.op, p)) return send(500, { error: `injected failure: ${body.op} ${p}` });
        if (body.op === "write") {
          const key = `write ${p}`;
          enter(key);
          const commit = () => {
            leave(key);
            mkdirp(p.slice(0, p.lastIndexOf("/")) || "/");
            files.set(p, String(body.content ?? ""));
            touch(p);
            send(200, { ok: true });
          };
          if (writeDelayMs) setTimeout(commit, writeDelayMs);
          else commit();
          return;
        }
        if (body.op === "mkdir") {
          mkdirp(p);
          return send(200, { ok: true });
        }
        if (body.op === "delete") {
          if (!files.has(p)) return send(404, { error: `not found: ${p}` });
          for (const key of [...files.keys()]) {
            if (key === p || key.startsWith(`${p}/`)) {
              files.delete(key);
              mtimes.delete(key);
            }
          }
          return send(200, { ok: true });
        }
        return send(400, { error: `unknown op: ${body.op}` });
      });
      return;
    }

    send(404, { error: `no route for ${req.method} ${url.pathname}` });
  });

  await new Promise((resolve) => server.listen(0, "127.0.0.1", resolve));
  return {
    port: server.address().port,
    files,
    read: (p) => files.get(norm(p)),
    // Direct writes, bypassing the service — how a test simulates a file
    // changing UNDER the service (e.g. raw/ drifting away from the heading
    // map that was built for it).
    write: (p, content) => {
      mkdirp(norm(p).split("/").slice(0, -1).join("/") || "/");
      files.set(norm(p), String(content));
      touch(norm(p));
    },
    remove: (p) => {
      mtimes.delete(norm(p));
      return files.delete(norm(p));
    },
    /** Requests seen since the last reset: `counts().read` is a Map of
     *  path -> count; `total(op)` sums one op. */
    counts: () => tally,
    total: (op) => [...(tally.get(op) || new Map()).values()].reduce((a, b) => a + b, 0),
    resetCounts: () => tally.clear(),
    /** Fail the next `op` request whose path satisfies `match` with a 500. */
    failNext: (op, match) => failures.push({ op, match: typeof match === "function" ? match : (p) => p === norm(match) }),
    paths: () => [...files.keys()].sort(),
    /** Hold every write open for `ms` before it lands (0 = immediate). */
    delayWrites: (ms) => {
      writeDelayMs = ms;
    },
    /** The most writes to `p` that were ever being served at the same time. */
    peakWritesInFlight: (p) => peakInFlight.get(`write ${norm(p)}`) || 0,
    close: () => new Promise((resolve) => server.close(() => resolve())),
  };
}
