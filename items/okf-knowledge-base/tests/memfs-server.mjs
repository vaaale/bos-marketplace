// memfs-server.mjs — an in-memory stand-in for BOS's /api/fs route.
//
// okf-core reaches the VFS ONLY through lib/vfs-bridge's loopback HTTP calls
// (see that file's header), and vfs-bridge resolves its base from
// process.env.PORT at call time. So pointing PORT at this server is enough to
// exercise the real okf-core storage paths — the real writes, the real
// listings, the real frontmatter round-trip — with no BOS running.
//
// It implements exactly the ops vfs-bridge uses: list / stat / read / write /
// mkdir / delete.

import http from "node:http";

export async function startMemFs() {
  /** @type {Map<string, string|null>} path -> content (null = directory) */
  const files = new Map([["/", null]]);

  const norm = (p) => {
    const cleaned = String(p || "/").replace(/\/+$/, "");
    return cleaned.startsWith("/") ? cleaned || "/" : `/${cleaned}`;
  };
  const mkdirp = (p) => {
    const parts = norm(p).split("/").filter(Boolean);
    let cur = "";
    for (const part of parts) {
      cur += `/${part}`;
      if (!files.has(cur)) files.set(cur, null);
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
      if (op === "stat") {
        if (!files.has(p)) return send(404, { error: `not found: ${p}` });
        const content = files.get(p);
        return send(200, { entry: { name: p.split("/").pop() || "/", type: content === null ? "dir" : "file", size: content ? Buffer.byteLength(content) : 0 } });
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
          entries.push({ name: key.slice(prefix.length), type: content === null ? "dir" : "file", size: content ? Buffer.byteLength(content) : 0 });
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
        if (body.op === "write") {
          mkdirp(p.slice(0, p.lastIndexOf("/")) || "/");
          files.set(p, String(body.content ?? ""));
          return send(200, { ok: true });
        }
        if (body.op === "mkdir") {
          mkdirp(p);
          return send(200, { ok: true });
        }
        if (body.op === "delete") {
          if (!files.has(p)) return send(404, { error: `not found: ${p}` });
          for (const key of [...files.keys()]) {
            if (key === p || key.startsWith(`${p}/`)) files.delete(key);
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
    paths: () => [...files.keys()].sort(),
    close: () => new Promise((resolve) => server.close(() => resolve())),
  };
}
