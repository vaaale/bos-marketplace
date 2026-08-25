"use strict";

const { test, describe, before, after } = require("node:test");
const assert = require("node:assert/strict");
const http = require("http");
const website = require("../lib/sources/website");

// A tiny real HTTP server (Node built-ins only, no mocks) exercising the
// crawler's same-domain restriction, depth cap, page limit, and robots.txt
// handling end to end.
let server;
let baseUrl;

const PAGES = {
  "/": `<html><head><title>Home</title></head><body>
    <p>Welcome to the site.</p>
    <a href="/about">About</a>
    <a href="/blocked">Blocked</a>
    <a href="https://external.example.com/">External</a>
  </body></html>`,
  "/about": `<html><body><p>About us.</p><a href="/deep">Deep</a></body></html>`,
  "/deep": `<html><body><p>Deep page.</p><a href="/deeper">Deeper</a></body></html>`,
  "/deeper": `<html><body><p>Deeper page.</p></body></html>`,
  "/blocked": `<html><body><p>Should be skipped by robots.txt.</p></body></html>`,
  "/robots.txt": "User-agent: *\nDisallow: /blocked\n",
};

before(async () => {
  server = http.createServer((req, res) => {
    const path = (req.url || "/").split("?")[0];
    const body = PAGES[path];
    if (!body) {
      res.writeHead(404);
      return res.end("not found");
    }
    res.writeHead(200, { "Content-Type": path.endsWith(".txt") ? "text/plain" : "text/html" });
    res.end(body);
  });
  await new Promise((resolve) => server.listen(0, "127.0.0.1", resolve));
  const addr = server.address();
  baseUrl = `http://127.0.0.1:${addr.port}`;
});

after(async () => {
  await new Promise((resolve) => server.close(resolve));
});

describe("website source acquire()", () => {
  test("crawls same-hostname pages, skips robots-disallowed and external links", async () => {
    const source = { reference: baseUrl + "/", extra: { maxDepth: 4, pageLimit: 20 } };
    const result = await website.acquire(source, {});
    const paths = result.items.map((i) => new URL(i.sourceRef).pathname);
    assert.ok(paths.includes("/"));
    assert.ok(paths.includes("/about"));
    assert.ok(paths.includes("/deep"));
    assert.ok(!paths.includes("/blocked"));
    assert.ok(!result.items.some((i) => i.sourceRef.includes("external.example.com")));
    assert.ok(result.notes.some((n) => n.reason === "robots-disallowed"));
  });

  test("depth cap stops descending before the deepest page", async () => {
    const source = { reference: baseUrl + "/", extra: { maxDepth: 1, pageLimit: 20 } };
    const result = await website.acquire(source, {});
    const paths = result.items.map((i) => new URL(i.sourceRef).pathname);
    assert.ok(paths.includes("/"));
    assert.ok(paths.includes("/about"));
    // /deep is 2 hops from "/" (/ -> /about -> /deep) — depth 1 only allows 1 hop.
    assert.ok(!paths.includes("/deep"));
  });

  test("page limit caps the total number of pages fetched", async () => {
    const source = { reference: baseUrl + "/", extra: { maxDepth: 4, pageLimit: 2 } };
    const result = await website.acquire(source, {});
    assert.ok(result.items.length <= 2);
  });

  test("an unreachable page is reported as a note, not a thrown error", async () => {
    const source = { reference: "http://127.0.0.1:1/", extra: { maxDepth: 1, pageLimit: 5 } };
    const result = await website.acquire(source, {});
    assert.equal(result.items.length, 0);
    assert.ok(result.notes.some((n) => /unreachable/.test(n.reason)));
  });
});
