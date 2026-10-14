// index.js — the OKF Knowledge Base service worker entrypoint.
//
// Retained unchanged in shape from the pre-redesign item (spec Assumptions):
// the bind-then-handshake-first ordering, the loopback VFS bridge, and the
// 039 tool_declare loop. What changed around it: DECLARATIONS is now the
// 21-tool surface, createRequestHandler serves the standalone app's REST
// routes (bundles/toc/concept/search/graph/jobs) instead of the old
// settings config-app's, and this file now also runs the JOB STALE REAPER
// (see startReaper below).
//
// This file is also `import()`ed from BOS's MAIN thread (parentPort === null)
// during manifest validation (validateManifestAtStart, CH-011) — every use of
// parentPort below MUST stay inside the `if (parentPort)` guard so that
// load-time `import()` never throws.

const { parentPort } = require("worker_threads");
const fs = require("fs");
const fsp = fs.promises;
const path = require("path");
const http = require("http");

const core = require("./lib/okf-core");
const { DECLARATIONS, makeHandlers } = require("./lib/tools");
const { createRequestHandler } = require("./lib/http-bridge");
const vfsBridge = require("./lib/vfs-bridge");

const DEFAULT_BUNDLE_ROOT = "/KnowledgeBase";
// Bundle-level ingest crawl limits (per-call overridable on okf_ingest).
const DEFAULT_MAX_DEPTH = 1;
const DEFAULT_MAX_WORKERS = 3;
// The ingest chunk bound (ADR-012 / FR-056): okf_add_raw_source pre-splits any
// source larger than this so the agent never file_reads a whole document into
// its context. ~8K tokens.
const DEFAULT_MAX_CHUNK_SIZE = 32000;
// How long a job may sit non-terminal before the reaper calls it lost.
// 30 minutes: comfortably longer than a real ingest run (minutes), short
// enough that a run orphaned by a restart does not spin for a whole day.
const DEFAULT_STALE_JOB_MS = 30 * 60 * 1000;
// FR-059 / ADR-014 B3 — the total-runtime backstop, independent of activity.
const DEFAULT_MAX_TOTAL_TIMEOUT_MS = 6 * 60 * 60 * 1000;
// How often the reaper sweeps. A fifth of the default staleness window, so
// a lost run is admitted to within a few minutes of actually being lost.
const REAPER_INTERVAL_MS = 5 * 60 * 1000;
const handlers = makeHandlers(core);

if (parentPort) {
  let server = null;
  let boundPort = null;
  // bundleRoot is a BOS VFS path (e.g. "/KnowledgeBase") — this is what the
  // app and okf_* tool results report back, AND what's actually passed
  // to okf-core's storage functions. okf-core never touches the host
  // filesystem itself: every read/write/mkdir goes through ./lib/vfs-bridge's
  // loopback calls to BOS's own /api/fs route, which is the only sanctioned
  // way an unbundled worker-thread service can reach the VFS (see
  // docs/dev/os-shell/virtual-file-system.md and seed/skills/build-studio/
  // references/target-marketplace-item.md's "Reaching the VFS from a
  // service"). An earlier version of this file tried to remap bundleRoot onto
  // a *host* path derived from the service's own config directory
  // (dataDir()/system/config/<id>/../..) — which resolved to
  // dataDir()/system/KnowledgeBase, not the real VFS root
  // (dataDir()/vfs/KnowledgeBase): every bundle got written inside BOS's
  // internal system/ control directory, invisible to the Files app and to
  // every other consumer of the real /KnowledgeBase VFS path, even though the
  // service itself (and its app, which only ever talks to this same
  // service) looked like it was working fine.
  let bundleRoot = DEFAULT_BUNDLE_ROOT;
  let ingestDefaults = { maxDepth: DEFAULT_MAX_DEPTH, maxWorkers: DEFAULT_MAX_WORKERS, maxChunkSize: DEFAULT_MAX_CHUNK_SIZE };
  let serviceId = "okf-knowledge-base";
  // The reaper's two bounds (FR-059, ADR-014 Part B): inactivity (silence
  // since the last trajectory event) and total runtime (the backstop for a
  // run that is alive but not progressing).
  let staleJobMs = DEFAULT_STALE_JOB_MS;
  let maxTotalTimeoutMs = DEFAULT_MAX_TOTAL_TIMEOUT_MS;
  let reaperTimer = null;

  function log(level, message) {
    parentPort.postMessage({ type: "log", level, message });
  }

  // Mirrors the same env-var check BOS's own /api/services/[id]/config route
  // uses (src/lib/devharness/supervisor.ts's supervisorEnabled()) — worker
  // threads inherit process.env from the main thread, so this stays in sync
  // without any IPC round-trip. See docs/dev/apps/services.md §11.
  function getRuntime() {
    const supervisorEnabled = !!process.env.BOS_SUPERVISOR_URL;
    return {
      httpPath: supervisorEnabled ? `/__supervisor/services/${serviceId}/` : null,
      port: boundPort,
      // `runtime` is the service's own effective configuration, and it is what
      // GET /config reports. maxChunkSize rides here (FR-056) next to the
      // bundleRoot the app already reads — one payload, no second route.
      runtime: {
        bundleRoot,
        maxChunkSize: ingestDefaults.maxChunkSize,
        maxDepth: ingestDefaults.maxDepth,
        maxWorkers: ingestDefaults.maxWorkers,
        maxConcurrentRuns: core.getMaxConcurrentRuns(),
        // The reaper's bounds (FR-059/US13 acceptance 3): what the service is
        // ACTUALLY using, so a changed setting can be confirmed from here
        // rather than inferred from a run that did or did not get reaped.
        staleJobMs,
        jobFinalizeTimeoutMs: staleJobMs,
        maxTotalTimeoutMs,
      },
      maxChunkSize: ingestDefaults.maxChunkSize,
      staleJobMs,
      jobFinalizeTimeoutMs: staleJobMs,
      maxTotalTimeoutMs,
    };
  }

  async function closeServer() {
    if (reaperTimer) {
      clearInterval(reaperTimer);
      reaperTimer = null;
    }
    if (!server) return;
    await new Promise((resolve) => server.close(() => resolve()));
    server = null;
  }

  // ── The job stale reaper (design ADR-006 / FR-049) ─────────────────────
  //
  // core.driveRun writes a terminal state on every path it controls, so a
  // run that merely FAILS is already recorded honestly. What it cannot cover
  // is this process dying mid-run — a service restart, a BOS reload, a
  // killed Next.js. Those orphan the job: it stays `running` with nobody
  // left watching it, and the Jobs tab spins forever on a run that ended
  // minutes ago.
  //
  // So the reaper runs BOTH on a timer and as a sweep on (re)start. The
  // startup sweep is the important half: a restart is precisely the event
  // that orphans jobs, and the first thing this service should do about the
  // jobs it finds `running` — when it knows for a fact it is not running
  // any of them — is admit they are lost.
  async function reapOnce(reason) {
    try {
      const { count, reaped } = await core.reapStaleJobs(bundleRoot, {
        inactivityMs: staleJobMs,
        maxTotalMs: maxTotalTimeoutMs,
      });
      if (count) {
        log("info", `job reaper (${reason}): marked ${count} stale run(s) failed — ${reaped.join(", ")}`);
      }
    } catch (err) {
      log("warn", `job reaper (${reason}) could not run (non-fatal): ${err.message}`);
    }
  }

  function startReaper() {
    if (reaperTimer) clearInterval(reaperTimer);
    reaperTimer = setInterval(() => void reapOnce("timer"), REAPER_INTERVAL_MS);
    // Never hold the worker open just to run a sweep.
    if (typeof reaperTimer.unref === "function") reaperTimer.unref();
  }

  // One-time, additive-only recovery for bundles created while the bug above
  // was live: an earlier version of this file wrote every bundle under
  // dataDir()/system/<leaf-of-bundleRoot> (a REAL host path, computed exactly
  // as below) instead of the VFS. Anything created during that window still
  // sits there on disk, invisible to this now-corrected service. This copies
  // each such bundle into the real VFS bundleRoot (skipping any name that
  // already exists there, so it never clobbers newer data) and then renames
  // — never deletes — the legacy directory, so this is safe to run on every
  // startup: once migrated, the legacy path no longer exists under its
  // original name and this becomes a no-op.
  async function copyHostDirToVfs(srcDir, destVfsPath) {
    const entries = await fsp.readdir(srcDir, { withFileTypes: true });
    for (const entry of entries) {
      const srcPath = path.join(srcDir, entry.name);
      const destPath = `${destVfsPath}/${entry.name}`;
      if (entry.isDirectory()) {
        await copyHostDirToVfs(srcPath, destPath);
      } else {
        const content = await fsp.readFile(srcPath, "utf8");
        await vfsBridge.writeText(destPath, content);
      }
    }
  }

  async function migrateLegacyHostBundles(configDirPath, currentBundleRoot) {
    const legacyRoot = path.resolve(configDirPath, "..", "..", path.basename(currentBundleRoot) || "KnowledgeBase");
    let legacyEntries;
    try {
      legacyEntries = await fsp.readdir(legacyRoot, { withFileTypes: true });
    } catch {
      return; // nothing at the legacy location — most installs, nothing to do
    }
    const migrated = [];
    for (const entry of legacyEntries) {
      if (!entry.isDirectory()) continue;
      const destDir = `${currentBundleRoot}/${entry.name}`;
      if (await vfsBridge.exists(destDir)) continue; // don't clobber anything already at the real destination
      await copyHostDirToVfs(path.join(legacyRoot, entry.name), destDir);
      migrated.push(entry.name);
    }
    if (migrated.length) {
      const archivedPath = `${legacyRoot}.migrated-${Date.now()}`;
      await fsp.rename(legacyRoot, archivedPath);
      log(
        "info",
        `migrated ${migrated.length} bundle(s) that were stranded at the old, buggy host location into the real VFS at ${currentBundleRoot}: ${migrated.join(", ")}. The old location is archived (not deleted) at ${archivedPath}.`,
      );
    }
  }

  parentPort.on("message", async (msg) => {
    try {
      if (msg.type === "initialize") {
        serviceId = msg.serviceId || serviceId;
        // configDirPath (dataDir()/system/config/<id>) holds this service's
        // OWN user-editable config/runtime state — a real host path, but
        // unrelated to the VFS: it's BOS-internal service bookkeeping, not
        // user content, so reading it directly via fs is fine (unlike bundle
        // storage below, which must go through the VFS bridge).
        const configPath = path.join(msg.configDirPath, `${serviceId}.json`);
        let userConfig = {};
        try {
          userConfig = JSON.parse(await fsp.readFile(configPath, "utf8"));
        } catch {
          // no user config yet — fall back to manifest defaults below
        }
        bundleRoot = typeof userConfig.bundleRoot === "string" && userConfig.bundleRoot ? userConfig.bundleRoot : DEFAULT_BUNDLE_ROOT;
        ingestDefaults = {
          maxDepth: Number.isFinite(userConfig.maxDepth) ? userConfig.maxDepth : DEFAULT_MAX_DEPTH,
          maxWorkers: Number.isFinite(userConfig.maxWorkers) ? userConfig.maxWorkers : DEFAULT_MAX_WORKERS,
          maxChunkSize:
            Number.isFinite(userConfig.maxChunkSize) && userConfig.maxChunkSize > 0
              ? userConfig.maxChunkSize
              : DEFAULT_MAX_CHUNK_SIZE,
        };
        // How many ingest runs may run at once; the rest wait queued (the run
        // queue in okf-core). A bundle-wide re-ingest goes through it too.
        core.setMaxConcurrentRuns(userConfig.maxConcurrentRuns);
        // `staleJobMs` is the installed name for the inactivity bound;
        // `jobFinalizeTimeoutMs` is the spec's name for the SAME bound, so
        // both are accepted and neither config spelling is a silent no-op.
        const inactivity = Number.isFinite(userConfig.staleJobMs)
          ? userConfig.staleJobMs
          : userConfig.jobFinalizeTimeoutMs;
        staleJobMs = Number.isFinite(inactivity) && inactivity > 0 ? inactivity : DEFAULT_STALE_JOB_MS;
        maxTotalTimeoutMs =
          Number.isFinite(userConfig.maxTotalTimeoutMs) && userConfig.maxTotalTimeoutMs > 0
            ? userConfig.maxTotalTimeoutMs
            : DEFAULT_MAX_TOTAL_TIMEOUT_MS;
        const port = typeof userConfig.port === "number" ? userConfig.port : 0;

        // Bind + send initialized/bound/tool_declare FIRST, before touching the
        // VFS bridge at all. This used to be the other way around: mkdir the
        // bundleRoot and run the legacy-bundle migration (both loopback HTTP
        // round-trips to BOS's own /api/fs, per vfs-bridge.js) BEFORE ever
        // creating the HTTP server or posting a single message — so the whole
        // tool_declare handshake was gated on BOS's own API routes already
        // being up and fast, which they often aren't yet at worker-startup
        // time (cold Next.js dev-server compiles, or many services' migration
        // sweeps competing for the same request queue during startAll()).
        // Any of that running long pushed the worker past ServiceManager's
        // startup timeout (default 30s) with `initialized` never sent — the
        // worker gets terminated and NO okf_* tool ever gets declared for
        // that boot, even though every declaration itself was always well
        // formed. Sending the handshake first makes tool registration
        // reliable regardless of VFS/API readiness; the mkdir/migration are
        // demoted to a best-effort background step exactly as their own
        // "non-fatal" comments already assumed (listBundles() already retries
        // the mkdir lazily on every /bundles request).
        server = http.createServer(
          createRequestHandler({
            core,
            bundleRoot,
            serviceId,
            getRuntime,
            declarations: DECLARATIONS,
            vfs: vfsBridge,
            getIngestDefaults: () => ingestDefaults,
          }),
        );
        server.on("error", (err) => {
          parentPort.postMessage({ type: "crash", error: err.message, stack: err.stack });
        });
        server.listen(port, "127.0.0.1", () => {
          boundPort = server.address().port;
          parentPort.postMessage({ type: "initialized" });
          parentPort.postMessage({ type: "bound", port: boundPort, host: "127.0.0.1" });
          for (const declaration of DECLARATIONS) {
            parentPort.postMessage({
              type: "tool_declare",
              payload: { callId: `declare-${declaration.name}`, declaration },
            });
          }
          log("info", `OKF Knowledge Base bound on 127.0.0.1:${boundPort}, bundleRoot=${bundleRoot} (via VFS loopback bridge, ${vfsBridge.vfsBaseUrl()})`);

          void (async () => {
            try {
              await vfsBridge.mkdir(bundleRoot);
            } catch (err) {
              // Non-fatal: BOS's own HTTP server may not be fully up yet at
              // worker-startup time. listBundles() (called on every /bundles
              // request) retries this same mkdir lazily, so a transient failure
              // here doesn't leave the bundle root permanently missing.
              log("warn", `could not pre-create bundleRoot "${bundleRoot}" via VFS bridge yet: ${err.message}`);
            }

            try {
              await migrateLegacyHostBundles(msg.configDirPath, bundleRoot);
            } catch (err) {
              log("warn", `legacy bundle migration check failed (non-fatal): ${err.message}`);
            }

            // Warm the global job store from disk. Ingest runs are
            // service-level operational state (okf-core's `.jobs/jobs.json`
            // under the bundle root), so the Jobs tab still shows yesterday's
            // completed and failed runs after a service restart. Non-fatal
            // to the rest of the service: an unreadable store is reported
            // here and by every job operation that needs it — it is never
            // replaced with an empty one, which would erase the history.
            try {
              const jobs = await core.listJobs(bundleRoot);
              log("info", `job store loaded: ${jobs.length} ingest run(s) on record`);
            } catch (err) {
              log("warn", `could not load the ingest job store yet (non-fatal): ${err.message}`);
            }

            // Sweep first, then arm the timer. See startReaper's comment for
            // why the startup sweep is the half that matters.
            await reapOnce("startup sweep");
            // Runs still QUEUED when the service last stopped are waiting, not
            // lost — start them now that the slots are free again.
            await core.pumpQueue(bundleRoot);
            startReaper();
          })();
        });
      } else if (msg.type === "dispose" || msg.type === "restart") {
        await closeServer();
        parentPort.postMessage({ type: "disposed" });
      } else if (msg.type === "tool_call") {
        // `caller` ({runId, agentId}) is which run made the call — BOS's
        // answer, not the model's. Absent from a BOS that predates it.
        const { callId, name, args, caller } = msg.payload;
        const handler = handlers[name];
        if (!handler) {
          parentPort.postMessage({
            type: "tool_error",
            payload: { callId, error: { code: "unknown_tool", message: `unknown tool: ${name}` } },
          });
          return;
        }
        try {
          const result = await handler(args || {}, { core, bundleRoot, vfs: vfsBridge, ingestDefaults, staleJobMs, maxTotalTimeoutMs, getRuntime, serviceId, caller });
          parentPort.postMessage({ type: "tool_result", payload: { callId, result } });
        } catch (err) {
          parentPort.postMessage({
            type: "tool_error",
            payload: { callId, error: { code: "tool_execution_error", message: err.message, stack: err.stack } },
          });
        }
      }
    } catch (err) {
      parentPort.postMessage({ type: "error", message: err.message, stack: err.stack });
    }
  });
}
