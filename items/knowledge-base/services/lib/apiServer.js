"use strict";

// Plain JSON HTTP API — the bridge between the config UI (config/config.html,
// running same-origin under BOS via /api/services/knowledge-base/config-app)
// and this worker's state/pipeline. Mounted on the SAME http.Server as the
// MCP endpoint (index.js routes by path prefix).
//
// CORS: under a Supervisor-fronted deployment the config UI reaches this
// through `httpPath` (same origin as BOS itself, via the proxy — no CORS
// needed). Under plain `npm run dev` with no Supervisor, the config UI falls
// back to the worker's own bound port directly, which IS a different origin
// from BOS's own (same host, different port) — so every response here sets
// permissive CORS headers. There's no secret/session to protect on these
// routes (personal single-user OS; the sensitive calls — Drive OAuth, VFS —
// already happen behind BOS's own session-authenticated surfaces before
// reaching this worker).

const state = require("./state");
const dedupe = require("./dedupe");
const pipeline = require("./pipeline");
const graphiti = require("./graphiti");
const drive = require("./sources/drive");
const query = require("./query");
const log = require("./log");

function sendJson(res, status, body) {
  const data = JSON.stringify(body);
  res.writeHead(status, {
    "Content-Type": "application/json; charset=utf-8",
    "Content-Length": Buffer.byteLength(data),
    "Access-Control-Allow-Origin": "*",
  });
  res.end(data);
}

function readJsonBody(req) {
  return new Promise((resolve, reject) => {
    const chunks = [];
    req.on("data", (c) => chunks.push(c));
    req.on("end", () => {
      const raw = Buffer.concat(chunks).toString("utf8");
      if (!raw) return resolve({});
      try {
        resolve(JSON.parse(raw));
      } catch {
        reject(new Error("invalid JSON body"));
      }
    });
    req.on("error", reject);
  });
}

// ---------------------------------------------------------------------------
// View helpers — shape state for the config UI, matching the mockup's
// vocabulary directly (statuses, "N sources", health summary badges).
// ---------------------------------------------------------------------------

function kbHealthSummary(kbId) {
  const sources = state.listSources(kbId);
  if (sources.length === 0) return { label: "Empty", tone: "neutral" };
  const failed = sources.filter((s) => s.status === "failed" || s.status === "needs_reauth").length;
  const inProgress = sources.filter((s) => ["pending", "indexing", "crawling", "connecting"].includes(s.status)).length;
  if (failed > 0) return { label: "Needs attention", tone: "warn" };
  if (inProgress > 0) return { label: "Indexing", tone: "neutral" };
  return { label: "Healthy", tone: "good" };
}

function kbListView() {
  return state.listKbs().map((kb) => ({
    ...kb,
    sourceCount: state.listSources(kb.id).length,
    health: kbHealthSummary(kb.id),
  }));
}

function kbDetailView(kbId) {
  const kb = state.getKb(kbId);
  if (!kb) return null;
  const sources = state.listSources(kbId);
  const indexed = sources.filter((s) => s.status === "indexed").length;
  const inProgress = sources.filter((s) => ["pending", "indexing", "crawling", "connecting"].includes(s.status)).length;
  const failed = sources.filter((s) => s.status === "failed" || s.status === "needs_reauth").length;
  return {
    kb: { ...kb, sourceCount: sources.length, health: kbHealthSummary(kbId) },
    sources,
    health: {
      indexed,
      total: sources.length,
      inProgress,
      failed,
      events: state.listEvents(kbId).slice(0, 50),
    },
  };
}

// ---------------------------------------------------------------------------
// Route table — [method, regex, handler(match, body, url)]
// ---------------------------------------------------------------------------

async function deleteSourceCascade(source) {
  pipeline.cancel(source.id);
  for (const entry of Object.values((source.extra && source.extra.itemIndex) || {})) {
    for (const episodeId of entry.episodeIds || []) {
      await graphiti
        .deleteEpisode({ episodeUuid: episodeId })
        .catch((err) => log.warn(`failed to delete episode ${episodeId} for removed source "${source.id}"`, err && err.message));
    }
  }
  dedupe.forgetSource(source.kbId, source.id);
  state.deleteSource(source.id);
}

const routes = [
  ["GET", /^\/api\/kbs$/, async () => ({ status: 200, body: { kbs: kbListView() } })],

  ["POST", /^\/api\/kbs$/, async (_m, body) => {
    const kb = await state.createKb({ name: body.name, description: body.description });
    return { status: 201, body: { kb } };
  }],

  ["GET", /^\/api\/kbs\/([^/]+)$/, async (m) => {
    const view = kbDetailView(m[1]);
    if (!view) return { status: 404, body: { error: "knowledge base not found" } };
    return { status: 200, body: view };
  }],

  ["PATCH", /^\/api\/kbs\/([^/]+)$/, async (m, body) => {
    const kb = await state.renameKb(m[1], { name: body.name, description: body.description });
    return { status: 200, body: { kb } };
  }],

  ["DELETE", /^\/api\/kbs\/([^/]+)$/, async (m) => {
    const kbId = m[1];
    for (const source of state.listSources(kbId)) await deleteSourceCascade(source);
    await graphiti.clearGraph({ kbId }).catch((err) => log.warn(`failed to clear Graphiti group for deleted KB "${kbId}"`, err && err.message));
    state.deleteEventsForKb(kbId);
    dedupe.forgetKb(kbId);
    await state.deleteKb(kbId);
    return { status: 200, body: { ok: true } };
  }],

  ["POST", /^\/api\/kbs\/([^/]+)\/sources\/upload$/, async (m, body) => {
    const source = await state.createSource({
      kbId: m[1],
      type: "upload",
      name: body.name,
      reference: body.vfsPath,
      extra: {},
    });
    pipeline.enqueue(source.id);
    return { status: 201, body: { source } };
  }],

  ["POST", /^\/api\/kbs\/([^/]+)\/sources\/website$/, async (m, body) => {
    const url = new URL(body.url); // throws on malformed input -> 400 below
    const source = await state.createSource({
      kbId: m[1],
      type: "website",
      name: url.hostname,
      reference: url.toString(),
      extra: { maxDepth: body.maxDepth || undefined, pageLimit: body.pageLimit || undefined },
    });
    pipeline.enqueue(source.id);
    return { status: 201, body: { source } };
  }],

  ["POST", /^\/api\/kbs\/([^/]+)\/sources\/folder$/, async (m, body) => {
    const source = await state.createSource({
      kbId: m[1],
      type: "folder",
      name: body.name,
      reference: body.vfsPath,
      extra: {},
    });
    pipeline.enqueue(source.id);
    return { status: 201, body: { source } };
  }],

  ["POST", /^\/api\/kbs\/([^/]+)\/sources\/drive$/, async (m, body) => {
    const source = await state.createSource({
      kbId: m[1],
      type: "drive",
      name: body.folderName || body.folderId,
      reference: body.folderId,
      extra: {},
    });
    pipeline.enqueue(source.id);
    return { status: 201, body: { source } };
  }],

  ["POST", /^\/api\/sources\/([^/]+)\/refresh$/, async (m) => {
    const source = state.getSource(m[1]);
    if (!source) return { status: 404, body: { error: "source not found" } };
    pipeline.enqueue(source.id);
    return { status: 200, body: { source } };
  }],

  ["POST", /^\/api\/sources\/([^/]+)\/retry$/, async (m) => {
    const source = state.getSource(m[1]);
    if (!source) return { status: 404, body: { error: "source not found" } };
    await pipeline.retry(source.id);
    return { status: 200, body: { source } };
  }],

  ["DELETE", /^\/api\/sources\/([^/]+)$/, async (m) => {
    const source = state.getSource(m[1]);
    if (!source) return { status: 404, body: { error: "source not found" } };
    await deleteSourceCascade(source);
    return { status: 200, body: { ok: true } };
  }],

  ["GET", /^\/api\/drive\/status$/, async () => ({ status: 200, body: await drive.checkConnection() })],

  ["GET", /^\/api\/drive\/folders$/, async (_m, _body, url) => ({
    status: 200,
    body: { folders: await drive.listFolders(url.searchParams.get("parentId") || undefined) },
  })],

  ["POST", /^\/api\/query\/search$/, async (_m, body) => ({ status: 200, body: await query.search(body) })],
  ["POST", /^\/api\/query\/retrieve$/, async (_m, body) => ({ status: 200, body: await query.retrieve(body) })],

  ["GET", /^\/api\/graphiti\/status$/, async () => {
    try {
      return { status: 200, body: { connected: true, status: await graphiti.getStatus() } };
    } catch (err) {
      return { status: 200, body: { connected: false, error: (err && err.message) || String(err) } };
    }
  }],
];

async function handleRequest(req, res) {
  const url = new URL(req.url, "http://internal");
  if (req.method === "OPTIONS") {
    res.writeHead(204, {
      "Access-Control-Allow-Origin": "*",
      "Access-Control-Allow-Methods": "GET, POST, PATCH, DELETE, OPTIONS",
      "Access-Control-Allow-Headers": "Content-Type",
    });
    return res.end();
  }

  for (const [method, pattern, handler] of routes) {
    if (req.method !== method) continue;
    const match = pattern.exec(url.pathname);
    if (!match) continue;
    try {
      const body = method === "POST" || method === "PATCH" ? await readJsonBody(req) : {};
      // GET is the config UI's own 3s polling refresh — logging every poll
      // would drown the log file in noise with nothing to debug. Every
      // mutating call (create/delete/refresh/retry a KB or source) is a real
      // decision point worth a trace.
      if (method !== "GET") log.debug(`${method} ${url.pathname}`, body);
      const { status, body: responseBody } = await handler(match, body, url);
      return sendJson(res, status, responseBody);
    } catch (err) {
      const message = (err && err.message) || String(err);
      log.warn(`${method} ${url.pathname} -> 400`, message);
      return sendJson(res, 400, { error: message });
    }
  }

  return sendJson(res, 404, { error: `No route for ${req.method} ${url.pathname}` });
}

module.exports = { handleRequest };
