"use strict";

// Unit tests for path sanitization / directory-traversal prevention (T-05, T-10).

const { test, describe } = require("node:test");
const assert = require("node:assert/strict");
const daemon = require("../services/index.js");

describe("sanitizePath", () => {
  test("passes through a clean path", () => {
    assert.equal(daemon.sanitizePath("/Documents/notes.txt"), "/Documents/notes.txt");
  });

  test("defaults a missing path to root", () => {
    assert.equal(daemon.sanitizePath(""), "/");
    assert.equal(daemon.sanitizePath(null), "/");
  });

  test("adds a leading slash if missing", () => {
    assert.equal(daemon.sanitizePath("Documents"), "/Documents");
  });

  test("strips a query string", () => {
    assert.equal(daemon.sanitizePath("/Documents/a.txt?rev=1"), "/Documents/a.txt");
  });

  test("decodes percent-encoding", () => {
    assert.equal(daemon.sanitizePath("/My%20Documents/a.txt"), "/My Documents/a.txt");
  });

  test("collapses a classic ../ traversal attempt back to root", () => {
    assert.equal(daemon.sanitizePath("/../../etc/passwd"), "/etc/passwd");
    assert.equal(daemon.sanitizePath("/Documents/../../../etc/passwd"), "/etc/passwd");
  });

  test("collapses an encoded traversal attempt", () => {
    assert.equal(daemon.sanitizePath("/%2e%2e/%2e%2e/etc"), "/etc");
  });

  test("collapses internal ./ and // segments", () => {
    assert.equal(daemon.sanitizePath("/Documents/./a//b"), "/Documents/a/b");
  });
});

describe("isPathSafe", () => {
  test("accepts root and normal absolute paths", () => {
    assert.equal(daemon.isPathSafe("/"), true);
    assert.equal(daemon.isPathSafe("/Documents/a.txt"), true);
  });

  test("rejects a relative path", () => {
    assert.equal(daemon.isPathSafe("Documents/a.txt"), false);
  });

  test("rejects a literal .. segment", () => {
    assert.equal(daemon.isPathSafe("/Documents/../a.txt"), false);
  });
});

describe("validatePath", () => {
  test("returns the sanitized path for a legitimate request", () => {
    assert.equal(daemon.validatePath("/Documents/a.txt"), "/Documents/a.txt");
  });

  test("neutralizes traversal rather than escaping the VFS root", () => {
    // sanitizePath's normalize step already confines an absolute path — the
    // combined validatePath never returns something outside the root.
    const result = daemon.validatePath("/../../../etc/passwd");
    assert.equal(result, "/etc/passwd");
    assert.ok(result.startsWith("/"));
    assert.ok(!result.split("/").includes(".."));
  });

  test("accepts an absolute path at the root", () => {
    assert.equal(daemon.validatePath("/"), "/");
  });
});
