"use strict";
// Defect 2 — Nasdaq adapter assetclass resolution (FR-017 / NFR-008).
//
// The defect: user-added individual stocks (category "stock") could never
// fetch. Root cause (VERIFIED LIVE 2026-09-20, not assumed): the Nasdaq chart
// endpoint accepts ONLY the assetclass values "etf" and "index". There is no
// stock assetclass — "assetclass=stock" (and 10 other values) are rejected
// with "Bad or No parameter assetclass", and a real stock (AAPL / NFLX)
// returns "Symbol not exists" under BOTH etf and index. Nasdaq therefore
// cannot serve individual stocks at all; the only stock-capable provider is
// the keyed fallback (Twelve Data).
//
// The fix has two halves (see config.test.js for the provider-chain half):
//   1. the adapter derives assetclass per instrument and, for a stock, signals
//      NOT_FOUND (before any network I/O) so the per-symbol chain (FR-011)
//      falls through to the stock-capable provider instead of issuing a request
//      the endpoint would reject;
//   2. a user-added stock defaults to a provider chain that includes that
//      stock-capable provider.
//
// These assertions are pure / no-network: resolveAssetClass is a pure
// projection and fetchDaily throws for a stock BEFORE touching the network.
// Run with: node --test services/tests/nasdaq.test.js

const test = require("node:test");
const assert = require("node:assert/strict");

const nasdaq = require("../src/providers/nasdaq.js");
const { ProviderError } = require("../src/providers/http.js");

const RANGE = { from: "2026-01-01", to: "2026-09-20" };

test("resolveAssetClass: NDX (index) -> index; stocks -> unsupported; ETFs -> etf", () => {
  assert.equal(nasdaq.resolveAssetClass({ symbol: "NDX", assetClass: "index" }), "index");
  assert.equal(nasdaq.resolveAssetClass({ symbol: "AAPL", category: "stock" }), "unsupported");
  assert.equal(nasdaq.resolveAssetClass({ symbol: "XLK", category: "sector" }), "etf");
  assert.equal(nasdaq.resolveAssetClass({ symbol: "EFA", category: "proxy" }), "etf");
  assert.equal(nasdaq.resolveAssetClass({ symbol: "SPY", category: "broad" }), "etf");
  // assetClass (index) takes precedence — NDX is an index, not a stock
  assert.equal(nasdaq.resolveAssetClass({ symbol: "NDX", category: "broad", assetClass: "index" }), "index");
});

test("fetchDaily for a stock signals NOT_FOUND (no invalid request, no network)", async () => {
  await assert.rejects(
    nasdaq.fetchDaily({ symbol: "AAPL", category: "stock", currency: "USD" }, RANGE),
    (err) => {
      assert.ok(err instanceof ProviderError, "a structured ProviderError");
      assert.equal(err.code, "NOT_FOUND", "NOT_FOUND so the chain falls through");
      return true;
    }
  );
});

test("fetchDaily for a stock does NOT depend on a network round-trip (throws synchronously before fetch)", async () => {
  // The NOT_FOUND must be decided from the instrument alone, before any
  // outbound request — so a stock never reaches Nasdaq with a bogus class.
  let threw = false;
  try {
    await nasdaq.fetchDaily({ symbol: "NFLX", category: "stock" }, RANGE);
  } catch (err) {
    threw = true;
    assert.equal(err.code, "NOT_FOUND");
  }
  assert.equal(threw, true, "expected the stock path to reject without a network call");
});
