// job-store-memory.test.mjs — the job store survives a live run inside the
// service's 256 MB heap, whatever history it has accumulated (FR-057, ADR-013).
//
//   node --test tests/job-store-memory.test.mjs
//
// The reproduction (production, 2026-10-14): the OKF worker died with "Worker
// terminated due to reaching memory limit: JS heap out of memory" seven times
// in two days — mid-e2e, during okf_read_toc and okf_list_concepts, i.e. during
// whatever happened to be running. The cause was the job store:
//
//   • every record carried its run's FULL trajectory, so `.jobs/jobs.json` held
//     40 runs' worth of tool results — 13 MB, non-ASCII, so every in-heap copy
//     of it is a two-byte string — and the hot map kept all of it resident;
//   • every captured event rewrote that whole file, JSON-encoded twice on the
//     way to /api/fs (the store, then the request body):
//
//       await vfs.writeText(jobsPath(bundleRoot), JSON.stringify(jobsState, null, 2) + "\n")
//
//   • and nothing serialised those rewrites. `schedulePersistJobs` starts a
//     write whenever 250 ms have passed since the last one STARTED, so when one
//     takes longer than that they overlap — five at once, ~60 MB of transient
//     strings each — and whichever lands last wins, even if it is the oldest.
//
// The contract this file pins: a run's trajectory lives in its own file, a
// job record does not carry it, and no file has two writes in flight.

import test from "node:test";
import assert from "node:assert/strict";
import http from "node:http";
import { Worker } from "node:worker_threads";
import { createRequire } from "node:module";
import { startMemFs } from "./memfs-server.mjs";

const require = createRequire(import.meta.url);
const core = require("../services/lib/okf-core.js");

// ServiceManager's RESOURCE_LIMITS — the boundary the service actually runs in.
const RESOURCE_LIMITS = { maxOldGenerationSizeMb: 256, maxYoungGenerationSizeMb: 64 };

const jobsFile = (root) => `${root}/.jobs/jobs.json`;
const trajectoryFile = (root, id) => `${root}/.jobs/trajectories/${id}.json`;

/** A completed job record as a store written by any earlier service holds it. */
function record(id, extra = {}) {
  return {
    id, status: "completed", bundleId: "b", source: `https://x.test/${id}`,
    maxDepth: null, maxWorkers: null, parentJobId: null, reingestDocId: null,
    queuedAt: "2026-10-12T09:00:00.000Z", startedAt: "2026-10-12T09:00:01.000Z", lastEventAt: null,
    endedAt: "2026-10-12T09:00:40.000Z", durationMs: 39000, progress: null,
    summary: null, error: null, runId: `headless-okf-ingest-${id}`, cancelRequested: false,
    ...extra,
  };
}

async function freshStore(t, jobs) {
  const fs = await startMemFs();
  const previousPort = process.env.PORT;
  process.env.PORT = String(fs.port);
  const root = "/KnowledgeBase";
  if (jobs) fs.write(jobsFile(root), `${JSON.stringify({ jobs, seq: 2000 }, null, 2)}\n`);
  core.resetJobStore();
  t.after(async () => {
    core.resetJobStore();
    if (previousPort === undefined) delete process.env.PORT;
    else process.env.PORT = previousPort;
    await fs.close();
  });
  return { fs, root };
}

// ── AP1 — the reproduction, at the boundary it happened at ───────────────

/**
 * A completed run's trajectory shaped like production's: tool calls whose
 * results are JSON TEXT (an okf_* tool returns a JSON string), so every
 * rewrite of a store that embeds them escapes those quotes once for the
 * store and again for the /api/fs request body.
 */
function productionTrajectory(tag) {
  const terms = Array.from({ length: 60 }, (_, i) => ({
    term: `term ${tag}-${i}`, kind: "topic", count: 2,
    covers: [{ docId: `doc-${tag}`, chId: `ch-${i}`, title: `${i}. Section`, description: `Résumé of section ${i}: "quoted" detail.` }],
  }));
  const events = [{ type: "run_started", runId: `headless-okf-ingest-${tag}` }];
  for (let i = 0; i < 18; i++) {
    events.push({ type: "reasoning_delta", delta: "Reading the next chunk, then deciding chapters. ".repeat(20) });
    events.push({ type: "tool", tool: "okf_list_concepts", input: { bundle: "b" } });
    events.push({ type: "tool_result", name: "okf_list_concepts", result: JSON.stringify({ terms }) });
  }
  events.push({ type: "done", text: "Ingested.", result: { endedReason: "completed" } });
  return events;
}

/** The delegate endpoint: one run's NDJSON, paced like a streaming model. */
async function startDelegate(t) {
  const chunk = "Article 9 — risk management system. ".repeat(900); // a ~32 KB chunk file_read
  const server = http.createServer((req, res) => {
    req.resume();
    req.on("end", async () => {
      res.writeHead(200, { "Content-Type": "application/x-ndjson" });
      const line = (e) => res.write(`${JSON.stringify(e)}\n`);
      const tick = () => new Promise((resolve) => setTimeout(resolve, 10));
      line({ type: "run_started", runId: "headless-okf-ingest-live" });
      for (let i = 0; i < 40; i++) {
        for (let r = 0; r < 20; r++) {
          line({ type: "reasoning_delta", delta: "token " });
          await tick();
        }
        line({ type: "tool", tool: "file_read", input: { path: `.chunks/doc/${i}.md` } });
        await tick();
        line({ type: "tool_result", result: chunk });
      }
      line({ type: "done", text: "Ingested: 1 chapters", result: { endedReason: "completed" } });
      res.end();
    });
  });
  await new Promise((resolve) => server.listen(0, "127.0.0.1", resolve));
  t.after(() => new Promise((resolve) => server.close(() => resolve())));
  return server.address().port;
}

test("AP1 an ingest run on top of a production-sized history does not exhaust the worker's heap", async (t) => {
  // 40 completed runs: production's store when the worker died (13 MB).
  const history = Array.from({ length: 40 }, (_, i) => record(`run-${1100 + i}`, { trajectory: productionTrajectory(i) }));
  const { fs, root } = await freshStore(t, history);
  const delegatePort = await startDelegate(t);

  const worker = new Worker(new URL("./fixtures/job-stream-worker.mjs", import.meta.url), {
    workerData: { port: fs.port, delegatePort, root },
    resourceLimits: RESOURCE_LIMITS,
  });
  const outcome = await new Promise((resolve) => {
    worker.once("message", (m) => resolve({ ok: true, ...m }));
    worker.once("error", (err) => resolve({ ok: false, error: err.message }));
    worker.once("exit", (code) => resolve({ ok: false, error: `exited ${code} before finishing` }));
  });
  await worker.terminate();

  assert.equal(outcome.error, undefined, "the worker must survive the run");
  // ...and the run it survived is recorded in full: run_started, 40 × (one
  // merged reasoning event, tool, tool_result), done.
  const stored = JSON.parse(fs.read(trajectoryFile(root, outcome.jobId)));
  assert.equal(stored.length, 1 + 40 * 3 + 1);
});

// ── AP2 — a job record does not carry its trajectory ─────────────────────

test("AP2 the trajectory is stored in its own file, not in jobs.json, and survives a restart", async (t) => {
  const { fs, root } = await freshStore(t);
  const job = await core.createJob(root, { bundleId: "b", source: "https://x.test/a" });
  const events = [
    { type: "run_started", runId: "headless-okf-ingest-a" },
    { type: "tool", tool: "file_read", input: { path: "/x" } },
    { type: "tool_result", result: "# X" },
  ];
  for (const e of events) await core.appendJobTrajectory(root, job.id, e);
  await core.updateJob(root, job.id, { status: "completed" });

  const store = JSON.parse(fs.read(jobsFile(root)));
  const onDisk = store.jobs.find((j) => j.id === job.id);
  assert.equal(onDisk.trajectory, undefined, "jobs.json holds records, not every run's tool results");
  assert.equal(onDisk.trajectoryEvents, 3, "the list's event count is on the record");
  assert.deepEqual(JSON.parse(fs.read(trajectoryFile(root, job.id))), events);

  core.resetJobStore(); // a restart
  assert.deepEqual((await core.getJob(root, job.id)).trajectory, events);
  const [row] = await core.listJobs(root);
  assert.equal(row.trajectory, undefined);
  assert.equal(row.trajectoryEvents, 3);
});

// ── AP3 — one write per file at a time, and the last write is the newest ──

test("AP3 a burst of events never has two writes of one file in flight, and the newest state lands last", async (t) => {
  const { fs, root } = await freshStore(t);
  const job = await core.createJob(root, { bundleId: "b", source: "https://x.test/burst" });
  fs.delayWrites(100);

  const appended = [];
  for (let i = 0; i < 60; i++) {
    appended.push(core.appendJobTrajectory(root, job.id, { type: "tool_result", result: `event ${i}` }));
    await new Promise((resolve) => setTimeout(resolve, 3));
  }
  await Promise.all(appended);
  await core.updateJob(root, job.id, { status: "completed", summary: "done" });

  assert.equal(fs.peakWritesInFlight(jobsFile(root)), 1);
  assert.equal(fs.peakWritesInFlight(trajectoryFile(root, job.id)), 1);
  const stored = JSON.parse(fs.read(trajectoryFile(root, job.id)));
  assert.equal(stored.length, 60);
  assert.equal(stored[59].result, "event 59");
  assert.equal(JSON.parse(fs.read(jobsFile(root))).jobs.find((j) => j.id === job.id).status, "completed");
});

// ── AP4 — a store written by an earlier service converges ────────────────

test("AP4 inline trajectories in an older store move to their own files on load", async (t) => {
  const inline = [{ type: "tool", tool: "web_fetch", input: { url: "https://x.test" } }, { type: "tool_result", result: "ok" }];
  const kept = [{ type: "run_started", runId: "r" }];
  const { fs, root } = await freshStore(t, [
    record("run-1"),
    record("run-2", { trajectory: inline }),
    // An older service reading a NEW store sees no trajectory and writes one
    // back empty (keeping the count, a field it does not know and passes
    // through) — that must not erase the file the newer service wrote.
    record("run-3", { trajectory: [], trajectoryEvents: 1 }),
  ]);
  fs.write(trajectoryFile(root, "run-3"), JSON.stringify(kept));

  const rows = await core.listJobs(root);
  assert.deepEqual(rows.map((r) => [r.id, r.trajectoryEvents]), [["run-1", 0], ["run-2", 2], ["run-3", 1]]);
  assert.ok(JSON.parse(fs.read(jobsFile(root))).jobs.every((j) => j.trajectory === undefined), "jobs.json is rewritten without them");
  assert.deepEqual(JSON.parse(fs.read(trajectoryFile(root, "run-2"))), inline);
  assert.deepEqual((await core.getJob(root, "run-2")).trajectory, inline);
  assert.deepEqual((await core.getJob(root, "run-3")).trajectory, kept);
  assert.deepEqual((await core.getJob(root, "run-1")).trajectory, []);
});

// ── AP5 — a store that could not be read is not an empty store ────────────

test("AP5 a failed read of jobs.json is an error, never a clean store that overwrites the history", async (t) => {
  const { fs, root } = await freshStore(t, [record("run-1")]);
  const before = fs.read(jobsFile(root));
  fs.failNext("read", jobsFile(root));

  await assert.rejects(core.createJob(root, { bundleId: "b", source: "https://x.test/a" }), /jobs\.json/);
  assert.equal(fs.read(jobsFile(root)), before, "the history on disk is untouched");

  // A corrupt file is the same: report it, do not replace it.
  fs.write(jobsFile(root), "{ not json");
  core.resetJobStore();
  await assert.rejects(core.listJobs(root), /jobs\.json/);
  assert.equal(fs.read(jobsFile(root)), "{ not json");
});

// ── AP6 — removing a record removes its trajectory ────────────────────────

test("AP6 deleting a job, or trimming it from the history, deletes its trajectory file", async (t) => {
  const { fs, root } = await freshStore(t);
  const job = await core.createJob(root, { bundleId: "b", source: "https://x.test/a" });
  await core.appendJobTrajectory(root, job.id, { type: "tool_result", result: "x" });
  await core.updateJob(root, job.id, { status: "completed" });
  assert.ok(fs.read(trajectoryFile(root, job.id)));

  await core.deleteJob(root, job.id);
  assert.equal(fs.read(trajectoryFile(root, job.id)), undefined);

  // the history cap: the oldest record past the limit takes its file with it
  const oldest = await core.createJob(root, { bundleId: "b", source: "https://x.test/oldest" });
  await core.appendJobTrajectory(root, oldest.id, { type: "tool_result", result: "old" });
  await core.updateJob(root, oldest.id, { status: "completed" });
  for (let i = 0; i < core.JOB_HISTORY_LIMIT; i++) await core.createJob(root, { bundleId: "b", source: `https://x.test/${i}` });
  assert.equal(await core.getJob(root, oldest.id), null);
  assert.equal(fs.read(trajectoryFile(root, oldest.id)), undefined);
});
