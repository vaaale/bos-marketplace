"use strict";

// Local folder source (038 addition — folder-as-source, beyond the original
// spec's Upload/Drive/Website source types): the config UI uploads a whole
// folder's files into the VFS under one generated root path (preserving
// relative structure via repeated /api/fs/upload calls, one per subfolder —
// see config/config.html's ingestFolder()); this acquirer walks that VFS
// subtree the same way lib/sources/drive.js walks a Drive folder, just over
// BOS's own VFS (lib/http-bridge.js's vfsList/vfsReadBytes) instead of the
// Drive API. `source.reference` is the VFS root path of the folder.

const path = require("path");
const bridge = require("../http-bridge");
const log = require("../log");

const MAX_FILE_BYTES = 50 * 1024 * 1024; // matches drive.js / the config UI's upload cap

/** Walks a VFS folder (and its subfolders) collecting every file entry. */
async function walkFolder(vfsPath, depth, notes) {
  if (depth > 20) {
    notes.push({ name: vfsPath, reason: "folder nesting too deep — stopped descending" });
    return [];
  }
  const res = await bridge.vfsList(vfsPath);
  if (res.status !== 200 || !res.body || !Array.isArray(res.body.entries)) {
    throw new Error(`Folder not found in VFS: ${vfsPath}`);
  }
  const files = [];
  for (const entry of res.body.entries) {
    if (entry.type === "dir") {
      files.push(...(await walkFolder(entry.path, depth + 1, notes)));
    } else {
      files.push(entry);
    }
  }
  return files;
}

/** Acquires every file under `source.reference` (a VFS folder path),
 *  recursing into subfolders. Files that fail to read or exceed the size cap
 *  are reported as notes, not fatal — the rest of the folder still indexes
 *  (FR-011 edge case, same as the Drive source). */
async function acquire(source, opts) {
  const onProgress = (opts && opts.onProgress) || (() => {});
  const rootPath = source.reference;
  const notes = [];
  const files = await walkFolder(rootPath, 0, notes);
  log.debug(`folder "${rootPath}" walk found ${files.length} file(s)`, { notes: notes.length });

  const items = [];
  for (const entry of files) {
    if (entry.size > MAX_FILE_BYTES) {
      notes.push({ name: entry.path, reason: `${entry.size} bytes, over the ${MAX_FILE_BYTES}-byte cap — skipped` });
      onProgress({ done: items.length + notes.length, total: files.length });
      continue;
    }
    try {
      const bytes = await bridge.vfsReadBytes(entry.path);
      items.push({
        name: path.posix.relative(rootPath, entry.path) || entry.name,
        bytes,
        referenceTime: new Date(entry.modified || Date.now()).toISOString(),
        sourceRef: entry.path,
      });
    } catch (err) {
      log.warn(`folder file "${entry.path}" failed to read`, err && err.message);
      notes.push({ name: entry.path, reason: (err && err.message) || String(err) });
    }
    onProgress({ done: items.length + notes.length, total: files.length });
  }

  return { items, notes, filesTotal: files.length };
}

module.exports = { acquire };
