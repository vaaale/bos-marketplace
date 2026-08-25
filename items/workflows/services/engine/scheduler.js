// scheduler.js — the DAG scheduler: ready-set dispatch up to
// maxConcurrentSteps, Research-node fan-out (also capped), per-step retry
// with exponential backoff, dynamic-routing integration (router.js), and
// cancellation. Re-implements + extends the retired src/lib/workflows/
// runner.ts's scheduling core for the new node model (node-model.js) and the
// loopback execution contract (executor.js).
//
// This module does not persist anything itself — it only calls `emit(event)`
// for every lifecycle/step event; the caller (handlers.js/runs.js) is
// responsible for appending events to the run log and updating live state.

const { normalizeWorkflow, hasCandidates, isAutoDelegate } = require("./node-model");
const { executeNode } = require("./executor");
const { resolveCandidates } = require("./router");

function isTransientError(err) {
  const msg = (err && err.message ? err.message : "").toLowerCase();
  return msg.includes("timeout") || msg.includes("network") || msg.includes("econnreset") || msg.includes("etimedout") || msg.includes("fetch failed");
}

function backoffMs(attempt) {
  return Math.min(8000, 500 * 2 ** Math.max(0, attempt - 1));
}

function withTimeout(p, timeoutSec, signal) {
  if (!timeoutSec) {
    if (signal.aborted) return Promise.reject(new Error("aborted"));
    return p;
  }
  return new Promise((resolve, reject) => {
    const t = setTimeout(() => reject(new Error(`step timed out after ${timeoutSec}s`)), timeoutSec * 1000);
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

/** Research fan-out: one delegate call per researchAgents entry, concurrent up to `concurrency`. */
async function runResearchFanOut(node, ctx, opts) {
  const entries = node.researchAgents || [];
  const results = new Array(entries.length);
  let cursor = 0;
  const concurrency = Math.max(1, Math.min(ctx.maxConcurrency, entries.length || 1));

  async function worker() {
    while (cursor < entries.length) {
      const i = cursor++;
      const subNode = { ...node, id: `${node.id}#${i}`, outputType: "delegate", agentSource: entries[i], candidates: [] };
      try {
        const { output } = await executeNode(subNode, ctx, { signal: opts.signal });
        results[i] = { agentSource: entries[i], output };
      } catch (err) {
        results[i] = { agentSource: entries[i], error: err.message };
      }
    }
  }
  await Promise.all(Array.from({ length: concurrency }, worker));
  return results;
}

async function runNodeOnce(node, ctx, opts) {
  if (node.outputType === "research") return runResearchFanOut(node, ctx, opts);
  const { output } = await executeNode(node, ctx, opts);
  return output;
}

async function runNode(node, ctx, emit, signal) {
  const retryLimit = node.retryLimit ?? ctx.workflow.config?.defaultRetryLimit ?? 1;
  const timeout = node.timeout ?? ctx.workflow.config?.defaultTimeout;
  let attempt = 0;
  let lastError = "";

  while (attempt < retryLimit) {
    attempt++;
    if (signal.aborted) return { status: "cancelled", attempts: attempt - 1, error: "aborted" };
    emit(makeEvent(ctx.runId, ctx.workflow.id, "step.start", { stepId: node.id, attempt }));
    try {
      const out = await withTimeout(runNodeOnce(node, ctx, { signal }), timeout, signal);
      if (node.outputType === "ag-ui") emit(makeEvent(ctx.runId, ctx.workflow.id, "ag-ui", { stepId: node.id, payload: out }));

      let selected = null;
      if (hasCandidates(node) && node.outputType !== "ag-ui") {
        const retryDelegate = async (clarification) => {
          const { output } = await executeNode(node, ctx, { signal, extraInstruction: clarification });
          return typeof output === "string" ? output : JSON.stringify(output ?? "");
        };
        selected = await resolveCandidates(node, out, retryDelegate);
      }

      emit(makeEvent(ctx.runId, ctx.workflow.id, "step.complete", { stepId: node.id, attempt, payload: out, selected: selected || undefined }));
      return { status: "complete", attempts: attempt, output: out, selected };
    } catch (err) {
      lastError = err.message;
      if (lastError === "aborted") {
        emit(makeEvent(ctx.runId, ctx.workflow.id, "step.fail", { stepId: node.id, attempt, error: "cancelled" }));
        return { status: "cancelled", attempts: attempt, error: "cancelled" };
      }
      const transient = isTransientError(err);
      if (attempt < retryLimit && transient) {
        emit(makeEvent(ctx.runId, ctx.workflow.id, "step.retry", { stepId: node.id, attempt, error: lastError }));
        await new Promise((r) => setTimeout(r, backoffMs(attempt)));
        continue;
      }
      emit(makeEvent(ctx.runId, ctx.workflow.id, "step.fail", { stepId: node.id, attempt, error: lastError }));
      return { status: "failed", attempts: attempt, error: lastError };
    }
  }
  return { status: "failed", attempts: attempt, error: lastError || "exhausted retries" };
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
 * (called synchronously for every lifecycle/step event) and resolves with a
 * final summary once every reachable step has settled. `abortSignal` cancels
 * the run (FR-009) — in-flight/pending steps are marked "cancelled"; steps
 * left unreached purely by dynamic routing (an unselected candidate) or a
 * sibling failure are marked "neutral" (never ran).
 */
async function runWorkflow(wfInput, { runId, workflowName, featureBranch, conversationId, abortSignal, emit, maxConcurrentSteps }) {
  const wf = normalizeWorkflow(wfInput);
  const steps = wf.steps;
  const stepsById = new Map(steps.map((s) => [s.id, s]));
  const { remainingDeps, dependents } = buildAdjacency(steps);
  const maxConcurrency = Math.max(1, maxConcurrentSteps ?? wf.config?.maxConcurrentSteps ?? 5);

  const ctx = { workflow: wf, workflowName: workflowName || wf.name, runId, outputs: new Map(), maxConcurrency };

  const pending = new Set(steps.map((s) => s.id));
  const inFlight = new Set();
  const stepStates = {};
  for (const s of steps) stepStates[s.id] = { status: "pending", attempts: 0 };

  let failed = false;
  let cancelled = false;
  let resolver = null;

  const ready = [];
  for (const [id, deps] of remainingDeps) if (deps.size === 0) ready.push(id);

  emit(makeEvent(runId, wf.id, "workflow.start"));

  while (pending.size > 0 || inFlight.size > 0) {
    if (abortSignal.aborted) {
      cancelled = true;
    }
    if (cancelled || failed) {
      if (inFlight.size === 0) break; // let already-dispatched steps drain; stop launching new ones
    }
    while (!cancelled && !failed && ready.length > 0 && inFlight.size < maxConcurrency) {
      const id = ready.shift();
      pending.delete(id);
      inFlight.add(id);
      const node = stepsById.get(id);
      stepStates[id].status = "running";
      void (async () => {
        const res = await runNode(node, ctx, emit, abortSignal);
        inFlight.delete(id);
        if (res.status === "complete") {
          ctx.outputs.set(id, res.output);
          stepStates[id] = { status: "completed", attempts: res.attempts, output: res.output };
          const allChildren = dependents.get(id) ?? [];
          const unlocked = res.selected ? new Set(res.selected) : null;
          for (const child of allChildren) {
            if (unlocked && !unlocked.has(child)) continue; // routed away — stays pending forever, reported "neutral" at the end
            const deps = remainingDeps.get(child);
            if (!deps) continue;
            deps.delete(id);
            if (deps.size === 0 && pending.has(child)) ready.push(child);
          }
        } else if (res.status === "cancelled") {
          cancelled = true;
          stepStates[id] = { status: "cancelled", attempts: res.attempts };
        } else {
          failed = true;
          stepStates[id] = { status: "failed", attempts: res.attempts, error: res.error };
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

  for (const id of pending) {
    stepStates[id] = { status: cancelled ? "cancelled" : "neutral", attempts: 0 };
  }

  let state;
  if (cancelled) {
    state = "cancelled";
    emit(makeEvent(runId, wf.id, "workflow.cancel"));
  } else if (failed) {
    state = "failed";
    emit(makeEvent(runId, wf.id, "workflow.fail", { error: "one or more steps failed" }));
  } else {
    state = "completed";
    emit(makeEvent(runId, wf.id, "workflow.complete"));
  }

  return { state, steps: stepStates };
}

module.exports = { runWorkflow, buildAdjacency, isTransientError, backoffMs };
