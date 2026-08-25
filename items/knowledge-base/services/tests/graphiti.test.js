"use strict";

const { test, describe, beforeEach, afterEach } = require("node:test");
const assert = require("node:assert/strict");
const fs = require("fs");
const os = require("os");
const path = require("path");

// graphiti.js's wire format is exactly the bug this file guards against
// (038-knowledge-base bugfix round): earlier versions sent delete_episode
// {episode_uuid}, clear_graph {group_id}, and get_episodes
// {group_id, reference_time, last_n} — none of which match the real
// getzep/graphiti mcp_server tool contract (verified live against
// http://wingman.akhbar.lan:5051/mcp), which wants uuid/group_ids(plural)/
// max_episodes. add_memory itself is fire-and-forget (its response never
// carries an episode id) — an even earlier version tried to work around
// that by generating a client-side uuid and sending it as add_memory's
// optional `uuid` arg, but graphiti_core's add_episode treats a non-null
// uuid as "look up this existing episode" (EpisodicNode.get_by_uuid), which
// fails with "node <uuid> not found" for a uuid the server has never seen.
// addEpisode must NOT send a uuid; the real one is discovered afterward by
// matching on `name` via waitForEpisode.
//
// The MCP SDK's Client/StreamableHTTPClientTransport are stubbed via
// require.cache (same pattern as tests/sources-drive.test.js) so this
// exercises graphiti.js's actual argument-building logic without a live
// Graphiti deployment.

let graphiti;
let calls;
let tmpDir;

function stubModule(resolvedPath, exportsObj) {
  require.cache[resolvedPath] = { id: resolvedPath, filename: resolvedPath, loaded: true, exports: exportsObj };
}

function freshGraphiti({ toolResult } = {}) {
  const clientPath = require.resolve("@modelcontextprotocol/sdk/client/index.js");
  const transportPath = require.resolve("@modelcontextprotocol/sdk/client/streamableHttp.js");
  const graphitiPath = require.resolve("../lib/graphiti");
  delete require.cache[clientPath];
  delete require.cache[transportPath];
  delete require.cache[graphitiPath];

  calls = [];

  class FakeClient {
    async connect() {}
    async close() {}
    async callTool({ name, arguments: args }) {
      calls.push({ name, args });
      const text = toolResult ? toolResult(name, args) : JSON.stringify({});
      return { content: [{ type: "text", text }], isError: false };
    }
  }
  class FakeTransport {
    constructor(url) {
      this.url = url;
    }
  }

  stubModule(clientPath, { Client: FakeClient });
  stubModule(transportPath, { StreamableHTTPClientTransport: FakeTransport });

  graphiti = require(graphitiPath);
  tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "kb-graphiti-test-"));
  fs.writeFileSync(path.join(tmpDir, "knowledge-base.json"), JSON.stringify({ graphitiEndpoint: "http://fake/mcp" }));
  graphiti.init(tmpDir, "knowledge-base");
  return graphiti;
}

afterEach(() => {
  delete require.cache[require.resolve("@modelcontextprotocol/sdk/client/index.js")];
  delete require.cache[require.resolve("@modelcontextprotocol/sdk/client/streamableHttp.js")];
  delete require.cache[require.resolve("../lib/graphiti")];
  if (tmpDir) fs.rmSync(tmpDir, { recursive: true, force: true });
});

describe("graphiti — add_memory (addEpisode)", () => {
  test("never sends a uuid — a new episode has none yet, and add_memory's uuid arg means 'look up an existing one'", async () => {
    freshGraphiti({
      toolResult: (name) => JSON.stringify({ message: `Episode queued` }),
    });
    await graphiti.addEpisode({ kbId: "kb1", name: "doc", episodeBody: "text" });

    assert.equal(calls.length, 1);
    assert.equal(calls[0].name, "add_memory");
    assert.equal(calls[0].args.group_id, "kb1");
    assert.equal(calls[0].args.name, "doc");
    assert.equal("uuid" in calls[0].args, false, "must not send uuid for a new episode — see graphiti.js's addEpisode comment");
  });
});

describe("graphiti — delete_episode (deleteEpisode)", () => {
  test("sends `uuid`, not `episode_uuid`", async () => {
    freshGraphiti();
    await graphiti.deleteEpisode({ episodeUuid: "ep-123" });
    assert.equal(calls.length, 1);
    assert.equal(calls[0].name, "delete_episode");
    assert.deepEqual(calls[0].args, { uuid: "ep-123" });
  });
});

describe("graphiti — clear_graph (clearGraph)", () => {
  test("sends `group_ids` as an array, not singular `group_id`", async () => {
    freshGraphiti();
    await graphiti.clearGraph({ kbId: "kb1" });
    assert.equal(calls.length, 1);
    assert.equal(calls[0].name, "clear_graph");
    assert.deepEqual(calls[0].args, { group_ids: ["kb1"] });
  });
});

describe("graphiti — get_episodes (getEpisodes)", () => {
  test("sends `group_ids` (array) + `max_episodes`, not group_id/reference_time/last_n", async () => {
    freshGraphiti({ toolResult: () => JSON.stringify({ episodes: [] }) });
    await graphiti.getEpisodes({ kbId: "kb1", lastN: 5 });
    assert.equal(calls.length, 1);
    assert.equal(calls[0].name, "get_episodes");
    assert.deepEqual(calls[0].args, { group_ids: ["kb1"], max_episodes: 5 });
  });
});

// This is the fix for the core bug this feature exists to address: add_memory
// is fire-and-forget and never returns an episode id, so the only way to know
// a queued episode actually made it into Graphiti — and the only way to learn
// its real uuid — is to poll get_episodes and match by the `name` we chose
// before queuing it. Marking a source "indexed" the moment add_memory's
// queued ack comes back — without ever checking it landed — is exactly what
// let files look ingested when nothing was ever pushed into Graphiti.
describe("graphiti — waitForEpisode (post-queue verification)", () => {
  test("resolves landed:true and returns the real uuid as soon as get_episodes reports a matching name", async () => {
    let call = 0;
    freshGraphiti({
      toolResult: (name) => {
        if (name !== "get_episodes") return JSON.stringify({});
        call++;
        // Not present on the first poll, present on the second — exercises
        // the actual polling loop, not just a first-try match.
        return JSON.stringify({ episodes: call < 2 ? [] : [{ uuid: "ep-abc", name: "doc" }] });
      },
    });
    const result = await graphiti.waitForEpisode({ kbId: "kb1", name: "doc", timeoutMs: 5000, pollIntervalMs: 5 });
    assert.equal(result.landed, true);
    assert.equal(result.uuid, "ep-abc");
    assert.equal(result.attempts, 2);
  });

  test("resolves landed:false (uuid: null) once timeoutMs elapses without a matching name ever appearing", async () => {
    freshGraphiti({ toolResult: () => JSON.stringify({ episodes: [{ uuid: "some-other-episode", name: "other doc" }] }) });
    const result = await graphiti.waitForEpisode({ kbId: "kb1", name: "doc", timeoutMs: 30, pollIntervalMs: 10 });
    assert.equal(result.landed, false);
    assert.equal(result.uuid, null);
    assert.ok(result.attempts >= 1);
  });

  test("matches on episode_uuid/id fallbacks the same way getEpisodes' own callers do", async () => {
    freshGraphiti({ toolResult: () => JSON.stringify({ episodes: [{ episode_uuid: "ep-xyz", name: "doc" }] }) });
    const result = await graphiti.waitForEpisode({ kbId: "kb1", name: "doc", timeoutMs: 5000, pollIntervalMs: 5 });
    assert.equal(result.landed, true);
    assert.equal(result.uuid, "ep-xyz");
  });

  test("sourceDescription narrows the match when two episodes share a name", async () => {
    freshGraphiti({
      toolResult: () =>
        JSON.stringify({
          episodes: [
            { uuid: "ep-wrong", name: "doc", source_description: "/other.md" },
            { uuid: "ep-right", name: "doc", source_description: "/mine.md" },
          ],
        }),
    });
    const result = await graphiti.waitForEpisode({ kbId: "kb1", name: "doc", sourceDescription: "/mine.md", timeoutMs: 5000, pollIntervalMs: 5 });
    assert.equal(result.landed, true);
    assert.equal(result.uuid, "ep-right");
  });
});

// 038 round 3: a fixed verification window can never be right for every
// deployment's real LLM/embeddings latency — a large multi-part PDF (21
// chunks) timed out at ~120s against a live Graphiti deployment even though
// ingestion was actually succeeding. currentVerifyTimeoutMs() makes the
// window operator-configurable via the same per-service config file
// currentEndpoint() already reads (config/config.html's Connection settings
// PATCHes it), so it can be raised without a code change once an operator
// has observed their own deployment's real latency.
describe("graphiti — episode verification timeout is configurable", () => {
  test("currentVerifyTimeoutMs reads episodeVerifyTimeoutSeconds from config and converts to ms", () => {
    freshGraphiti();
    fs.writeFileSync(path.join(tmpDir, "knowledge-base.json"), JSON.stringify({ graphitiEndpoint: "http://fake/mcp", episodeVerifyTimeoutSeconds: 42 }));
    assert.equal(graphiti.currentVerifyTimeoutMs(), 42000);
  });

  test("falls back to the 5-minute default when the config value is absent, non-numeric, or non-positive", () => {
    freshGraphiti();
    assert.equal(graphiti.currentVerifyTimeoutMs(), 300000, "no config file written yet");

    fs.writeFileSync(path.join(tmpDir, "knowledge-base.json"), JSON.stringify({ graphitiEndpoint: "http://fake/mcp" }));
    assert.equal(graphiti.currentVerifyTimeoutMs(), 300000, "key absent");

    fs.writeFileSync(path.join(tmpDir, "knowledge-base.json"), JSON.stringify({ graphitiEndpoint: "http://fake/mcp", episodeVerifyTimeoutSeconds: "not-a-number" }));
    assert.equal(graphiti.currentVerifyTimeoutMs(), 300000, "non-numeric");

    fs.writeFileSync(path.join(tmpDir, "knowledge-base.json"), JSON.stringify({ graphitiEndpoint: "http://fake/mcp", episodeVerifyTimeoutSeconds: -5 }));
    assert.equal(graphiti.currentVerifyTimeoutMs(), 300000, "non-positive");
  });

  test("waitForEpisode falls back to the configured timeout when no explicit timeoutMs is given", async () => {
    freshGraphiti({ toolResult: () => JSON.stringify({ episodes: [] }) });
    fs.writeFileSync(path.join(tmpDir, "knowledge-base.json"), JSON.stringify({ graphitiEndpoint: "http://fake/mcp", episodeVerifyTimeoutSeconds: 0.02 }));
    const result = await graphiti.waitForEpisode({ kbId: "kb1", name: "doc", pollIntervalMs: 5 });
    assert.equal(result.landed, false);
    assert.ok(result.elapsedMs >= 20, `expected elapsedMs >= 20 (the configured 20ms window), got ${result.elapsedMs}`);
  });
});
