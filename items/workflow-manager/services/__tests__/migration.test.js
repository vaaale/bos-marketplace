// migration.test.js — additive, idempotent legacy-workflow recovery (ADR-5/FR-005).

const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("fs");
const fsp = fs.promises;
const os = require("os");
const path = require("path");
const { startFakeBos } = require("./_fake-bos");

async function withTempConfigDir(fn) {
  const root = await fsp.mkdtemp(path.join(os.tmpdir(), "wf-migration-"));
  // configDirPath is dataDir()/system/config/<id>/ — migration.js resolves
  // the legacy root as ../../Workflows relative to it, i.e. dataDir()/system/Workflows.
  const configDirPath = path.join(root, "system", "config", "workflows");
  await fsp.mkdir(configDirPath, { recursive: true });
  try {
    await fn(root, configDirPath);
  } finally {
    await fsp.rm(root, { recursive: true, force: true });
  }
}

test("migration.js", async (t) => {
  const bos = await startFakeBos();
  process.env.NEXT_PUBLIC_APP_ORIGIN = bos.origin;
  delete require.cache[require.resolve("../vfs")];
  delete require.cache[require.resolve("../engine/store")];
  delete require.cache[require.resolve("../migration")];
  const { runMigration, migrateLegacyHostWorkflows, archiveLegacyExecutionLogs } = require("../migration");
  const vfs = require("../vfs");

  const logs = [];
  const log = (level, message) => logs.push({ level, message });

  await t.test("migrateLegacyHostWorkflows is a no-op when there is no legacy directory", async () => {
    await withTempConfigDir(async (root, configDirPath) => {
      await migrateLegacyHostWorkflows(configDirPath, log);
      assert.deepEqual(await vfs.list("/Workflows").catch(() => []), []);
    });
  });

  await t.test("migrateLegacyHostWorkflows copies stranded workflows into the real VFS and archives the legacy dir", async () => {
    await withTempConfigDir(async (root, configDirPath) => {
      const legacyRoot = path.join(root, "system", "Workflows");
      await fsp.mkdir(legacyRoot, { recursive: true });
      await fsp.writeFile(path.join(legacyRoot, "stranded-workflow.json"), JSON.stringify({ id: "stranded", name: "Stranded" }));
      await fsp.writeFile(path.join(legacyRoot, "not-a-workflow.txt"), "ignore me");

      await migrateLegacyHostWorkflows(configDirPath, log);

      const migrated = await vfs.readText("/Workflows/stranded-workflow.json");
      assert.deepEqual(JSON.parse(migrated), { id: "stranded", name: "Stranded" });
      // the legacy dir itself is renamed (archived), never deleted
      assert.equal(fs.existsSync(legacyRoot), false);
      const parent = path.join(root, "system");
      const archived = (await fsp.readdir(parent)).find((n) => n.startsWith("Workflows.migrated-"));
      assert.ok(archived, "expected an archived Workflows.migrated-* directory");
      assert.ok(fs.existsSync(path.join(parent, archived, "not-a-workflow.txt")));
    });
  });

  await t.test("migrateLegacyHostWorkflows never clobbers a workflow that already exists in the real VFS", async () => {
    await withTempConfigDir(async (root, configDirPath) => {
      await vfs.writeText("/Workflows/existing-workflow.json", JSON.stringify({ id: "existing", name: "Real" }));
      const legacyRoot = path.join(root, "system", "Workflows");
      await fsp.mkdir(legacyRoot, { recursive: true });
      await fsp.writeFile(path.join(legacyRoot, "existing-workflow.json"), JSON.stringify({ id: "existing", name: "Stale legacy copy" }));

      await migrateLegacyHostWorkflows(configDirPath, log);

      const content = JSON.parse(await vfs.readText("/Workflows/existing-workflow.json"));
      assert.equal(content.name, "Real");
    });
  });

  await t.test("archiveLegacyExecutionLogs renames retired-engine execution logs, never deletes", async () => {
    await vfs.writeText("/Workflows/old-execution-log.json", "[]");
    await archiveLegacyExecutionLogs(log);
    const entries = await vfs.list("/Workflows");
    assert.equal(entries.some((e) => e.name === "old-execution-log.json"), false);
    assert.ok(entries.some((e) => /^old-execution-log\.json\.archived-/.test(e.name)));
  });

  await t.test("runMigration is safe to call even with no legacy state at all", async () => {
    await withTempConfigDir(async (root, configDirPath) => {
      await assert.doesNotReject(() => runMigration(configDirPath, log));
    });
  });

  await bos.close();
});
