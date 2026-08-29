// store.test.js — workflow CRUD over the loopback VFS bridge.

const test = require("node:test");
const assert = require("node:assert/strict");
const { startFakeBos } = require("./_fake-bos");

test("store.js", async (t) => {
  const bos = await startFakeBos();
  process.env.NEXT_PUBLIC_APP_ORIGIN = bos.origin;
  delete require.cache[require.resolve("../vfs")];
  delete require.cache[require.resolve("../engine/store")];
  const store = require("../engine/store");

  await t.test("listWorkflows starts empty", async () => {
    assert.deepEqual(await store.listWorkflows(), []);
  });

  let savedId;
  await t.test("saveWorkflow assigns an id, version, and timestamps", async () => {
    const wf = await store.saveWorkflow({ name: "Data Pipeline", steps: [{ id: "a" }] });
    savedId = wf.id;
    assert.ok(wf.id.startsWith("data-pipeline-"));
    assert.equal(wf.version, 1);
    assert.equal(wf.steps.length, 1);
    assert.ok(wf.createdAt);
    assert.ok(wf.updatedAt);
  });

  await t.test("getWorkflow reads it back", async () => {
    const wf = await store.getWorkflow(savedId);
    assert.equal(wf.name, "Data Pipeline");
  });

  await t.test("getWorkflow returns undefined for a missing id", async () => {
    assert.equal(await store.getWorkflow("no-such-id"), undefined);
  });

  await t.test("listWorkflows returns the saved workflow, sorted newest-updated first", async () => {
    await new Promise((r) => setTimeout(r, 2));
    const second = await store.saveWorkflow({ name: "Second", steps: [{ id: "a" }] });
    const list = await store.listWorkflows();
    assert.equal(list.length, 2);
    assert.equal(list[0].id, second.id);
  });

  await t.test("saveWorkflow preserves an explicit id and bumps updatedAt on re-save", async () => {
    const first = await store.getWorkflow(savedId);
    await new Promise((r) => setTimeout(r, 2));
    const resaved = await store.saveWorkflow({ ...first, name: "Renamed" });
    assert.equal(resaved.id, savedId);
    assert.ok(resaved.updatedAt >= first.updatedAt);
    assert.equal(resaved.name, "Renamed");
  });

  await t.test("deleteWorkflow removes it", async () => {
    await store.deleteWorkflow(savedId);
    assert.equal(await store.getWorkflow(savedId), undefined);
  });

  await bos.close();
});
