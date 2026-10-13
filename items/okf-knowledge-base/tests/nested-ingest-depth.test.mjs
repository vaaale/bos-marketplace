// nested-ingest-depth.test.mjs — a reference ingested FROM INSIDE an ingest run
// inherits that run's remaining depth; it never starts over at the default.
//
// The reproduction is production, 2026-10-13: one PDF (run-1005, maxDepth 1)
// followed its references with `okf_ingest`, each child was created with the
// default maxDepth 1 again, and those children followed THEIR references —
//
//   run-1005 → run-1008, run-1009
//   run-1008 → run-1010, run-1011, run-1012, run-1014
//   run-1009 → run-1013
//
// seven concurrent ingest runs from one request, with no bound but the
// reference graph, until the service's heap gave out. The prompt's "follow at
// most N hops" could not hold: nothing told the CHILD it was a child.
//
// The service now knows, without asking the model: BOS passes the calling run
// on every tool call (`caller.runId`), and a job records its run's id, so a call
// whose run belongs to one of this service's jobs is a nested ingest. A depth
// the model passes itself would be a bound it could switch off by leaving it out.
//
// Offline: the real `okf_ingest` tool handler -> core.triggerIngest -> driveRun
// against a mock delegate (OKF_DELEGATE_URL) and the in-memory /api/fs.
//
//   node --test tests/nested-ingest-depth.test.mjs

import http from "node:http";
import test, { after, before } from "node:test";
import assert from "node:assert/strict";
import { createRequire } from "node:module";
import { startMemFs } from "./memfs-server.mjs";

const require = createRequire(import.meta.url);
const core = require("../services/lib/okf-core.js");
const { makeHandlers } = require("../services/lib/tools.js");

const ROOT = "/KnowledgeBase";
const BUNDLE = "depth";
const handlers = makeHandlers(core);

let fs;
let delegate;
let runSeq = 0;
const tasks = []; // every task the service launched, in order
const previousEnv = {};

before(async () => {
  fs = await startMemFs();
  delegate = http.createServer((req, res) => {
    if (req.method !== "POST" || req.url !== "/api/subagents/delegate") {
      res.writeHead(404, { "Content-Type": "application/json" });
      return res.end('{"error":"no route"}');
    }
    let body = "";
    req.on("data", (c) => (body += c));
    req.on("end", () => {
      tasks.push(JSON.parse(body).task);
      const runId = `headless-okf-ingest-test-${++runSeq}`;
      res.writeHead(200, { "Content-Type": "application/x-ndjson" });
      res.write(`${JSON.stringify({ type: "run_started", runId, agent: "okf-ingest" })}\n`);
      res.end(`${JSON.stringify({ type: "done", text: "done", result: { endedReason: "completed" } })}\n`);
    });
  });
  await new Promise((resolve) => delegate.listen(0, "127.0.0.1", resolve));
  previousEnv.PORT = process.env.PORT;
  previousEnv.OKF_DELEGATE_URL = process.env.OKF_DELEGATE_URL;
  process.env.PORT = String(fs.port);
  process.env.OKF_DELEGATE_URL = `http://127.0.0.1:${delegate.address().port}`;
  await core.initBundle(ROOT, BUNDLE);
});

after(async () => {
  for (const [k, v] of Object.entries(previousEnv)) {
    if (v === undefined) delete process.env[k];
    else process.env[k] = v;
  }
  await new Promise((resolve) => delegate.close(() => resolve()));
  await fs.close();
});

async function settled(jobId) {
  for (let i = 0; i < 400; i++) {
    const job = await core.getJob(ROOT, jobId);
    if (job && job.runId && ["completed", "failed", "cancelled"].includes(job.status)) return job;
    await new Promise((r) => setTimeout(r, 25));
  }
  throw new Error(`job ${jobId} never settled`);
}

/** The tool call exactly as the worker makes it: args from the model, the
 *  caller from BOS. */
function okfIngest(args, caller) {
  return handlers.okf_ingest(
    { bundle: BUNDLE, ...args },
    { core, bundleRoot: ROOT, ingestDefaults: { maxDepth: 1, maxWorkers: 2 }, ...(caller ? { caller } : {}) },
  );
}

test("a top-level ingest gets the requested or default depth — nothing about it changes", async () => {
  const started = await okfIngest({ source: "https://example.test/top" }, { runId: "run-some-chat", agentId: "assistant" });
  assert.equal(started.status, "queued");
  assert.equal(started.maxDepth, 1);
  const job = await settled(started.jobId);
  assert.equal(job.parentJobId ?? null, null);
});

test("a reference ingested from inside a run inherits ONE hop less, and records its parent", async () => {
  const parent = await settled((await okfIngest({ source: "https://example.test/seed", maxDepth: 3 })).jobId);

  const child = await okfIngest({ source: "https://example.test/ref" }, { runId: parent.runId, agentId: "okf-ingest" });
  assert.equal(child.status, "queued");
  // 2, not the default 1 — the child's bound comes from its parent
  assert.equal(child.maxDepth, 2, "the parent had 3 hops; its reference has 2 left");
  assert.equal((await settled(child.jobId)).parentJobId, parent.id);
});

test("a nested ingest cannot ask for MORE depth than its parent has left", async () => {
  const parent = await settled((await okfIngest({ source: "https://example.test/seed2", maxDepth: 1 })).jobId);

  const child = await okfIngest({ source: "https://example.test/ref2", maxDepth: 5 }, { runId: parent.runId, agentId: "okf-ingest" });
  assert.equal(child.maxDepth, 0, "a model-supplied maxDepth may lower the bound, never raise it");
  await settled(child.jobId);
  assert.match(tasks.at(-1), /do NOT follow any references/i, "a run with no hops left is told so, not told to follow 0 hops");
});

test("a run with no hops left cannot start another run at all", async () => {
  const seed = await settled((await okfIngest({ source: "https://example.test/seed3", maxDepth: 1 })).jobId);
  const leaf = await settled(
    (await okfIngest({ source: "https://example.test/leaf" }, { runId: seed.runId, agentId: "okf-ingest" })).jobId,
  );
  const before = (await core.listJobs(ROOT)).length;

  const refused = await okfIngest({ source: "https://example.test/too-deep" }, { runId: leaf.runId, agentId: "okf-ingest" });

  assert.equal(refused.status, "over_depth");
  assert.equal(refused.jobId, null);
  assert.equal((await core.listJobs(ROOT)).length, before, "no job is created past the depth limit");
});
