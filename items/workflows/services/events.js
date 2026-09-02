// events.js — US16/FR-039…FR-043: event-TRIGGERED workflow runs.
//
// Two halves, both pure functions over injected transports so they can be
// unit tested without a live BOS (see __tests__/events.test.js):
//
//   OUTBOUND (subscription management) — reconcileSubscriptions() keeps the
//   set of headless handlers this service has declared with 034's event
//   kernel exactly equal to the union of every workflow's `triggers` array.
//   Declaring is a Worker→Main IPC message (`handler_declare`, the same
//   channel `tool_declare` uses); UN-declaring has no IPC message, so it goes
//   over the loopback HTTP event API (`POST /api/events/unregister`), the
//   same bridge vfs.js already uses for /api/fs.
//
//   INBOUND (dispatch) — handleEventDispatch() handles a Main→Worker
//   `event_dispatch` message: it starts one INDEPENDENT run per workflow that
//   declares the event's type as a trigger, then acks the event IMMEDIATELY
//   (NFR-007: ack on run-START, never on run-completion — a workflow run can
//   take minutes to hours, far past any handler timeout, and the kernel's
//   dispatch queue is per-handler serial, so acking late would stall every
//   later event of the same type behind this run).
//
// Wire shapes are 034's, not this file's invention:
//   handler_declare payload  — { callId, handlerId, eventType, displayName, … }
//                              (src/core/service/types.ts HandlerDeclarePayload)
//   event_dispatch payload   — { callId, eventId, handlerId, record }
//                              (EventDispatchPayload; `record` is an EventRecord,
//                               so the triggering payload is `record.payload`)
//   ack                      — POST /api/events/<eventId>/ack
//                              { handlerId, callerId, callId?, result? }
//   unregister               — POST /api/events/unregister { handlerId, ownerId }
// handleEventDispatch also accepts the flatter `{ eventType, event }` shape so
// a caller (or a test) can hand it either.
//
// NAMESPACE NOTE: the kernel only lets an owner register handlers inside its
// owned root (`com.bos.workflows.*`) plus the `eventNamespaces` its
// service.json is granted — which is why service.json now grants
// `com.bos.*`: a workflow's whole point is to react to events emitted by
// OTHER components (files, mail, downloads…).

/** This service's id — the kernel's `ownerId`/`callerId` for every call below. */
const SERVICE_ID = "workflows";

/** One handler per distinct trigger type, named `workflows:<eventType>`. */
function handlerIdFor(eventType) {
  return `${SERVICE_ID}:${eventType}`;
}

/** The event types this service currently has declared handlers for. Module
 *  level on purpose: the subscription set is a property of the worker (there
 *  is exactly one per running service), and reconcile is called from several
 *  places (startup, every workflow CRUD write). */
let subscribedSet = new Set();

function normalizeTriggers(workflow) {
  const raw = workflow && Array.isArray(workflow.triggers) ? workflow.triggers : [];
  const out = [];
  for (const t of raw) {
    if (typeof t !== "string") continue;
    const trimmed = t.trim();
    if (trimmed) out.push(trimmed);
  }
  return out;
}

/**
 * FR-039: the union of every workflow's declared trigger event types. A
 * workflow with no `triggers` field, a non-array one, or an empty array
 * contributes nothing — event triggering is strictly opt-in per workflow.
 */
function deriveTriggerUnion(workflows) {
  const union = new Set();
  for (const wf of Array.isArray(workflows) ? workflows : []) {
    for (const t of normalizeTriggers(wf)) union.add(t);
  }
  return union;
}

/**
 * True when a workflow's declared trigger matches a concrete emitted type.
 * Exact match, plus the kernel's own `prefix.*` pattern semantics (types.ts
 * typeMatches) so a workflow may declare `triggers: ["com.bos.files.*"]` and
 * be woken by `com.bos.files.created`.
 */
function triggerMatches(trigger, eventType) {
  if (!trigger || !eventType) return false;
  if (trigger === eventType) return true;
  if (trigger.endsWith(".*")) return eventType.startsWith(trigger.slice(0, -1));
  return false;
}

/** Every workflow that declares `eventType` (FR-040). */
function workflowsTriggeredBy(workflows, eventType) {
  return (Array.isArray(workflows) ? workflows : []).filter((wf) =>
    normalizeTriggers(wf).some((t) => triggerMatches(t, eventType)),
  );
}

/**
 * FR-039 — make the declared handler set equal `deriveTriggerUnion(workflows)`.
 *
 * Called at startup and after every workflow create/modify/delete, so it must
 * be IDEMPOTENT and cheap: a type already in `subscribedSet` is skipped
 * entirely rather than re-declared. (Re-declaring would in fact be harmless —
 * the kernel treats a repeat `handler_declare` as an upsert that PRESERVES a
 * user's `enabled` toggle — but skipping keeps the common no-op reconcile
 * free of IPC traffic.)
 *
 * @param {object[]} allWorkflows every workflow currently in the VFS
 * @param {object} deps
 * @param {(msg: object) => void} deps.ipcPost   parentPort.postMessage
 * @param {(method: string, path: string, body?: object) => Promise<{status:number, body:any}>} deps.httpJson  vfs.jsonRequest
 * @param {(level: string, message: string) => void} [deps.log]
 * @returns {Promise<Set<string>>} the new subscription set
 */
async function reconcileSubscriptions(allWorkflows, { ipcPost, httpJson, log } = {}) {
  const logger = log || (() => {});
  const target = deriveTriggerUnion(allWorkflows);

  const added = [];
  for (const eventType of target) {
    if (subscribedSet.has(eventType)) continue; // idempotent — already declared
    const handlerId = handlerIdFor(eventType);
    if (typeof ipcPost !== "function") {
      logger("warn", `event subscribe skipped for "${eventType}": no IPC channel available`);
      continue;
    }
    ipcPost({
      type: "handler_declare",
      payload: {
        callId: `declare-${handlerId}`,
        handlerId,
        eventType,
        // The kernel derives `mode` from the declaring transport, but stating
        // it keeps the message self-describing (and the extra field is ignored).
        mode: "headless",
        displayName: `Run workflows triggered by ${eventType}`,
        description: `Starts every workflow whose triggers include "${eventType}" (US16/FR-040).`,
        icon: "workflow",
      },
    });
    subscribedSet.add(eventType);
    added.push(eventType);
    logger("info", `event subscribe: declared headless handler ${handlerId} for "${eventType}" (NFR-005)`);
  }

  const removed = [];
  for (const eventType of Array.from(subscribedSet)) {
    if (target.has(eventType)) continue;
    const handlerId = handlerIdFor(eventType);
    // No workflow triggers on this type any more. Drop it from the set even if
    // the unregister call fails: a handler the kernel still believes in is
    // harmless (handleEventDispatch acks a dispatch that matches zero
    // workflows), whereas keeping a stale entry here would make a later
    // re-subscribe silently skip its `handler_declare`.
    subscribedSet.delete(eventType);
    removed.push(eventType);
    try {
      if (typeof httpJson !== "function") throw new Error("no loopback HTTP transport available");
      const res = await httpJson("POST", "/api/events/unregister", { handlerId, ownerId: SERVICE_ID, eventType });
      if (res && res.status >= 300) {
        throw new Error((res.body && res.body.error && (res.body.error.message || res.body.error)) || `HTTP ${res.status}`);
      }
      logger("info", `event unsubscribe: unregistered handler ${handlerId} for "${eventType}" (NFR-005)`);
    } catch (err) {
      logger("warn", `event unsubscribe failed for "${eventType}" (non-fatal, handler left registered): ${err.message}`);
    }
  }

  if (added.length || removed.length) {
    logger(
      "info",
      `event subscriptions reconciled: +[${added.join(", ")}] -[${removed.join(", ")}], now watching ${subscribedSet.size} event type(s)`,
    );
  }
  return new Set(subscribedSet);
}

/** Read the dispatch payload tolerantly: 034's `{ eventId, record }` shape,
 *  or a flat `{ eventType, event }` one. */
function readDispatch(dispatchPayload) {
  const p = dispatchPayload || {};
  const record = p.record || p.event || {};
  return {
    callId: p.callId,
    handlerId: p.handlerId,
    eventId: p.eventId || record.id,
    eventType: p.eventType || record.type,
    eventContext: record.payload == null ? null : record.payload,
    record,
  };
}

async function resolveWorkflows(deps) {
  if (Array.isArray(deps.workflows)) return deps.workflows;
  if (typeof deps.listWorkflows === "function") return (await deps.listWorkflows()) || [];
  return [];
}

/**
 * FR-040/041/042/043 + NFR-007 — handle one `event_dispatch`.
 *
 *  1. find every workflow whose `triggers` match the emitted type;
 *  2. start ONE INDEPENDENT run per match, carrying the event provenance
 *     (startSource "event", triggerEventId/Type, eventContext) — this is the
 *     existing fire-and-poll path, so `startRun` returns a runId immediately
 *     and two events for the same workflow legitimately produce two
 *     concurrent runs (FR-043);
 *  3. ack the event RIGHT NOW, not when the runs finish (NFR-007).
 *
 * The ack is sent even when zero workflows matched (a dispatch for a handler
 * whose last triggering workflow was just deleted): an un-acked event stays
 * pending and is re-dispatched, so "nothing to do" must still settle.
 *
 * An ack failure is logged and swallowed — the runs have already started, and
 * throwing would only lose that information. The kernel will re-dispatch, and
 * FR-043 explicitly accepts the resulting duplicate run.
 */
async function handleEventDispatch(dispatchPayload, deps = {}) {
  const { startRun, httpJson } = deps;
  const logger = deps.log || (() => {});
  const { callId, handlerId, eventId, eventType, eventContext } = readDispatch(dispatchPayload);

  let matches = [];
  try {
    matches = workflowsTriggeredBy(await resolveWorkflows(deps), eventType);
  } catch (err) {
    logger("warn", `event_dispatch: could not read workflows for "${eventType}" (${err.message}) — acking with no run started`);
  }

  const started = [];
  for (const wf of matches) {
    try {
      const result = await startRun({
        workflowId: wf.id,
        startSource: "event",
        triggerEventId: eventId,
        triggerEventType: eventType,
        eventContext,
      });
      const runId = result && result.runId;
      started.push({ workflowId: wf.id, runId });
      logger("info", `event_dispatch: event "${eventType}" (${eventId}) started run ${runId} for workflow ${wf.id} (NFR-005)`);
    } catch (err) {
      // One workflow failing to start (unknown id, failed validation) must
      // neither stop the other matches nor block the ack.
      started.push({ workflowId: wf.id, error: err.message });
      logger("warn", `event_dispatch: event "${eventType}" (${eventId}) could not start workflow ${wf.id}: ${err.message}`);
    }
  }
  if (!matches.length) {
    logger("info", `event_dispatch: event "${eventType}" (${eventId}) matched no workflow triggers — acking as a no-op`);
  }

  // NFR-007 — ack on run-START.
  let acked = false;
  try {
    if (typeof httpJson !== "function") throw new Error("no loopback HTTP transport available");
    const res = await httpJson("POST", `/api/events/${encodeURIComponent(eventId)}/ack`, {
      handlerId,
      callerId: SERVICE_ID,
      ...(callId ? { callId } : {}),
      result: { startedRuns: started },
    });
    if (res && res.status >= 300) {
      throw new Error((res.body && res.body.error && (res.body.error.message || res.body.error)) || `HTTP ${res.status}`);
    }
    acked = true;
    logger("info", `event_dispatch: acked event ${eventId} for handler ${handlerId} after starting ${started.length} run(s) (NFR-007)`);
  } catch (err) {
    logger(
      "error",
      `event_dispatch: ack failed for event ${eventId} (handler ${handlerId}): ${err.message} — the ${started.length} run(s) already started continue; a kernel re-dispatch may duplicate them (FR-043)`,
    );
  }

  return { eventId, eventType, handlerId, started, acked };
}

/** Test/introspection seams. */
function getSubscribedSet() {
  return new Set(subscribedSet);
}

function resetSubscriptions() {
  subscribedSet = new Set();
}

module.exports = {
  SERVICE_ID,
  handlerIdFor,
  normalizeTriggers,
  deriveTriggerUnion,
  triggerMatches,
  workflowsTriggeredBy,
  reconcileSubscriptions,
  handleEventDispatch,
  getSubscribedSet,
  resetSubscriptions,
};
