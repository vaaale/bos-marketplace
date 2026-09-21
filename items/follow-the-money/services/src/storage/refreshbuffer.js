"use strict";
// Per-attempt refresh event buffer (Refresh Console observability layer).
//
// Holds the in-memory ring of the CURRENT (or most recent completed) refresh's
// events, one event per fetch ATTEMPT. `seq` is monotonic within a refresh and
// is the tail cursor the app polls with (`?since=<seq>`). Counts (okCount /
// issueCount) always describe the whole current refresh, while `events` is the
// delta after `since` — the standard log-tail shape.
//
// The buffer is intentionally framework-free and stateless across refreshes:
// the caller resets it when a refresh starts. Persistence to data/refresh/
// log.jsonl is injected via `append` (best-effort; a persist failure must not
// break the refresh).

const MAX_EVENTS = 200;

// `append` persists one event; `onError` receives a cause string when a persist
// write fails (see push — the failure is logged, never silently discarded).
function createRefreshBuffer(append, onError) {
  let inProgress = false;
  let refreshId = null;
  let startedAt = null;
  let asOf = null;
  let seq = 0;
  const ring = []; // most recent refresh's events, oldest-first

  function reset(id, at) {
    inProgress = true;
    refreshId = id;
    startedAt = at;
    asOf = at;
    seq = 0;
    ring.length = 0;
  }

  function finish(at) {
    inProgress = false;
    if (at) asOf = at;
  }

  // `ev` carries { symbol, name, provider, status, detail, keyed?, probeEnabled? }.
  // Returns the stamped event (with seq + ts).
  function push(ev) {
    seq += 1;
    const event = Object.assign({}, ev, { seq, ts: new Date().toISOString() });
    ring.push(event);
    if (ring.length > MAX_EVENTS) ring.splice(0, ring.length - MAX_EVENTS);
    asOf = event.ts;
    if (typeof append === "function") {
      try {
        append(event);
      } catch (err) {
        // Deliberate containment, NOT a swallow: the in-memory ring is the
        // authoritative source for GET /api/refresh/log, so a persist failure
        // must not fail the refresh. Logged with its cause (via onError) so it
        // can't read as a silent success.
        if (typeof onError === "function") {
          onError("refresh-log persist failed: " + String((err && err.stack) || err));
        }
      }
    }
    return event;
  }

  // snapshot(since): `events` = ring entries with seq > since (whole ring when
  // since is undefined/0); counts always over the whole ring (the current refresh).
  function snapshot(since) {
    const threshold = since === undefined || since === null ? 0 : since;
    const events = ring.filter((e) => e.seq > threshold);
    let okCount = 0;
    let issueCount = 0;
    for (const e of ring) {
      if (e.status === "ok") okCount += 1;
      else issueCount += 1;
    }
    return {
      inProgress,
      refreshId,
      startedAt,
      asOf,
      okCount,
      issueCount,
      events
    };
  }

  return { reset, finish, push, snapshot, MAX_EVENTS };
}

module.exports = { createRefreshBuffer, MAX_EVENTS };
