// index.js — the Workflow Manager service worker entrypoint.
//
// This file is also `import()`ed from BOS's MAIN thread (parentPort === null)
// during manifest validation (validateManifestAtStart) — every use of
// parentPort below MUST stay inside the `if (parentPort)` guard so that
// load-time `import()` never throws.

const { parentPort } = require("worker_threads");
const fs = require("fs");
const fsp = fs.promises;
const path = require("path");
const http = require("http");

const { DECLARATIONS } = require("./tools");
const { makeHandlers, makeRunStarter } = require("./handlers");
const { createRequestHandler } = require("./http-bridge");
const { runMigration } = require("./migration");
const vfs = require("./vfs");
const events = require("./events");
const store = require("./engine/store");

const DEFAULT_PORT = 0;
const DEFAULT_HOST = "127.0.0.1";
const DEFAULT_MAX_CONCURRENT_STEPS = 5;

if (parentPort) {
  let server = null;
  let boundPort = null;
  let boundHost = DEFAULT_HOST;
  let serviceId = "workflows";
  let maxConcurrentSteps = DEFAULT_MAX_CONCURRENT_STEPS;

  function log(level, message) {
    parentPort.postMessage({ type: "log", level, message });
  }

  // Worker threads inherit process.env from the main thread — this mirrors
  // the same env-var check BOS's own /api/services/[id]/config route uses
  // (supervisorEnabled()), so it stays in sync without any IPC round-trip.
  function getRuntime() {
    const supervisorEnabled = !!process.env.BOS_SUPERVISOR_URL;
    return {
      serviceId,
      httpPath: supervisorEnabled ? `/__supervisor/services/${serviceId}/` : null,
      port: boundPort,
      host: boundHost,
      vfsOrigin: vfs.vfsBaseUrl(),
    };
  }

  // Worker→Main IPC. `tool_declare` (039) and `handler_declare` (034/US16)
  // both travel this way — same channel, different message type.
  const ipcPost = (msg) => parentPort.postMessage(msg);

  const handlerCtx = {
    log,
    ipcPost,
    get defaultMaxConcurrentSteps() {
      return maxConcurrentSteps;
    },
  };

  const handlers = makeHandlers(handlerCtx);
  // The same run-start primitive `workflow_run` uses — US16 hands it to
  // events.js so an event-triggered run is started exactly like any other,
  // just with `startSource: "event"` and the event's provenance (FR-041).
  const startRun = makeRunStarter(handlerCtx);

  /** US16/FR-039 — declare a headless handler for every distinct event type
   *  any workflow lists in its `triggers`, and drop the ones nothing triggers
   *  on any more. Called once the service is up (below) and after every
   *  workflow CRUD write (handlers.js). */
  async function reconcileEventSubscriptions(reason) {
    try {
      const workflows = await store.listWorkflows();
      const subscribed = await events.reconcileSubscriptions(workflows, { ipcPost, httpJson: vfs.jsonRequest, log });
      log("info", `event subscriptions (${reason}): watching ${subscribed.size} event type(s)${subscribed.size ? ` — ${Array.from(subscribed).join(", ")}` : ""}`);
    } catch (err) {
      log("warn", `event subscription reconcile (${reason}) failed (non-fatal): ${err.message}`);
    }
  }

  async function closeServer() {
    if (!server) return;
    await new Promise((resolve) => server.close(() => resolve()));
    server = null;
  }

  parentPort.on("message", async (msg) => {
    try {
      if (msg.type === "initialize") {
        serviceId = msg.serviceId || serviceId;
        // configDirPath (dataDir()/system/config/<id>) holds this service's
        // OWN user-editable config/runtime state — a real host path, but
        // BOS-internal bookkeeping, not user content, so reading it directly
        // via fs is fine (unlike workflow storage itself, which must always
        // go through vfs.js's loopback /api/fs bridge — NFR-004).
        const configPath = path.join(msg.configDirPath, `${serviceId}.json`);
        let userConfig = {};
        try {
          userConfig = JSON.parse(await fsp.readFile(configPath, "utf8"));
        } catch {
          // no user config yet — fall back to manifest defaults below
        }
        const port = typeof userConfig.port === "number" ? userConfig.port : DEFAULT_PORT;
        boundHost = typeof userConfig.host === "string" && userConfig.host ? userConfig.host : DEFAULT_HOST;
        maxConcurrentSteps = Number.isFinite(userConfig.maxConcurrentSteps) ? userConfig.maxConcurrentSteps : DEFAULT_MAX_CONCURRENT_STEPS;

        // Bind + send initialized/bound/tool_declare FIRST, before touching
        // the VFS bridge at all (see migration.js's header + services.md's
        // worked example) — the handshake must not be gated on BOS's own API
        // routes already being up, which they may not be yet at
        // worker-startup time (cold Next.js compiles, or many services'
        // migration sweeps competing for the same request queue during
        // startAll()). ensureRoot/migration are demoted to a best-effort
        // background step below.
        server = http.createServer(createRequestHandler({ handlers, getRuntime }));
        server.on("error", (err) => {
          parentPort.postMessage({ type: "crash", error: err.message, stack: err.stack });
        });
        server.listen(port, boundHost, () => {
          boundPort = server.address().port;
          parentPort.postMessage({ type: "initialized" });
          parentPort.postMessage({ type: "bound", port: boundPort, host: boundHost });
          for (const declaration of DECLARATIONS) {
            parentPort.postMessage({
              type: "tool_declare",
              payload: { callId: `declare-${declaration.name}`, declaration },
            });
          }
          log("info", `Workflow Manager bound on ${boundHost}:${boundPort}, maxConcurrentSteps=${maxConcurrentSteps}, VFS bridge=${vfs.vfsBaseUrl()}`);

          void (async () => {
            try {
              await vfs.mkdir("/Workflows");
              await vfs.mkdir("/Workflows/.runs");
            } catch (err) {
              log("warn", `could not pre-create /Workflows via VFS bridge yet (non-fatal, retried lazily): ${err.message}`);
            }
            try {
              await runMigration(msg.configDirPath, log);
            } catch (err) {
              log("warn", `legacy migration check failed (non-fatal): ${err.message}`);
            }
            // US16/FR-039 — the service is now fully initialized (handshake
            // sent, tools declared, /Workflows present and migrated), so the
            // workflow list is readable: derive the trigger union and declare
            // one headless handler per event type. Deliberately AFTER the
            // handshake, for the same reason the migration is: a declare that
            // needs BOS's API routes must never gate `initialized`.
            await reconcileEventSubscriptions("startup");
          })();
        });
      } else if (msg.type === "dispose" || msg.type === "restart") {
        await closeServer();
        parentPort.postMessage({ type: "disposed" });
      } else if (msg.type === "event_dispatch") {
        // 034's kernel invoking one of our declared headless handlers
        // (US16/FR-040). handleEventDispatch starts one run per matching
        // workflow and acks over loopback HTTP immediately — there is no
        // reply message on this channel (types.ts: no event_dispatch_result).
        const payload = msg.payload || {};
        log("info", `event_dispatch received: handler=${payload.handlerId} event=${payload.eventId} type=${payload.record?.type}`);
        await events.handleEventDispatch(payload, {
          startRun,
          httpJson: vfs.jsonRequest,
          log,
          listWorkflows: () => store.listWorkflows(),
        });
      } else if (msg.type === "tool_call") {
        const { callId, name, args } = msg.payload;
        const handler = handlers[name];
        if (!handler) {
          log("warn", `tool_call: unknown tool "${name}" (callId=${callId})`);
          parentPort.postMessage({
            type: "tool_error",
            payload: { callId, error: { code: "unknown_tool", message: `unknown tool: ${name}` } },
          });
          return;
        }
        log("info", `tool_call dispatched: ${name} (callId=${callId})`);
        try {
          const result = await handler(args || {});
          log("info", `tool_call resolved: ${name} (callId=${callId})`);
          parentPort.postMessage({ type: "tool_result", payload: { callId, result } });
        } catch (err) {
          log("warn", `tool_call failed: ${name} (callId=${callId}): ${err.message}`);
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
