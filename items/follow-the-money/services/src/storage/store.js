"use strict";
// Atomic JSON storage primitive. Every persistence file in the item goes
// through this module (NFR-003 / NFR-005): write temp file in the same
// directory, then rename — a crash mid-write never corrupts prior data.
const fs = require("node:fs");
const path = require("node:path");

function ensureDir(dirPath) {
  fs.mkdirSync(dirPath, { recursive: true });
}

function readJSON(filePath, fallback) {
  try {
    const text = fs.readFileSync(filePath, "utf8");
    return JSON.parse(text);
  } catch (err) {
    return fallback === undefined ? null : fallback;
  }
}

// Atomic write: temp file in the same dir -> rename. `mode` (e.g. 0o600 for
// secret.json) is applied to the temp file before the rename.
function writeJSON(filePath, obj, opts) {
  const dir = path.dirname(filePath);
  ensureDir(dir);
  const tmp = path.join(dir, "." + path.basename(filePath) + ".tmp-" + process.pid);
  const mode = opts && opts.mode;
  fs.writeFileSync(tmp, JSON.stringify(obj, null, 2) + "\n", mode ? { mode } : undefined);
  fs.renameSync(tmp, filePath);
  if (mode) {
    try { fs.chmodSync(filePath, mode); } catch (err) { /* best effort */ }
  }
}

// Atomic plain-text write (used by the bounded refresh log).
function writeText(filePath, text) {
  const dir = path.dirname(filePath);
  ensureDir(dir);
  const tmp = path.join(dir, "." + path.basename(filePath) + ".tmp-" + process.pid);
  fs.writeFileSync(tmp, text);
  fs.renameSync(tmp, filePath);
}

function exists(filePath) {
  try { fs.statSync(filePath); return true; } catch (err) { return false; }
}

function removeFile(filePath) {
  try { fs.unlinkSync(filePath); return true; } catch (err) { return false; }
}

function listFiles(dirPath) {
  try { return fs.readdirSync(dirPath).sort(); } catch (err) { return []; }
}

module.exports = { ensureDir, readJSON, writeJSON, writeText, exists, removeFile, listFiles };
