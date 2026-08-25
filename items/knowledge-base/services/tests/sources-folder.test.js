"use strict";

const { test, describe, afterEach } = require("node:test");
const assert = require("node:assert/strict");

// folder.js reaches BOS only through lib/http-bridge.js's vfsList/vfsReadBytes
// — stub that module in require's cache before requiring folder.js fresh, the
// same pattern tests/sources-drive.test.js uses for drive.js, so these tests
// exercise folder.js's own recursive-walk/size-cap logic against a scripted
// fake VFS tree instead of a live BOS server.
function freshFolderWithBridge(bridgeImpl) {
  const bridgePath = require.resolve("../lib/http-bridge");
  const folderPath = require.resolve("../lib/sources/folder");
  delete require.cache[bridgePath];
  delete require.cache[folderPath];
  require.cache[bridgePath] = { id: bridgePath, filename: bridgePath, loaded: true, exports: bridgeImpl };
  return require(folderPath);
}

afterEach(() => {
  delete require.cache[require.resolve("../lib/http-bridge")];
  delete require.cache[require.resolve("../lib/sources/folder")];
});

describe("folder source — acquire", () => {
  test("recurses into subfolders and collects every file with a root-relative name", async () => {
    const tree = {
      "/KnowledgeBase/kb1/docs": [
        { name: "sub", path: "/KnowledgeBase/kb1/docs/sub", type: "dir", size: 0, modified: 0 },
        { name: "a.txt", path: "/KnowledgeBase/kb1/docs/a.txt", type: "file", size: 6, modified: 111 },
      ],
      "/KnowledgeBase/kb1/docs/sub": [
        { name: "b.txt", path: "/KnowledgeBase/kb1/docs/sub/b.txt", type: "file", size: 6, modified: 222 },
      ],
    };
    const folder = freshFolderWithBridge({
      vfsList: async (p) => ({ status: 200, body: { entries: tree[p] || [] } }),
      vfsReadBytes: async (p) => Buffer.from(`content of ${p}`),
    });

    const result = await folder.acquire({ reference: "/KnowledgeBase/kb1/docs" }, {});
    assert.equal(result.filesTotal, 2);
    assert.equal(result.notes.length, 0);
    const byName = Object.fromEntries(result.items.map((i) => [i.name, i]));
    assert.deepEqual(Object.keys(byName).sort(), ["a.txt", "sub/b.txt"]);
    assert.equal(byName["sub/b.txt"].bytes.toString("utf8"), "content of /KnowledgeBase/kb1/docs/sub/b.txt");
    assert.equal(byName["a.txt"].sourceRef, "/KnowledgeBase/kb1/docs/a.txt");
  });

  test("a too-large file is reported as a note, not a thrown error", async () => {
    const tree = {
      "/root": [{ name: "huge.pdf", path: "/root/huge.pdf", type: "file", size: 999999999, modified: 0 }],
    };
    const folder = freshFolderWithBridge({
      vfsList: async (p) => ({ status: 200, body: { entries: tree[p] || [] } }),
      vfsReadBytes: async () => { throw new Error("should not be called for an over-cap file"); },
    });

    const result = await folder.acquire({ reference: "/root" }, {});
    assert.equal(result.items.length, 0);
    assert.equal(result.notes.length, 1);
    assert.match(result.notes[0].reason, /over the .* cap/);
  });

  test("a file that fails to read is reported as a note, the rest of the folder still indexes", async () => {
    const tree = {
      "/root": [
        { name: "ok.txt", path: "/root/ok.txt", type: "file", size: 2, modified: 0 },
        { name: "bad.txt", path: "/root/bad.txt", type: "file", size: 2, modified: 0 },
      ],
    };
    const folder = freshFolderWithBridge({
      vfsList: async (p) => ({ status: 200, body: { entries: tree[p] || [] } }),
      vfsReadBytes: async (p) => {
        if (p.endsWith("bad.txt")) throw new Error("read failed");
        return Buffer.from("ok");
      },
    });

    const result = await folder.acquire({ reference: "/root" }, {});
    assert.equal(result.items.length, 1);
    assert.equal(result.items[0].name, "ok.txt");
    assert.equal(result.notes.length, 1);
    assert.match(result.notes[0].reason, /read failed/);
  });

  test("throws a clear error when the VFS folder does not exist", async () => {
    const folder = freshFolderWithBridge({
      vfsList: async () => ({ status: 404, body: { error: "not found" } }),
      vfsReadBytes: async () => { throw new Error("unreachable"); },
    });
    await assert.rejects(() => folder.acquire({ reference: "/missing" }, {}), /Folder not found in VFS/);
  });
});
