// job-trajectory-reload.test.mjs — the trajectory survives a service restart,
// and a job record written BEFORE the field existed still loads (FR-057).
//
// Its own file on purpose: okf-core's job store is a module-level hot map that
// loads once per process, so "what a cold service reads off disk" can only be
// observed in a process that has not loaded it yet.
//
//   node --test tests/

import test, { after, before } from "node:test";
import assert from "node:assert/strict";
import { createRequire } from "node:module";
import { startMemFs } from "./memfs-server.mjs";

const require = createRequire(import.meta.url);
const core = require("../services/lib/okf-core.js");

const ROOT = "/KnowledgeBase";
const TRAJECTORY = [
  { type: "run_started", runId: "headless-okf-ingest-restart", agent: "okf-ingest" },
  { type: "tool", tool: "okf_upsert_concept", input: { bundle: "b", id: "doc/ch" } },
  { type: "tool_result", result: { id: "doc/ch", created: true } },
  { type: "done", text: "done", result: { endedReason: "completed" } },
];

let fs;
let previousPort;

before(async () => {
  fs = await startMemFs();
  previousPort = process.env.PORT;
  process.env.PORT = String(fs.port);

  // a store written by a previous service lifetime: one record WITH a
  // trajectory, one from before the field existed
  const store = {
    seq: 1042,
    jobs: [
      {
        id: "run-1042", status: "completed", bundleId: "b", source: "https://x.test/a",
        queuedAt: "2026-10-12T09:00:00.000Z", startedAt: "2026-10-12T09:00:01.000Z",
        endedAt: "2026-10-12T09:00:40.000Z", durationMs: 39000, progress: null,
        summary: null, error: null, runId: "headless-okf-ingest-restart", cancelRequested: false,
        trajectory: TRAJECTORY,
      },
      {
        id: "run-1041", status: "completed", bundleId: "b", source: "https://x.test/legacy",
        queuedAt: "2026-10-11T09:00:00.000Z", startedAt: null, endedAt: null, durationMs: null,
        progress: null, summary: null, error: null, runId: null, cancelRequested: false,
      },
    ],
  };
  const res = await fetch(`http://127.0.0.1:${fs.port}/api/fs`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ op: "write", path: `${ROOT}/.jobs/jobs.json`, content: `${JSON.stringify(store, null, 2)}\n` }),
  });
  assert.ok(res.ok);
});

after(async () => {
  if (previousPort === undefined) delete process.env.PORT;
  else process.env.PORT = previousPort;
  await fs.close();
});

test("a cold load deserializes the trajectory array off disk", async () => {
  const job = await core.getJob(ROOT, "run-1042");
  assert.deepEqual(job.trajectory, TRAJECTORY);
});

test("a record written before the field existed loads with an empty trajectory, not undefined", async () => {
  const job = await core.getJob(ROOT, "run-1041");
  assert.deepEqual(job.trajectory, [], "every reader downstream is entitled to an array");
  const rows = await core.listJobs(ROOT);
  assert.equal(rows.find((j) => j.id === "run-1041").trajectoryEvents, 0);
  assert.equal(rows.find((j) => j.id === "run-1042").trajectoryEvents, TRAJECTORY.length);
});

test("appendJobTrajectory grows a live job's array and persists it", async () => {
  const event = { type: "tool", tool: "okf_lint", input: { bundle: "b" } };
  await core.appendJobTrajectory(ROOT, "run-1041", event);
  assert.deepEqual((await core.getJob(ROOT, "run-1041")).trajectory, [event]);

  // the coalescing window is 250ms; give the trailing write room to land
  await new Promise((r) => setTimeout(r, 400));
  const persisted = JSON.parse(fs.read(`${ROOT}/.jobs/jobs.json`));
  assert.deepEqual(persisted.jobs.find((j) => j.id === "run-1041").trajectory, [event]);

  // an unknown job is a no-op, not a throw — capture must never break a run
  assert.equal(await core.appendJobTrajectory(ROOT, "run-nope", event), null);
  assert.equal(await core.appendJobTrajectory(ROOT, "run-1041", null), null);
});
