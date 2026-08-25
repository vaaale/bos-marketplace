"use strict";

// Persistent application state for this item — KB metadata, sources, health
// events, and the content-hash dedupe registry. Lives under the ITEM's own
// `data/` directory (item root), never under BOS's dataDir() — the item owns
// this state, the same way a marketplace item's own repo owns its runtime
// files (design.md §4.4). `data/kbs.json`'s SHAPE is a real, already-consumed
// contract: src/lib/agent/kb-catalog.ts (part of BOS core) reads
// `<itemPath>/data/kbs.json` directly to build the agent's "## Knowledge
// bases" system-prompt block — it accepts either a bare array or
// `{ kbs: [...] }` and only requires each entry to have `id`/`name` (string).
// Keep every KB entry at least `{ id, name, description }`-shaped so that
// catalog reader keeps working without changes.

const fs = require("fs");
const path = require("path");
const crypto = require("crypto");
const log = require("./log");

let dataDir = null;

function init(itemDataDir) {
  dataDir = itemDataDir;
  fs.mkdirSync(dataDir, { recursive: true });
}

function filePath(name) {
  return path.join(dataDir, name);
}

function readJson(name, fallback) {
  try {
    const raw = fs.readFileSync(filePath(name), "utf8");
    return JSON.parse(raw);
  } catch (err) {
    // ENOENT (fresh install, file never written yet) is expected — falling
    // back to the caller's default shape is correct there. Anything else
    // (corrupt JSON, permission error) silently returning the empty default
    // would look exactly like "this KB/source/event list is legitimately
    // empty" — the opposite of true — so it must be logged.
    if (err && err.code === "ENOENT") log.debug(`${name} does not exist yet — using default`);
    else log.error(`failed to read/parse ${filePath(name)} — falling back to default (existing data may be masked)`, err);
    return fallback;
  }
}

function writeJsonAtomic(name, value) {
  const target = filePath(name);
  const tmp = `${target}.${process.pid}.${Date.now()}.tmp`;
  fs.writeFileSync(tmp, JSON.stringify(value, null, 2));
  fs.renameSync(tmp, target);
}

// A tiny in-process mutex per file name — every mutation here is a
// read-modify-write against a JSON file; without this, two IPC/HTTP requests
// arriving back-to-back (e.g. two sources finishing ingestion at once) could
// race and silently drop one's write.
const locks = new Map();
function withLock(name, fn) {
  const prev = locks.get(name) || Promise.resolve();
  const next = prev.then(fn, fn).finally(() => {
    if (locks.get(name) === next) locks.delete(name);
  });
  locks.set(name, next);
  return next;
}

function newId(prefix) {
  return `${prefix}_${crypto.randomBytes(9).toString("hex")}`;
}

function nowIso() {
  return new Date().toISOString();
}

// ---------------------------------------------------------------------------
// Knowledge bases
// ---------------------------------------------------------------------------

function loadKbs() {
  const parsed = readJson("kbs.json", { kbs: [] });
  const list = Array.isArray(parsed) ? parsed : Array.isArray(parsed.kbs) ? parsed.kbs : [];
  return list;
}

function saveKbs(list) {
  writeJsonAtomic("kbs.json", { kbs: list });
}

function listKbs() {
  return loadKbs();
}

function getKb(id) {
  return loadKbs().find((kb) => kb.id === id) || null;
}

function createKb({ name, description }) {
  return withLock("kbs.json", () => {
    const trimmed = (name || "").trim();
    if (!trimmed) throw new Error("name is required");
    const list = loadKbs();
    if (list.some((kb) => kb.name.toLowerCase() === trimmed.toLowerCase())) {
      throw new Error(`a knowledge base named "${trimmed}" already exists`);
    }
    const kb = {
      id: newId("kb"),
      name: trimmed,
      description: (description || "").trim(),
      createdAt: nowIso(),
      updatedAt: nowIso(),
    };
    list.push(kb);
    saveKbs(list);
    return kb;
  });
}

function renameKb(id, { name, description }) {
  return withLock("kbs.json", () => {
    const list = loadKbs();
    const kb = list.find((k) => k.id === id);
    if (!kb) throw new Error("knowledge base not found");
    if (typeof name === "string" && name.trim()) kb.name = name.trim();
    if (typeof description === "string") kb.description = description.trim();
    kb.updatedAt = nowIso();
    saveKbs(list);
    return kb;
  });
}

function deleteKb(id) {
  return withLock("kbs.json", () => {
    const list = loadKbs();
    const next = list.filter((k) => k.id !== id);
    if (next.length === list.length) throw new Error("knowledge base not found");
    saveKbs(next);
  });
}

// ---------------------------------------------------------------------------
// Sources
// ---------------------------------------------------------------------------

function loadSources() {
  const parsed = readJson("sources.json", { sources: [] });
  return Array.isArray(parsed.sources) ? parsed.sources : [];
}

function saveSources(list) {
  writeJsonAtomic("sources.json", { sources: list });
}

function listSources(kbId) {
  const all = loadSources();
  return kbId ? all.filter((s) => s.kbId === kbId) : all;
}

function getSource(id) {
  return loadSources().find((s) => s.id === id) || null;
}

// status: "pending" | "indexing" | "crawling" | "connecting" | "indexed" | "failed" | "needs_reauth"
function createSource({ kbId, type, name, reference, extra }) {
  return withLock("sources.json", () => {
    const list = loadSources();
    const source = {
      id: newId("src"),
      kbId,
      type,
      name,
      reference,
      status: "pending",
      statusMessage: null,
      stats: { episodes: 0, itemsTotal: null, itemsDone: 0, sizeBytes: 0 },
      lastSyncedAt: null,
      createdAt: nowIso(),
      updatedAt: nowIso(),
      extra: extra || {},
    };
    list.push(source);
    saveSources(list);
    return source;
  });
}

function updateSource(id, patch) {
  return withLock("sources.json", () => {
    const list = loadSources();
    const source = list.find((s) => s.id === id);
    if (!source) return null;
    // `stats` is merged, not replaced — pull it out before Object.assign so
    // a partial stats patch (e.g. just itemsDone during progress) can't
    // clobber fields set by an earlier patch (e.g. itemsTotal).
    const { stats: statsPatch, ...rest } = patch;
    Object.assign(source, rest, { updatedAt: nowIso() });
    if (statsPatch) source.stats = { ...source.stats, ...statsPatch };
    saveSources(list);
    return source;
  });
}

function deleteSource(id) {
  return withLock("sources.json", () => {
    const list = loadSources();
    const next = list.filter((s) => s.id !== id);
    saveSources(next);
  });
}

function deleteSourcesForKb(kbId) {
  return withLock("sources.json", () => {
    const list = loadSources();
    const next = list.filter((s) => s.kbId !== kbId);
    saveSources(next);
  });
}

// ---------------------------------------------------------------------------
// Health events — the Health tab's timeline (per-KB, most-recent-first).
// ---------------------------------------------------------------------------

function loadEvents() {
  const parsed = readJson("events.json", { events: [] });
  return Array.isArray(parsed.events) ? parsed.events : [];
}

function saveEvents(list) {
  writeJsonAtomic("events.json", { events: list });
}

function addEvent({ kbId, sourceId, level, title, message }) {
  return withLock("events.json", () => {
    const list = loadEvents();
    list.unshift({
      id: newId("evt"),
      kbId,
      sourceId: sourceId || null,
      level, // "info" | "success" | "warn" | "error"
      title,
      message: message || "",
      at: nowIso(),
    });
    // Bounded — this is a rolling health timeline, not an audit log.
    const trimmed = list.slice(0, 500);
    saveEvents(trimmed);
    return trimmed[0];
  });
}

function listEvents(kbId) {
  const all = loadEvents();
  return kbId ? all.filter((e) => e.kbId === kbId) : all;
}

function deleteEventsForKb(kbId) {
  return withLock("events.json", () => {
    const list = loadEvents();
    saveEvents(list.filter((e) => e.kbId !== kbId));
  });
}

// ---------------------------------------------------------------------------
// Content-hash dedupe registry (FR-008) — SHA-256 of extracted text, scoped
// per KB (the same document in two different KBs is not a duplicate; each KB
// is an independent Graphiti group/index).
// ---------------------------------------------------------------------------

function hashText(text) {
  return crypto.createHash("sha256").update(text, "utf8").digest("hex");
}

function loadHashes() {
  return readJson("hashes.json", {});
}

function saveHashesRaw(map) {
  writeJsonAtomic("hashes.json", map);
}

/** Returns the existing registry entry for (kbId, hash) or null. */
function findHash(kbId, hash) {
  const map = loadHashes();
  const bucket = map[kbId] || {};
  return bucket[hash] || null;
}

/** Records that `hash` (from `sourceId`) is now indexed as `episodeIds` under
 *  `kbId`. Idempotent — re-registering the same hash just refreshes it. */
function registerHash(kbId, hash, { sourceId, episodeIds }) {
  return withLock("hashes.json", () => {
    const map = loadHashes();
    if (!map[kbId]) map[kbId] = {};
    map[kbId][hash] = { sourceId, episodeIds, indexedAt: nowIso() };
    saveHashesRaw(map);
  });
}

function forgetHashesForSource(kbId, sourceId) {
  return withLock("hashes.json", () => {
    const map = loadHashes();
    const bucket = map[kbId];
    if (!bucket) return;
    for (const hash of Object.keys(bucket)) {
      if (bucket[hash].sourceId === sourceId) delete bucket[hash];
    }
    saveHashesRaw(map);
  });
}

function forgetHashesForKb(kbId) {
  return withLock("hashes.json", () => {
    const map = loadHashes();
    delete map[kbId];
    saveHashesRaw(map);
  });
}

module.exports = {
  init,
  newId,
  nowIso,
  listKbs,
  getKb,
  createKb,
  renameKb,
  deleteKb,
  listSources,
  getSource,
  createSource,
  updateSource,
  deleteSource,
  deleteSourcesForKb,
  addEvent,
  listEvents,
  deleteEventsForKb,
  hashText,
  findHash,
  registerHash,
  forgetHashesForSource,
  forgetHashesForKb,
};
