"use strict";
// CNBC heartbeat adapter (FR-010) — the spot-quote liveness check.
//
// ROOT CAUSE (VERIFIED LIVE 2026-09-21, not assumed): the heartbeat had never
// succeeded since a worker restart — /api/health showed pipelineAlive:false with
// lastHeartbeat:null — even though outbound egress was fine. Probing the real
// endpoint showed the cause is Akamai's edge, which SOFT-BLOCKS non-browser
// clients:
//   Node's default fetch (undici) User-Agent -> HTTP 200 but body "{}" (empty)
//   literal "undici"/"curl" UAs             -> HTTP 403 "Access Denied"
//   a browser User-Agent                    -> HTTP 200 with the real quote
// The adapter sent NO headers, so it always got the empty body, parse found no
// FormattedQuote, and fetchSpot returned null — silently. The sibling nasdaq.js
// adapter already sends browser-ish headers ("or it 403s"); CNBC was the only
// provider that omitted them.
//
// Two halves are tested here, both hermetic (globalThis.fetch is stubbed — no
// network, no Date.now assertion):
//   1. the adapter must send a browser User-Agent (the primary fix) and parse
//      the REAL response shape (array FormattedQuote + currencyCode).
//   2. a failure must leave a VISIBLE lastError — not vanish into null
//      (the no-cause-failure class the other fixes closed).
//
// Run with: node --test services/tests/cnbc.test.js

const test = require("node:test");
const assert = require("node:assert/strict");

const cnbc = require("../src/providers/cnbc.js");

// The real live body shape (NDX, US-only index) — FormattedQuote is an ARRAY,
// currency is currencyCode (no `cur` field), last is a comma string.
const REAL_BODY = {
  FormattedQuoteResult: {
    FormattedQuote: [
      {
        symbol: "NDX",
        last: "29,644.167",
        last_time: "2026-09-18",
        last_timedate: "09/18/26 EDT",
        exchange: "NASDAQ",
        currencyCode: "USD",
        type: "INDEX"
      }
    ]
  }
};

// Stub globalThis.fetch to capture the request and return a canned response.
function mockFetch(status, bodyText) {
  const captured = { url: null, headers: null };
  const orig = globalThis.fetch;
  globalThis.fetch = async (url, opts) => {
    captured.url = url;
    captured.headers = (opts && opts.headers) || {};
    return { status, text: async () => bodyText, headers: { get: () => null } };
  };
  return {
    captured,
    restore() {
      globalThis.fetch = orig;
    }
  };
}

function headerOf(headers, name) {
  for (const k of Object.keys(headers || {})) {
    if (k.toLowerCase() === name.toLowerCase()) return headers[k];
  }
  return undefined;
}

test("CNBC fetchSpot sends a browser User-Agent and parses the real spot response", async () => {
  const { captured, restore } = mockFetch(200, JSON.stringify(REAL_BODY));
  try {
    const spot = await cnbc.fetchSpot("NDX");
    assert.ok(spot, "a real response must parse to a spot quote");
    assert.equal(spot.last, 29644.167, "comma string last parses to a number");
    assert.equal(spot.currency, "USD", "currency comes from currencyCode");
    assert.ok(typeof spot.time === "number" && spot.time > 0, "a numeric time");

    // The load-bearing header: a browser User-Agent. Without it Akamai returns
    // an empty body and the heartbeat is dead. This is the primary fix — on the
    // unfixed code no User-Agent is sent at all, so this assertion fails.
    const ua = headerOf(captured.headers, "User-Agent");
    assert.ok(ua, "must send a User-Agent header");
    assert.match(ua, /Mozilla|AppleWebKit|Chrome|Safari|Firefox/, "must be a browser-ish UA");
    assert.ok(!/^undici$|^node/i.test(ua), "must not be the undici/node default UA");
  } finally {
    restore();
  }
});

test("empty Akamai soft-block body (HTTP 200 + '{}') -> null + a VISIBLE lastError (not silent)", async () => {
  const { restore } = mockFetch(200, "{}");
  try {
    const spot = await cnbc.fetchSpot("NDX");
    assert.equal(spot, null, "an empty body yields no spot");
    // The silence is the bug: a bare null with no cause hid this for weeks.
    assert.ok(cnbc.lastError, "the failure must carry a visible cause, not vanish into null");
    assert.equal(typeof cnbc.lastError, "string");
  } finally {
    restore();
  }
});

test("a non-2xx (403 hard-block) -> null + a VISIBLE lastError naming the HTTP status", async () => {
  const { restore } = mockFetch(403, "Access Denied");
  try {
    const spot = await cnbc.fetchSpot("NDX");
    assert.equal(spot, null);
    assert.ok(cnbc.lastError, "a 403 must not be swallowed silently");
    assert.match(String(cnbc.lastError), /403|HTTP/, "the cause must name the failure");
  } finally {
    restore();
  }
});

test("a successful fetch clears a prior lastError", async () => {
  const ok = mockFetch(200, JSON.stringify(REAL_BODY));
  try {
    cnbc.lastError = "stale previous failure";
    const spot = await cnbc.fetchSpot("NDX");
    assert.ok(spot, "parses on success");
    assert.equal(cnbc.lastError, null, "success clears the recorded error");
  } finally {
    ok.restore();
  }
});
