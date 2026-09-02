// node-model.js — the two orthogonal node axes (spec Key Entities / design.md
// §1.3/§3.4.2). A node is NOT a flat "step type" (that was the retired
// engine's modeling error) — it combines:
//
//   agentSource — WHO executes the node:
//     { kind: "static", agentId }                                  — an existing BOS agent
//     { kind: "ephemeral", task, tools?, skills?, systemPrompt? }   — a one-off agent (FR-021)
//
//   outputType — WHAT the node produces, independent of agentSource:
//     "delegate" | "tool" | "research" | "ag-ui" | "event"
//
// Any combination is valid. `event` (US18/FR-046) is the one output type with
// NO agent at all: it emits a configurable event into BOS's event system
// (`POST /api/events`) and is a pure I/O step — the cheapest node type there
// is (no LLM, no delegate, no sub-process), so it deliberately requires no
// `agentSource` (validate.js only demands one for delegate/tool nodes).
//
// A node may additionally declare `candidates` — a list of downstream step ids
// the node's agent chooses between as its last action (US7/FR-018/FR-019,
// dynamic routing) — see router.js for the selection contract.

const OUTPUT_TYPES = ["delegate", "tool", "research", "ag-ui", "event"];
const AGENT_SOURCE_KINDS = ["static", "ephemeral"];
const EVENT_PAYLOAD_MODES = ["static", "template"];

/** A BOS event type: dot-separated, lowercase (FR-046/FR-048a). */
const EVENT_TYPE_PATTERN = /^[a-z0-9]+(\.[a-z0-9_-]+)+$/;

/** ADR-14 / FR-048b: this item may only emit under its OWN namespace. */
const WORKFLOWS_EVENT_NAMESPACE = "com.bos.workflows.";

/** `{{nodeId.field.path}}` placeholder in a template-mode event payload. */
const TEMPLATE_REF_PATTERN = /\{\{\s*([^{}\s]+?)\s*\}\}/g;

function isValidEventType(type) {
  return typeof type === "string" && EVENT_TYPE_PATTERN.test(type);
}

/**
 * Split one `{{nodeId.field.path}}` reference into its node id and the dot-path
 * into that node's output. A leading `output` segment names the node's output
 * root, so `{{n.output}}`, `{{n.output.summary}}` and `{{n.summary}}` all mean
 * what an author expects (design.md §13).
 */
function parseTemplateRef(ref) {
  const segments = String(ref).split(".");
  const nodeId = segments.shift() || "";
  if (segments[0] === "output") segments.shift();
  return { ref: String(ref), nodeId, path: segments };
}

/** Every `{{...}}` reference in a template-mode payload, in order. */
function parseTemplateRefs(text) {
  if (typeof text !== "string") return [];
  const out = [];
  TEMPLATE_REF_PATTERN.lastIndex = 0;
  let match;
  while ((match = TEMPLATE_REF_PATTERN.exec(text)) !== null) out.push(parseTemplateRef(match[1]));
  return out;
}

function isPlainObject(v) {
  return v != null && typeof v === "object" && !Array.isArray(v);
}

/**
 * Coerce an `event` node's config into `{ eventType, payload: { mode, ... } }`.
 * Deliberately does NOT invent a mode: an absent/unknown `payload.mode` is
 * preserved as-is so validate.js can report it, rather than silently emitting
 * an empty static payload (design.md §13).
 */
function normalizeEventConfig(raw) {
  const cfg = isPlainObject(raw) ? raw : {};
  const rawPayload = isPlainObject(cfg.payload) ? cfg.payload : {};
  const payload = { mode: rawPayload.mode };
  if (rawPayload.mode === "template") {
    payload.text = rawPayload.text;
    if (Object.prototype.hasOwnProperty.call(rawPayload, "fallback")) payload.fallback = rawPayload.fallback;
  } else if (Object.prototype.hasOwnProperty.call(rawPayload, "value")) {
    payload.value = rawPayload.value;
  }
  return { eventType: typeof cfg.eventType === "string" ? cfg.eventType.trim() : cfg.eventType, payload };
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

  if (node.outputType === "event") {
    // An event node carries no agent and no researchAgents — just the event
    // type it emits and how its payload is built (US18/FR-046).
    node.config = normalizeEventConfig(node.config);
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
  else if (node.outputType === "event") sub = node.config?.eventType || "unnamed-event";
  else sub = node.agentSource?.kind === "ephemeral" ? "ephemeral" : node.agentSource?.agentId || "agent";
  return `${node.outputType} · ${sub}`;
}

function hasCandidates(node) {
  return Array.isArray(node.candidates) && node.candidates.length > 0;
}

function isEventNode(node) {
  return node?.outputType === "event";
}

/**
 * Shape errors for one `event` node's config (US18/FR-046) — the "validate on
 * load" half of the event node. Pure: takes a NORMALIZED node, returns
 * human-readable messages. Namespace policy (FR-048b) and template-reference
 * resolvability (FR-048c) need the whole workflow, so they live in validate.js.
 */
function eventNodeConfigErrors(node) {
  const errors = [];
  const cfg = isPlainObject(node?.config) ? node.config : null;
  if (!cfg) return [`Step "${node?.id}" (event) requires a config with an eventType and a payload.`];

  if (!cfg.eventType) errors.push(`Step "${node.id}" (event) requires config.eventType.`);
  else if (!isValidEventType(cfg.eventType)) {
    errors.push(`Step "${node.id}" (event) has an invalid config.eventType "${cfg.eventType}" — event types are dot-separated and lowercase (e.g. "com.bos.workflows.analysis.complete").`);
  }

  const payload = isPlainObject(cfg.payload) ? cfg.payload : null;
  if (!payload) return [...errors, `Step "${node.id}" (event) requires config.payload with mode "static" or "template".`];

  if (!EVENT_PAYLOAD_MODES.includes(payload.mode)) {
    errors.push(`Step "${node.id}" (event) has an invalid config.payload.mode "${payload.mode}" — must be "static" or "template".`);
  } else if (payload.mode === "static") {
    if (!Object.prototype.hasOwnProperty.call(payload, "value")) {
      errors.push(`Step "${node.id}" (event, static payload) requires config.payload.value.`);
    } else if (!isPlainObject(payload.value)) {
      errors.push(`Step "${node.id}" (event, static payload) requires config.payload.value to be a JSON object (an event payload is always an object).`);
    }
  } else if (typeof payload.text !== "string" || !payload.text.trim()) {
    errors.push(`Step "${node.id}" (event, template payload) requires config.payload.text (a JSON template string with {{nodeId.field}} placeholders).`);
  }

  return errors;
}

/** FR-019: a node with exactly one candidate auto-delegates — no selection action required. */
function isAutoDelegate(node) {
  return hasCandidates(node) && node.candidates.length === 1;
}

module.exports = {
  OUTPUT_TYPES,
  AGENT_SOURCE_KINDS,
  EVENT_PAYLOAD_MODES,
  EVENT_TYPE_PATTERN,
  TEMPLATE_REF_PATTERN,
  WORKFLOWS_EVENT_NAMESPACE,
  isValidEventType,
  parseTemplateRef,
  parseTemplateRefs,
  normalizeEventConfig,
  isEventNode,
  eventNodeConfigErrors,
  normalizeNode,
  normalizeWorkflow,
  describeNode,
  hasCandidates,
  isAutoDelegate,
};
