"use strict";

// Ingestion pipeline orchestration (design.md §5): acquire -> extract ->
// chunk -> content-hash de-dup -> add_episode -> journal (source status)
// update. Runs a small bounded queue so large sources never block the config
// UI (FR-011 edge case) and multiple sources can index concurrently, matching
// the mockup's several simultaneously-"Indexing"/"Crawling" source cards.

const extract = require("./extract");
const { chunkText } = require("./chunk");
const state = require("./state");
const dedupe = require("./dedupe");
const graphiti = require("./graphiti");
const uploadSource = require("./sources/upload");
const websiteSource = require("./sources/website");
const driveSource = require("./sources/drive");
const folderSource = require("./sources/folder");
const log = require("./log");

const ACQUIRERS = { upload: uploadSource, website: websiteSource, drive: driveSource, folder: folderSource };

// Distinguishes "add_memory's HTTP round trip itself failed" (connection
// refused, MCP error, etc. — surfaced as "Graphiti unavailable: ...") from
// "add_memory was accepted and queued, but the episode never verifiably
// showed up in get_episodes within the verification window" (surfaced with
// its own actionable message — see ingestOneItem). Both are real ingestion
// failures; only the message differs.
class VerificationTimeoutError extends Error {}

const MAX_CONCURRENT_JOBS = 2;
const queue = [];
let running = 0;
// Sources currently in-flight — used so "delete source while indexing"
// cancels/ignores the in-flight job (spec edge case: "deletion wins").
const cancelled = new Set();

function pump() {
  while (running < MAX_CONCURRENT_JOBS && queue.length > 0) {
    const sourceId = queue.shift();
    running++;
    // runJob() already catches every error it knows how to attribute to a
    // step (acquire, extract, add_episode) and turns it into a "failed"
    // source + health event. This catch is the last resort for anything
    // else — a bug in runJob itself, a rejected state.* write, etc. Without
    // logging here, that class of failure vanishes completely: no failed
    // status, no health event, no trace anywhere (this is the "catch-all
    // that swallows errors without logging" the no-logging report pointed
    // at) — the source just sits stuck at its in-progress status forever.
    runJob(sourceId)
      .catch((err) => log.error(`unhandled error running ingestion job for source "${sourceId}"`, err))
      .finally(() => {
        running--;
        pump();
      });
  }
}

function enqueue(sourceId) {
  if (queue.includes(sourceId)) {
    log.debug(`source "${sourceId}" already queued — ignoring duplicate enqueue`);
    return;
  }
  log.debug(`enqueuing source "${sourceId}"`, { queueLength: queue.length + 1, running });
  queue.push(sourceId);
  pump();
}

function cancel(sourceId) {
  log.debug(`cancelling source "${sourceId}"`);
  cancelled.add(sourceId);
  const idx = queue.indexOf(sourceId);
  if (idx !== -1) queue.splice(idx, 1);
}

function isCancelled(sourceId) {
  return cancelled.has(sourceId);
}

// The configured verification window (graphiti.js's currentVerifyTimeoutMs,
// set via config/config.html's Connection settings) is sized for one job's
// expected latency. It isn't the whole story once MAX_CONCURRENT_JOBS jobs
// are actually running together: they share the same Graphiti MCP server
// and, behind it, the same LLM backend for entity extraction/embedding, so a
// second job in flight can plausibly double how long any one episode takes
// to land. Scale the configured window by how many jobs are running *right
// now* — capped at MAX_CONCURRENT_JOBS by construction, since `running`
// never exceeds it (see pump()).
function verifyTimeoutMs() {
  return graphiti.currentVerifyTimeoutMs() * Math.max(1, running);
}

function inProgressStatus(type) {
  return type === "website" ? "crawling" : type === "drive" ? "connecting" : "indexing";
}

async function ingestOneItem(kbId, source, item) {
  let text;
  try {
    // Google Drive's plain-text exports (Docs → text/plain, Sheets → CSV)
    // arrive already-decoded and don't need format dispatch by extension —
    // everything else (uploads, website HTML, binary Drive files) does.
    text = item.alreadyText ? item.bytes.toString("utf8") : await extract.extractText(item.name, item.bytes);
  } catch (err) {
    log.warn(`text extraction failed for "${item.name}" (source ${source.id})`, err && err.message);
    return { ok: false, sourceRef: item.sourceRef, name: item.name, error: (err && err.message) || String(err) };
  }
  log.debug(`extracted text for "${item.name}" (source ${source.id})`, { chars: text.length });

  const chunks = chunkText(text);
  log.debug(`chunked "${item.name}" (source ${source.id}) into ${chunks.length} episode(s)`);
  const episodeIds = [];
  let usedDedupe = false;

  // Everything past extraction (chunking, dedupe, the Graphiti round trip,
  // and the post-queue verification poll) can fail for reasons that have
  // nothing to do with the document itself — the MCP endpoint unreachable,
  // misconfigured, or its embeddings backend broken so queued episodes never
  // land (FR-011 edge case: "ingestion retries/backlogs"). Without this
  // try/catch, a rejected call propagates uncaught out of runJob's loop and
  // the source is silently stuck "indexing" forever with no error surfaced.
  try {
    for (let i = 0; i < chunks.length; i++) {
      const chunkBody = chunks[i];
      const { isDuplicate, hash, existing } = dedupe.check(kbId, chunkBody);
      if (isDuplicate) {
        usedDedupe = true;
        episodeIds.push(...((existing && existing.episodeIds) || []));
        log.debug(`chunk ${i + 1}/${chunks.length} of "${item.name}" is a dedupe hit — skipping add_memory`, { hash });
        continue;
      }
      const episodeName = chunks.length > 1 ? `${item.name} (part ${i + 1}/${chunks.length})` : item.name;
      const sourceDescription = item.sourceRef || source.reference;
      await graphiti.addEpisode({
        kbId,
        name: episodeName,
        episodeBody: chunkBody,
        // Graphiti's add_memory `source` is NOT the BOS source type (upload/
        // website/drive) — its live inputSchema only recognizes 'text',
        // 'json', or 'message' (verified against
        // http://wingman.akhbar.lan:5051/mcp's tools/list on 2026-08-06).
        // Passing 'upload' silently fell back to 'text' server-side but
        // broke episode processing ("node ... not found") because the
        // fallback happens after argument validation has already gone
        // wrong. extract.extractText (and Drive's alreadyText path) always
        // hands us plain text here, never JSON or chat-message content, so
        // 'text' is the only correct value regardless of source.type or the
        // original file extension.
        source: "text",
        sourceDescription,
        referenceTime: item.referenceTime,
      });

      // The queued acknowledgement above is NOT confirmation the episode
      // exists in Graphiti, and it carries no episode id (add_memory is
      // fire-and-forget — see graphiti.addEpisode's own comment). Only a
      // positive get_episodes hit, matched by the name we chose above, both
      // confirms it landed AND tells us its real Graphiti-assigned uuid.
      log.debug(`verifying episode "${episodeName}" actually landed in Graphiti group "${kbId}"`);
      const verification = await graphiti.waitForEpisode({ kbId, name: episodeName, sourceDescription, timeoutMs: verifyTimeoutMs() });
      if (!verification.landed) {
        // Deliberately does NOT diagnose a cause (e.g. "embeddings backend
        // broken") — waitForEpisode only knows the episode never showed up
        // in get_episodes within its window; it never inspected Graphiti's
        // queue, LLM calls, or embeddings status, so asserting a specific
        // culprit here would be a guess dressed up as a finding (the exact
        // bug this replaced — see graphiti.js's DEFAULT_VERIFY_TIMEOUT_MS
        // comment). It may simply still be processing.
        throw new VerificationTimeoutError(
          `Episode "${episodeName}" was queued in Graphiti but wasn't confirmed landed after ${verification.attempts} check(s) over ${Math.round(verification.elapsedMs / 1000)}s. It may still be processing (entity extraction + embedding can take a while) — check ${graphiti.currentEndpoint()} and its logs, then Retry once it's had time to finish.`,
        );
      }
      const episodeId = verification.uuid;
      if (!episodeId) {
        throw new Error(`Episode "${episodeName}" landed in Graphiti but get_episodes returned no uuid/episode_uuid/id for it`);
      }
      log.debug(`episode "${episodeName}" (uuid ${episodeId}) verified landed in Graphiti`, {
        attempts: verification.attempts,
        elapsedMs: verification.elapsedMs,
      });

      episodeIds.push(episodeId);
      await dedupe.register(kbId, hash, source.id, [episodeId]);
    }
  } catch (err) {
    const message = err instanceof VerificationTimeoutError ? err.message : `Graphiti unavailable: ${(err && err.message) || String(err)}`;
    log.error(`ingestion failed for "${item.name}" (source ${source.id})`, err);
    return { ok: false, sourceRef: item.sourceRef, name: item.name, error: message };
  }

  log.debug(`"${item.name}" (source ${source.id}) fully ingested and verified`, { episodes: episodeIds.length, deduped: usedDedupe });
  return {
    ok: true,
    sourceRef: item.sourceRef,
    name: item.name,
    episodeIds,
    chunkCount: chunks.length,
    bytes: item.bytes.length,
    deduped: usedDedupe,
  };
}

async function runJob(sourceId) {
  cancelled.delete(sourceId);
  const source = state.getSource(sourceId);
  if (!source) return;
  const acquirer = ACQUIRERS[source.type];
  if (!acquirer) return;

  log.debug(`acquiring source "${source.name}" (${sourceId}, type ${source.type})`, { reference: source.reference });
  state.updateSource(sourceId, { status: inProgressStatus(source.type), statusMessage: null });

  let acquired;
  try {
    acquired = await acquirer.acquire(source, {
      onProgress: ({ done, total }) => {
        if (isCancelled(sourceId)) return;
        state.updateSource(sourceId, { stats: { itemsTotal: total, itemsDone: done } });
      },
    });
    log.debug(`acquired source "${source.name}" (${sourceId})`, { items: acquired.items.length, notes: (acquired.notes || []).length });
  } catch (err) {
    if (isCancelled(sourceId)) return;
    const message = (err && err.message) || String(err);
    log.error(`acquire failed for source "${source.name}" (${sourceId})`, err);
    state.updateSource(sourceId, { status: "failed", statusMessage: message });
    state.addEvent({ kbId: source.kbId, sourceId, level: "error", title: `${source.name} failed`, message });
    return;
  }

  if (isCancelled(sourceId)) return; // deletion wins — drop results silently

  const previousRefs = Object.keys((source.extra && source.extra.itemIndex) || {});
  const itemIndex = { ...(source.extra && source.extra.itemIndex) };
  const seenRefs = new Set();
  let episodeCount = 0;
  let sizeBytes = 0;
  const failures = [];

  for (const item of acquired.items) {
    if (isCancelled(sourceId)) return;
    const result = await ingestOneItem(source.kbId, source, item);
    if (result.ok) {
      seenRefs.add(result.sourceRef);
      itemIndex[result.sourceRef] = { name: result.name, episodeIds: result.episodeIds };
      episodeCount += result.episodeIds.length;
      sizeBytes += result.bytes;
    } else {
      failures.push(result);
    }
  }

  // Refresh (FR-010): de-index items that disappeared since the last run —
  // present in the old itemIndex but not seen this time.
  const removedRefs = previousRefs.filter((ref) => !seenRefs.has(ref));
  for (const ref of removedRefs) {
    const entry = itemIndex[ref];
    delete itemIndex[ref];
    if (entry) {
      for (const episodeId of entry.episodeIds || []) {
        await graphiti
          .deleteEpisode({ episodeUuid: episodeId })
          .catch((err) => log.warn(`failed to delete stale episode ${episodeId} for source "${sourceId}"`, err && err.message));
      }
    }
  }
  if (removedRefs.length > 0) dedupe.forgetSource(source.kbId, sourceId);

  const acquireNotes = acquired.notes || [];
  const addedCount = Array.from(seenRefs).filter((ref) => !previousRefs.includes(ref)).length;

  // Every acquired item failed to ingest — this is a total ingestion
  // failure (bad extraction, or Graphiti unreachable/misconfigured/broken
  // for the whole batch), not a partial sync. Marking "indexed" here is
  // exactly the bug this pipeline used to have: a source that looks
  // successful because add_memory's queued ack came back, while nothing
  // ever actually landed in Graphiti. An upload source is always exactly
  // one item, so this also covers the single-file case (title kept as
  // "failed to extract" there to match the mockup's wording).
  if (failures.length > 0 && failures.length === acquired.items.length) {
    const title = source.type === "upload" ? `${source.name} failed to extract` : `${source.name} failed`;
    log.warn(`source "${source.name}" (${sourceId}) — all ${failures.length} item(s) failed to ingest`, failures[0].error);
    state.updateSource(sourceId, { status: "failed", statusMessage: failures[0].error });
    state.addEvent({ kbId: source.kbId, sourceId, level: "error", title, message: failures[0].error });
    return;
  }

  log.info(`source "${source.name}" (${sourceId}) indexed`, {
    items: acquired.items.length,
    episodes: episodeCount,
    failures: failures.length,
  });

  state.updateSource(sourceId, {
    status: "indexed",
    statusMessage: null,
    lastSyncedAt: state.nowIso(),
    stats: {
      episodes: episodeCount,
      itemsTotal: acquired.items.length,
      itemsDone: acquired.items.length,
      sizeBytes,
    },
    extra: { ...source.extra, itemIndex },
  });

  state.addEvent({
    kbId: source.kbId,
    sourceId,
    level: failures.length > 0 || acquireNotes.length > 0 ? "warn" : "success",
    title: `${source.name} synced`,
    message: describeSync(source, acquired, failures, acquireNotes, addedCount, removedRefs.length),
  });
}

function describeSync(source, acquired, failures, notes, added, removed) {
  const parts = [`${acquired.items.length} item(s) indexed`];
  if (added > 0) parts.push(`${added} added`);
  if (removed > 0) parts.push(`${removed} removed`);
  if (failures.length > 0) parts.push(`${failures.length} failed`);
  if (notes.length > 0) parts.push(`${notes.length} skipped`);
  return parts.join(" · ") + " since last refresh.";
}

async function retry(sourceId) {
  enqueue(sourceId);
}

module.exports = { enqueue, cancel, retry };
