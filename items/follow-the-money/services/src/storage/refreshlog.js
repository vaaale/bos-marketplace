"use strict";
// Bounded append-only refresh log: data/refresh/log.jsonl — one RefreshRecord
// JSON line per provider-per-refresh, trimmed to the last 500 lines on append.

const fs = require("node:fs");
const path = require("node:path");
const store = require("./store.js");

const MAX_LINES = 500;

function logPath(dataDir) {
  return path.join(dataDir, "refresh", "log.jsonl");
}

function readLines(dataDir) {
  try {
    const text = fs.readFileSync(logPath(dataDir), "utf8");
    return text.split("\n").filter((l) => l.trim().length > 0);
  } catch (err) {
    return [];
  }
}

function appendRecord(dataDir, record) {
  const lines = readLines(dataDir);
  lines.push(JSON.stringify(record));
  const bounded = lines.slice(-MAX_LINES);
  store.writeText(logPath(dataDir), bounded.join("\n") + "\n");
}

// Append ONE per-attempt event line (Refresh Console). Shares the same file and
// the same 500-line trim as the per-provider summary records (no cap change).
// Event lines are tagged kind:"event" so summary readers can skip them — see
// latestByProvider.
function appendEvent(dataDir, event) {
  const lines = readLines(dataDir);
  lines.push(JSON.stringify(Object.assign({}, event, { kind: "event" })));
  const bounded = lines.slice(-MAX_LINES);
  store.writeText(logPath(dataDir), bounded.join("\n") + "\n");
}

function readRecords(dataDir, limit) {
  const lines = readLines(dataDir);
  const take = limit ? lines.slice(-limit) : lines;
  const records = [];
  for (const l of take) {
    try { records.push(JSON.parse(l)); } catch (err) { /* skip corrupt line */ }
  }
  return records;
}

// Latest SUMMARY record per provider id. Per-attempt event lines (kind:"event")
// are skipped — they carry a `provider` field too and would otherwise clobber
// the per-provider summary the health endpoint reads.
function latestByProvider(dataDir) {
  const records = readRecords(dataDir);
  const latest = {};
  for (const r of records) {
    if (r && r.kind === "event") continue;
    latest[r.provider] = r;
  }
  return latest;
}

module.exports = { appendRecord, appendEvent, readRecords, latestByProvider };
