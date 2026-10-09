// http-bridge.js — the dependency-free REST surface the standalone OKF
// Knowledge Base app talks to, bound on the service's own HTTP port
// (service.json's `port`, default 0 = OS-assigned), on loopback only.
//
// ── Why this exists at all (ADR-003) ─────────────────────────────────────
//
// The app is a sandboxed browser iframe. It is NOT an agent and cannot call
// the 18 okf_* tools: those are an agent surface, IPC-dispatched and
// JSON-schema-gated. So the app gets its own HTTP data layer here, reusing
// the SAME okf-core functions the tools call. One capability, two surfaces —
// `okf_search` and `GET/POST /bundles/<b>/search` run the identical
// `core.search()`, so the UI can never drift from what the agent sees.
//
// Critically: adding app views adds NOTHING to the 18-tool agent surface
// (FR-036/SC-007). These routes are internal plumbing, not tool_declare'd.
//
// ── Routes (design.md §8.3) ──────────────────────────────────────────────
//   GET    /config                              -> { httpPath, port, runtime }
//   GET    /tools                               -> { count, tools: [declaration] }
//   GET    /bundles                             -> [ health, ... ]
//   POST   /bundles                             -> create { name, title?, description? }
//   GET    /bundles/<b>                         -> { health, documents, conceptIndex }
//   DELETE /bundles/<b>                         -> { deleted: true }
//   GET    /bundles/<b>/toc/<docId>             -> the stored document TOC
//   GET    /bundles/<b>/concept/<id...>         -> one concept IN FULL
//   GET    /bundles/<b>/search?query=&limit=    -> identical rows to okf_search
//   POST   /bundles/<b>/search  {query, limit}  -> same
//   GET    /bundles/<b>/graph                   -> { nodes, edges } (derived on read)
//   GET    /bundles/<b>/assets/<assetPath...>   -> raw image/video bytes
//   GET    /bundles/<b>/lint                    -> lint report
//   GET    /bundles/<b>/stale                   -> stale report
//   POST   /bundles/<b>/merge   {from, to}      -> consolidate two concept terms
//   POST   /bundles/<b>/import                  -> { files } | { sourcePath }
//   POST   /bundles/<b>/ingest  {source}        -> queues a run (the SAME
//                                                  dispatcher okf_ingest runs)
//   GET    /bundles/<b>/export                  -> { name, files, assets }
//   GET    /jobs[?bundleId=&status=&limit=]     -> [ job, ... ]
//   GET    /jobs/<id>                           -> one job record
//   POST   /jobs/<id>/start                     -> sub-agent: mark running
//   POST   /jobs/<id>/progress  {progress}      -> sub-agent: live progress
//   POST   /jobs/<id>/complete  {summary}       -> sub-agent: mark completed
//   POST   /jobs/<id>/fail      {error}         -> sub-agent OR the calling
//                                                  assistant's safety net
//   POST   /jobs/<id>  {status, ...}            -> the generic transition form
//
// Everything the APP calls is read-only except bundle create/import/export/
// delete, which the mockup gates behind explicit confirmation dialogs. All
// knowledge WRITES stay agent/tool-driven.
//
// ── Trust boundary ───────────────────────────────────────────────────────
// Loopback-scoped auth (spec FR-023 / bos-spec 039 FR-009): the server binds
// 127.0.0.1 (see index.js) AND this bridge independently verifies the actual
// TCP peer, because a reverse proxy in front of it could otherwise forward a
// non-loopback client's request.

function corsHeaders() {
  return {
    "Access-Control-Allow-Origin": "*",
    "Access-Control-Allow-Methods": "GET, POST, DELETE, OPTIONS",
    "Access-Control-Allow-Headers": "Content-Type",
  };
}

function sendJson(res, status, body) {
  const payload = JSON.stringify(body);
  res.writeHead(status, {
    "Content-Type": "application/json",
    "Content-Length": Buffer.byteLength(payload),
    ...corsHeaders(),
  });
  res.end(payload);
}

function sendBytes(res, status, buffer, contentType) {
  res.writeHead(status, {
    "Content-Type": contentType || "application/octet-stream",
    "Content-Length": buffer.length,
    "Cache-Control": "private, max-age=300",
    ...corsHeaders(),
  });
  res.end(buffer);
}

function readJsonBody(req) {
  return new Promise((resolve, reject) => {
    let data = "";
    req.on("data", (chunk) => {
      data += chunk;
      if (data.length > 32 * 1024 * 1024) req.destroy(new Error("body too large"));
    });
    req.on("end", () => {
      if (!data) return resolve({});
      try {
        resolve(JSON.parse(data));
      } catch {
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

function isLoopbackAddress(addr) {
  return addr === "127.0.0.1" || addr === "::1" || addr === "::ffff:127.0.0.1";
}

// A direct TCP peer that isn't loopback is a genuine untrusted connection and
// gets rejected outright, regardless of any headers it carries — a forwarded
// header can't launder a non-loopback peer into legitimacy.
//
// A loopback peer IS the trust boundary: either a direct local caller, or the
// Supervisor's httpPath proxy relaying a browser request on the user's
// behalf. That proxy legitimately attaches an X-Forwarded-For carrying the
// browser's real (non-loopback) IP — expected proxied traffic, not spoofing.
function isTrustedPeer(req) {
  return isLoopbackAddress(req.socket.remoteAddress);
}

/** ctx: { core, bundleRoot, serviceId, getRuntime, declarations, vfs, getIngestDefaults, planIngest } */
function createRequestHandler(ctx) {
  return async function requestHandler(req, res) {
    if (!isTrustedPeer(req)) {
      return sendJson(res, 403, { error: "forbidden: this bridge only accepts loopback-scoped requests" });
    }

    const url = new URL(req.url, "http://internal");
    const parts = url.pathname.replace(/^\/+|\/+$/g, "").split("/").filter(Boolean).map(decodeURIComponent);
    const { core, bundleRoot } = ctx;

    if (req.method === "OPTIONS") {
      res.writeHead(204, corsHeaders());
      return res.end();
    }

    try {
      // ── GET /config ────────────────────────────────────────────────────
      if (req.method === "GET" && parts.length === 1 && parts[0] === "config") {
        return sendJson(res, 200, ctx.getRuntime());
      }

      // GET /tools — the declared okf_* surface, so the app's titlebar badge
      // states the REAL count rather than a hardcoded string, and so the e2e
      // suite can assert the 18-tool contract (SC-007) against what the
      // service actually declares. Read-only; this is not itself a tool.
      if (req.method === "GET" && parts.length === 1 && parts[0] === "tools") {
        const tools = ctx.declarations || [];
        return sendJson(res, 200, {
          count: tools.length,
          tools: tools.map((d) => ({
            name: d.name,
            description: d.description,
            inputSchema: d.inputSchema,
            parallelSafe: !!d.parallelSafe,
          })),
        });
      }

      // ── /jobs ──────────────────────────────────────────────────────────
      if (parts[0] === "jobs") {
        if (req.method === "GET" && parts.length === 1) {
          const limitParam = url.searchParams.get("limit");
          const jobs = await core.listJobs(bundleRoot, {
            bundleId: url.searchParams.get("bundleId") || undefined,
            status: url.searchParams.get("status") || undefined,
            limit: limitParam ? Number(limitParam) : undefined,
          });
          const active = jobs.filter((j) => j.status === "running" || j.status === "queued").length;
          return sendJson(res, 200, { jobs, total: jobs.length, active });
        }
        const jobId = parts[1];
        if (jobId && req.method === "GET" && parts.length === 2) {
          const job = await core.getJob(bundleRoot, jobId);
          if (!job) return sendJson(res, 404, { error: `job not found: ${jobId}` });
          return sendJson(res, 200, job);
        }
        // The sub-agent's lifecycle callbacks (ADR-006). These are plain HTTP
        // on the service's own loopback port — NOT tools — which is precisely
        // how run observability is added without a 19th tool.
        if (jobId && req.method === "POST" && parts.length === 3) {
          const body = await readJsonBody(req);
          const action = parts[2];
          if (action === "start") return sendJson(res, 200, await core.updateJob(bundleRoot, jobId, { status: "running", progress: body.progress }));
          if (action === "progress") return sendJson(res, 200, await core.updateJob(bundleRoot, jobId, { progress: body.progress ?? null }));
          if (action === "complete") return sendJson(res, 200, await core.updateJob(bundleRoot, jobId, { status: "completed", summary: body.summary || null }));
          if (action === "fail") return sendJson(res, 200, await core.updateJob(bundleRoot, jobId, { status: "failed", error: body.error || "ingest failed with no reported reason" }));
          return sendJson(res, 404, { error: `no such job action: ${action}` });
        }
        if (jobId && req.method === "POST" && parts.length === 2) {
          const body = await readJsonBody(req);
          return sendJson(res, 200, await core.updateJob(bundleRoot, jobId, body));
        }
      }

      // ── /bundles ───────────────────────────────────────────────────────
      if (parts[0] === "bundles") {
        if (req.method === "GET" && parts.length === 1) {
          return sendJson(res, 200, { bundles: await core.listBundles(bundleRoot) });
        }
        if (req.method === "POST" && parts.length === 1) {
          const body = await readJsonBody(req);
          if (!body.name) return sendJson(res, 400, { error: "name is required" });
          return sendJson(res, 201, await core.initBundle(bundleRoot, body.name, { title: body.title, description: body.description }));
        }

        const bundle = parts[1];
        if (bundle && req.method === "GET" && parts.length === 2) {
          return sendJson(res, 200, await core.bundleDetail(bundleRoot, bundle));
        }
        if (bundle && req.method === "DELETE" && parts.length === 2) {
          return sendJson(res, 200, await core.deleteBundle(bundleRoot, bundle));
        }

        const section = parts[2];

        if (bundle && req.method === "GET" && section === "toc" && parts.length >= 4) {
          return sendJson(res, 200, await core.readToc(bundleRoot, bundle, parts.slice(3).join("/")));
        }
        // concept ids are `<docId>/<chId>`, so the id is the REST of the path
        if (bundle && req.method === "GET" && section === "concept" && parts.length >= 4) {
          return sendJson(res, 200, await core.readConcept(bundleRoot, bundle, parts.slice(3).join("/")));
        }
        if (bundle && section === "search" && parts.length === 3 && (req.method === "GET" || req.method === "POST")) {
          const body = req.method === "POST" ? await readJsonBody(req) : {};
          const query = req.method === "POST" ? body.query : url.searchParams.get("query");
          const limitRaw = req.method === "POST" ? body.limit : url.searchParams.get("limit");
          const limit = limitRaw === undefined || limitRaw === null || limitRaw === "" ? undefined : Number(limitRaw);
          // byte-for-byte the okf_search tool's rows — same core.search()
          const rows = await core.search(bundleRoot, bundle, query || "", limit);
          return sendJson(res, 200, { bundle, query: query || "", rows, count: rows.length });
        }
        if (bundle && req.method === "GET" && section === "graph" && parts.length === 3) {
          return sendJson(res, 200, await core.graph(bundleRoot, bundle));
        }
        if (bundle && req.method === "GET" && section === "assets" && parts.length >= 4) {
          const assetPath = parts.slice(3).join("/");
          const rel = assetPath.startsWith("raw/") ? assetPath : `raw/assets/${assetPath}`;
          const { buffer, contentType } = await core.readAsset(bundleRoot, bundle, rel);
          return sendBytes(res, 200, buffer, contentType);
        }
        if (bundle && req.method === "GET" && section === "lint" && parts.length === 3) {
          return sendJson(res, 200, await core.lintBundle(bundleRoot, bundle));
        }
        if (bundle && req.method === "GET" && section === "stale" && parts.length === 3) {
          return sendJson(res, 200, { bundle, stale: await core.staleReport(bundleRoot, bundle) });
        }
        if (bundle && req.method === "GET" && section === "export" && parts.length === 3) {
          return sendJson(res, 200, await core.exportBundle(bundleRoot, bundle));
        }
        // POST /bundles/<b>/merge — vocabulary curation from the Concept
        // Index. US6 names the USER as a merge actor and this is the only
        // user-facing surface, so the app needs it; it reuses the very same
        // core.mergeConcepts() the okf_merge_concepts tool calls, and adds no
        // tool. (Knowledge *authoring* stays agent-driven; this is curation
        // of the derived vocabulary, which is what the index view is for.)
        if (bundle && req.method === "POST" && section === "merge" && parts.length === 3) {
          const body = await readJsonBody(req);
          if (!body.from || !body.to) return sendJson(res, 400, { error: "both `from` and `to` concept terms are required" });
          return sendJson(res, 200, await core.mergeConcepts(bundleRoot, bundle, body.from, body.to));
        }

        // POST /bundles/<b>/ingest — the app's Ingest modal. It runs the
        // SAME planIngest() the okf_ingest tool runs: the run is recorded as
        // a queued job with its callback URLs, and the delegation block comes
        // back for the user to hand the assistant. The service deliberately
        // cannot perform the delegation itself (it has no agent loop), so
        // this queues and plans — it does not pretend to start an agent.
        if (bundle && req.method === "POST" && section === "ingest" && parts.length === 3) {
          const body = await readJsonBody(req);
          if (!body.source) return sendJson(res, 400, { error: "source is required" });
          if (!ctx.planIngest) return sendJson(res, 501, { error: "ingest planning is not wired into this bridge" });
          return sendJson(
            res,
            200,
            await ctx.planIngest(
              { bundle, source: body.source, maxDepth: body.maxDepth, maxWorkers: body.maxWorkers },
              { core, bundleRoot, vfs: ctx.vfs, ingestDefaults: ctx.getIngestDefaults(), getRuntime: ctx.getRuntime },
            ),
          );
        }
        if (bundle && req.method === "POST" && section === "import" && parts.length === 3) {
          const body = await readJsonBody(req);
          return sendJson(res, 200, await core.importBundle(bundleRoot, bundle, { files: body.files, sourcePath: body.sourcePath }));
        }
      }

      return sendJson(res, 404, { error: `no route for ${req.method} ${url.pathname}` });
    } catch (err) {
      sendJson(res, statusForError(err), { error: err.message });
    }
  };
}

module.exports = { createRequestHandler, isTrustedPeer, statusForError };
