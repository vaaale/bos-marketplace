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
//   {type:"tool", tool, input}          one per tool call, as it happens
//   {type:"tool_result", ...}           enriched (ADR-13), may be absent
//   {type:"reasoning_delta", ...}       enriched, may be absent
//   {type:"final_text", ...}            enriched, may be absent
//   {type:"done", result, text}         TERMINAL — result.{output, endedReason, error}
//   {type:"error", error}               TERMINAL — the run threw before finishing
//
// We deliberately parse only what we act on (`run_started` for the run id,
// `tool` for progress, `done` / `error` for the terminal state) and ignore
// unknown line types rather than failing on them: the endpoint is allowed to
// add event kinds, and a service that crashed on an unrecognised line would
// be broken by an additive change.
//
// ── Stopping a run (ADR-010) ─────────────────────────────────────────────
//
// The run executes in the MAIN Next.js process; this worker is a separate
// thread holding its stream. The worker cannot reach the run's
// `AbortController` directly, and it must NOT abort its own `fetch` to stop
// it: the delegate route never wires the request's signal into the run, so
// aborting the client side closes the stream and leaves the run executing —
// writing chapters, burning tokens — with nothing watching it. The run and
// the job would disagree.
//
// So the worker asks the process that owns the run, over the same loopback
// channel it already uses for `/api/fs` and the delegate endpoint:
//
//   POST /api/subagents/<runId>/abort   ->   {aborted: boolean, runId}
//
// `aborted:false` is not an error — it means "no such live run" (already
// finished, or never started here), which makes the call idempotent.
//
// Two pieces are needed for that, and both live here because this is the
// only module that sees the stream:
//
//   • the `runId`, captured from the FIRST `run_started` line (the delegate
//     route forwards it verbatim, before anything else, precisely so a
//     fire-and-forget caller learns the id while the run is in flight);
//   • the QUEUED WINDOW — a cancel that arrives before `run_started` has
//     nothing to abort yet, so it is remembered against the job and fired
//     the instant the id lands. A queued-window cancel then behaves exactly
//     like a running cancel, instead of quietly waiting out a whole run.
//
// ── The mock-delegate seam ───────────────────────────────────────────────
//
// `OKF_DELEGATE_URL` overrides where the headless-run endpoint lives. When
// it is set, BOTH calls follow it: the run is started at that URL and the
// abort goes to `<that origin>/api/subagents/<runId>/abort`. That is the
// whole seam — one env var, no branch in the logic below — and it is what
// lets the e2e suite point the bridge at a deterministic mock that emits
// `run_started` and then stays open, so cancel/delete are asserted in
// milliseconds instead of waiting out a real multi-minute agent run.

const http = require("http");
const vfs = require("./vfs-bridge");

/** The agent id this service delegates to (bundled in agents/okf-ingest/). */
const INGEST_AGENT = "okf-ingest";

/**
 * The runs this worker is currently holding a stream for, keyed by JOB id —
 * the id the job store and both cancel surfaces speak in. `runId` is null
 * until `run_started` lands; `pendingAbort` is a cancel that arrived before
 * it did (the queued window).
 *
 * An entry is removed when the run ends, so a cancel against a finished run
 * finds nothing live and reports `aborted:false` rather than inventing a
 * stop that did not happen.
 */
const liveRuns = new Map();

/**
 * The loopback base for BOS's own API — resolved exactly the way vfs-bridge
 * resolves it for /api/fs, by reusing that function rather than re-deriving
 * it. One place learns the Next.js port; both bridges follow it.
 */
function loopbackBaseUrl() {
  return vfs.vfsBaseUrl();
}

/** Where the headless-run endpoint lives (see "the mock-delegate seam"). */
function delegateUrl() {
  const override = process.env.OKF_DELEGATE_URL;
  if (override) return new URL(override);
  return new URL("/api/subagents/delegate", loopbackBaseUrl());
}

/**
 * The platform's per-run abort route. It follows the delegate endpoint's
 * origin, because the run and the thing that can stop it are the same
 * process by construction — the run registry is `globalThis`-scoped, so an
 * abort has to reach the process that launched the run.
 */
function abortUrl(runId) {
  const base = process.env.OKF_DELEGATE_URL ? new URL(process.env.OKF_DELEGATE_URL).origin : loopbackBaseUrl();
  return new URL(`/api/subagents/${encodeURIComponent(runId)}/abort`, base);
}

/** True while this worker still holds a stream for `jobId`. */
function isRunLive(jobId) {
  return liveRuns.has(jobId);
}

/**
 * POST the platform's abort route for one run.
 *
 * Returns the route's own answer — `{aborted:true}` when it found and
 * stopped a live run, `{aborted:false}` when there was nothing live to stop.
 * NEVER throws for a run that was already gone: an abort that finds nothing
 * is the idempotent case, not a failure, and cancel must not break because
 * the run beat it to the finish line by a millisecond.
 */
function abortRun(runId) {
  return new Promise((resolve) => {
    if (!runId) {
      resolve({ aborted: false, reason: "no runId was captured for this run yet" });
      return;
    }
    const url = abortUrl(runId);
    const req = http.request(
      {
        method: "POST",
        hostname: url.hostname,
        port: url.port,
        path: url.pathname + url.search,
        headers: { "Content-Length": 0, Accept: "application/json" },
      },
      (res) => {
        let data = "";
        res.setEncoding("utf8");
        res.on("data", (c) => {
          data += c;
        });
        res.on("end", () => {
          let body = null;
          try {
            body = data ? JSON.parse(data) : null;
          } catch {
            body = null;
          }
          if (res.statusCode === 200 && body && typeof body.aborted === "boolean") {
            resolve({ ...body, runId });
            return;
          }
          resolve({
            aborted: false,
            runId,
            reason: `the abort route answered HTTP ${res.statusCode || 0}`,
          });
        });
      },
    );
    req.on("error", (err) => resolve({ aborted: false, runId, error: err.message }));
    req.end();
  });
}

/**
 * Cancel the run this worker is holding for `jobId` (ADR-010 step 2/3).
 *
 * Three shapes, and the caller (`core.cancelJob`) treats all three as "the
 * stop was recorded", because the job's `cancelled` state is written from
 * the job store either way — this only decides whether a live run was
 * actually interrupted:
 *
 *   • the runId is known       → abort it now
 *   • the run has not started  → remember it; `run_started` fires the abort
 *   • nothing is live          → try the stored runId anyway (it may be a
 *                                run a previous worker started), and report
 *                                whatever the route says
 */
async function cancelRun(jobId, storedRunId) {
  const entry = liveRuns.get(jobId);
  if (entry) {
    entry.cancelled = true;
    if (entry.runId) return abortRun(entry.runId);
    // The queued window: the run is in flight but has not announced its id
    // yet. Remember the intent — consumeNdjson fires it on `run_started`.
    entry.pendingAbort = true;
    return { aborted: false, pending: true, reason: "the run has not reported its runId yet — it will be aborted the moment it does" };
  }
  // No stream held here. If the record remembers a runId, ask anyway: the
  // route is idempotent and answers honestly if the run is already gone.
  if (storedRunId) return abortRun(storedRunId);
  // Nothing live and nothing to abort — but a cancel that arrives in the
  // sliver before the run is registered must not be lost either.
  const placeholder = { runId: null, cancelled: true, pendingAbort: true };
  liveRuns.set(jobId, placeholder);
  // …and must not be remembered forever: a job whose run never starts (an
  // orphan from before a restart, say) would otherwise leave an entry in
  // this map for the life of the worker. Well past any queued window.
  const expiry = setTimeout(() => {
    if (liveRuns.get(jobId) === placeholder) liveRuns.delete(jobId);
  }, 5 * 60 * 1000);
  if (typeof expiry.unref === "function") expiry.unref();
  return { aborted: false, pending: true, reason: "no live run is registered for this job yet" };
}

/**
 * Open the NDJSON stream. Resolves once the response HEAD is in, so the
 * caller can start consuming lines while the run is still going.
 */
function openDelegateStream({ task, agent }) {
  return new Promise((resolve, reject) => {
    const url = delegateUrl();
    const body = JSON.stringify({ task, agent: agent || INGEST_AGENT });
    const req = http.request(
      {
        method: "POST",
        hostname: url.hostname,
        port: url.port,
        path: url.pathname + url.search,
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
 * @param {string}  [opts.jobId]       the job this run belongs to — the key cancel speaks in
 * @param {string}  [opts.agent]       defaults to "okf-ingest"
 * @param {function} [opts.onRunStarted] ({runId}) => void — the run's own id, once
 * @param {function} [opts.onTool]     ({tool, index}) => void — progress ticks
 * @returns {Promise<{ok: boolean, output?: string, endedReason?: string, error?: string, runId?: string, toolCalls: number}>}
 *          Resolves with the run's own terminal signal. NEVER rejects for a
 *          run that failed — a failed run is a result, not an exception. It
 *          rejects only when the stream itself could not be established or
 *          read, which the launcher reports as a failed job all the same.
 */
async function runIngestAgent({ task, agent, jobId, onRunStarted, onTool }) {
  // Register BEFORE the request goes out, and preserve an entry a cancel
  // already created: `okf_cancel_job` can land in the sliver between
  // createJob and this line, and a cancel that arrives first must not be
  // silently dropped on the floor.
  const key = jobId || `anonymous-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`;
  const entry = liveRuns.get(key) || { runId: null, cancelled: false, pendingAbort: false };
  liveRuns.set(key, entry);

  try {
    return await consumeRun({ task, agent, entry, onRunStarted, onTool });
  } finally {
    // The run is over: nothing here is live any more, so a later cancel
    // correctly reports that there was nothing to stop.
    liveRuns.delete(key);
  }
}

async function consumeRun({ task, agent, entry, onRunStarted, onTool }) {
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

  await consumeNdjson(res, (line) => {
    if (!line || typeof line !== "object") return;
    // The FIRST line of a run, by contract (runner.ts emits it before
    // anything else). Everything cancel needs hangs off it.
    if (line.type === "run_started") {
      if (entry.runId || !line.runId) return; // the first one is the run's id; later ones are noise
      entry.runId = String(line.runId);
      if (onRunStarted) {
        try {
          onRunStarted({ runId: entry.runId });
        } catch {
          /* storing the id must never abort the run it identifies */
        }
      }
      // ADR-010/S4 — the queued window closed with a cancel already in it.
      // Abort NOW rather than letting the run proceed to a natural end that
      // the user has already said they do not want.
      if (entry.pendingAbort || entry.cancelled) {
        entry.pendingAbort = false;
        void abortRun(entry.runId);
      }
      return;
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
      runId: entry.runId,
      toolCalls,
    };
  }

  if (terminal.type === "error") {
    return { ok: false, error: String(terminal.error || "the sub-agent run threw"), endedReason: "error", runId: entry.runId, toolCalls };
  }

  const result = terminal.result || {};
  const endedReason = result.endedReason || (result.error ? "error" : "completed");
  // "completed" is the ONLY success. `max_steps` means the agent ran out of
  // budget mid-job: the bundle may hold a half-decomposed document, and
  // calling that a success would be the job store lying about its own data.
  // `cancelled` is not a success either — but it is not a failure, and the
  // launcher maps it to its own distinct terminal state (ADR-010).
  const ok = endedReason === "completed" && !result.error;
  return {
    ok,
    output: typeof result.output === "string" ? result.output : terminal.text || "",
    endedReason,
    error: ok || endedReason === "cancelled" ? undefined : result.error || `the run ended as "${endedReason}"`,
    steps: typeof result.steps === "number" ? result.steps : undefined,
    runId: entry.runId,
    toolCalls,
  };
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

module.exports = {
  runIngestAgent,
  cancelRun,
  abortRun,
  isRunLive,
  loopbackBaseUrl,
  delegateUrl,
  abortUrl,
  INGEST_AGENT,
};
