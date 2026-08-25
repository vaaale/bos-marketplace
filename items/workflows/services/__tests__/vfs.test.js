// vfs.test.js — the loopback /api/fs bridge (ADR-2/NFR-004). Run with:
//   node --test services/__tests__/vfs.test.js

const test = require("node:test");
const assert = require("node:assert/strict");
const { startFakeBos } = require("./_fake-bos");

test("vfs.js", async (t) => {
  const bos = await startFakeBos({ vfs: { "/Workflows/a-workflow.json": '{"id":"a"}' } });
  process.env.NEXT_PUBLIC_APP_ORIGIN = bos.origin;
  delete require.cache[require.resolve("../vfs")];
  const vfs = require("../vfs");

  await t.test("resolvePort reads NEXT_PUBLIC_APP_ORIGIN", () => {
    assert.equal(vfs.resolvePort(), String(bos.port));
  });

  await t.test("readText reads an existing file", async () => {
    const content = await vfs.readText("/Workflows/a-workflow.json");
    assert.equal(content, '{"id":"a"}');
  });

  await t.test("readText rejects a missing file", async () => {
    await assert.rejects(() => vfs.readText("/Workflows/missing.json"));
  });

  await t.test("exists is true for a file and false for a missing path", async () => {
    assert.equal(await vfs.exists("/Workflows/a-workflow.json"), true);
    assert.equal(await vfs.exists("/Workflows/nope.json"), false);
  });

  await t.test("writeText then readText round-trips", async () => {
    await vfs.writeText("/Workflows/b-workflow.json", '{"id":"b"}');
    assert.equal(await vfs.readText("/Workflows/b-workflow.json"), '{"id":"b"}');
  });

  await t.test("list returns entries under a directory", async () => {
    const entries = await vfs.list("/Workflows");
    const names = entries.map((e) => e.name).sort();
    assert.ok(names.includes("a-workflow.json"));
    assert.ok(names.includes("b-workflow.json"));
  });

  await t.test("remove deletes a file", async () => {
    await vfs.remove("/Workflows/b-workflow.json");
    assert.equal(await vfs.exists("/Workflows/b-workflow.json"), false);
  });

  await t.test("rename moves a file", async () => {
    await vfs.writeText("/Workflows/c-workflow.json", '{"id":"c"}');
    await vfs.rename("/Workflows/c-workflow.json", "/Workflows/d-workflow.json");
    assert.equal(await vfs.exists("/Workflows/c-workflow.json"), false);
    assert.equal(await vfs.readText("/Workflows/d-workflow.json"), '{"id":"c"}');
  });

  await bos.close();
});
