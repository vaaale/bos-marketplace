// job-trajectory.test.mjs — the launcher captures the run's NDJSON stream onto
// the job record (FR-057, ADR-013).
//
// This drives the REAL path end to end, offline: a mock delegate endpoint
// (pointed at by OKF_DELEGATE_URL, the seam delegate-bridge already resolves
// both the delegate and the abort call through) streams NDJSON at the real
// `core.triggerIngest` -> `driveRun` -> `delegate.runIngestAgent` chain, whose
// storage goes through the real okf-core job store over the in-memory /api/fs
// stand-in (tests/memfs-server.mjs). Nothing here stubs okf-core itself.
//
// One rig for the whole file: okf-core's job store is a single module-level
// hot map, so a second bundleRoot in the same process would share it.
//
//   node --test tests/

import http from "node:http";
import test, { after, before } from "node:test";
import assert from "node:assert/strict";
import { createRequire } from "node:module";
import { startMemFs } from "./memfs-server.mjs";

const require = createRequire(import.meta.url);
const core = require("../services/lib/okf-core.js");

const ROOT = "/KnowledgeBase";

const RUN = [
  { type: "run_started", runId: "headless-okf-ingest-abc123", agent: "okf-ingest", at: "2026-10-12T09:00:00Z" },
  { type: "tool", tool: "web_fetch", input: { url: "https://example.test/doc", output_path: "/workspace/okf-staged-doc.md" } },
  { type: "tool_result", result: { bytes: 4210, savedTo: "/workspace/okf-staged-doc.md" } },
  { type: "reasoning_delta", text: "thinking about the structure" },
  { type: "tool", tool: "okf_add_raw_source", input: { bundle: "traj", sourcePath: "/workspace/okf-staged-doc.md" } },
  { type: "tool_result", result: { rawFile: "raw/doc.md", docId: "doc", chunks: [{ path: ".chunks/doc/001.md", ordinal: 1, total: 1 }] } },
  { type: "done", text: "Ingested: 2 chapters, 3 concepts, 0 assets, 0 refs skipped, 0 refs failed.", result: { endedReason: "completed" } },
];

let fs;
let delegate;
let script = RUN; // what the next delegated run streams back
const previousEnv = {};

before(async () => {
  fs = await startMemFs();

  delegate = http.createServer((req, res) => {
    if (req.method !== "POST" || req.url !== "/api/subagents/delegate") {
      res.writeHead(404, { "Content-Type": "application/json" });
      return res.end('{"error":"no route"}');
    }
    req.resume();
    req.on("end", async () => {
      res.writeHead(200, { "Content-Type": "application/x-ndjson" });
      for (const event of script) {
        res.write(`${JSON.stringify(event)}\n`);
        // one line per tick, so the launcher really is reading a stream
        await new Promise((r) => setImmediate(r));
      }
      res.end();
    });
  });
  await new Promise((resolve) => delegate.listen(0, "127.0.0.1", resolve));

  previousEnv.PORT = process.env.PORT;
  previousEnv.OKF_DELEGATE_URL = process.env.OKF_DELEGATE_URL;
  process.env.PORT = String(fs.port);
  process.env.OKF_DELEGATE_URL = `http://127.0.0.1:${delegate.address().port}`;
});

after(async () => {
  for (const [k, v] of Object.entries(previousEnv)) {
    if (v === undefined) delete process.env[k];
    else process.env[k] = v;
  }
  await new Promise((resolve) => delegate.close(() => resolve()));
  await fs.close();
});

async function waitForTerminal(jobId, timeoutMs = 10000) {
  const deadline = Date.now() + timeoutMs;
  for (;;) {
    const job = await core.getJob(ROOT, jobId);
    if (job && ["completed", "failed", "cancelled"].includes(job.status)) return job;
    if (Date.now() > deadline) throw new Error(`job ${jobId} never ended (last: ${job && job.status})`);
    await new Promise((r) => setTimeout(r, 25));
  }
}

async function runOnce(bundle, source, events) {
  script = events;
  await core.initBundle(ROOT, bundle).catch(() => {});
  const started = await core.triggerIngest(ROOT, { bundle, source });
  assert.equal(started.status, "queued", "the trigger must return before the run does");
  return { id: started.jobId, job: await waitForTerminal(started.jobId) };
}

test("the launcher records every stream event, in order and verbatim, on the job record", async () => {
  const { id, job } = await runOnce("traj", "https://example.test/doc", RUN);

  assert.equal(job.status, "completed");
  assert.equal(job.runId, "headless-okf-ingest-abc123");

  // every line, in stream order — including the ones the launcher does not act on
  assert.deepEqual(job.trajectory, RUN);
  assert.deepEqual(job.trajectory.map((e) => e.type), [
    "run_started", "tool", "tool_result", "reasoning_delta", "tool", "tool_result", "done",
  ]);
  // the wire type for a tool call is `tool` — NOT `tool_call` (ADR-013)
  assert.equal(job.trajectory[1].type, "tool");
  assert.equal(job.trajectory[1].tool, "web_fetch");
  assert.ok(job.trajectory[1].input.url);
  // the tool/tool_result pairing is POSITIONAL: there is no callId on the wire
  assert.ok(!("callId" in job.trajectory[1]));
  assert.ok(!("callId" in job.trajectory[2]));

  // and it is on DISK, in the persisted store, so a restart does not lose it
  const persisted = JSON.parse(fs.read(`${ROOT}/.jobs/jobs.json`));
  assert.deepEqual(persisted.jobs.find((j) => j.id === id).trajectory, RUN);
});

test("a crashed run captures the terminal `error` event alongside whatever preceded it", async () => {
  const events = [
    { type: "run_started", runId: "headless-okf-ingest-dead", agent: "okf-ingest" },
    { type: "tool", tool: "web_fetch", input: { url: "https://gone.test/x" } },
    { type: "tool_result", result: { ok: false, status: 410 } },
    { type: "error", error: "HTTP 410 Gone — the source no longer exists", at: "2026-10-12T09:01:00Z" },
  ];
  const { job } = await runOnce("boom", "https://gone.test/x", events);

  assert.equal(job.status, "failed");
  assert.equal(job.trajectory.length, 4);
  assert.equal(job.trajectory[3].type, "error");
  assert.match(job.trajectory[3].error, /410/);
});

test("a run that produces NO events leaves an empty trajectory — the app's only 'No trajectory' case", async () => {
  const { job } = await runOnce("silent", "https://quiet.test/x", []);
  assert.equal(job.status, "failed");
  assert.deepEqual(job.trajectory, []);
});

test("the LIST surfaces carry the event count, not the events — the detail read carries the array", async () => {
  const { id } = await runOnce("listed", "https://example.test/listed", RUN);

  const [row] = await core.listJobs(ROOT, { bundleId: "listed" });
  assert.equal(row.trajectory, undefined, "a list row must not carry tens of KB of events");
  assert.equal(row.trajectoryEvents, RUN.length);
  assert.equal(row.id, id);

  // okf_list_jobs rides the same projection (ADR-013 keeps the trajectory off
  // the agent surface), while the detail read is complete
  assert.deepEqual((await core.getJob(ROOT, id)).trajectory, RUN);
  assert.equal(core.jobListView(await core.getJob(ROOT, id)).trajectory, undefined);
});
