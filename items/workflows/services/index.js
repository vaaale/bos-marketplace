// Workflow Manager service — lifecycle-only daemon (user-specs/002-service-daemons).
// Execution runs on the main BOS process (src/lib/workflows/runner.ts) because
// it delegates to runSubAgent() (the full assistant/LLM stack), which can't
// reasonably run isolated in a worker_thread. This worker exists purely to
// give Workflows a Settings -> Plugins -> Services lifecycle: "running" lets
// /api/workflows/run proceed, "stopped" refuses new runs. initialize/dispose
// are near-instant no-ops.
//
// Same CH-011 concern as every other service worker: this file is also
// import()ed from the MAIN thread (parentPort === null there) by
// validateManifestAtStart's load check, so every top-level parentPort use
// must be guarded.
const { parentPort } = require("worker_threads");

if (parentPort) {
  parentPort.on("message", (msg) => {
    if (!msg || typeof msg.type !== "string") return;
    if (msg.type === "initialize") {
      parentPort.postMessage({ type: "initialized" });
    } else if (msg.type === "dispose") {
      parentPort.postMessage({ type: "disposed" });
    }
  });
}
