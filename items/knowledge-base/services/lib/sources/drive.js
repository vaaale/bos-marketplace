"use strict";

// Google Drive folder source (design.md §5.2): reaches Drive through BOS's
// own gsuite integration invoke route — OAuth token never leaves server code
// (Constitution II) — never a direct Google API call from this worker.
// src/lib/integrations/services/gsuite/adapters/drive-methods.ts is the
// authoritative method list this calls into.

const path = require("path");
const bridge = require("../http-bridge");
const log = require("../log");

const INTEGRATION_ID = "gsuite";
const SERVICE_ID = "drive";
const FOLDER_MIME = "application/vnd.google-apps.folder";
const MAX_FILE_BYTES = 50 * 1024 * 1024; // matches the config UI's "up to 50 MB each" note

// Google-native document types can't be downloaded as bytes — they must be
// exported to a concrete MIME type first (files_export).
const EXPORT_MIME_BY_GOOGLE_TYPE = {
  "application/vnd.google-apps.document": { mimeType: "text/plain", extension: ".txt" },
  "application/vnd.google-apps.spreadsheet": { mimeType: "text/csv", extension: ".csv" },
  "application/vnd.google-apps.presentation": { mimeType: "text/plain", extension: ".txt" },
};

async function invoke(method, args) {
  return bridge.integrationInvoke(INTEGRATION_ID, SERVICE_ID, method, args);
}

/** Whether the Drive integration is currently authorized — used by the
 *  config UI's "Connect Google Drive" step 1 (mockup: "Connected as
 *  you@example.com" vs. the OAuth-start prompt). */
async function checkConnection() {
  try {
    const about = await invoke("about_get", {});
    return { connected: true, email: about && about.user && about.user.emailAddress };
  } catch (err) {
    log.debug("Drive connection check failed", err && err.message);
    return { connected: false, reason: (err && err.message) || "not connected", needsReauth: err && err.status === 401 };
  }
}

async function listFolders(parentId) {
  const result = await invoke("folders_list", parentId ? { parentId } : {});
  return (result && result.files) || [];
}

async function listChildren(folderId) {
  const result = await invoke("files_list", {
    q: `'${folderId}' in parents and trashed=false`,
    pageSize: 1000,
    fields: "files(id,name,mimeType,size,modifiedTime)",
  });
  return (result && result.files) || [];
}

/** Walks a folder (and its subfolders) collecting every non-folder file. */
async function walkFolder(folderId, depth, notes) {
  if (depth > 20) {
    notes.push({ name: folderId, reason: "folder nesting too deep — stopped descending" });
    return [];
  }
  const children = await listChildren(folderId);
  const files = [];
  for (const child of children) {
    if (child.mimeType === FOLDER_MIME) {
      files.push(...(await walkFolder(child.id, depth + 1, notes)));
    } else {
      files.push(child);
    }
  }
  return files;
}

async function downloadFile(file) {
  const exportSpec = EXPORT_MIME_BY_GOOGLE_TYPE[file.mimeType];
  if (exportSpec) {
    const result = await invoke("files_export", { id: file.id, mimeType: exportSpec.mimeType, maxBytes: MAX_FILE_BYTES });
    if (result && result.error) throw new Error(`${file.name}: ${result.error}`);
    return { name: `${file.name}${exportSpec.extension}`, bytes: Buffer.from(result.base64, "base64") };
  }
  const result = await invoke("files_download", { id: file.id, maxBytes: MAX_FILE_BYTES });
  if (result && result.error === "too_large") {
    throw new Error(`${file.name} is ${result.size} bytes, over the ${MAX_FILE_BYTES}-byte cap — skipped`);
  }
  if (result && result.error) throw new Error(`${file.name}: ${result.error}`);
  const name = path.posix.basename(file.name);
  return { name, bytes: Buffer.from(result.base64, "base64") };
}

/** Acquires every text-extractable file under `source.reference` (a Drive
 *  folder id), recursing into subfolders. Files that fail to download (too
 *  large, transient error) are reported as notes, not fatal — the rest of
 *  the folder still indexes (FR-011 edge case). */
async function acquire(source, opts) {
  const onProgress = (opts && opts.onProgress) || (() => {});
  const folderId = source.reference;
  const notes = [];
  const files = await walkFolder(folderId, 0, notes);
  log.debug(`Drive folder "${folderId}" walk found ${files.length} file(s)`, { notes: notes.length });

  const items = [];
  for (const file of files) {
    try {
      const { name, bytes } = await downloadFile(file);
      items.push({
        name,
        bytes,
        referenceTime: new Date(file.modifiedTime || Date.now()).toISOString(),
        sourceRef: file.id,
      });
    } catch (err) {
      log.warn(`Drive file "${file.name}" failed to download`, err && err.message);
      notes.push({ name: file.name, reason: (err && err.message) || String(err) });
    }
    onProgress({ done: items.length + notes.length, total: files.length });
  }

  return { items, notes, filesTotal: files.length };
}

module.exports = { checkConnection, listFolders, acquire };
