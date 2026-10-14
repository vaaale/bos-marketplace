// job-stream-worker.mjs — one ingest run, launched and driven by the real
// launcher (triggerIngest → driveRun → the delegate stream), inside a worker
// thread with the SAME heap limits ServiceManager gives the OKF service
// (src/core/service/ServiceManager.ts: RESOURCE_LIMITS). Spawned by
// job-store-memory.test.mjs; the heap limit is the boundary under test, and a
// plain `node --test` process has none.
//
// workerData: { port, delegatePort, root }

import { parentPort, workerData } from "node:worker_threads";
import { createRequire } from "node:module";

process.env.PORT = String(workerData.port);
process.env.OKF_DELEGATE_URL = `http://127.0.0.1:${workerData.delegatePort}`;
const core = createRequire(import.meta.url)("../../services/lib/okf-core.js");

const { root } = workerData;
await core.initBundle(root, "live");
const { jobId } = await core.triggerIngest(root, { bundle: "live", source: "https://x.test/live" });
for (;;) {
  const job = await core.getJob(root, jobId);
  if (["completed", "failed", "cancelled"].includes(job.status)) break;
  await new Promise((resolve) => setTimeout(resolve, 100));
}
parentPort.postMessage({ jobId });
