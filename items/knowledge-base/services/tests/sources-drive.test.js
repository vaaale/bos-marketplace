"use strict";

const { test, describe, beforeEach, afterEach } = require("node:test");
const assert = require("node:assert/strict");

// drive.js reaches BOS only through lib/http-bridge.js's integrationInvoke —
// stub that module in require's cache before requiring drive.js fresh, so
// these tests exercise drive.js's own folder-walk/export/download logic
// against a scripted fake adapter instead of a live gsuite integration.
function freshDriveWithBridge(invokeImpl) {
  const bridgePath = require.resolve("../lib/http-bridge");
  const drivePath = require.resolve("../lib/sources/drive");
  delete require.cache[bridgePath];
  delete require.cache[drivePath];
  require.cache[bridgePath] = {
    id: bridgePath,
    filename: bridgePath,
    loaded: true,
    exports: { integrationInvoke: invokeImpl },
  };
  return require(drivePath);
}

afterEach(() => {
  delete require.cache[require.resolve("../lib/http-bridge")];
  delete require.cache[require.resolve("../lib/sources/drive")];
});

describe("drive source — checkConnection", () => {
  test("connected when about_get succeeds", async () => {
    const drive = freshDriveWithBridge(async (_i, _s, method) => {
      assert.equal(method, "about_get");
      return { user: { emailAddress: "you@example.com" } };
    });
    const status = await drive.checkConnection();
    assert.deepEqual(status, { connected: true, email: "you@example.com" });
  });

  test("not connected when about_get throws", async () => {
    const drive = freshDriveWithBridge(async () => {
      const err = new Error("Scope not available");
      err.status = 403;
      throw err;
    });
    const status = await drive.checkConnection();
    assert.equal(status.connected, false);
    assert.match(status.reason, /Scope not available/);
  });
});

describe("drive source — acquire", () => {
  test("recurses into subfolders and collects only non-folder files", async () => {
    const FOLDER_MIME = "application/vnd.google-apps.folder";
    const tree = {
      root: [
        { id: "sub", name: "Sub", mimeType: FOLDER_MIME },
        { id: "f1", name: "a.txt", mimeType: "text/plain", modifiedTime: "2026-01-01T00:00:00Z" },
      ],
      sub: [{ id: "f2", name: "b.txt", mimeType: "text/plain", modifiedTime: "2026-01-02T00:00:00Z" }],
    };
    const drive = freshDriveWithBridge(async (_i, _s, method, args) => {
      if (method === "files_list") {
        const parentId = args.q.match(/'([^']+)' in parents/)[1];
        return { files: tree[parentId] || [] };
      }
      if (method === "files_download") {
        return { base64: Buffer.from(`content of ${args.id}`).toString("base64") };
      }
      throw new Error(`unexpected method ${method}`);
    });
    const result = await drive.acquire({ reference: "root" }, {});
    assert.equal(result.filesTotal, 2);
    const names = result.items.map((i) => i.name).sort();
    assert.deepEqual(names, ["a.txt", "b.txt"]);
    assert.equal(result.notes.length, 0);
  });

  test("a Google Doc is exported to text/plain, not downloaded raw", async () => {
    const drive = freshDriveWithBridge(async (_i, _s, method, args) => {
      if (method === "files_list") {
        return { files: [{ id: "doc1", name: "Notes", mimeType: "application/vnd.google-apps.document" }] };
      }
      if (method === "files_export") {
        assert.equal(args.mimeType, "text/plain");
        return { base64: Buffer.from("exported text").toString("base64") };
      }
      throw new Error(`unexpected method ${method}`);
    });
    const result = await drive.acquire({ reference: "root" }, {});
    assert.equal(result.items[0].name, "Notes.txt");
    assert.equal(result.items[0].bytes.toString("utf8"), "exported text");
  });

  test("a too-large file is reported as a note, not a thrown error", async () => {
    const drive = freshDriveWithBridge(async (_i, _s, method) => {
      if (method === "files_list") return { files: [{ id: "big", name: "huge.pdf", mimeType: "application/pdf" }] };
      if (method === "files_download") return { error: "too_large", size: 999999999 };
      throw new Error("unexpected");
    });
    const result = await drive.acquire({ reference: "root" }, {});
    assert.equal(result.items.length, 0);
    assert.equal(result.notes.length, 1);
    assert.match(result.notes[0].reason, /over the .* cap/);
  });
});
