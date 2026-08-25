"use strict";

// Upload source (design.md §5.2): the config UI writes bytes into the VFS via
// BOS's own /api/fs/upload (a browser-facing route, called directly by
// config.html since it's served same-origin); the worker only ever READS
// bytes back via the loopback /api/fs/raw bridge — never imports "@/os/vfs".

const path = require("path");
const bridge = require("../http-bridge");

/** One upload source = one VFS file. Returns the raw bytes + a last-modified
 *  timestamp (used as Graphiti's reference_time). */
async function acquire(source) {
  const vfsPath = source.reference;
  const stat = await bridge.vfsStat(vfsPath);
  if (stat.status !== 200 || !stat.body || !stat.body.entry) {
    throw new Error(`File not found in VFS: ${vfsPath}`);
  }
  const entry = stat.body.entry;
  const bytes = await bridge.vfsReadBytes(vfsPath);
  return {
    items: [
      {
        name: path.posix.basename(vfsPath),
        bytes,
        referenceTime: new Date(entry.modified || Date.now()).toISOString(),
        sourceRef: vfsPath,
      },
    ],
    sizeBytes: entry.size || bytes.length,
  };
}

module.exports = { acquire };
