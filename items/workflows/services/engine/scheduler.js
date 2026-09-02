// scheduler.js — the DAG scheduler: ready-set dispatch up to
// maxConcurrentSteps, Research-node fan-out (also capped), per-step retry
// with exponential backoff, dynamic-routing integration (router.js), and
// cancellation.
//
// This module does not persist anything itself — it only calls `emit(event)`
// for every lifecycle/step/agent event; the caller (runs.js) folds those into
// the RunState projection (engine/run-state.js) and persists them.
//
// Scope-add responsibilities (US11/US13/US14/US15):
//   * Option A selection propagation (FR-031) — a node is gated by a routing
//     node's selection ONLY if it is a declared candidate leaf of it; every
//     other node is gated purely by its own dependencies, so a SHARED step
//     between the branch point and the leaves runs normally. An unselected
//     leaf is explicitly `step.skip`ped (reason `branch-not-selected`), not
//     left silently pending.
//   * Zero-executed-leaves guard (FR-032) — a selected branch that runs no
//     leaf emits `workflow.branch.skipped` and downgrades the run's final
//     state to `completed_with_warnings`, never a silent `completed`.
//   * Per-step + per-run timeouts (FR-038) — a stuck agent fails fast with a
//     timeout reason; a run past its deadline is halted.
//   * Dry-run fixtures (FR-037) — a fixture-designated node (including a
//     whole research fan-out) short-circuits to its canned output.
//   * Research fan-out emits per-sub-agent `agent.sub_agent` transitions
//     (FR-022/FR-036) so the straggler is identifiable live.

const { normalizeWorkflow, hasCandidates } = require("./node-model");
const { executeNode, fixtureFor } = require("./executor");
const { resolveCandidates, buildCandidateIndex, selectionAllows } = require("./router");

/** Fallbacks used when the workflow's own config sets no timeout (FR-038:
 *  "configurable … with sensible defaults" — a run may never hang forever). */
const DEFAULT_STEP_TIMEOUT_SEC = 900; // 15 min per step
const DEFAULT_RUN_TIMEOUT_SEC = 7200; // 2 h per run

function stepTimeoutError(node, seconds) {
  const err = new Error(`step "${node.id}" timed out after ${seconds}s`);
  err.code = "step_timeout";
  return err;
}

function isTransientError(err) {
  // Our OWN step timeout is deliberately NOT transient: US15 asks for
  // fail-fast, and retrying a hung agent just burns the same wall clock again.
  if (err && err.code === "step_timeout") return false;
  const msg = (err && err.message ? err.message : "").toLowerCase();
  return msg.includes("timeout") || msg.includes("network") || msg.includes("econnreset") || msg.includes("etimedout") || msg.includes("fetch failed");
}

function backoffMs(attempt) {
  return Math.min(8000, 500 * 2 ** Math.max(0, attempt - 1));
}

function withTimeout(p, timeoutSec, signal, node) {
  if (!timeoutSec) {
    if (signal.aborted) return Promise.reject(new Error("aborted"));
    return p;
  }
  return new Promise((resolve, reject) => {
    const t = setTimeout(() => reject(stepTimeoutError(node, timeoutSec)), timeoutSec * 1000);
    const onAbort = () => {
      clearTimeout(t);
      reject(new Error("aborted"));
    };
    signal.addEventListener("abort", onAbort, { once: true });
    p.then(
      (v) => {
        clearTimeout(t);
        signal.removeEventListener("abort", onAbort);
        resolve(v);
      },
      (e) => {
        clearTimeout(t);
        signal.removeEventListener("abort", onAbort);
        reject(e);
      },
    );
  });
}

function makeEvent(runId, workflowId, type, patch = {}) {
  return { type, runId, workflowId, ts: Date.now(), ...patch };
}

function subAgentLabel(entry, index) {
  if (!entry) return `sub-${index + 1}`;
  if (entry.kind === "static") return entry.agentId || `sub-${index + 1}`;
  const task = String(entry.task || "").trim().replace(/\s+/g, " ");
  return task ? `${index + 1} · ${task.slice(0, 60)}` : `sub-${index + 1}`;
}

/**
 * Research fan-out: one delegate call per researchAgents entry, concurrent up
 * to `concurrency`, with a live `agent.sub_agent` transition per entry
 * (pending → running → completed/failed) so `workflow_status` and the
 * trajectory panel can name the straggler (FR-022/FR-036).
 */
async function runResearchFanOut(node, ctx, opts) {
  const emit = ctx.emit || (() => {});
  const entries = node.researchAgents || [];

  const fixture = fixtureFor(node, ctx);
  if (fixture) {
    // The WHOLE fan-out is fixture-designated: no sub-agent runs at all.
    emit("agent.action", { stepId: node.id, action: `dry-run fixture for "${fixture.key}"` });
    emit("agent.response", { stepId: node.id, text: typeof fixture.value === "string" ? fixture.value : `(dry-run fixture)\n${JSON.stringify(fixture.value, null, 2)}` });
    return fixture.value;
  }

  const results = new Array(entries.length);
  const subIds = entries.map((_, i) => `${node.id}#${i}`);
  const labels = entries.map((entry, i) => subAgentLabel(entry, i));

  emit("agent.prompt", {
    stepId: node.id,
    prompt: [`Research fan-out for workflow step "${node.id}" — ${entries.length} sub-agent(s) run in parallel:`, ...labels.map((l, i) => `  ${i + 1}. ${l}`)].join("\n"),
  });
  entries.forEach((_, i) => emit("agent.sub_agent", { stepId: node.id, subAgentId: subIds[i], label: labels[i], status: "pending", action: "" }));

  let cursor = 0;
  let settled = 0;
  const concurrency = Math.max(1, Math.min(ctx.maxConcurrency, entries.length || 1));

  async function worker() {
    while (cursor < entries.length) {
      const i = cursor++;
      const subNode = {
        ...node,
        id: subIds[i],
        parentId: node.id,
        fixtureKey: subIds[i],
        outputType: "delegate",
        agentSource: entries[i],
        candidates: [],
      };
      emit("agent.sub_agent", { stepId: node.id, subAgentId: subIds[i], label: labels[i], status: "running", action: "running…" });
      try {
        const { output } = await executeNode(subNode, ctx, { signal: opts.signal, subAgentId: subIds[i], label: labels[i] });
        results[i] = { subAgentId: subIds[i], label: labels[i], agentSource: entries[i], output };
        emit("agent.sub_agent", { stepId: node.id, subAgentId: subIds[i], label: labels[i], status: "completed", action: "done" });
      } catch (err) {
        results[i] = { subAgentId: subIds[i], label: labels[i], agentSource: entries[i], error: err.message };
        emit("agent.sub_agent", { stepId: node.id, subAgentId: subIds[i], label: labels[i], status: "failed", action: err.message, error: err.message });
      }
      settled++;
      emit("agent.action", { stepId: node.id, action: `${settled}/${entries.length} sub-agents finished` });
    }
  }
  await Promise.all(Array.from({ length: concurrency }, worker));
  return results;
}

/** Returns `{ output, toolEvents }` — toolEvents carry the structured
 *  select_branch signal router.js reads (FR-029). */
async function runNodeOnce(node, ctx, opts) {
  if (node.outputType === "research") {
    const output = await runResearchFanOut(node, ctx, opts);
    return { output, toolEvents: [] };
  }
  return executeNode(node, ctx, opts);
}

function dispatchAction(node) {
  if (node.outputType === "research") return `fanning out ${(node.researchAgents || []).length} sub-agent(s)`;
  if (node.outputType === "tool") return `calling ${node.toolName || "tool"}`;
  if (node.outputType === "ag-ui") return "producing artifact";
  if (node.outputType === "event") return `emitting ${node.config?.eventType || "event"}`;
  return `delegating to ${node.agentSource?.kind === "static" ? node.agentSource.agentId || "agent" : "ephemeral agent"}`;
}

async function runNode(node, ctx, emit, signal) {
  const retryLimit = node.retryLimit ?? ctx.workflow.config?.defaultRetryLimit ?? 1;
  const timeout = node.timeout ?? ctx.workflow.config?.defaultTimeout ?? ctx.defaultStepTimeout;
  let attempt = 0;
  let lastError = "";
  let lastTimedOut = false;

  while (attempt < retryLimit) {
    attempt++;
    if (signal.aborted) return { status: "cancelled", attempts: attempt - 1, error: "aborted" };
    emit("step.start", { stepId: node.id, attempt, maxAttempts: retryLimit });
    emit("step.running", { stepId: node.id, attempt, action: dispatchAction(node) });
    try {
      const res = await withTimeout(runNodeOnce(node, ctx, { signal }), timeout, signal, node);
      const out = res.output;
      if (node.outputType === "ag-ui") emit("ag-ui", { stepId: node.id, payload: out });

      let selected = null;
      if (hasCandidates(node) && node.outputType !== "ag-ui") {
        emit("step.running", { stepId: node.id, attempt, action: "resolving branch selection" });
        const retryDelegate = (clarification) => executeNode(node, ctx, { signal, extraInstruction: clarification });
        selected = await resolveCandidates(node, res, retryDelegate, {
          onRetry: (n) => emit("agent.action", { stepId: node.id, action: `re-asking for a structured branch selection (${n})` }),
        });
      }

      emit("step.complete", { stepId: node.id, attempt, payload: out, selected: selected || undefined });
      return { status: "complete", attempts: attempt, output: out, selected };
    } catch (err) {
      lastError = err.message;
      lastTimedOut = err.code === "step_timeout";
      if (lastError === "aborted") {
        emit("step.fail", { stepId: node.id, attempt, error: "cancelled" });
        return { status: "cancelled", attempts: attempt, error: "cancelled" };
      }
      const transient = isTransientError(err);
      if (attempt < retryLimit && transient) {
        emit("step.retry", { stepId: node.id, attempt, maxAttempts: retryLimit, error: lastError });
        await new Promise((r) => setTimeout(r, backoffMs(attempt)));
        continue;
      }
      emit("step.fail", { stepId: node.id, attempt, error: lastError, ...(lastTimedOut ? { reason: "step-timeout" } : {}) });
      return { status: "failed", attempts: attempt, error: lastError, timedOut: lastTimedOut };
    }
  }
  return { status: "failed", attempts: attempt, error: lastError || "exhausted retries", timedOut: lastTimedOut };
}

function buildAdjacency(steps) {
  const remainingDeps = new Map();
  const dependents = new Map();
  for (const s of steps) {
    remainingDeps.set(s.id, new Set(s.dependencies ?? []));
    dependents.set(s.id, []);
  }
  for (const s of steps) {
    for (const dep of s.dependencies ?? []) {
      const list = dependents.get(dep);
      if (list) list.push(s.id);
    }
  }
  return { remainingDeps, dependents };
}

/**
 * Run a workflow to completion (or cancellation). Emits events via `emit`
 * (called synchronously for every lifecycle/step/agent event) and resolves
 * with a final summary once every reachable step has settled. `abortSignal`
 * cancels the run (FR-009) — in-flight/pending steps are marked "cancelled";
 * a leaf the routing node did not select is marked "skipped"; steps left
 * unreached by a sibling failure are marked "neutral" (never ran).
 */
async function runWorkflow(wfInput, { runId, workflowName, featureBranch, conversationId, abortSignal, emit, maxConcurrentSteps, dryRun, fixtures, startSource, triggerEventId, triggerEventType, eventContext }) {
  const wf = normalizeWorkflow(wfInput);
  const steps = wf.steps;
  const stepsById = new Map(steps.map((s) => [s.id, s]));
  const { remainingDeps, dependents } = buildAdjacency(steps);
  const { gatedBy, candidatesOf } = buildCandidateIndex(steps);
  const maxConcurrency = Math.max(1, maxConcurrentSteps ?? wf.config?.maxConcurrentSteps ?? 5);

  const emitEvent = (type, patch) => emit(makeEvent(runId, wf.id, type, patch));

  // Per-run deadline (FR-038): an internal controller so a run timeout can
  // halt in-flight steps exactly the way a user cancel does, while staying
  // distinguishable from one in the final state.
  const runTimeoutSec = wf.config?.runTimeout ?? wf.config?.defaultRunTimeout ?? DEFAULT_RUN_TIMEOUT_SEC;
  const internal = new AbortController();
  const signal = internal.signal;
  let runTimedOut = false;
  const onExternalAbort = () => internal.abort();
  if (abortSignal.aborted) internal.abort();
  else abortSignal.addEventListener("abort", onExternalAbort, { once: true });
  const deadline = runTimeoutSec
    ? setTimeout(() => {
        runTimedOut = true;
        internal.abort();
      }, runTimeoutSec * 1000)
    : null;
  if (deadline && typeof deadline.unref === "function") deadline.unref();

  const ctx = {
    workflow: wf,
    workflowName: workflowName || wf.name,
    runId,
    featureBranch,
    conversationId,
    outputs: new Map(),
    maxConcurrency,
    emit: emitEvent,
    dryRun: dryRun === true,
    fixtures: dryRun === true ? fixtures || {} : null,
    defaultStepTimeout: DEFAULT_STEP_TIMEOUT_SEC,
    // US16/FR-041/FR-042 — run provenance travels with the execution context
    // so executor.js can hand an event-triggered run's payload to the root
    // node(s) it woke up.
    startSource: startSource || "tool",
    triggerEventId: triggerEventId ?? null,
    triggerEventType: triggerEventType ?? null,
    eventContext: eventContext ?? null,
  };

  const pending = new Set(steps.map((s) => s.id));
  const inFlight = new Set();
  const queued = new Set();
  const skipped = new Set();
  const selected = new Map();
  const stepStates = {};
  for (const s of steps) stepStates[s.id] = { status: "pending", attempts: 0 };

  let failed = false;
  let cancelled = false;
  let resolver = null;

  const ready = [];
  function enqueueIfReady(id) {
    if (!pending.has(id) || queued.has(id) || skipped.has(id)) return;
    if ((remainingDeps.get(id)?.size ?? 0) !== 0) return;
    if (!selectionAllows(id, gatedBy, selected)) return; // Option A gate
    queued.add(id);
    ready.push(id);
  }
  function markSkipped(id, reason) {
    if (!pending.has(id) || skipped.has(id)) return;
    skipped.add(id);
    pending.delete(id);
    queued.delete(id);
    stepStates[id] = { status: "skipped", attempts: 0, reason };
    emitEvent("step.skip", { stepId: id, reason });
  }

  for (const id of remainingDeps.keys()) enqueueIfReady(id);

  emitEvent("workflow.start", {
    dryRun: ctx.dryRun || undefined,
    startSource: ctx.startSource,
    ...(ctx.startSource === "event" ? { triggerEventType: ctx.triggerEventType, triggerEventId: ctx.triggerEventId } : {}),
  });

  while (pending.size > 0 || inFlight.size > 0) {
    if (signal.aborted) cancelled = true;
    if (cancelled || failed) {
      if (inFlight.size === 0) break; // let already-dispatched steps drain; stop launching new ones
    }
    while (!cancelled && !failed && ready.length > 0 && inFlight.size < maxConcurrency) {
      const id = ready.shift();
      queued.delete(id);
      // A leaf can be skipped by a routing decision after it was queued —
      // never dispatch one that has since been gated out.
      if (skipped.has(id) || !pending.has(id)) continue;
      pending.delete(id);
      inFlight.add(id);
      const node = stepsById.get(id);
      stepStates[id].status = "running";
      void (async () => {
        const res = await runNode(node, ctx, emitEvent, signal);
        inFlight.delete(id);
        if (res.status === "complete") {
          ctx.outputs.set(id, res.output);
          stepStates[id] = { status: "completed", attempts: res.attempts, output: res.output, ...(res.selected ? { selected: res.selected } : {}) };
          if (res.selected) {
            selected.set(id, res.selected);
            // Unselected candidate leaves are explicitly skipped (FR-031),
            // not left pending — a skip is a first-class, reported outcome.
            for (const candidateId of candidatesOf.get(id) || []) {
              if (!res.selected.includes(candidateId)) markSkipped(candidateId, "branch-not-selected");
            }
          }
          // Dependency edges are released for EVERY dependent — the Option A
          // gate (selectionAllows) is what withholds an unselected leaf, so a
          // shared non-candidate step downstream of a routing node runs
          // normally (the exact bug FR-031 fixes).
          for (const child of dependents.get(id) ?? []) {
            const deps = remainingDeps.get(child);
            if (!deps) continue;
            deps.delete(id);
            enqueueIfReady(child);
          }
          // A selected leaf may already have had all its deps satisfied while
          // the gate was closed — re-check it now that the gate is open.
          for (const candidateId of res.selected || []) enqueueIfReady(candidateId);
        } else if (res.status === "cancelled") {
          cancelled = true;
          stepStates[id] = { status: "cancelled", attempts: res.attempts };
        } else {
          failed = true;
          stepStates[id] = { status: "failed", attempts: res.attempts, error: res.error, ...(res.timedOut ? { timedOut: true } : {}) };
        }
        if (resolver) {
          const r = resolver;
          resolver = null;
          r();
        }
      })();
    }
    if (inFlight.size === 0 && (ready.length === 0 || failed)) break;
    await new Promise((res) => (resolver = res));
  }

  if (deadline) clearTimeout(deadline);
  abortSignal.removeEventListener?.("abort", onExternalAbort);

  for (const id of pending) {
    stepStates[id] = { status: cancelled ? "cancelled" : "neutral", attempts: 0 };
  }

  // FR-032: a routing node whose selected branch executed ZERO leaves is a
  // silent no-op — surface it rather than reporting a plain `completed`.
  const branchWarnings = [];
  for (const [routerId, sel] of selected) {
    const executed = sel.filter((leafId) => {
      const st = stepStates[leafId];
      return st && (st.status === "completed" || st.status === "failed");
    });
    if (executed.length === 0) {
      branchWarnings.push({ stepId: routerId, selected: sel });
      emitEvent("workflow.branch.skipped", {
        stepId: routerId,
        selected: sel,
        reason: `routing node "${routerId}" selected [${sel.join(", ")}] but zero of those leaves executed`,
      });
    }
  }

  let state;
  if (runTimedOut) {
    state = "failed";
    emitEvent("workflow.fail", { error: `run timed out after ${runTimeoutSec}s`, reason: "run-timeout" });
  } else if (cancelled) {
    state = "cancelled";
    emitEvent("workflow.cancel");
  } else if (failed) {
    state = "failed";
    emitEvent("workflow.fail", { error: "one or more steps failed" });
  } else {
    state = branchWarnings.length ? "completed_with_warnings" : "completed";
    emitEvent("workflow.complete", { finalState: state, ...(branchWarnings.length ? { warnings: branchWarnings } : {}) });
  }

  return {
    state,
    finalState: state,
    steps: stepStates,
    selected: Object.fromEntries(selected),
    warnings: branchWarnings,
    timedOut: runTimedOut || undefined,
  };
}

module.exports = {
  runWorkflow,
  buildAdjacency,
  isTransientError,
  backoffMs,
  runResearchFanOut,
  DEFAULT_STEP_TIMEOUT_SEC,
  DEFAULT_RUN_TIMEOUT_SEC,
};
