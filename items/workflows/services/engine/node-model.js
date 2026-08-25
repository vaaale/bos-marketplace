// node-model.js — the two orthogonal node axes (spec Key Entities / design.md
// §1.3/§3.4.2). A node is NOT a flat "step type" (that was the retired
// engine's modeling error) — it combines:
//
//   agentSource — WHO executes the node:
//     { kind: "static", agentId }                                  — an existing BOS agent
//     { kind: "ephemeral", task, tools?, skills?, systemPrompt? }   — a one-off agent (FR-021)
//
//   outputType — WHAT the node produces, independent of agentSource:
//     "delegate" | "tool" | "research" | "ag-ui"
//
// Any combination is valid. A node may additionally declare `candidates` — a
// list of downstream step ids the node's agent chooses between as its last
// action (US7/FR-018/FR-019, dynamic routing) — see router.js for the
// selection contract.

const OUTPUT_TYPES = ["delegate", "tool", "research", "ag-ui"];
const AGENT_SOURCE_KINDS = ["static", "ephemeral"];

function isPlainObject(v) {
  return v != null && typeof v === "object" && !Array.isArray(v);
}

/** Fill in defaults / coerce shapes; does not validate (see validate.js for that). */
function normalizeNode(raw) {
  const node = { ...raw };
  node.id = String(node.id ?? "");
  node.outputType = OUTPUT_TYPES.includes(node.outputType) ? node.outputType : "delegate";
  node.dependencies = Array.isArray(node.dependencies) ? node.dependencies.map(String) : [];
  node.candidates = Array.isArray(node.candidates)
    ? node.candidates.map((c) => (isPlainObject(c) ? { id: String(c.id ?? ""), agentId: c.agentId, description: c.description } : { id: String(c) }))
    : [];

  const src = node.agentSource;
  if (isPlainObject(src) && src.kind === "ephemeral") {
    node.agentSource = {
      kind: "ephemeral",
      task: String(src.task ?? ""),
      tools: Array.isArray(src.tools) ? src.tools.map(String) : [],
      skills: Array.isArray(src.skills) ? src.skills.map(String) : [],
      systemPrompt: src.systemPrompt ? String(src.systemPrompt) : undefined,
    };
  } else if (isPlainObject(src) && src.kind === "static") {
    node.agentSource = { kind: "static", agentId: String(src.agentId ?? "") };
  } else {
    // Missing/malformed agentSource normalizes to an empty static ref;
    // validate.js flags this as an error rather than silently defaulting to
    // an ephemeral agent, since "no agent specified" is almost always an
    // authoring mistake, not an intentional ephemeral node.
    node.agentSource = { kind: "static", agentId: "" };
  }

  if (node.outputType === "research") {
    // Research nodes fan out one delegate call per researchAgents entry —
    // each entry is either a static BOS agent id (string) or an inline
    // ephemeral agent spec { task, tools?, skills?, systemPrompt? }. This is
    // deliberately separate from `candidates` (dynamic routing, US7): research
    // fan-out is scheduling (always runs every entry, in parallel), routing
    // is a choice (the agent picks a subset of downstream steps).
    node.researchAgents = Array.isArray(node.researchAgents)
      ? node.researchAgents.map((a) =>
          typeof a === "string"
            ? { kind: "static", agentId: a }
            : { kind: "ephemeral", task: String(a.task ?? ""), tools: Array.isArray(a.tools) ? a.tools.map(String) : [], skills: Array.isArray(a.skills) ? a.skills.map(String) : [], systemPrompt: a.systemPrompt },
        )
      : [];
  }

  return node;
}

function normalizeWorkflow(wf) {
  return {
    ...wf,
    steps: Array.isArray(wf.steps) ? wf.steps.map(normalizeNode) : [],
  };
}

/** Human-readable "outputType · sub" label used by the app graph (mockup §8). */
function describeNode(node) {
  let sub = "";
  if (node.outputType === "tool") sub = node.toolName || "unnamed-tool";
  else if (node.outputType === "research") sub = `${(node.researchAgents || node.candidates || []).length} agent(s)`;
  else if (node.outputType === "ag-ui") sub = node.outputConvention || "artifact";
  else sub = node.agentSource?.kind === "ephemeral" ? "ephemeral" : node.agentSource?.agentId || "agent";
  return `${node.outputType} · ${sub}`;
}

function hasCandidates(node) {
  return Array.isArray(node.candidates) && node.candidates.length > 0;
}

/** FR-019: a node with exactly one candidate auto-delegates — no selection action required. */
function isAutoDelegate(node) {
  return hasCandidates(node) && node.candidates.length === 1;
}

module.exports = {
  OUTPUT_TYPES,
  AGENT_SOURCE_KINDS,
  normalizeNode,
  normalizeWorkflow,
  describeNode,
  hasCandidates,
  isAutoDelegate,
};
