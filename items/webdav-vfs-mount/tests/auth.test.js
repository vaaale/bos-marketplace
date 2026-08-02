"use strict";

// Unit tests for the auth module (T-10). Plain Node, no VFS dependency — but
// verifyCandidate/validateAuth now call BOS's own loopback
// /api/secrets/<service>/verify bridge (docs/dev/features/headless-client-auth.md,
// "Worker-thread services"), so these tests stand up a tiny fake server on
// process.env.PORT that mimics that route's exact contract
// ({ candidate } -> { valid }), rather than mocking the daemon's own HTTP
// call. This file no longer tests token generation/hashing at all — the
// daemon doesn't do either anymore; BOS's real /api/secrets/<service> route
// does, and that route has its own tests (see the main repo's
// tests/services/service-secrets.test.ts).

const { test, describe, before, after, beforeEach } = require("node:test");
const assert = require("node:assert/strict");
const http = require("node:http");
const daemon = require("../services/index.js");

const SERVICE_ID = "webdav-vfs-mount";

let fakeServer;
let restorePort;
/** @type {Set<string>} */
let validSecrets;

before(async () => {
  validSecrets = new Set();
  fakeServer = http.createServer((req, res) => {
    if (req.url === `/api/secrets/${SERVICE_ID}/verify` && req.method === "POST") {
      let body = "";
      req.on("data", (c) => (body += c));
      req.on("end", () => {
        const parsed = JSON.parse(body || "{}");
        const valid = validSecrets.has(parsed.candidate);
        res.writeHead(200, { "Content-Type": "application/json" });
        res.end(JSON.stringify({ valid }));
      });
      return;
    }
    res.writeHead(404);
    res.end();
  });
  await new Promise((resolve) => fakeServer.listen(0, "127.0.0.1", resolve));
  restorePort = process.env.PORT;
  process.env.PORT = String(fakeServer.address().port);
});

after(async () => {
  await new Promise((resolve) => fakeServer.close(resolve));
  if (restorePort === undefined) delete process.env.PORT;
  else process.env.PORT = restorePort;
});

beforeEach(() => {
  validSecrets.clear();
});

describe("extractBearerToken", () => {
  test("parses a standard Bearer header", () => {
    const req = { headers: { authorization: "Bearer abc123" } };
    assert.equal(daemon.extractBearerToken(req), "abc123");
  });

  test("is case-insensitive on the scheme", () => {
    const req = { headers: { authorization: "bearer abc123" } };
    assert.equal(daemon.extractBearerToken(req), "abc123");
  });

  test("returns null when the header is absent", () => {
    assert.equal(daemon.extractBearerToken({ headers: {} }), null);
  });

  test("returns null for a non-Bearer scheme", () => {
    const req = { headers: { authorization: "Basic dXNlcjpwYXNz" } };
    assert.equal(daemon.extractBearerToken(req), null);
  });
});

describe("verifyCandidate (loopback to /api/secrets/<service>/verify)", () => {
  test("resolves true for a candidate the fake secrets route recognizes", async () => {
    validSecrets.add("a-real-token");
    assert.equal(await daemon.verifyCandidate(SERVICE_ID, "a-real-token"), true);
  });

  test("resolves false for an unrecognized candidate", async () => {
    assert.equal(await daemon.verifyCandidate(SERVICE_ID, "not-a-real-token"), false);
  });

  test("resolves false when nothing has ever been minted (eager-start 401 case)", async () => {
    assert.equal(await daemon.verifyCandidate(SERVICE_ID, "anything"), false);
  });
});

describe("validateAuth", () => {
  test("accepts a request bearing a currently-valid token", async () => {
    validSecrets.add("the-token");
    const req = { headers: { authorization: "Bearer the-token" } };
    assert.equal(await daemon.validateAuth(req, SERVICE_ID), true);
  });

  test("rejects when no token has been minted at all (eager-start 401)", async () => {
    const req = { headers: { authorization: "Bearer whatever" } };
    assert.equal(await daemon.validateAuth(req, SERVICE_ID), false);
  });

  test("rejects a missing Authorization header without ever calling the loopback route", async () => {
    assert.equal(await daemon.validateAuth({ headers: {} }, SERVICE_ID), false);
  });

  test("rejects the wrong token", async () => {
    validSecrets.add("correct-token");
    const req = { headers: { authorization: "Bearer wrong-token" } };
    assert.equal(await daemon.validateAuth(req, SERVICE_ID), false);
  });

  test("a revoked token (removed from the valid set) is rejected on the very next check — no restart needed", async () => {
    validSecrets.add("soon-revoked");
    const req = { headers: { authorization: "Bearer soon-revoked" } };
    assert.equal(await daemon.validateAuth(req, SERVICE_ID), true);

    validSecrets.delete("soon-revoked");
    assert.equal(await daemon.validateAuth(req, SERVICE_ID), false);
  });
});
