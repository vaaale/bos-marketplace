// run-state.js — the SINGLE SOURCE OF TRUTH for a run's live per-step state
// (US13/FR-036) and the node-scoped agent trace the app's trajectory panel
// renders (US10/FR-026/FR-028).
//
// Before this module the engine had two half-states: `runs.js` kept an
// `events: []` array and only assigned `steps` AFTER `runWorkflow()` resolved,
// so `workflow_status` returned `steps: {}` for the entire duration of a run
// and the app had to re-derive per-step status from the raw event stream
// itself (app/src/lib/liveStatus.ts). Now there is exactly ONE reducer — this
// file — and both consumers (the workflow_* tools and the app) read its
// projection, so they can never disagree (FR-036 / design "One live state,
// two consumers").
//
// Shape (spec US13):
//   RunState { runId, workflowId, status, finalState?, startedAt, endedAt?,
//              selected: Map<nodeId, candidateId[]>,
//              steps: Map<nodeId, StepRuntimeState> }
//   StepRuntimeState { status, attempt, maxAttempts, currentAction?,
//                      subAgents?: Map<subAgentId, {label,status,action}>,
//                      outputs?: structuredData,
//                      agentTrace?: { prompt?, thinking?,
//                                     toolCalls: [{name,args,result,ok,inflight}],
//                                     response? } }
//
// The event log is append-only with a monotonic `seq`, which is what makes
// `subscribe(since)` / `GET /run/<runId>?since=` a cheap tail rather than a
// full re-read, and what makes a persisted run replayable byte-for-byte into
// the same projection (historical mode in the trajectory panel).

/** Every lifecycle event the panel renders as a row, in mockup order. */
const STEP_EVENT_TYPES = ["step.start", "step.retry", "step.running", "step.complete", "step.fail", "step.cancel", "step.skip"];
/** Agent-execution events (FR-028) — trace-only, never rendered as lifecycle rows. */
const AGENT_EVENT_TYPES = ["agent.prompt", "agent.reasoning", "agent.tool_call", "agent.response", "agent.action", "agent.sub_agent"];

const TERMINAL_STEP_STATUSES = new Set(["completed", "failed", "cancelled", "skipped", "neutral"]);

/** US16/FR-041 — how a run was started. "user" = the app's Run button,
 *  "tool" = the `workflow_run` tool (the historical default), "event" = a 034
 *  event dispatch matched one of the workflow's `triggers` (events.js). */
const START_SOURCES = ["user", "tool", "event"];

function emptyTrace() {
  return { toolCalls: [] };
}

function newStepState() {
  return {
    status: "pending",
    attempt: 0,
    maxAttempts: 1,
    currentAction: undefined,
    subAgents: new Map(),
    outputs: undefined,
    agentTrace: emptyTrace(),
  };
}

function toolCallKey(ev) {
  if (ev.callId) return `id:${ev.callId}`;
  if (ev.name) return `name:${ev.name}`;
  return "anon";
}

/** Merge one `agent.tool_call` event into a trace: an inflight call is updated
 *  IN PLACE by its completion rather than appended twice (FR-028). */
function mergeToolCall(trace, ev) {
  const key = toolCallKey(ev);
  // Prefer the newest still-inflight call with this key; otherwise the newest
  // call with this key that has no result yet.
  let target = null;
  for (let i = trace.toolCalls.length - 1; i >= 0; i--) {
    const tc = trace.toolCalls[i];
    if (tc.key !== key) continue;
    if (tc.inflight) {
      target = tc;
      break;
    }
  }
  if (!target) {
    target = { key, name: ev.name || "tool", args: ev.args, result: undefined, ok: undefined, inflight: ev.inflight !== false };
    trace.toolCalls.push(target);
    if (ev.inflight !== false && ev.result === undefined) return trace;
  }
  if (ev.name) target.name = ev.name;
  if (ev.args !== undefined) target.args = ev.args;
  if (ev.result !== undefined) target.result = ev.result;
  if (ev.ok !== undefined) target.ok = ev.ok;
  target.inflight = ev.inflight === true;
  if (!target.inflight && target.ok === undefined) target.ok = true;
  return trace;
}

class RunState {
  constructor({ runId, workflowId, workflowName, startedAt, startSource, triggerEventId, triggerEventType, eventContext } = {}) {
    this.runId = runId;
    this.workflowId = workflowId;
    this.workflowName = workflowName;
    // US16/FR-041 — run PROVENANCE. `startSource` defaults to "tool" so a run
    // record written before this field existed (and any caller that does not
    // pass one) reads back exactly as it always did.
    this.startSource = START_SOURCES.includes(startSource) ? startSource : "tool";
    this.triggerEventId = this.startSource === "event" ? (triggerEventId ?? null) : null;
    this.triggerEventType = this.startSource === "event" ? (triggerEventType ?? null) : null;
    this.eventContext = this.startSource === "event" ? (eventContext ?? null) : null;
    this.status = "running";
    this.finalState = undefined;
    this.startedAt = startedAt ?? Date.now();
    this.endedAt = undefined;
    this.error = undefined;
    this.selected = new Map();
    this.steps = new Map();
    this.warnings = [];
    this.events = [];
    this.seq = 0;
    this.listeners = new Set();
  }

  /** Pre-seed the per-step map from the workflow so a poll before the first
   *  dispatch already returns every step as "pending" (never `steps: {}`). */
  seedSteps(steps) {
    for (const s of steps || []) {
      if (!s || !s.id) continue;
      if (!this.steps.has(s.id)) this.steps.set(s.id, newStepState());
      const st = this.steps.get(s.id);
      st.maxAttempts = s.retryLimit ?? st.maxAttempts;
    }
    return this;
  }

  stepFor(id) {
    if (!this.steps.has(id)) this.steps.set(id, newStepState());
    return this.steps.get(id);
  }

  /** Append one engine event, fold it into the projection, notify subscribers. */
  record(event) {
    const ev = { ...event, seq: ++this.seq, ts: event.ts ?? Date.now() };
    this.events.push(ev);
    this.apply(ev);
    for (const listener of this.listeners) {
      try {
        listener([ev]);
      } catch {
        // a bad subscriber must never break the engine's event loop
      }
    }
    return ev;
  }

  apply(ev) {
    switch (ev.type) {
      case "workflow.start":
        this.status = "running";
        this.startedAt = ev.ts ?? this.startedAt;
        return;
      case "workflow.complete":
        this.status = ev.finalState || "completed";
        this.finalState = ev.finalState || "completed";
        this.endedAt = ev.ts;
        return;
      case "workflow.fail":
        this.status = "failed";
        this.finalState = "failed";
        this.error = ev.error;
        this.endedAt = ev.ts;
        return;
      case "workflow.cancel":
        this.status = "cancelled";
        this.finalState = "cancelled";
        this.endedAt = ev.ts;
        return;
      case "workflow.branch.skipped":
        this.warnings.push({ stepId: ev.stepId, selected: ev.selected, reason: ev.reason || "branch-selected-but-no-leaf-executed", ts: ev.ts });
        return;
      default:
        break;
    }
    if (!ev.stepId) return;
    const st = this.stepFor(ev.stepId);

    switch (ev.type) {
      case "step.start": {
        // A retry is a fresh attempt: the panel must show THIS attempt's
        // prompt/tool calls, not attempt 1's (mockup run #7 `transform`).
        if (ev.attempt && ev.attempt > 1) st.agentTrace = emptyTrace();
        st.status = "running";
        st.attempt = ev.attempt ?? st.attempt + 1;
        if (ev.maxAttempts) st.maxAttempts = ev.maxAttempts;
        st.currentAction = ev.action || "starting…";
        st.error = undefined;
        return;
      }
      case "step.retry":
        st.status = "running";
        st.attempt = ev.attempt ?? st.attempt;
        if (ev.maxAttempts) st.maxAttempts = ev.maxAttempts;
        st.error = ev.error;
        st.currentAction = ev.action || "retrying…";
        return;
      case "step.running":
        st.status = "running";
        if (ev.action) st.currentAction = ev.action;
        return;
      case "step.complete":
        st.status = "completed";
        if (ev.attempt) st.attempt = ev.attempt;
        st.currentAction = undefined;
        if (ev.payload !== undefined) st.outputs = ev.payload;
        if (ev.selected) {
          st.selected = ev.selected;
          this.selected.set(ev.stepId, ev.selected);
        }
        return;
      case "step.fail":
        st.status = ev.error === "cancelled" ? "cancelled" : "failed";
        if (ev.attempt) st.attempt = ev.attempt;
        st.error = ev.error;
        st.timedOut = ev.reason === "step-timeout" || undefined;
        st.currentAction = undefined;
        return;
      case "step.cancel":
        st.status = "cancelled";
        st.currentAction = undefined;
        return;
      case "step.skip":
        st.status = "skipped";
        st.reason = ev.reason;
        st.currentAction = undefined;
        return;
      case "agent.prompt":
        this.traceFor(st, ev).prompt = ev.prompt;
        return;
      case "agent.reasoning": {
        const trace = this.traceFor(st, ev);
        const text = ev.text ?? ev.delta ?? "";
        trace.thinking = ev.replace ? text : `${trace.thinking || ""}${text}`;
        return;
      }
      case "agent.tool_call":
        mergeToolCall(this.traceFor(st, ev), ev);
        return;
      case "agent.response": {
        const trace = this.traceFor(st, ev);
        const text = ev.text ?? ev.delta ?? "";
        trace.response = ev.append ? `${trace.response || ""}${text}` : text;
        return;
      }
      case "agent.action":
        if (ev.subAgentId) {
          const sa = this.subAgentFor(st, ev.subAgentId, ev.label);
          sa.action = ev.action;
        } else if (ev.action !== undefined) {
          // An explicit empty action clears the line ("no longer doing
          // anything in particular"), which is why this tests for presence
          // rather than truthiness.
          st.currentAction = ev.action || undefined;
        }
        return;
      case "agent.sub_agent": {
        const sa = this.subAgentFor(st, ev.subAgentId, ev.label);
        if (ev.label) sa.label = ev.label;
        if (ev.status) sa.status = ev.status;
        if (ev.action !== undefined) sa.action = ev.action;
        if (ev.error) sa.error = ev.error;
        return;
      }
      default:
        return;
    }
  }

  subAgentFor(st, subAgentId, label) {
    if (!st.subAgents.has(subAgentId)) st.subAgents.set(subAgentId, { id: subAgentId, label: label || subAgentId, status: "pending", action: "" });
    return st.subAgents.get(subAgentId);
  }

  /** Agent events carrying a `subAgentId` belong to that sub-agent's own
   *  trace (research fan-out), not to the parent node's trace. */
  traceFor(st, ev) {
    if (!ev.subAgentId) {
      if (!st.agentTrace) st.agentTrace = emptyTrace();
      return st.agentTrace;
    }
    const sa = this.subAgentFor(st, ev.subAgentId, ev.label);
    if (!sa.agentTrace) sa.agentTrace = emptyTrace();
    return sa.agentTrace;
  }

  /** Final per-step outcomes handed back by the scheduler when the run ends —
   *  authoritative for steps that never emitted an event at all ("neutral"). */
  applyFinalSteps(stepStates) {
    for (const [id, final] of Object.entries(stepStates || {})) {
      const st = this.stepFor(id);
      st.status = final.status;
      if (final.attempts) st.attempt = final.attempts;
      if (final.attempt) st.attempt = final.attempt;
      // Persisted runs carry maxAttempts, but a REPLAYED state has no
      // workflow to seed it from — restore it so a historical trajectory
      // shows the same "attempt N/M" the live one did.
      if (final.maxAttempts) st.maxAttempts = final.maxAttempts;
      if (final.currentAction) st.currentAction = final.currentAction;
      if (final.output !== undefined) st.outputs = final.output;
      if (final.error) st.error = final.error;
      if (final.reason) st.reason = final.reason;
    }
  }

  eventsSince(since) {
    const from = Number.isFinite(since) ? Number(since) : 0;
    if (!from) return this.events;
    return this.events.filter((e) => e.seq > from);
  }

  /** Tail the log. `cb` receives arrays of new events; returns an unsubscribe. */
  subscribe(since, cb) {
    const backlog = this.eventsSince(since);
    if (backlog.length) {
      try {
        cb(backlog);
      } catch {
        // ignore — see record()
      }
    }
    this.listeners.add(cb);
    return () => this.listeners.delete(cb);
  }

  stepsSnapshot() {
    const out = {};
    for (const [id, st] of this.steps) out[id] = serializeStep(st);
    return out;
  }

  selectedSnapshot() {
    const out = {};
    for (const [id, sel] of this.selected) out[id] = sel;
    return out;
  }

  /** The wire shape returned by GET /run/<runId>, workflow_status, and
   *  workflow_run_get — identical for live and replayed runs. */
  snapshot({ since } = {}) {
    return {
      runId: this.runId,
      workflowId: this.workflowId,
      workflowName: this.workflowName,
      startSource: this.startSource,
      triggerEventId: this.triggerEventId,
      triggerEventType: this.triggerEventType,
      eventContext: this.eventContext,
      status: this.status,
      state: this.status,
      finalState: this.finalState,
      startedAt: this.startedAt,
      endedAt: this.endedAt,
      error: this.error,
      selected: this.selectedSnapshot(),
      steps: this.stepsSnapshot(),
      warnings: this.warnings,
      events: this.eventsSince(since),
      seq: this.seq,
    };
  }

  /** The persisted run record (FR-015/FR-028: same file, richer schema). */
  toPersisted() {
    return {
      schemaVersion: 2,
      workflowId: this.workflowId,
      workflowName: this.workflowName,
      runId: this.runId,
      startSource: this.startSource,
      triggerEventId: this.triggerEventId,
      triggerEventType: this.triggerEventType,
      eventContext: this.eventContext,
      startedAt: this.startedAt,
      endedAt: this.endedAt,
      state: this.status,
      finalState: this.finalState,
      error: this.error,
      selected: this.selectedSnapshot(),
      steps: this.stepsSnapshot(),
      warnings: this.warnings,
      events: this.events,
    };
  }
}

function serializeSubAgents(map) {
  const out = {};
  for (const [id, sa] of map) out[id] = { ...sa, ...(sa.agentTrace ? { agentTrace: { ...sa.agentTrace, toolCalls: sa.agentTrace.toolCalls.map(serializeToolCall) } } : {}) };
  return out;
}

function serializeToolCall(tc) {
  const { key, ...rest } = tc;
  return rest;
}

function serializeStep(st) {
  const out = {
    status: st.status,
    attempt: st.attempt,
    // Legacy field name kept so existing consumers (and the persisted run
    // schema v1) keep working — `attempts` and `attempt` are the same number.
    attempts: st.attempt,
    maxAttempts: st.maxAttempts,
  };
  if (st.currentAction) out.currentAction = st.currentAction;
  if (st.error) out.error = st.error;
  if (st.reason) out.reason = st.reason;
  if (st.timedOut) out.timedOut = true;
  if (st.selected) out.selected = st.selected;
  if (st.outputs !== undefined) {
    out.outputs = st.outputs;
    out.output = st.outputs; // v1 field name, still read by the app + tests
  }
  if (st.subAgents && st.subAgents.size) out.subAgents = serializeSubAgents(st.subAgents);
  if (st.agentTrace && (st.agentTrace.prompt || st.agentTrace.thinking || st.agentTrace.response || st.agentTrace.toolCalls.length)) {
    out.agentTrace = {
      prompt: st.agentTrace.prompt,
      thinking: st.agentTrace.thinking,
      response: st.agentTrace.response,
      toolCalls: st.agentTrace.toolCalls.map(serializeToolCall),
    };
  }
  return out;
}

function createRunState(opts) {
  return new RunState(opts);
}

/**
 * Rebuild the exact same projection from a PERSISTED run record — this is
 * what makes a historical run replayable in the trajectory panel with the
 * full agent trace, not just final statuses (US10 scenario 4).
 */
function replayRunState(persisted) {
  if (!persisted) return undefined;
  const rs = new RunState({
    runId: persisted.runId,
    workflowId: persisted.workflowId,
    workflowName: persisted.workflowName,
    startedAt: persisted.startedAt,
    // A pre-US16 run record carries none of these — the constructor's "tool"
    // default is exactly the right answer for it (FR-041).
    startSource: persisted.startSource,
    triggerEventId: persisted.triggerEventId,
    triggerEventType: persisted.triggerEventType,
    eventContext: persisted.eventContext,
  });
  for (const ev of persisted.events || []) {
    rs.events.push(ev);
    rs.seq = Math.max(rs.seq, ev.seq || 0);
    rs.apply(ev);
  }
  if (!rs.seq) rs.seq = rs.events.length;
  // Persisted final statuses win over the replayed ones (they carry
  // "neutral" for steps that never emitted a single event).
  if (persisted.steps) rs.applyFinalSteps(persisted.steps);
  rs.status = persisted.state || rs.status;
  rs.finalState = persisted.finalState || rs.finalState;
  rs.endedAt = persisted.endedAt ?? rs.endedAt;
  rs.error = persisted.error ?? rs.error;
  if (persisted.selected) for (const [k, v] of Object.entries(persisted.selected)) rs.selected.set(k, v);
  if (persisted.warnings) rs.warnings = persisted.warnings;
  return rs;
}

// ---------------------------------------------------------------------------
// Process-wide registry — how http-bridge.js's GET /run/<runId> (and runs.js)
// find a live run's state by id alone, with no workflowId round trip.
// ---------------------------------------------------------------------------

const REGISTRY = new Map();

function registerRunState(rs) {
  REGISTRY.set(rs.runId, rs);
  return rs;
}

function getRunState(runId) {
  return REGISTRY.get(runId);
}

function unregisterRunState(runId) {
  REGISTRY.delete(runId);
}

function runStatesForWorkflow(workflowId) {
  return Array.from(REGISTRY.values()).filter((rs) => rs.workflowId === workflowId);
}

module.exports = {
  RunState,
  START_SOURCES,
  STEP_EVENT_TYPES,
  AGENT_EVENT_TYPES,
  TERMINAL_STEP_STATUSES,
  createRunState,
  replayRunState,
  serializeStep,
  registerRunState,
  getRunState,
  unregisterRunState,
  runStatesForWorkflow,
};
