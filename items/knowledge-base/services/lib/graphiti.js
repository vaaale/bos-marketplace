"use strict";

// MCP client for the user's externally-deployed (Dokploy) Graphiti MCP
// server (design.md §5.6, ADR-4). The endpoint is user-configurable (FR-014)
// — read fresh from the service's own BOS-managed config file on every call
// (never cached across calls beyond the current connection), so a change
// made in the config UI (which PATCHes that same file via BOS's generic
// `/api/services/<id>/config` route) takes effect on the very next call,
// with no restart/reinstall.
//
// Graphiti groups map 1:1 to knowledge bases (a hard per-KB partition in the
// user's FalkorDB) — every call below takes a KB id and passes it through as
// `group_id`.

const fs = require("fs");
const path = require("path");
const { Client } = require("@modelcontextprotocol/sdk/client/index.js");
const { StreamableHTTPClientTransport } = require("@modelcontextprotocol/sdk/client/streamableHttp.js");
const log = require("./log");

let configDirPath = null;
let serviceId = null;

function init(dirPath, id) {
  configDirPath = dirPath;
  serviceId = id;
}

function currentEndpoint() {
  try {
    const raw = fs.readFileSync(path.join(configDirPath, `${serviceId}.json`), "utf8");
    const parsed = JSON.parse(raw);
    if (typeof parsed.graphitiEndpoint === "string" && parsed.graphitiEndpoint.trim()) {
      return parsed.graphitiEndpoint.trim();
    }
  } catch (err) {
    // ENOENT (no config file yet, e.g. fresh install before first save) is
    // expected — still logged, at debug level, so it's visible when tracing
    // why a call used the default endpoint. Anything else (corrupt JSON,
    // permission error) is a real problem masking a silent fallback to the
    // default endpoint, so it's logged at warn.
    if (err && err.code === "ENOENT") log.debug("no config file yet — using default Graphiti endpoint");
    else log.warn("failed to read graphitiEndpoint from config — using default", err && err.message);
  }
  return "http://127.0.0.1:8020/mcp/";
}

/** Reads the operator-configured episode verification window (seconds, the
 *  unit the config page exposes) from the same per-service config file as
 *  currentEndpoint(), fresh on every call for the same reason — a change
 *  saved in the config UI must take effect on the very next verification
 *  poll, no restart. Falls back to DEFAULT_VERIFY_TIMEOUT_MS when the config
 *  file is missing (fresh install) or the value isn't a positive number. */
function currentVerifyTimeoutMs() {
  try {
    const raw = fs.readFileSync(path.join(configDirPath, `${serviceId}.json`), "utf8");
    const parsed = JSON.parse(raw);
    const seconds = Number(parsed.episodeVerifyTimeoutSeconds);
    if (Number.isFinite(seconds) && seconds > 0) return seconds * 1000;
  } catch (err) {
    if (err && err.code === "ENOENT") log.debug("no config file yet — using default verify timeout");
    else log.warn("failed to read episodeVerifyTimeoutSeconds from config — using default", err && err.message);
  }
  return DEFAULT_VERIFY_TIMEOUT_MS;
}

let cached = null; // { endpoint, client }
let connecting = null; // in-flight connect promise, so concurrent callers share one session

async function getClient(opts) {
  const endpoint = currentEndpoint();
  const forceReconnect = (opts && opts.forceReconnect) || false;

  if (!forceReconnect && cached && cached.endpoint === endpoint && cached.client) return cached.client;
  if (connecting) return connecting;

  // Endpoint changed, first call, or the server dropped our session — drop
  // any previous connection and reconnect. Best-effort close; a dead/
  // unreachable old server shouldn't block picking up the new one.
  if (cached && cached.client) {
    cached.client.close().catch((err) => log.warn("failed to close stale Graphiti client", err.message));
    cached = null;
  }

  log.debug(`connecting to Graphiti MCP endpoint ${endpoint}`, { forceReconnect });
  connecting = (async () => {
    const client = new Client({ name: "browseros-knowledge-base", version: "1.0.0" }, { capabilities: {} });
    const transport = new StreamableHTTPClientTransport(new URL(endpoint));
    await client.connect(transport);
    cached = { endpoint, client };
    log.info(`connected to Graphiti MCP endpoint ${endpoint}`);
    return client;
  })();
  try {
    return await connecting;
  } catch (err) {
    log.error(`failed to connect to Graphiti MCP endpoint ${endpoint}`, err);
    throw err;
  } finally {
    connecting = null;
  }
}

/** The Graphiti MCP server's Streamable HTTP session can go away server-side
 *  (restart, idle timeout) while our cached client still believes it's
 *  connected — every call would otherwise fail identically forever with
 *  "Session not found" until the process restarts. Reconnect once and retry
 *  when that happens. */
function isSessionLostError(err) {
  return /session\s*(not\s*found|expired|invalid)/i.test((err && err.message) || "");
}

async function runTool(client, name, args) {
  const result = await client.callTool({ name, arguments: args || {} });
  if (result && result.isError) {
    const text = (result.content || []).map((c) => c.text).filter(Boolean).join("\n");
    throw new Error(text || `Graphiti tool "${name}" returned an error`);
  }
  return result;
}

async function callTool(name, args) {
  const endpoint = currentEndpoint();
  log.debug(`calling Graphiti tool "${name}"`, { endpoint, args });
  const client = await getClient();
  try {
    const result = await runTool(client, name, args);
    log.debug(`Graphiti tool "${name}" returned`, { endpoint, result: textOf(result) });
    return result;
  } catch (err) {
    if (!isSessionLostError(err)) {
      log.warn(`Graphiti tool "${name}" failed`, { endpoint, error: err && err.message });
      throw err;
    }
    log.warn(`Graphiti session lost calling "${name}" — reconnecting and retrying once`, { endpoint });
    const fresh = await getClient({ forceReconnect: true });
    return await runTool(fresh, name, args);
  }
}

/** Extracts the plain-text content items from an MCP tool result; Graphiti's
 *  own tools return either a single text block (often JSON-encoded) or a
 *  list of them. Callers that expect structured data parse the joined text
 *  as JSON; callers that just want passage text use it directly. */
function textOf(result) {
  return (result && result.content ? result.content : [])
    .filter((c) => c.type === "text" && typeof c.text === "string")
    .map((c) => c.text)
    .join("\n");
}

/** `context` is only used for the debug log on a parse miss — many of
 *  Graphiti's own responses are plain confirmation text, not JSON, so a miss
 *  isn't itself an error; callers that need structured data handle a `null`
 *  return. Silently returning null with no trace at all is exactly the kind
 *  of swallow that made the fire-and-forget bug invisible for so long. */
function tryParseJson(text, context) {
  try {
    return JSON.parse(text);
  } catch (err) {
    log.debug(`Graphiti response for ${context || "call"} was not JSON`, { text, error: err.message });
    return null;
  }
}

async function getStatus() {
  const result = await callTool("get_status", {});
  return tryParseJson(textOf(result), "get_status") || { text: textOf(result) };
}

/** Pushes one episode into the KB's Graphiti group. `referenceTime` should be
 *  an ISO-8601 string (document last-modified, or crawl time) so Graphiti's
 *  temporal ordering is meaningful (design.md §5.3).
 *
 *  The MCP tool that does this is named `add_memory` (not `add_episode`) in
 *  the actual getzep/graphiti mcp_server tool contract — `add_episode` 404s
 *  as an unknown tool against a real deployment. Verified live against
 *  http://wingman.akhbar.lan:5051/mcp (2026-08-06): the
 *  `group_id`/`name`/`episode_body`/`source`/`source_description`/
 *  `reference_time` argument shape matches add_memory's signature.
 *
 *  Do NOT send a client-generated `uuid` here for a new episode (an earlier
 *  version of this function did, via `crypto.randomUUID()`, to work around
 *  add_memory's fire-and-forget response below). `add_memory`'s inputSchema
 *  does accept an optional `uuid`, but graphiti_core's `add_episode` treats
 *  any non-null `uuid` as "this episode already exists" and looks it up via
 *  `EpisodicNode.get_by_uuid(driver, uuid)` instead of creating a new node.
 *  For a uuid the server has never seen, that lookup raises inside the async
 *  queue worker — exactly the live bug report: `queue_service - ERROR -
 *  Failed to process episode <uuid> for group <group_id>: node <uuid> not
 *  found`. Every episode was failing queue processing this way. The real
 *  uuid can only be learned after the fact, by matching on `name` via
 *  `waitForEpisode` below.
 *
 *  `add_memory` is fire-and-forget — its own docstring says so ("returns
 *  immediately and processes the episode addition in the background") and
 *  confirmed live: the response is only
 *  `{ message: "Episode '<name>' queued for processing in group '<id>'" }`,
 *  never an episode id. */
async function addEpisode({ kbId, name, episodeBody, source, sourceDescription, referenceTime }) {
  const args = {
    group_id: kbId,
    name,
    episode_body: episodeBody,
    source: source || "text",
    source_description: sourceDescription || "",
    reference_time: referenceTime || new Date().toISOString(),
  };
  log.debug(`add_memory: queuing episode "${name}" for group "${kbId}"`, {
    endpoint: currentEndpoint(),
    bodyChars: episodeBody.length,
  });
  const result = await callTool("add_memory", args);
  const parsed = tryParseJson(textOf(result), "add_memory") || { text: textOf(result) };
  log.debug(`add_memory: queued acknowledgement for "${name}"`, parsed);
  return parsed;
}

async function searchNodes({ kbId, query, limit }) {
  const result = await callTool("search_nodes", { group_ids: [kbId], query, max_nodes: limit || 10 });
  const parsed = tryParseJson(textOf(result), "search_nodes");
  return Array.isArray(parsed) ? parsed : Array.isArray(parsed && parsed.nodes) ? parsed.nodes : [];
}

async function searchMemoryFacts({ kbId, query, limit }) {
  const result = await callTool("search_memory_facts", { group_ids: [kbId], query, max_facts: limit || 10 });
  const parsed = tryParseJson(textOf(result), "search_memory_facts");
  return Array.isArray(parsed) ? parsed : Array.isArray(parsed && parsed.facts) ? parsed.facts : [];
}

/** Reconstructs passage provenance for a set of episode UUIDs (design.md
 *  §5.7/ADR-5 — Graphiti's native retrieval returns entities/facts, not raw
 *  passages; we surface the underlying episode text as the "passage").
 *
 *  `get_episodes`' real inputSchema (verified live) takes `group_ids` (a
 *  list) and `max_episodes` — not the `group_id`/`reference_time`/`last_n`
 *  this used to send, which the live server simply ignored/rejected. */
async function getEpisodes({ kbId, lastN }) {
  const result = await callTool("get_episodes", {
    group_ids: [kbId],
    max_episodes: lastN || 20,
  });
  const parsed = tryParseJson(textOf(result), "get_episodes");
  return Array.isArray(parsed) ? parsed : Array.isArray(parsed && parsed.episodes) ? parsed.episodes : [];
}

function episodeUuidOf(episode) {
  return episode && (episode.uuid || episode.episode_uuid || episode.id);
}

/** `name` is the only identifier we control end-to-end (we chose it before
 *  calling add_memory); `sourceDescription`, when given, narrows further in
 *  case two items ever share a name. Neither `uuid` nor `episode_uuid` is
 *  ours to match on here — those are assigned by Graphiti itself and are
 *  exactly what we're trying to discover. */
function episodeMatches(episode, name, sourceDescription) {
  if (!episode || episode.name !== name) return false;
  return sourceDescription == null || episode.source_description === sourceDescription;
}

// add_memory is fire-and-forget (see addEpisode above) — Graphiti does the
// actual LLM entity extraction, embedding, and graph write asynchronously
// after the queued acknowledgement returns, and never hands back an episode
// id. These bound how long we poll get_episodes for a just-queued episode
// (matched by name, the only identifier we control — see episodeMatches)
// before giving up and reporting it as NOT verifiably landed. Quality-first
// (spec Q3): we'd rather block an ingestion job a bounded amount of time
// than mark a source "indexed" on faith.
//
// (Bug history, 038 round 2) An earlier 20s timeout was too short and a
// false-negative machine: per design.md §5 the episode isn't visible via
// get_episodes until graphiti_core's queue worker finishes BOTH of its LLM
// round trips (structured-output entity/edge extraction, then embedding),
// each proxied through BOS's `/api/llm/openai/[...path]` to whatever
// provider the user configured — routinely well over 20s under real
// providers/rate limits, and worse with MAX_CONCURRENT_JOBS (pipeline.js)
// contending for the same LLM. The episode was landing every time, just
// after this function had already given up and reported `landed: false`,
// which ingestOneItem then reported as a `failed` source blaming "the
// Graphiti server and its embeddings backend" — a guess baked into the
// message text, not anything actually checked. Raised to a window generous
// enough for that real-world latency; see ingestOneItem's
// VerificationTimeoutError message for the corresponding wording fix (it no
// longer asserts a diagnosis this function never made).
//
// (Bug history, 038 round 3) Even ~2min was still too short against a real
// multi-part ingestion (a large PDF chunked into 21 episodes) hitting a live
// Graphiti deployment — part 2/21 alone timed out. Raised the default again
// and, since a fixed constant can never be right for every deployment's LLM
// latency, made it configurable (see currentVerifyTimeoutMs below) — the
// config page (config/config.html's Connection settings) writes
// `episodeVerifyTimeoutSeconds` to this same per-service config file that
// currentEndpoint() already reads, so operators can raise it further without
// a code change once they've observed their own deployment's real latency.
const DEFAULT_VERIFY_TIMEOUT_MS = 300000; // 5 minutes
const DEFAULT_VERIFY_POLL_INTERVAL_MS = 2000;
// How many of the group's most-recent episodes to scan per poll — generous
// enough to find a just-queued episode even if several sources are
// ingesting into the same KB concurrently (MAX_CONCURRENT_JOBS in
// pipeline.js), without pulling the group's entire history every poll.
const VERIFY_SCAN_WINDOW = 50;

/** Polls `get_episodes` until an episode matching `name` (and, if given,
 *  `sourceDescription`) shows up, or `timeoutMs` elapses, then returns its
 *  real Graphiti-assigned uuid. This is the ONLY way to know whether a
 *  queued `add_memory` call ever actually landed, and the ONLY way to learn
 *  its uuid — add_memory's own response never carries either.
 *
 *  Do NOT match (or generate) a client-side uuid here: passing one to
 *  `add_memory` makes graphiti_core's `add_episode` look up an *existing*
 *  node by that uuid instead of creating a new one, which is exactly the
 *  `node <uuid> not found` bug this function's name-based matching replaces
 *  (see addEpisode's comment).
 *
 *  Returns `{ landed, uuid, attempts, elapsedMs }`; never throws for "not
 *  found yet" (the expected non-landed case) or for a transient
 *  get_episodes error (logged and retried on the next poll) — only a bug in
 *  the polling loop itself would throw. */
async function waitForEpisode({ kbId, name, sourceDescription, timeoutMs, pollIntervalMs }) {
  const timeout = timeoutMs || currentVerifyTimeoutMs();
  const interval = pollIntervalMs || DEFAULT_VERIFY_POLL_INTERVAL_MS;
  const startedAt = Date.now();
  const deadline = startedAt + timeout;
  let attempts = 0;

  // eslint-disable-next-line no-constant-condition
  while (true) {
    attempts++;
    let episodes = [];
    try {
      episodes = await getEpisodes({ kbId, lastN: VERIFY_SCAN_WINDOW });
    } catch (err) {
      log.warn(`verify poll #${attempts} for episode "${name}" (group "${kbId}") failed to call get_episodes — will retry`, err && err.message);
    }
    const landedEpisode = episodes.find((ep) => episodeMatches(ep, name, sourceDescription));
    const elapsedMs = Date.now() - startedAt;
    log.debug(`verify poll #${attempts} for episode "${name}" (group "${kbId}"): ${landedEpisode ? "LANDED" : "not yet"}`, {
      elapsedMs,
      episodesScanned: episodes.length,
    });
    if (landedEpisode) return { landed: true, uuid: episodeUuidOf(landedEpisode), attempts, elapsedMs };
    if (Date.now() >= deadline) return { landed: false, uuid: null, attempts, elapsedMs };
    await new Promise((resolve) => setTimeout(resolve, interval));
  }
}

/** `delete_episode`'s real inputSchema (verified live) takes `uuid`, not
 *  `episode_uuid`. */
async function deleteEpisode({ episodeUuid }) {
  await callTool("delete_episode", { uuid: episodeUuid });
}

/** Deletion wins (spec edge case) — clears the whole group when a KB is
 *  deleted, cleaning up its Graphiti-side index (FR-012). `clear_graph`'s
 *  real inputSchema (verified live) takes `group_ids` (a list), not the
 *  singular `group_id` this used to send. */
async function clearGraph({ kbId }) {
  await callTool("clear_graph", { group_ids: [kbId] });
}

module.exports = {
  init,
  currentEndpoint,
  currentVerifyTimeoutMs,
  getStatus,
  addEpisode,
  waitForEpisode,
  searchNodes,
  searchMemoryFacts,
  getEpisodes,
  deleteEpisode,
  clearGraph,
};
