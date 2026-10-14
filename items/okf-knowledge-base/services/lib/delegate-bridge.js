// delegate-bridge.js — the worker's client for BOS's loopback headless-run
// endpoint, `POST /api/subagents/delegate`.
//
// ── Why this file exists ─────────────────────────────────────────────────
//
// The service runs in a worker thread, outside the Next.js process. It has no
// agent loop, no `web_fetch`, no `agent_delegate`. Before this bridge,
// `okf_ingest` could therefore only *plan*: it handed the calling assistant a
// list of steps and a delegation block and hoped the assistant executed them.
// That made ingest a three-call ritual the caller had to perform correctly,
// occupied the caller's turn for the whole run, and left the job record's
// terminal state depending on the sub-agent remembering to phone home.
//
// BOS already exposes the thing the worker was missing: `/api/subagents/
// delegate` starts a real headless sub-agent run in the main process and
// streams it back as NDJSON. It is reachable over plain loopback HTTP — the
// same transport `vfs-bridge` uses for `/api/fs`. So the worker CAN trigger a
// run itself. `okf_ingest` becomes one call that returns `{jobId}`, and the
// LAUNCHER (this module's caller) owns the job's terminal state, derived from
// the run's own signal rather than from the agent's good manners.
//
// ── Trust boundary ───────────────────────────────────────────────────────
//
// Loopback IS the trust boundary, exactly as it is for `/api/fs`: a process
// that can open 127.0.0.1:<next-port> is already inside BOS. There is no
// per-request auth token to attach, and inventing one here would be
// cargo-cult — it would protect nothing that loopback does not already
// protect, and would be a second secret to rotate.
//
// ── The stream ───────────────────────────────────────────────────────────
//
// Content-Type: application/x-ndjson. One JSON object per line:
//
//   {type:"run_started", runId}         FIRST — the run's handle (FR-052)
//   {type:"tool", tool, input}          one per tool call, as it happens
//   {type:"tool_result", ...}           enriched (ADR-13), may be absent
//   {type:"reasoning_delta", ...}       enriched, may be absent
//   {type:"final_text", ...}            enriched, may be absent
//   {type:"done", result, text}         TERMINAL — result.{output, endedReason, error}
//   {type:"error", error}               TERMINAL — the run threw before finishing
//
// We deliberately ACT on only part of that (`run_started` for the runId the
// cancel path needs, `tool` for progress, `done` / `error` for the terminal
// state) and ignore unknown line types rather than
// failing on them: the endpoint is allowed to add event kinds, and a service
// that crashed on an unrecognised line would be broken by an additive change.
//
// We nonetheless CAPTURE all of it. `onEvent` receives every parsed line, in
// order, verbatim — that array is the job's `trajectory` (FR-057, ADR-013),
// and an event this module has no use for is exactly the kind of event a user
// debugging a surprising run does.

const http = require("http");
const vfs = require("./vfs-bridge");

/** The agent id this service delegates to (bundled in agents/okf-ingest/). */
const INGEST_AGENT = "okf-ingest";

/**
 * The loopback base for BOS's own API — resolved exactly the way vfs-bridge
 * resolves it for /api/fs, by reusing that function rather than re-deriving
 * it. One place learns the Next.js port; both bridges follow it.
 *
 * `OKF_DELEGATE_URL` overrides it, and is the ONE seam for pointing the
 * delegate AND abort calls somewhere else (a test double, or a BOS whose API
 * is not on $PORT). Both calls resolve through here, so they can never end
 * up addressing two different servers.
 */
function loopbackBaseUrl() {
  const override = process.env.OKF_DELEGATE_URL;
  return override && override.trim() ? override.trim() : vfs.vfsBaseUrl();
}

/**
 * Open the NDJSON stream. Resolves once the response HEAD is in, so the
 * caller can start consuming lines while the run is still going.
 */
function openDelegateStream({ task, agent }) {
  return new Promise((resolve, reject) => {
    const url = new URL("/api/subagents/delegate", loopbackBaseUrl());
    const body = JSON.stringify({ task, agent: agent || INGEST_AGENT });
    const req = http.request(
      {
        method: "POST",
        hostname: url.hostname,
        port: url.port,
        path: url.pathname,
        headers: {
          "Content-Type": "application/json",
          "Content-Length": Buffer.byteLength(body),
          Accept: "application/x-ndjson",
        },
        // A headless agent run is minutes, not seconds. Node's default
        // socket timeout would kill the stream mid-run and the launcher
        // would report a failure that never happened.
        timeout: 0,
      },
      (res) => resolve(res),
    );
    req.on("error", reject);
    req.write(body);
    req.end();
  });
}

/**
 * Run the `okf-ingest` sub-agent and consume its NDJSON stream to the end.
 *
 * This is fire-and-AWAIT-async: the caller (`core.triggerIngest`) starts it
 * without awaiting, so the invoking tool returns `{jobId}` immediately and
 * the caller's turn is never occupied by the run. Everything that happens
 * after that happens here.
 *
 * @param {object}   opts
 * @param {string}   opts.task         the full task text (embeds jobId/bundle/source)
 * @param {string}  [opts.agent]       defaults to "okf-ingest"
 * @param {function} [opts.onTool]     ({tool, index}) => void — progress ticks
 * @param {function} [opts.onRunStarted] ({runId}) => void — fired once, as
 *        soon as the run names itself (FR-052). The launcher stores the id on
 *        the job; it is the handle `okf_cancel_job` aborts by.
 * @param {function} [opts.onEvent]    (event) => void — fired for EVERY parsed
 *        NDJSON line, in stream order, with the object exactly as it came off
 *        the wire. This is the job TRAJECTORY (FR-057, ADR-013): the launcher
 *        appends each event to the job record, so the Jobs tab can show what
 *        the agent actually did. No filtering and no transformation happen
 *        here — a line this module does not act on is still a line the user
 *        may need to debug a run, and deciding what matters is the renderer's
 *        job, not the reader's.
 *
 *        It is ALSO the reaper's liveness signal (FR-059, ADR-014 Part B):
 *        the launcher's onEvent stamps `job.lastEventAt` on every line that
 *        comes through here and persists it with the record, so "stale"
 *        means "has said nothing for the inactivity bound" rather than
 *        "has been running that long". Every event counts — reasoning
 *        deltas and tool results alike — which is why this fires before any
 *        of the early returns below rather than per event KIND.
 * @returns {Promise<{ok: boolean, output?: string, endedReason?: string, error?: string, runId?: string, toolCalls: number}>}
 *          Resolves with the run's own terminal signal. NEVER rejects for a
 *          run that failed — a failed run is a result, not an exception. It
 *          rejects only when the stream itself could not be established or
 *          read, which the launcher reports as a failed job all the same.
 */
async function runIngestAgent({ task, agent, onTool, onRunStarted, onEvent }) {
  const res = await openDelegateStream({ task, agent });

  if (res.statusCode && res.statusCode >= 400) {
    // A non-stream error response (404 no such agent, 400 bad body) comes
    // back as plain JSON, not NDJSON.
    const text = await readAll(res);
    let message = `delegate endpoint returned HTTP ${res.statusCode}`;
    try {
      const parsed = JSON.parse(text);
      if (parsed && parsed.error) message = parsed.error;
    } catch {
      /* non-JSON body — keep the status-code message */
    }
    return { ok: false, error: message, endedReason: "error", toolCalls: 0 };
  }

  let terminal = null;
  let toolCalls = 0;
  let runId = null;

  await consumeNdjson(res, (line) => {
    if (!line || typeof line !== "object") return;
    // TRAJECTORY FIRST (ADR-013) — before any of the early returns below, so
    // `run_started` and `tool` are captured too. A capture failure must never
    // break the run it is describing.
    if (onEvent) {
      try {
        onEvent(line);
      } catch {
        /* recording what happened is not allowed to change what happens */
      }
    }
    // The run's handle. `run_started` is where the endpoint announces it;
    // we also accept a runId riding on any earlier line rather than insisting
    // on one event name, because missing it costs the cancel path its only
    // handle for the whole run.
    if (!runId && (line.type === "run_started" || line.runId)) {
      const id = line.runId || (line.run && line.run.id) || (line.result && line.result.runId);
      if (id) {
        runId = String(id);
        // Capturing the id must never break the stream that carried it, so
        // a failure is logged with its cause rather than thrown into the loop.
        if (onRunStarted) {
          const logFailure = (err) => console.error(`[okf] could not record run ${runId}: ${err && err.stack ? err.stack : err}`);
          try {
            void Promise.resolve(onRunStarted({ runId })).catch(logFailure);
          } catch (err) {
            logFailure(err);
          }
        }
      }
      if (line.type === "run_started") return;
    }
    if (line.type === "tool") {
      toolCalls++;
      if (onTool) {
        try {
          onTool({ tool: String(line.tool || "tool"), index: toolCalls });
        } catch {
          /* a progress-reporting failure must never abort the run it reports on */
        }
      }
      return;
    }
    if (line.type === "done") terminal = line;
    else if (line.type === "error") terminal = line;
  });

  if (!terminal) {
    // The stream ended without a terminal line: the run died with the main
    // process, or the connection dropped. Honest answer: we do not know it
    // succeeded, so it did not.
    return {
      ok: false,
      error: "the sub-agent stream ended without a terminal line — the run was interrupted",
      endedReason: "error",
      runId,
      toolCalls,
    };
  }

  if (terminal.type === "error") {
    return { ok: false, error: String(terminal.error || "the sub-agent run threw"), endedReason: "error", runId, toolCalls };
  }

  const result = terminal.result || {};
  const endedReason = result.endedReason || (result.error ? "error" : "completed");
  // "completed" is the ONLY success. `max_steps` means the agent ran out of
  // budget mid-job: the bundle may hold a half-decomposed document, and
  // calling that a success would be the job store lying about its own data.
  const ok = endedReason === "completed" && !result.error;
  return {
    ok,
    output: typeof result.output === "string" ? result.output : terminal.text || "",
    endedReason,
    // A cancelled run is a STOP, not an error — the launcher maps it to the
    // `cancelled` job status and must not be handed an error string to paint
    // a failure card with (FR-050).
    error: ok || endedReason === "cancelled" ? undefined : result.error || `the run ended as "${endedReason}"`,
    steps: typeof result.steps === "number" ? result.steps : undefined,
    runId: runId || (typeof result.runId === "string" ? result.runId : undefined),
    toolCalls,
  };
}

/**
 * Abort a headless run by its id (FR-052).
 *
 * `POST /api/subagents/<runId>/abort` is a GENERIC platform route — the HTTP
 * face of BOS's in-process `abortHeadlessRun(runId)` run-registry. It knows
 * nothing about OKF jobs: it aborts a run and answers `{aborted: true|false}`.
 * Mapping that onto a job record is this item's business, done in
 * `core.cancelJob`.
 *
 * `aborted: false` is a legitimate answer, not an error: it means no live run
 * is registered under that id — it already finished, or the process that
 * owned it restarted. Only a transport failure or a non-2xx status rejects.
 *
 * @param {string} runId
 * @returns {Promise<{aborted: boolean, runId: string, error?: string}>}
 */
function abortRun(runId) {
  return new Promise((resolve, reject) => {
    const id = String(runId || "").trim();
    if (!id) return reject(new Error("runId is required to abort a run"));

    const url = new URL(`/api/subagents/${encodeURIComponent(id)}/abort`, loopbackBaseUrl());
    const body = JSON.stringify({ reason: "cancelled from the OKF Knowledge Base service" });
    const req = http.request(
      {
        method: "POST",
        hostname: url.hostname,
        port: url.port,
        path: url.pathname,
        headers: {
          "Content-Type": "application/json",
          "Content-Length": Buffer.byteLength(body),
          Accept: "application/json",
        },
      },
      (res) => {
        readAll(res)
          .then((text) => {
            let parsed = null;
            try {
              parsed = text ? JSON.parse(text) : null;
            } catch {
              /* a non-JSON body is reported through the status check below */
            }
            if (res.statusCode && res.statusCode >= 400) {
              const message = (parsed && parsed.error) || `abort endpoint returned HTTP ${res.statusCode}`;
              return reject(new Error(message));
            }
            resolve({
              aborted: !!(parsed && parsed.aborted),
              runId: id,
              error: parsed && parsed.error ? String(parsed.error) : undefined,
            });
          })
          .catch(reject);
      },
    );
    req.on("error", reject);
    req.write(body);
    req.end();
  });
}

/** Read a whole (small, non-stream) response body as text. */
function readAll(res) {
  return new Promise((resolve, reject) => {
    let data = "";
    res.setEncoding("utf8");
    res.on("data", (c) => {
      data += c;
    });
    res.on("end", () => resolve(data));
    res.on("error", reject);
  });
}

/**
 * Consume an NDJSON response, invoking `onLine` per parsed object. Partial
 * lines are buffered across chunks — an NDJSON reader that assumes one chunk
 * is one line works right up until a line straddles a TCP boundary, which it
 * eventually will.
 */
function consumeNdjson(res, onLine) {
  return new Promise((resolve, reject) => {
    let buffer = "";
    res.setEncoding("utf8");
    const flush = (chunkEnd) => {
      let nl;
      while ((nl = buffer.indexOf("\n")) !== -1) {
        const raw = buffer.slice(0, nl).trim();
        buffer = buffer.slice(nl + 1);
        if (!raw) continue;
        try {
          onLine(JSON.parse(raw));
        } catch {
          /* a malformed line is skipped, not fatal */
        }
      }
      if (chunkEnd && buffer.trim()) {
        try {
          onLine(JSON.parse(buffer.trim()));
        } catch {
          /* trailing garbage — ignore */
        }
        buffer = "";
      }
    };
    res.on("data", (c) => {
      buffer += c;
      flush(false);
    });
    res.on("end", () => {
      flush(true);
      resolve();
    });
    res.on("error", reject);
  });
}

module.exports = { runIngestAgent, abortRun, loopbackBaseUrl, INGEST_AGENT };
