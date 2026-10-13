// reingest-and-queue.test.mjs — re-ingesting a document or a whole bundle, and
// the run queue that makes a bundle-wide re-ingest safe.
//
// Before: a source already in the provenance ledger could never be ingested
// again — `okf_ingest` and the app's Ingest dialog answered "Already ingested"
// and stopped. And every ingest started its run the moment it was requested:
// on 2026-10-13 one request became seven concurrent runs, competing for one
// model, until the service ran out of heap. A "re-ingest everything" button on
// top of that would have started one run per document at once.
//
// Now: `reingest: true` re-acquires a known source from its ORIGIN and, when
// its run starts, clears the document (stub, chapters, chunk cache — raw/ is
// append-only and keeps every version) so the new run rewrites it under the
// same id. Every run goes through a queue capped at `maxConcurrentRuns`.
//
// Offline: the real core against the in-memory /api/fs and a mock delegate
// that HOLDS each run open until the test releases it — which is what makes
// "at most N at once" and "cleared when the run starts" observable.
//
//   node --test tests/reingest-and-queue.test.mjs

import http from "node:http";
import test, { after, before, beforeEach } from "node:test";
import assert from "node:assert/strict";
import { createRequire } from "node:module";
import { startMemFs } from "./memfs-server.mjs";

const require = createRequire(import.meta.url);
const core = require("../services/lib/okf-core.js");

const ROOT = "/KnowledgeBase";
let fs;
let delegate;
let seq = 0;
const runs = []; // {runId, task, release()}
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
      const runId = `headless-okf-ingest-q-${++seq}`;
      res.writeHead(200, { "Content-Type": "application/x-ndjson" });
      res.write(`${JSON.stringify({ type: "run_started", runId, agent: "okf-ingest" })}\n`);
      runs.push({
        runId,
        task: JSON.parse(body).task,
        release: () => res.end(`${JSON.stringify({ type: "done", text: "done", result: { endedReason: "completed" } })}\n`),
      });
    });
  });
  await new Promise((resolve) => delegate.listen(0, "127.0.0.1", resolve));
  previousEnv.PORT = process.env.PORT;
  previousEnv.OKF_DELEGATE_URL = process.env.OKF_DELEGATE_URL;
  process.env.PORT = String(fs.port);
  process.env.OKF_DELEGATE_URL = `http://127.0.0.1:${delegate.address().port}`;
});

after(async () => {
  for (const r of runs) r.release();
  for (const [k, v] of Object.entries(previousEnv)) {
    if (v === undefined) delete process.env[k];
    else process.env[k] = v;
  }
  await new Promise((resolve) => delegate.close(() => resolve()));
  await fs.close();
});

beforeEach(() => core.setMaxConcurrentRuns(2));

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
async function until(predicate, what) {
  for (let i = 0; i < 400; i++) {
    if (await predicate()) return;
    await sleep(25);
  }
  throw new Error(`timed out waiting for ${what}`);
}
const statusOf = async (id) => (await core.getJob(ROOT, id)).status;
const runFor = async (jobId) => {
  const job = await core.getJob(ROOT, jobId);
  return runs.find((r) => r.runId === job.runId);
};
async function finish(jobId) {
  await until(async () => !!(await runFor(jobId)), `${jobId} to start`);
  (await runFor(jobId)).release();
  await until(async () => (await statusOf(jobId)) === "completed", `${jobId} to complete`);
}

/** A bundle holding one ingested document, written the way an ingest leaves it. */
async function seedDocument(bundle, { originUrl = "https://example.test/report" } = {}) {
  await core.initBundle(ROOT, bundle);
  fs.write("/workspace/staged.md", "# Report\n\n## Part one\n\nAlpha.\n\n## Part two\n\nBeta.\n");
  const reg = await core.addRawSource(ROOT, bundle, { sourcePath: "/workspace/staged.md", originUrl });
  await core.upsertConcept(ROOT, bundle, reg.docId, { frontmatter: { type: "document", title: "Report", summary: "A report." } });
  await core.upsertConcept(ROOT, bundle, `${reg.docId}/part-one`, {
    sourceRange: { startHeading: 1 },
    frontmatter: { type: "section", parent: reg.docId, title: "Part one", concepts: ["alpha"], summary: "Alpha." },
  });
  return reg;
}
const exists = (p) => fs.paths().includes(p);

test("a known source is refused WITHOUT reingest — and the answer says how to re-ingest", async () => {
  const reg = await seedDocument("refuse");
  const res = await core.triggerIngest(ROOT, { bundle: "refuse", source: "https://example.test/report" });
  assert.equal(res.status, "already_ingested");
  assert.equal(res.docId, reg.docId);
  assert.match(res.note, /reingest: true/);
});

test("reingest: the document is re-acquired from its ORIGIN and cleared when its run STARTS; raw/ keeps every version", async () => {
  const reg = await seedDocument("again");
  const stub = `${ROOT}/again/concepts/${reg.docId}.md`;
  const chapter = `${ROOT}/again/concepts/${reg.docId}/part-one.md`;
  assert.ok(exists(stub) && exists(chapter));

  const res = await core.triggerIngest(ROOT, { bundle: "again", source: "https://example.test/report", reingest: true });
  assert.equal(res.status, "queued");
  await until(async () => !!(await runFor(res.jobId)), "the re-ingest run to start");

  assert.ok(!exists(stub), "the stub is cleared when the run starts");
  assert.ok(!exists(chapter), "the chapters are cleared when the run starts");
  assert.ok(!fs.paths().some((p) => p.startsWith(`${ROOT}/again/.chunks/${reg.docId}/`)), "the chunk cache is cleared");
  assert.ok(exists(`${ROOT}/again/${reg.rawFile}`), "raw/ is append-only — the old version stays");
  assert.match((await runFor(res.jobId)).task, /web_fetch\(\{"url":"https:\/\/example\.test\/report"/, "re-acquired from the origin URL");
  assert.equal((await core.getJob(ROOT, res.jobId)).reingestDocId, reg.docId);
  await finish(res.jobId);
});

test("a run started from INSIDE an ingest cannot re-ingest — it gets the ordinary answer", async () => {
  await seedDocument("nested-re");
  const parent = await core.triggerIngest(ROOT, { bundle: "nested-re", source: "https://example.test/other" });
  await until(async () => !!(await runFor(parent.jobId)), "the parent run");
  const res = await core.triggerIngest(ROOT, {
    bundle: "nested-re",
    source: "https://example.test/report",
    reingest: true,
    caller: { runId: (await runFor(parent.jobId)).runId, agentId: "okf-ingest" },
  });
  assert.equal(res.status, "already_ingested");
  await finish(parent.jobId);
});

test("at most maxConcurrentRuns run at once; the rest wait QUEUED and start as runs finish", async () => {
  await core.initBundle(ROOT, "queue");
  core.setMaxConcurrentRuns(2);
  const ids = [];
  for (const n of [1, 2, 3]) ids.push((await core.triggerIngest(ROOT, { bundle: "queue", source: `https://example.test/q${n}` })).jobId);

  await until(async () => (await statusOf(ids[0])) === "running" && (await statusOf(ids[1])) === "running", "two runs");
  await sleep(150);
  assert.equal(await statusOf(ids[2]), "queued", "the third waits — it is not started");
  assert.equal(await runFor(ids[2]), undefined);

  await finish(ids[0]);
  await until(async () => (await statusOf(ids[2])) === "running", "the third to start once a slot frees");
  await finish(ids[1]);
  await finish(ids[2]);
});

test("a queued job is never reaped as stale — it has no run that could have died", async () => {
  await core.initBundle(ROOT, "patient");
  core.setMaxConcurrentRuns(1);
  const a = (await core.triggerIngest(ROOT, { bundle: "patient", source: "https://example.test/p1" })).jobId;
  const b = (await core.triggerIngest(ROOT, { bundle: "patient", source: "https://example.test/p2" })).jobId;
  await until(async () => (await statusOf(a)) === "running", "the first run");
  const { reaped } = await core.reapStaleJobs(ROOT, { inactivityMs: 1, maxTotalMs: 1 });
  assert.ok(!reaped.includes(b), "the queued job is left alone");
  assert.equal(await statusOf(b), "queued");
  // (the RUNNING one is reaped by those absurd bounds — that is the reaper's job)
  // A cap change takes effect at the next pump — on the service, the restart
  // that reloads its config pumps on startup.
  core.setMaxConcurrentRuns(2);
  await core.pumpQueue(ROOT);
  await until(async () => (await statusOf(b)) === "running", "the queued job to start");
  await finish(b);
  (await runFor(a)).release();
});

test("a job cancelled while queued never starts", async () => {
  await core.initBundle(ROOT, "nevermind");
  core.setMaxConcurrentRuns(1);
  const a = (await core.triggerIngest(ROOT, { bundle: "nevermind", source: "https://example.test/n1" })).jobId;
  const b = (await core.triggerIngest(ROOT, { bundle: "nevermind", source: "https://example.test/n2" })).jobId;
  await core.cancelJob(ROOT, b);
  await finish(a);
  await sleep(150);
  assert.equal(await statusOf(b), "cancelled");
  assert.equal(await runFor(b), undefined, "no run was launched for it");
});

test("re-ingesting a bundle queues one re-ingest per document — not per asset — through the same cap", async () => {
  const reg = await seedDocument("whole", { originUrl: "https://example.test/one" });
  fs.write("/workspace/staged2.md", "# Two\n\nText.\n");
  const reg2 = await core.addRawSource(ROOT, "whole", { sourcePath: "/workspace/staged2.md", originUrl: "https://example.test/two" });
  fs.write(`${ROOT}/whole/raw/assets/${reg.docId}/fig.png`, "PNG");
  await core.addRawAsset(ROOT, "whole", { docId: reg.docId, sourcePath: `${ROOT}/whole/raw/assets/${reg.docId}/fig.png`, originUrl: "https://example.test/fig.png" });
  core.setMaxConcurrentRuns(1);

  const res = await core.reingestBundle(ROOT, "whole");
  assert.deepEqual(res.jobs.map((j) => j.docId).sort(), [reg.docId, reg2.docId].sort());
  const ids = res.jobs.map((j) => j.jobId);
  await until(async () => (await Promise.all(ids.map(statusOf))).filter((s) => s === "running").length === 1, "one running");
  assert.equal((await Promise.all(ids.map(statusOf))).filter((s) => s === "queued").length, 1, "the other waits");
  for (const id of ids) await finish(id);
});

test("a run whose source is a raw/ path gets chunks and a heading map before the agent starts", async () => {
  await core.initBundle(ROOT, "fromraw");
  fs.write(`${ROOT}/fromraw/raw/notes.md`, "Preamble.\n\n1 Introduction\n\nIntro text.\n\n2 Method\n\nMethod text.\n");
  const res = await core.triggerIngest(ROOT, { bundle: "fromraw", source: "raw/notes.md" });
  await until(async () => !!(await runFor(res.jobId)), "the run");
  const docId = core.docIdForSource("notes.md");
  const map = JSON.parse(fs.read(`${ROOT}/fromraw/.chunks/${docId}/headings.json`));
  assert.deepEqual(map.headings.map((h) => h.text), ["1 Introduction", "2 Method"]);
  const task = (await runFor(res.jobId)).task;
  assert.match(task, new RegExp(`\\.chunks/${docId}/001\\.md`), "the task hands the agent its chunks");
  assert.doesNotMatch(task, /Read it from there with `file_read`/, "never told to read the whole source");
  await finish(res.jobId);
});

test("re-ingesting ONE document by id re-acquires its recorded source — the app never needs to know it", async () => {
  const reg = await seedDocument("bydoc", { originUrl: "https://example.test/by-id" });
  const res = await core.reingestDocument(ROOT, "bydoc", reg.docId);
  assert.equal(res.docId, reg.docId);
  assert.equal(res.source, "https://example.test/by-id");
  await finish(res.jobId);
  await assert.rejects(core.reingestDocument(ROOT, "bydoc", "never-ingested"), (err) => err.statusCode === 404);
});

test("maxConcurrentRuns 0 PAUSES the queue: runs wait queued until it is raised", async () => {
  await core.initBundle(ROOT, "paused");
  core.setMaxConcurrentRuns(0);
  const id = (await core.triggerIngest(ROOT, { bundle: "paused", source: "https://example.test/held" })).jobId;
  await core.pumpQueue(ROOT);
  await sleep(150);
  assert.equal(await statusOf(id), "queued", "nothing starts while the queue is paused");
  assert.equal(core.getMaxConcurrentRuns(), 0);
  core.setMaxConcurrentRuns(1);
  await core.pumpQueue(ROOT);
  await finish(id);
});
