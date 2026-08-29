// migration.js — additive, idempotent legacy-workflow recovery (ADR-5,
// FR-005). Two independent, non-fatal concerns, both copy-then-archive and
// NEVER delete:
//
// 1. Host-path recovery: if an earlier/misconfigured run of this service (or
//    a hand-authored config) ever wrote workflow files to a HOST path derived
//    from the service's own config directory instead of the real VFS (the
//    same bug class documented for okf-knowledge-base's bundleRoot), copy any
//    such `<id>-workflow.json` files into the real VFS `/Workflows/` root
//    (skipping ids that already exist there) and archive (rename) the legacy
//    directory.
// 2. Retired-engine cleanup: the now-retired BOS-source engine
//    (src/lib/workflows/*) wrote per-workflow execution logs to
//    `/Workflows/<id>-execution-log.json` — already real VFS, nothing to
//    "recover", but that format is superseded by first-class run entities
//    (ADR-9). Archive (rename, never delete) any such file so it doesn't
//    linger as unexplained clutter next to the new `/Workflows/.runs/` tree.

const fs = require("fs");
const fsp = fs.promises;
const path = require("path");
const vfs = require("./vfs");
const { ROOT } = require("./engine/store");

async function copyHostDirToVfs(srcDir, destVfsPath) {
  const entries = await fsp.readdir(srcDir, { withFileTypes: true });
  for (const entry of entries) {
    const srcPath = path.join(srcDir, entry.name);
    const destPath = `${destVfsPath}/${entry.name}`;
    if (entry.isDirectory()) {
      await copyHostDirToVfs(srcPath, destPath);
    } else {
      const content = await fsp.readFile(srcPath, "utf8");
      await vfs.writeText(destPath, content);
    }
  }
}

async function migrateLegacyHostWorkflows(configDirPath, log) {
  // Mirrors the exact host path a config-dir-relative bug would have produced:
  // dataDir()/system/config/workflows/../../Workflows -> dataDir()/system/Workflows.
  const legacyRoot = path.resolve(configDirPath, "..", "..", "Workflows");
  let legacyEntries;
  try {
    legacyEntries = await fsp.readdir(legacyRoot, { withFileTypes: true });
  } catch {
    return; // nothing at the legacy location — the common case, nothing to do
  }
  const migrated = [];
  for (const entry of legacyEntries) {
    if (!entry.isFile() || !entry.name.endsWith("-workflow.json")) continue;
    const destPath = `${ROOT}/${entry.name}`;
    if (await vfs.exists(destPath)) continue; // never clobber a real workflow that already exists
    const content = await fsp.readFile(path.join(legacyRoot, entry.name), "utf8");
    await vfs.writeText(destPath, content);
    migrated.push(entry.name);
  }
  if (migrated.length) {
    const archivedPath = `${legacyRoot}.migrated-${Date.now()}`;
    await fsp.rename(legacyRoot, archivedPath);
    log("info", `migrated ${migrated.length} workflow(s) stranded at a legacy host path into the real VFS ${ROOT}/: ${migrated.join(", ")}. Legacy location archived (not deleted) at ${archivedPath}.`);
  }
}

async function archiveLegacyExecutionLogs(log) {
  let entries = [];
  try {
    entries = await vfs.list(ROOT);
  } catch {
    return;
  }
  const legacyLogs = entries.filter((e) => e.type === "file" && e.name.endsWith("-execution-log.json"));
  for (const e of legacyLogs) {
    const archivedName = `${e.name}.archived-${Date.now()}`;
    await vfs.rename(e.path, `${ROOT}/${archivedName}`).catch((err) => {
      log("warn", `could not archive legacy execution log ${e.path}: ${err.message}`);
    });
  }
  if (legacyLogs.length) {
    log("info", `archived ${legacyLogs.length} legacy execution-log file(s) from the retired engine (superseded by /Workflows/.runs/).`);
  }
}

/** Best-effort, safe to run on every startup — idempotent once migrated. */
async function runMigration(configDirPath, log) {
  await migrateLegacyHostWorkflows(configDirPath, log).catch((err) => log("warn", `host-path workflow migration check failed (non-fatal): ${err.message}`));
  await archiveLegacyExecutionLogs(log).catch((err) => log("warn", `legacy execution-log archive check failed (non-fatal): ${err.message}`));
}

module.exports = { runMigration, migrateLegacyHostWorkflows, archiveLegacyExecutionLogs };
