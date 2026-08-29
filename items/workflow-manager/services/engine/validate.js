// validate.js — DAG acyclicity + node schema validation. Re-implemented from
// the retired src/lib/workflows/validate.ts (Kahn's-algorithm cycle check),
// extended for the new node model (agentSource x outputType, candidates).
// Self-contained — no BOS-source import; the worker cannot list real BOS
// sub-agents, so a "static" agentSource's agentId is checked for presence
// only, not existence (that check now happens at execution time, in
// executor.js, where a missing agent surfaces as a normal step failure).

const { OUTPUT_TYPES, normalizeNode } = require("./node-model");
const { buildCandidateIndex } = require("./router");

/** Kahn's algorithm: true if the step graph (by declared dependencies) is acyclic. */
function isAcyclic(steps) {
  const inDeg = new Map();
  const adj = new Map();
  for (const s of steps) {
    inDeg.set(s.id, 0);
    adj.set(s.id, []);
  }
  for (const s of steps) {
    for (const dep of s.dependencies ?? []) {
      if (!inDeg.has(dep)) continue; // missing dep flagged separately
      inDeg.set(s.id, (inDeg.get(s.id) ?? 0) + 1);
      adj.get(dep).push(s.id);
    }
  }
  const queue = [];
  for (const [id, d] of inDeg) if (d === 0) queue.push(id);
  let visited = 0;
  while (queue.length) {
    const cur = queue.shift();
    visited++;
    for (const next of adj.get(cur) ?? []) {
      const d = (inDeg.get(next) ?? 0) - 1;
      inDeg.set(next, d);
      if (d === 0) queue.push(next);
    }
  }
  return visited === steps.length;
}

/** Which steps a step unlocks, by declared dependency edges (dep -> dependents). */
function dependentsIndex(steps) {
  const map = new Map(steps.map((s) => [s.id, []]));
  for (const s of steps) {
    for (const dep of s.dependencies ?? []) {
      if (map.has(dep)) map.get(dep).push(s.id);
    }
  }
  return map;
}

function reachableFrom(startId, dependents) {
  const seen = new Set();
  const queue = [startId];
  while (queue.length) {
    const cur = queue.shift();
    for (const next of dependents.get(cur) ?? []) {
      if (seen.has(next)) continue;
      seen.add(next);
      queue.push(next);
    }
  }
  return seen;
}

/**
 * FR-033 — candidate TOPOLOGY. Both of these are silent-no-op generators at
 * run time (they were exactly how a run reported `completed` having performed
 * no terminal action), so they are structural ERRORS, not warnings:
 *
 *  1. UNREACHABLE CANDIDATE LEAF — a candidate that has no dependency path
 *     back to its routing node can never be unlocked by the selection.
 *  2. AMBIGUOUS SHARED + GATED LEAF — a candidate leaf that other, ungated
 *     work depends on. Under Option A (FR-031) the leaf only runs when it is
 *     selected, so every ungated dependent of it is silently blocked whenever
 *     it is not; the node is trying to be a gated branch AND a shared step at
 *     once. Fix by moving the shared work above the branch point, or by
 *     declaring the dependent a candidate of the same routing node.
 */
function candidateTopologyErrors(steps, stepIds) {
  const errors = [];
  const { gatedBy, candidatesOf } = buildCandidateIndex(steps);
  if (candidatesOf.size === 0) return errors;
  const dependents = dependentsIndex(steps);

  for (const [routerId, candidateIds] of candidatesOf) {
    const reachable = reachableFrom(routerId, dependents);
    for (const leafId of candidateIds) {
      if (!stepIds.has(leafId)) continue; // already reported as an unknown candidate
      if (!reachable.has(leafId)) {
        errors.push(
          `Step "${routerId}" declares candidate "${leafId}" but there is no dependency path from "${routerId}" to "${leafId}" — the selection could never unlock it (unreachable candidate leaf).`,
        );
      }
    }
  }

  for (const [leafId, routers] of gatedBy) {
    for (const dependentId of dependents.get(leafId) ?? []) {
      const dependentRouters = gatedBy.get(dependentId);
      for (const routerId of routers) {
        if (dependentRouters && dependentRouters.has(routerId)) continue; // gated by the same router — consistent
        errors.push(
          `Step "${leafId}" is ambiguously both a gated candidate leaf of "${routerId}" and a shared dependency of "${dependentId}" (which is not gated by "${routerId}") — "${dependentId}" would be silently blocked whenever "${leafId}" is not selected. Move the shared work above the branch point, or declare "${dependentId}" a candidate of "${routerId}" too.`,
        );
      }
    }
  }

  return errors;
}

function validateWorkflow(wf) {
  const errors = [];
  const warnings = [];

  if (!wf || typeof wf !== "object") {
    return { ok: false, errors: ["Workflow must be an object."], warnings: [] };
  }
  if (!wf.id) errors.push("Workflow is missing an id.");
  if (!wf.name) warnings.push("Workflow has no name.");
  if (!Array.isArray(wf.steps) || wf.steps.length === 0) errors.push("Workflow must have at least one step.");

  const steps = (Array.isArray(wf.steps) ? wf.steps : []).map(normalizeNode);
  const stepIds = new Set();
  for (const s of steps) {
    if (!s.id) {
      errors.push("A step is missing an id.");
      continue;
    }
    if (stepIds.has(s.id)) errors.push(`Duplicate step id: ${s.id}.`);
    stepIds.add(s.id);
    if (!OUTPUT_TYPES.includes(s.outputType)) errors.push(`Step "${s.id}" has invalid outputType "${s.outputType}".`);

    // agentSource ("who executes the node") only applies to delegate/tool
    // nodes — ag-ui never delegates (its output is just node.input) and
    // research fans out its OWN per-entry agent sources (researchAgents),
    // not a single top-level one.
    if (s.outputType === "delegate" || s.outputType === "tool") {
      const src = s.agentSource;
      if (!src || (src.kind !== "static" && src.kind !== "ephemeral")) {
        errors.push(`Step "${s.id}" has an invalid agentSource (must be kind "static" or "ephemeral").`);
      } else if (src.kind === "static" && !src.agentId) {
        errors.push(`Step "${s.id}" (static agentSource) requires an agentId.`);
      } else if (src.kind === "ephemeral" && !src.task) {
        errors.push(`Step "${s.id}" (ephemeral agentSource) requires a task description.`);
      }
    }

    if (s.outputType === "tool" && !s.toolName) errors.push(`Step "${s.id}" (tool) requires a toolName.`);
    if (s.outputType === "research") {
      const fanOut = (s.researchAgents || []).length || (s.candidates || []).length;
      if (!fanOut) warnings.push(`Step "${s.id}" (research) declares no researchAgents/candidates to fan out to.`);
    }
  }

  for (const s of steps) {
    for (const dep of s.dependencies ?? []) {
      if (!stepIds.has(dep)) errors.push(`Step "${s.id}" depends on missing step "${dep}".`);
    }
    // FR-018/T039: candidateAgents (here: candidates[].id) must name real
    // downstream steps so dynamic routing has something to unlock.
    for (const cand of s.candidates ?? []) {
      if (!stepIds.has(cand.id)) errors.push(`Step "${s.id}" declares unknown candidate "${cand.id}".`);
    }
  }

  errors.push(...candidateTopologyErrors(steps, stepIds));

  if (steps.length > 0 && !isAcyclic(steps)) {
    errors.push("Workflow has a dependency cycle.");
  }

  return { ok: errors.length === 0, errors, warnings };
}

module.exports = { validateWorkflow, isAcyclic, candidateTopologyErrors };
