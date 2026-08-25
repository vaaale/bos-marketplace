"use strict";

// Content-hash de-dup (FR-008) — SHA-256 of the extracted text, scoped per KB.
// Thin policy layer over state.js's hash registry: state.js owns the on-disk
// bucket, this module owns the "is this a duplicate, and what do we do about
// it" decision so pipeline.js doesn't have to know the storage shape.

const state = require("./state");

/** Returns { isDuplicate, hash, existing } for a piece of extracted text
 *  within a KB. `existing` (when isDuplicate) is the registry entry recorded
 *  by the previous ingest of this exact content. */
function check(kbId, text) {
  const hash = state.hashText(text);
  const existing = state.findHash(kbId, hash);
  return { isDuplicate: !!existing, hash, existing };
}

/** Records that `hash` is now indexed as `episodeIds` for `sourceId` — makes
 *  re-adding the same content idempotent (skips add_episode next time). */
function register(kbId, hash, sourceId, episodeIds) {
  return state.registerHash(kbId, hash, { sourceId, episodeIds });
}

function forgetSource(kbId, sourceId) {
  return state.forgetHashesForSource(kbId, sourceId);
}

function forgetKb(kbId) {
  return state.forgetHashesForKb(kbId);
}

module.exports = { check, register, forgetSource, forgetKb };
