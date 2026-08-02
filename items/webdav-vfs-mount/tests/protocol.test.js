"use strict";

// Unit tests for the WebDAV/XML building blocks (T-03, T-10).

const { test, describe } = require("node:test");
const assert = require("node:assert/strict");
const daemon = require("../services/index.js");

describe("mimeFor", () => {
  test("maps known extensions", () => {
    assert.equal(daemon.mimeFor("a.txt"), "text/plain; charset=utf-8");
    assert.equal(daemon.mimeFor("a.png"), "image/png");
    assert.equal(daemon.mimeFor("a.json"), "application/json; charset=utf-8");
  });

  test("falls back to octet-stream for unknown extensions", () => {
    assert.equal(daemon.mimeFor("a.unknownext"), "application/octet-stream");
  });

  test("is case-insensitive", () => {
    assert.equal(daemon.mimeFor("A.PNG"), "image/png");
  });
});

describe("xmlEscape", () => {
  test("escapes the five XML special characters", () => {
    assert.equal(daemon.xmlEscape(`<a & b "c" 'd'>`), "&lt;a &amp; b &quot;c&quot; 'd'&gt;");
  });
});

// Regression: hrefs MUST be relative references, never paths absolute from
// this server's own root. This service is always reached through a proxy
// that strips its own path prefix before forwarding (the Supervisor's
// /__supervisor/services/<id>/ mount) — an absolute href like "/Documents/"
// is meaningless to a real client, since RFC 4918 resolves response hrefs
// against the Request-URI the CLIENT actually used, not this server's
// internal (post-prefix-stripping) view. This broke for real: a WebDAV
// client (davfs2) mounted and authenticated successfully, but silently
// showed an empty directory, because it correctly determined the absolute
// hrefs this service used to return weren't children of the collection it
// had mounted, and discarded every one of them.
//
// The self entry uses "." rather than an empty string — functionally
// identical per RFC 3986's dot-segment removal, but safer against a client
// XML parser that's less forgiving of a genuinely empty <D:href> element.
describe("hrefForEntry", () => {
  test("the self entry (isSelf=true) always gets '.', regardless of its own path", () => {
    assert.equal(daemon.hrefForEntry({ path: "/", type: "dir", name: "/" }, true), ".");
    assert.equal(daemon.hrefForEntry({ path: "/Documents", type: "dir", name: "Documents" }, true), ".");
  });

  test("a child entry gets just its own name — never the full VFS path", () => {
    const href = daemon.hrefForEntry({ path: "/Documents/a b.txt", type: "file", name: "a b.txt" }, false);
    assert.equal(href, "a%20b.txt");
  });

  test("a child directory entry gets its name with a trailing slash", () => {
    const href = daemon.hrefForEntry({ path: "/Documents/Sub", type: "dir", name: "Sub" }, false);
    assert.equal(href, "Sub/");
  });

  test("URL-encodes the child's name", () => {
    const href = daemon.hrefForEntry({ path: "/My Documents/a b.txt", type: "file", name: "a b.txt" }, false);
    assert.equal(href, "a%20b.txt");
  });
});

describe("etagFor", () => {
  test("is deterministic for the same size+modified", () => {
    const entry = { size: 42, modified: 1785000000000 };
    assert.equal(daemon.etagFor(entry), daemon.etagFor({ ...entry }));
  });

  test("differs when size or modified differs", () => {
    const a = daemon.etagFor({ size: 42, modified: 1785000000000 });
    const b = daemon.etagFor({ size: 43, modified: 1785000000000 });
    const c = daemon.etagFor({ size: 42, modified: 1785000000001 });
    assert.notEqual(a, b);
    assert.notEqual(a, c);
  });
});

describe("multistatusXml / propResponseXml", () => {
  test("the FIRST entry (the resource PROPFIND itself named) gets href='.'; subsequent entries get name-only hrefs", () => {
    const xml = daemon.multistatusXml([
      { name: "Documents", path: "/Documents", type: "dir", size: 0, modified: Date.now() },
      { name: "a.txt", path: "/Documents/a.txt", type: "file", size: 42, modified: Date.now() },
    ]);
    assert.match(xml, /^<\?xml version="1.0" encoding="utf-8"\?>/);
    assert.match(xml, /<D:multistatus xmlns:D="DAV:">/);
    assert.equal((xml.match(/<D:response>/g) || []).length, 2);
    assert.match(xml, /<D:href>\.<\/D:href>/); // self entry — ".", never "/Documents/"
    assert.match(xml, /<D:href>a\.txt<\/D:href>/); // child entry — name only, never "/Documents/a.txt"
    assert.doesNotMatch(xml, /<D:href>\/Documents/); // never an absolute VFS path anywhere
    assert.match(xml, /<D:collection\/>/); // the directory entry
    assert.match(xml, /<D:getcontentlength>42<\/D:getcontentlength>/); // the file entry
    assert.match(xml, /<D:getetag>W\/&quot;42-/); // the file entry's etag (xml-escaped quotes)
  });

  test("propResponseXml(entry, true) — a standalone self-response — has href='.'", () => {
    const xml = daemon.propResponseXml({ name: "a.txt", path: "/a.txt", type: "file", size: 3, modified: Date.now() }, true);
    assert.match(xml, /<D:href>\.<\/D:href>/);
  });

  test("propResponseXml(entry, false) — a file entry — has an empty resourcetype, content metadata, and an etag", () => {
    const xml = daemon.propResponseXml({ name: "a.txt", path: "/a.txt", type: "file", size: 3, modified: Date.now() }, false);
    assert.match(xml, /<D:resourcetype\/>/);
    assert.match(xml, /<D:getcontenttype>text\/plain; charset=utf-8<\/D:getcontenttype>/);
    assert.match(xml, /<D:href>a\.txt<\/D:href>/);
    assert.match(xml, /<D:getetag>/);
  });
});

// Regression: a real client's buffered-read GET requests were unconditionally
// answered with 200 + the full body, regardless of any Range header sent —
// spec-legal ("a server MAY ignore Range"), but it broke a real WebDAV
// client outright (a connection abort reading any file at all), since it
// issues ranged reads by default (davfs2's buf_size-driven buffering) and
// handles an unexpected 200-instead-of-206 far worse than the spec's
// "MAY ignore" language implies.
describe("parseRange", () => {
  test("returns null when the header is absent", () => {
    assert.equal(daemon.parseRange(undefined, 100), null);
  });

  test("returns null for a non-bytes-range header", () => {
    assert.equal(daemon.parseRange("items=0-10", 100), null);
  });

  test("parses a simple 'bytes=start-end' range", () => {
    assert.deepEqual(daemon.parseRange("bytes=0-9", 100), { start: 0, end: 9 });
    assert.deepEqual(daemon.parseRange("bytes=10-19", 100), { start: 10, end: 19 });
  });

  test("an open-ended range ('bytes=start-') goes to the last byte", () => {
    assert.deepEqual(daemon.parseRange("bytes=90-", 100), { start: 90, end: 99 });
  });

  test("a suffix range ('bytes=-N') means the last N bytes", () => {
    assert.deepEqual(daemon.parseRange("bytes=-10", 100), { start: 90, end: 99 });
  });

  test("clamps an end beyond the file size to the last byte", () => {
    assert.deepEqual(daemon.parseRange("bytes=0-99999", 100), { start: 0, end: 99 });
  });

  test("returns null for a start beyond the file size (unsatisfiable — caller falls back to a full 200)", () => {
    assert.equal(daemon.parseRange("bytes=200-300", 100), null);
  });

  test("returns null for a malformed range (end before start)", () => {
    assert.equal(daemon.parseRange("bytes=50-10", 100), null);
  });
});
