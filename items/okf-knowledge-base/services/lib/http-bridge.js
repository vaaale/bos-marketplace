// http-bridge.js — small dependency-free REST bridge the config UI (app/)
// talks to. Bound on the service's own HTTP port (service.json's `port`,
// default 0 = OS-assigned), on loopback only. Routes:
//   GET  /config                        -> { httpPath, port, runtime }
//   GET  /bundles                       -> [ bundleStatus, ... ]
//   POST /bundles                       -> create a bundle { name, title?, description? }
//   GET  /bundles/<name>                -> bundleStatus + concept list
//   GET  /bundles/<name>/health         -> bundleStatus
//   GET  /bundles/<name>/concepts/<id>  -> single concept read { id, frontmatter, body, links }
//   POST /bundles/<name>/concepts       -> upsert a concept { id, title?, body?, frontmatter? }
//   GET  /bundles/<name>/links?concept=<id>     -> outbound links (graph view)
//   GET  /bundles/<name>/backlinks?concept=<id> -> inbound links (graph view)
//   GET  /bundles/<name>/neighbors?concept=<id> -> in+out neighborhood (graph view)
//   POST /bundles/<name>/raw            -> add an immutable raw source { path, content }; rejects overwrite
//   POST /bundles/<name>/import         -> import { files: [{ path, content }] }
//   GET  /bundles/<name>/export         -> { name, files: [{ path, content }] }
//   DELETE /bundles/<name>                        -> delete the whole bundle (recursive)
//   DELETE /bundles/<name>/concepts/<id>[?rewrite_backlinks=true] -> delete a concept
//
// Loopback-scoped auth (spec 040 FR-006, bos-spec 039 FR-009): every request
// must originate from the loopback interface. The server itself only binds
// 127.0.0.1 (see index.js), but a reverse proxy in front of it could still
// forward a non-loopback client's request, so the bridge independently
// verifies the actual TCP peer address before handling anything.

function sendJson(res, status, body) {
  const payload = JSON.stringify(body);
  res.writeHead(status, {
    "Content-Type": "application/json",
    "Content-Length": Buffer.byteLength(payload),
    "Access-Control-Allow-Origin": "*",
    "Access-Control-Allow-Methods": "GET, POST, DELETE, OPTIONS",
    "Access-Control-Allow-Headers": "Content-Type",
  });
  res.end(payload);
}

function readJsonBody(req) {
  return new Promise((resolve, reject) => {
    let data = "";
    req.on("data", (chunk) => {
      data += chunk;
      if (data.length > 10 * 1024 * 1024) req.destroy(new Error("body too large"));
    });
    req.on("end", () => {
      if (!data) return resolve({});
      try {
        resolve(JSON.parse(data));
      } catch (e) {
        reject(new Error("invalid JSON body"));
      }
    });
    req.on("error", reject);
  });
}

function statusForError(err) {
  if (/not found/i.test(err.message)) return 404;
  if (/already exists/i.test(err.message)) return 409;
  return 400;
}

// Loopback-scoped trust boundary (spec 040 FR-006 / bos-spec 039 FR-009):
// only 127.0.0.1/::1 (and IPv4-mapped ::ffff:127.0.0.1) may reach the bridge.
function isLoopbackAddress(addr) {
  return addr === "127.0.0.1" || addr === "::1" || addr === "::ffff:127.0.0.1";
}

// The server itself only binds 127.0.0.1 (see index.js). A direct TCP peer
// that isn't loopback is a genuine untrusted connection and gets rejected
// outright below, regardless of any headers it carries — a forwarded header
// can't launder a non-loopback peer into legitimacy.
//
// A loopback peer, on the other hand, is the trust boundary itself: it's
// either a direct local caller or the Supervisor's httpPath proxy (per
// design.md ADR-004) relaying a browser request on the user's behalf. The
// Supervisor legitimately attaches an X-Forwarded-For/X-Real-IP header
// carrying the browser's real (non-loopback) client IP when it does this —
// that's expected proxied traffic, not a spoofing attempt, and must not be
// rejected on that basis.
function isTrustedPeer(req) {
  return isLoopbackAddress(req.socket.remoteAddress);
}

/** ctx: { core, bundleRoot, serviceId, getRuntime } */
function createRequestHandler(ctx) {
  return async function requestHandler(req, res) {
    if (!isTrustedPeer(req)) {
      return sendJson(res, 403, { error: "forbidden: this bridge only accepts loopback-scoped requests" });
    }

    const url = new URL(req.url, "http://internal");
    const parts = url.pathname.replace(/^\/+|\/+$/g, "").split("/").filter(Boolean);

    if (req.method === "OPTIONS") {
      res.writeHead(204, {
        "Access-Control-Allow-Origin": "*",
        "Access-Control-Allow-Methods": "GET, POST, DELETE, OPTIONS",
        "Access-Control-Allow-Headers": "Content-Type",
      });
      return res.end();
    }

    try {
      // GET /config
      if (req.method === "GET" && parts.length === 1 && parts[0] === "config") {
        return sendJson(res, 200, ctx.getRuntime());
      }

      // /bundles ...
      if (parts[0] === "bundles") {
        if (req.method === "GET" && parts.length === 1) {
          return sendJson(res, 200, await ctx.core.listBundles(ctx.bundleRoot));
        }
        if (req.method === "POST" && parts.length === 1) {
          const body = await readJsonBody(req);
          if (!body.name) return sendJson(res, 400, { error: "name is required" });
          return sendJson(res, 201, await ctx.core.initBundle(ctx.bundleRoot, body.name, { title: body.title, description: body.description }));
        }

        const bundleName = parts[1];
        if (bundleName && req.method === "GET" && parts.length === 2) {
          const [status, concepts] = await Promise.all([
            ctx.core.bundleStatus(ctx.bundleRoot, bundleName),
            ctx.core.listConcepts(ctx.bundleRoot, bundleName),
          ]);
          return sendJson(res, 200, { ...status, concepts });
        }
        if (bundleName && req.method === "GET" && parts.length === 3 && parts[2] === "health") {
          return sendJson(res, 200, await ctx.core.bundleStatus(ctx.bundleRoot, bundleName));
        }
        // DELETE /bundles/<name> — whole-bundle delete (recursive)
        if (bundleName && req.method === "DELETE" && parts.length === 2) {
          return sendJson(res, 200, await ctx.core.deleteBundle(ctx.bundleRoot, bundleName));
        }
        if (bundleName && req.method === "GET" && parts.length === 3 && parts[2] === "export") {
          return sendJson(res, 200, await ctx.core.exportBundle(ctx.bundleRoot, bundleName));
        }
        if (bundleName && req.method === "POST" && parts.length === 3 && parts[2] === "import") {
          const body = await readJsonBody(req);
          return sendJson(res, 200, await ctx.core.importBundle(ctx.bundleRoot, bundleName, { files: body.files }));
        }
        if (bundleName && req.method === "POST" && parts.length === 3 && parts[2] === "concepts") {
          const body = await readJsonBody(req);
          if (!body.id) return sendJson(res, 400, { error: "id is required" });
          return sendJson(
            res,
            201,
            await ctx.core.upsertConcept(ctx.bundleRoot, bundleName, body.id, {
              title: body.title,
              body: body.body,
              frontmatter: body.frontmatter,
            }),
          );
        }
        // GET /bundles/<name>/concepts/<id> — single concept read (graph view backing surface)
        if (bundleName && req.method === "GET" && parts.length > 3 && parts[2] === "concepts") {
          const conceptId = parts.slice(3).join("/");
          return sendJson(res, 200, await ctx.core.readConcept(ctx.bundleRoot, bundleName, conceptId));
        }
        // DELETE /bundles/<name>/concepts/<id>[?rewrite_backlinks=true] — concept delete
        if (bundleName && req.method === "DELETE" && parts.length > 3 && parts[2] === "concepts") {
          const conceptId = parts.slice(3).join("/");
          const body = await readJsonBody(req);
          const queryFlag = url.searchParams.get("rewrite_backlinks");
          const rewriteBacklinks = queryFlag !== null ? queryFlag === "true" || queryFlag === "1" : !!body.rewrite_backlinks;
          return sendJson(res, 200, await ctx.core.deleteConcept(ctx.bundleRoot, bundleName, conceptId, { rewriteBacklinks }));
        }
        if (bundleName && req.method === "GET" && parts.length === 3 && parts[2] === "links") {
          const conceptId = url.searchParams.get("concept");
          if (!conceptId) return sendJson(res, 400, { error: "concept query param is required" });
          return sendJson(res, 200, { id: conceptId, links: await ctx.core.listLinks(ctx.bundleRoot, bundleName, conceptId) });
        }
        if (bundleName && req.method === "GET" && parts.length === 3 && parts[2] === "backlinks") {
          const conceptId = url.searchParams.get("concept");
          if (!conceptId) return sendJson(res, 400, { error: "concept query param is required" });
          return sendJson(res, 200, { id: conceptId, backlinks: await ctx.core.backlinks(ctx.bundleRoot, bundleName, conceptId) });
        }
        if (bundleName && req.method === "GET" && parts.length === 3 && parts[2] === "neighbors") {
          const conceptId = url.searchParams.get("concept");
          if (!conceptId) return sendJson(res, 400, { error: "concept query param is required" });
          const depthParam = url.searchParams.get("depth");
          const depth = depthParam ? Number(depthParam) : undefined;
          return sendJson(res, 200, { id: conceptId, neighbors: await ctx.core.neighbors(ctx.bundleRoot, bundleName, conceptId, { depth }) });
        }
        // POST /bundles/<name>/raw — add an immutable raw source (append-only; GAP 2)
        if (bundleName && req.method === "POST" && parts.length === 3 && parts[2] === "raw") {
          const body = await readJsonBody(req);
          if (!body.path) return sendJson(res, 400, { error: "path is required" });
          if (body.content === undefined) return sendJson(res, 400, { error: "content is required" });
          return sendJson(res, 201, await ctx.core.addRawSource(ctx.bundleRoot, bundleName, body.path, body.content));
        }
      }

      return sendJson(res, 404, { error: `no route for ${req.method} ${url.pathname}` });
    } catch (err) {
      sendJson(res, statusForError(err), { error: err.message });
    }
  };
}

module.exports = { createRequestHandler };
