"use strict";
// Defect 3 — per-provider API-key slots (NFR-008 / NFR-009) and Defect 2 —
// user-added stock provider chain. These touch the config/secret layer and the
// two read endpoints, so they need a scratch data dir (file I/O only — no
// network, no Date.now dependence on asserted values).
//
// Run with: node --test services/tests/config.test.js

const test = require("node:test");
const assert = require("node:assert/strict");
const os = require("node:os");
const fs = require("node:fs");
const path = require("node:path");

const configMod = require("../src/config/config.js");
const store = require("../src/storage/store.js");
const { buildHealth } = require("../src/http/server.js");

// A minimal provider registry standing in for the real one — only the
// adapters' `requiresKey` flag is exercised here (nasdaq/cnbc = no key,
// twelvedata = keyed), mirroring the shipped adapters.
const FAKE_REGISTRY = {
  adapters: {
    nasdaq: { id: "nasdaq", requiresKey: false },
    twelvedata: { id: "twelvedata", requiresKey: true },
    cnbc: { id: "cnbc", requiresKey: false }
  },
  // minimal chain resolution mirroring the real registry (enough for
  // isKeyGated / isDisplayInstrument, which buildHealth uses)
  chainFor(inst) {
    const ids =
      Array.isArray(inst.providerIds) && inst.providerIds.length
        ? inst.providerIds
        : inst.provider === "both"
          ? ["nasdaq", "twelvedata"]
          : inst.provider === "fallback"
            ? ["twelvedata"]
            : ["nasdaq"];
    return ids.map((id) => this.adapters[id]).filter(Boolean);
  }
};

const SECRET = "SUPERSECRET_KEY_DO_NOT_LEAK_12345";

function tmpDataDir() {
  return fs.mkdtempSync(path.join(os.tmpdir(), "ftm-cfg-"));
}
function secretRaw(dataDir) {
  return fs.existsSync(path.join(dataDir, "secret.json")) ? fs.readFileSync(path.join(dataDir, "secret.json"), "utf8") : null;
}

// ---- Defect 3: per-provider key storage + ops ----------------------------

test("Defect 3: setKey/getKey/clearKey are per-provider and secret.json is keyed by provider", () => {
  const d = tmpDataDir();
  configMod.setKey(d, "twelvedata", SECRET);

  // stored keyed by provider
  const parsed = JSON.parse(secretRaw(d));
  assert.deepEqual(parsed, { providers: { twelvedata: SECRET } });
  assert.equal(configMod.getKey(d, "twelvedata"), SECRET);
  assert.equal(configMod.keyConfiguredFor(d, "twelvedata"), true);
  // a provider with no slot is not configured
  assert.equal(configMod.getKey(d, "cnbc"), null);
  assert.equal(configMod.keyConfiguredFor(d, "cnbc"), false);

  // still mode 0600
  const mode = fs.statSync(path.join(d, "secret.json")).mode & 0o777;
  assert.equal(mode, 0o600, "secret.json stays 0600");

  // clear removes the provider's slot (and the file when it was the only one)
  configMod.clearKey(d, "twelvedata");
  assert.equal(configMod.getKey(d, "twelvedata"), null);
  assert.equal(configMod.keyConfiguredFor(d, "twelvedata"), false);
  assert.equal(secretRaw(d), null, "file removed when no provider slots remain");
});

test("Defect 3: MIGRATION — legacy bare-string secret is read AND rewritten to the twelvedata slot on startup", () => {
  const d = tmpDataDir();
  store.writeJSON(path.join(d, "secret.json"), SECRET, { mode: 0o600 }); // legacy: a bare key string

  // readable before migration (normalization on the fly)
  assert.equal(configMod.getKey(d, "twelvedata"), SECRET);
  assert.equal(configMod.keyConfigured(d), true);

  const detail = configMod.migrateSecrets(d);
  assert.ok(detail, "migrateSecrets reports what it migrated");
  const parsed = JSON.parse(secretRaw(d));
  assert.deepEqual(parsed, { providers: { twelvedata: SECRET } }, "rewritten to the keyed format");
  // idempotent — a second run finds nothing to do
  assert.equal(configMod.migrateSecrets(d), null);
});

test("Defect 3: MIGRATION — legacy { apiKey } object is rewritten to the twelvedata slot", () => {
  const d = tmpDataDir();
  store.writeJSON(path.join(d, "secret.json"), { apiKey: "LEGACY_OBJ_KEY" }, { mode: 0o600 });

  assert.equal(configMod.getKey(d, "twelvedata"), "LEGACY_OBJ_KEY");
  assert.ok(configMod.migrateSecrets(d));
  assert.deepEqual(JSON.parse(secretRaw(d)), { providers: { twelvedata: "LEGACY_OBJ_KEY" } });
});

test("Defect 3: MIGRATION — no file / already-keyed file is a no-op (no empty secret created)", () => {
  const empty = tmpDataDir();
  assert.equal(configMod.migrateSecrets(empty), null);
  assert.equal(fs.existsSync(path.join(empty, "secret.json")), false, "never creates an empty secret file");

  const keyed = tmpDataDir();
  configMod.setKey(keyed, "twelvedata", "K");
  assert.equal(configMod.migrateSecrets(keyed), null, "already-keyed is a no-op");
});

test("Defect 3: applyConfigOps setKey/clearKey are scoped by providerId and validated against the registry", () => {
  const d = tmpDataDir();

  // valid: set the twelvedata key through the per-provider op
  let r = configMod.applyConfigOps(d, { setKey: { providerId: "twelvedata", apiKey: SECRET } }, FAKE_REGISTRY);
  assert.equal(r.ok, true);
  assert.equal(configMod.getKey(d, "twelvedata"), SECRET);

  // invalid: unknown provider
  r = configMod.applyConfigOps(d, { setKey: { providerId: "nope", apiKey: "x" } }, FAKE_REGISTRY);
  assert.equal(r.ok, false);
  assert.match(r.error, /unknown provider/);

  // invalid: a no-key provider cannot be given a key
  r = configMod.applyConfigOps(d, { setKey: { providerId: "nasdaq", apiKey: "x" } }, FAKE_REGISTRY);
  assert.equal(r.ok, false);
  assert.match(r.error, /does not require an API key/);

  // missing apiKey
  r = configMod.applyConfigOps(d, { setKey: { providerId: "twelvedata" } }, FAKE_REGISTRY);
  assert.equal(r.ok, false);
  assert.match(r.error, /apiKey/);

  // clear is provider-scoped
  r = configMod.applyConfigOps(d, { clearKey: { providerId: "twelvedata" } }, FAKE_REGISTRY);
  assert.equal(r.ok, true);
  assert.equal(configMod.getKey(d, "twelvedata"), null);
});

// ---- Defect 3: NFR-009 — key values never leave the service --------------

test("Defect 3: NFR-009 — GET /api/config (maskedConfig) reports per-provider presence, never the key value", () => {
  const d = tmpDataDir();
  configMod.setKey(d, "twelvedata", SECRET);

  const masked = configMod.maskedConfig(d, FAKE_REGISTRY);
  assert.deepEqual(masked.keyConfigured, { twelvedata: true }, "keyConfigured is per provider");
  const body = JSON.stringify(masked);
  assert.ok(!body.includes(SECRET), "the key value is NOT in the /api/config response");
  assert.ok(!body.toLowerCase().includes("supersecret"), "no partial leak either");

  // after clear, presence flips to false
  configMod.clearKey(d, "twelvedata");
  assert.deepEqual(configMod.maskedConfig(d, FAKE_REGISTRY).keyConfigured, { twelvedata: false });
});

test("Defect 3: NFR-009 — GET /api/health (buildHealth) reports per-provider presence, never the key value", () => {
  const d = tmpDataDir();
  configMod.setKey(d, "twelvedata", SECRET);
  const ctx = { dataDir: d, registry: FAKE_REGISTRY, state: { pipelineAlive: false } };

  const health = buildHealth(ctx);
  const td = health.providers.find((p) => p.id === "twelvedata");
  const nas = health.providers.find((p) => p.id === "nasdaq");
  assert.equal(td.keyConfigured, true, "twelvedata row shows keyConfigured per provider");
  assert.equal(nas.keyConfigured, null, "no-key provider row shows null (not a boolean)");
  assert.equal(health.keyConfigured, true, "top-level flat presence (single keyed provider) preserved");

  const body = JSON.stringify(health);
  assert.ok(!body.includes(SECRET), "the key value is NOT in the /api/health response");
});

// ---- Defect 2: a user-added stock's chain must include a stock-capable provider ----

test("Defect 2: a user-added stock defaults to a provider chain that includes the stock-capable (keyed) provider", () => {
  const d = tmpDataDir();

  // add a stock with no explicit provider -> must default to a chain with twelvedata
  let r = configMod.applyConfigOps(d, { instrumentAdd: { symbol: "AAPL", name: "Apple", region: "US", category: "stock" } }, FAKE_REGISTRY);
  assert.equal(r.ok, true);
  let aapl = configMod.getUniverse(d).find((i) => i.symbol === "AAPL");
  assert.equal(aapl.provider, "both", "a stock defaults to 'both' (chain [nasdaq, twelvedata])");
  assert.ok(aapl.providerIds.includes("twelvedata"), "the stock-capable provider is in the chain");
  assert.equal(aapl.source, "user");

  // control: a non-stock custom instrument keeps the no-key 'primary' default
  r = configMod.applyConfigOps(d, { instrumentAdd: { symbol: "XYZ", region: "US", category: "sector" } }, FAKE_REGISTRY);
  assert.equal(r.ok, true);
  const xyz = configMod.getUniverse(d).find((i) => i.symbol === "XYZ");
  assert.equal(xyz.provider, "primary");
  assert.deepEqual(xyz.providerIds, ["nasdaq"]);
});
