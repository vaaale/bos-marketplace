// reap-stale-jobs.test.mjs — the configurable inactivity reaper
// (FR-059 / US13, ADR-014 Part B, tasks Y4 + AA7).
//
// The reaper has TWO bounds and they catch different failures:
//
//   • inactivity (`now - lastEventAt`) catches a run that went SILENT;
//   • total runtime (`now - startedAt`) catches a run that is ALIVE and
//     emitting events while making no progress — which inactivity, by
//     construction, can never see.
//
// What is tested here is which bound fires when, that a live run is never
// reaped by either, that a terminal job is never touched at all, and that
// the `error` names the bound that actually tripped — because a message
// that guesses the wrong cause ("most likely BOS restarted") sends the user
// looking in the wrong place.
//
// Offline: the real okf-core job store against the in-memory /api/fs
// stand-in (tests/memfs-server.mjs). No service, no BOS, no delegate.
//
//   node --test tests/reap-stale-jobs.test.mjs

import test from "node:test";
import assert from "node:assert/strict";
import { createRequire } from "node:module";
import { startMemFs } from "./memfs-server.mjs";

const require = createRequire(import.meta.url);
const core = require("../services/lib/okf-core.js");

const MINUTE = 60 * 1000;
const HOUR = 60 * MINUTE;
const INACTIVITY = 30 * MINUTE;
const MAX_TOTAL = 6 * HOUR;

const ago = (ms) => new Date(Date.now() - ms).toISOString();

/**
 * A fresh job store, seeded by writing the records directly — the reaper
 * reads whatever `loadJobs` finds, and building a 7-hour-old run any other
 * way would mean waiting 7 hours.
 */
async function withJobs(t, jobs) {
  const fs = await startMemFs();
  const previousPort = process.env.PORT;
  process.env.PORT = String(fs.port);
  t.after(async () => {
    if (previousPort === undefined) delete process.env.PORT;
    else process.env.PORT = previousPort;
    await fs.close();
  });

  const root = "/KB";
  const full = jobs.map((j, i) => ({
    id: j.id || `run-${1000 + i}`,
    status: "running",
    bundleId: "kb",
    source: "raw/doc.md",
    queuedAt: ago(8 * HOUR),
    startedAt: ago(10 * MINUTE),
    lastEventAt: null,
    endedAt: null,
    durationMs: null,
    progress: null,
    summary: null,
    error: null,
    runId: null,
    cancelRequested: false,
    trajectory: [],
    ...j,
  }));
  fs.write(`${root}/.jobs/jobs.json`, JSON.stringify({ jobs: full, seq: 1000 + full.length }, null, 2));
  // The store is module-level and cached across tests in one process.
  core.resetJobStore();
  return { fs, root };
}

const reap = (root) => core.reapStaleJobs(root, { inactivityMs: INACTIVITY, maxTotalMs: MAX_TOTAL });
const jobById = async (root, id) => core.getJob(root, id);

// ── (a) the inactivity bound ────────────────────────────────────────────

test("a run silent for 31 minutes is reaped — the INACTIVITY bound tripped", async (t) => {
  const { root } = await withJobs(t, [{ id: "run-silent", lastEventAt: ago(31 * MINUTE), startedAt: ago(40 * MINUTE) }]);

  const res = await reap(root);
  assert.deepEqual(res.reaped, ["run-silent"]);
  assert.equal(res.count, 1);

  const job = await jobById(root, "run-silent");
  assert.equal(job.status, "failed");
  assert.match(job.error, /no progress \(no trajectory event\)/);
  assert.match(job.error, /alive but silent/);
  // The restart is listed as ONE possible cause, never asserted as the cause.
  assert.match(job.error, /a long model generation, a provider stall, or a BOS restart/);
  assert.ok(!/most likely BOS restarted/.test(job.error), "the old wrong-by-default message is gone");
  assert.ok(!/maximum total runtime/.test(job.error), "the wrong bound is not named");
});

test("a run that never produced an event is reaped off startedAt", async (t) => {
  const { root } = await withJobs(t, [{ id: "run-mute", lastEventAt: null, startedAt: ago(45 * MINUTE) }]);
  const res = await reap(root);
  assert.deepEqual(res.reaped, ["run-mute"]);
  assert.match((await jobById(root, "run-mute")).error, /no progress/);
});

// ── (b) a live run is NOT reaped, however long it has been running ──────

test("a run that spoke 5 minutes ago is NOT reaped, even 35 minutes in", async (t) => {
  const { root } = await withJobs(t, [{ id: "run-live", lastEventAt: ago(5 * MINUTE), startedAt: ago(35 * MINUTE) }]);
  const res = await reap(root);
  assert.deepEqual(res.reaped, [], "inactivity is measured from the last event, not from the start");
  assert.equal((await jobById(root, "run-live")).status, "running");
});

test("a long ingest still emitting events is NOT reaped at 90 minutes", async (t) => {
  const { root } = await withJobs(t, [{ id: "run-long", lastEventAt: ago(20 * MINUTE), startedAt: ago(90 * MINUTE) }]);
  assert.deepEqual((await reap(root)).reaped, []);
});

// ── (c) the total-runtime backstop ──────────────────────────────────────

test("a run active 10 minutes ago but 7 hours old is reaped — the TOTAL bound tripped", async (t) => {
  const { root } = await withJobs(t, [{ id: "run-thrash", lastEventAt: ago(10 * MINUTE), startedAt: ago(7 * HOUR) }]);

  const res = await reap(root);
  assert.deepEqual(res.reaped, ["run-thrash"]);

  const job = await jobById(root, "run-thrash");
  assert.equal(job.status, "failed");
  assert.match(job.error, /exceeded the maximum total runtime \(6 hour\(s\)\)/);
  assert.match(job.error, /active but not progressing/);
  assert.ok(!/no progress \(no trajectory event\)/.test(job.error), "the inactivity message is not used for a total trip");
});

test("the inactivity message wins when BOTH bounds are past — it is the more specific observation", async (t) => {
  const { root } = await withJobs(t, [{ id: "run-dead", lastEventAt: ago(2 * HOUR), startedAt: ago(7 * HOUR) }]);
  await reap(root);
  assert.match((await jobById(root, "run-dead")).error, /no progress/);
});

// ── (d) terminal states are never reaped (unchanged behaviour) ──────────

test("completed / cancelled / failed jobs are never reaped, however old", async (t) => {
  const { root } = await withJobs(t, [
    { id: "run-done", status: "completed", lastEventAt: ago(9 * HOUR), startedAt: ago(9 * HOUR) },
    { id: "run-cancelled", status: "cancelled", lastEventAt: ago(9 * HOUR), startedAt: ago(9 * HOUR) },
    { id: "run-failed", status: "failed", error: "its own failure", lastEventAt: ago(9 * HOUR), startedAt: ago(9 * HOUR) },
  ]);

  assert.deepEqual((await reap(root)).reaped, []);
  assert.equal((await jobById(root, "run-done")).status, "completed");
  assert.equal((await jobById(root, "run-cancelled")).status, "cancelled");
  // a cancelled run keeps error:null — it is not a failure (FR-050)
  assert.equal((await jobById(root, "run-cancelled")).error, null);
  assert.equal((await jobById(root, "run-failed")).error, "its own failure", "an existing failure is not overwritten");
});

// This used to assert the opposite. Before the run queue a job was `queued`
// only for the instant before its run started, so one still queued 45 minutes
// later was a lost run. Now `queued` means WAITING for a slot under
// maxConcurrentRuns — reaping it would fail work that never started, and a
// restart re-pumps it instead (tests/reingest-and-queue.test.mjs).
test("a queued job is NOT a reap candidate — it is waiting for a run slot, not a run that died", async (t) => {
  const { root } = await withJobs(t, [{ id: "run-queued", status: "queued", startedAt: null, lastEventAt: null, queuedAt: ago(45 * MINUTE) }]);
  assert.deepEqual((await reap(root)).reaped, []);
  assert.equal((await jobById(root, "run-queued")).status, "queued");
});

// ── the bounds are CONFIGURABLE (US13 acceptance 3) ─────────────────────

test("a short configured inactivity bound reaps a run that the default would not", async (t) => {
  const { root } = await withJobs(t, [{ id: "run-short", lastEventAt: ago(10 * 1000), startedAt: ago(MINUTE) }]);

  assert.deepEqual((await reap(root)).reaped, [], "untouched under the 30-minute default");
  const res = await core.reapStaleJobs(root, { inactivityMs: 5 * 1000, maxTotalMs: MAX_TOTAL });
  assert.deepEqual(res.reaped, ["run-short"]);
  assert.equal(res.cutoffMs, 5 * 1000);
  assert.match((await jobById(root, "run-short")).error, /no progress/);
});

test("a short configured total bound reaps an actively-emitting run", async (t) => {
  const { root } = await withJobs(t, [{ id: "run-busy", lastEventAt: ago(1000), startedAt: ago(2 * MINUTE) }]);
  const res = await core.reapStaleJobs(root, { inactivityMs: 30 * MINUTE, maxTotalMs: 60 * 1000 });
  assert.deepEqual(res.reaped, ["run-busy"]);
  assert.equal(res.maxTotalMs, 60 * 1000);
  assert.match((await jobById(root, "run-busy")).error, /maximum total runtime/);
});

test("the pre-ADR-014 call shape (a bare number = the inactivity bound) still works", async (t) => {
  const { root } = await withJobs(t, [{ id: "run-legacy", lastEventAt: ago(31 * MINUTE), startedAt: ago(31 * MINUTE) }]);
  const res = await core.reapStaleJobs(root, INACTIVITY);
  assert.deepEqual(res.reaped, ["run-legacy"]);
  assert.equal(res.cutoffMs, INACTIVITY);
  assert.equal(res.maxTotalMs, 6 * HOUR, "the total backstop defaults in");
});

test("nonsense bounds fall back to the defaults rather than reaping everything", async (t) => {
  const { root } = await withJobs(t, [{ id: "run-ok", lastEventAt: ago(MINUTE), startedAt: ago(MINUTE) }]);
  const res = await core.reapStaleJobs(root, { inactivityMs: 0, maxTotalMs: -1 });
  assert.deepEqual(res.reaped, []);
  assert.equal(res.cutoffMs, 30 * MINUTE);
  assert.equal(res.maxTotalMs, 6 * HOUR);
});

// ── the liveness stamp itself (Y1) ──────────────────────────────────────

test("every captured trajectory event refreshes lastEventAt, and it is persisted", async (t) => {
  const { fs, root } = await withJobs(t, [{ id: "run-stamp", lastEventAt: ago(29 * MINUTE), startedAt: ago(29 * MINUTE) }]);

  await core.appendJobTrajectory(root, "run-stamp", { type: "reasoning_delta", text: "thinking" });
  const job = await jobById(root, "run-stamp");
  assert.ok(Date.now() - Date.parse(job.lastEventAt) < 5000, "the stamp moved to now");

  // ...and it survives a restart: the record on disk carries it, so a
  // reaper sweeping after a reload sees the same liveness it would have.
  const onDisk = JSON.parse(fs.read(`${root}/.jobs/jobs.json`)).jobs.find((j) => j.id === "run-stamp");
  assert.equal(onDisk.lastEventAt, job.lastEventAt);
  assert.equal(onDisk.trajectoryEvents, 1);
  assert.equal(JSON.parse(fs.read(`${root}/.jobs/trajectories/run-stamp.json`)).length, 1);

  assert.deepEqual((await reap(root)).reaped, [], "a run that just spoke is not stale");
});
