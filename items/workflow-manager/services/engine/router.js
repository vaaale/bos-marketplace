// router.js — dynamic routing (US7/US11, FR-018/FR-019/FR-029/FR-030/FR-031).
//
// A node MAY declare `candidates` (downstream step ids). When it has more than
// one, the node's agent must select the appropriate candidate(s); a node with
// exactly one candidate skips selection and auto-delegates (FR-019).
//
// SELECTION IS A STRUCTURED SIGNAL, NEVER PROSE (FR-029). The previous
// contract asked the agent to end its response with a `SELECT: <id>` line and
// regex-matched the prose — which is exactly how the field evaluation ended
// up recording `quiet` when the agent had said it was choosing the alarm
// branch. The engine now reads the selection deterministically from, in
// priority order:
//
//   1. a `select_branch` TOOL CALL in the delegate's tool-event stream —
//      `{ selected: [candidateId, …] }` (the canonical signal, see
//      tools.js's SELECT_BRANCH_TOOL);
//   2. a structured output object carrying `select_branch` / `selected`
//      (the equivalent structured-output field FR-029 allows, and the shape
//      a dry-run fixture uses);
//   3. a strict JSON object embedded in the output text — parsed with
//      JSON.parse (a fenced ```json block or a balanced {...}), accepted ONLY
//      if it is a select_branch envelope. Free-form prose is never scanned
//      for candidate names.
//
// If no valid signal is produced, the node is re-delegated with a stronger
// clarifying instruction up to `maxRetries` times and then FAILS (FR-030) —
// the engine never defaults to an arbitrary candidate.

const { isAutoDelegate, hasCandidates } = require("./node-model");

/** Pull `selected` out of a select_branch payload, whatever shape it arrived in. */
function selectedFrom(value) {
  if (value == null) return null;
  if (Array.isArray(value)) return value.map(String);
  if (typeof value === "string") return [value];
  if (typeof value !== "object") return null;
  if (value.selected !== undefined) return selectedFrom(value.selected);
  if (value.select_branch !== undefined) return selectedFrom(value.select_branch);
  if (value.candidates !== undefined) return selectedFrom(value.candidates);
  return null;
}

function isSelectBranchCall(ev) {
  const name = ev && (ev.name || ev.tool);
  return name === "select_branch";
}

/** Arguments of a tool event, tolerating both the `{tool,input}` and the
 *  `{name,args}` spellings the delegate stream has used. */
function toolArgs(ev) {
  const raw = ev.args !== undefined ? ev.args : ev.input;
  if (typeof raw !== "string") return raw;
  try {
    return JSON.parse(raw);
  } catch {
    return undefined;
  }
}

/** Strict, structured-only extraction from an output STRING: a fenced JSON
 *  block or a balanced top-level object, parsed with JSON.parse. Anything
 *  that is not a select_branch envelope is rejected — no prose scanning. */
function parseStructuredText(text) {
  if (typeof text !== "string" || !text.includes("{")) return null;
  const candidates = [];
  const fenced = text.match(/```(?:json)?\s*([\s\S]*?)```/g) || [];
  for (const block of fenced) candidates.push(block.replace(/```(?:json)?/g, "").replace(/```/g, ""));
  // Balanced-brace scan, last object first (the selection is the last action).
  const objects = [];
  let depth = 0;
  let start = -1;
  for (let i = 0; i < text.length; i++) {
    const ch = text[i];
    if (ch === "{") {
      if (depth === 0) start = i;
      depth++;
    } else if (ch === "}") {
      depth--;
      if (depth === 0 && start >= 0) {
        objects.push(text.slice(start, i + 1));
        start = -1;
      }
    }
  }
  candidates.push(...objects.reverse());

  for (const raw of candidates) {
    let parsed;
    try {
      parsed = JSON.parse(raw.trim());
    } catch {
      continue;
    }
    if (!parsed || typeof parsed !== "object") continue;
    const envelope =
      parsed.select_branch !== undefined
        ? parsed.select_branch
        : (parsed.tool === "select_branch" || parsed.name === "select_branch") && parsed.selected === undefined
          ? (parsed.arguments ?? parsed.args ?? parsed.input)
          : parsed.selected !== undefined
            ? parsed
            : null;
    if (envelope == null) continue;
    const selected = selectedFrom(envelope);
    if (selected && selected.length) return selected;
  }
  return null;
}

/**
 * Read the structured selection signal out of one node execution result.
 * `result` is `{ output, toolEvents }` (executor.executeNode's return) — or,
 * for convenience in tests, a bare output value.
 * Returns `{ selected, source }` or `null` when there is no valid signal.
 * Ids not in `validIds` invalidate the whole signal (FR-029: "MUST reference
 * only candidate id(s) valid for that node") rather than being silently
 * filtered, so a hallucinated branch never routes to a real neighbour.
 */
function readSelectionSignal(result, validIds) {
  const valid = new Set(validIds);
  const res = result && typeof result === "object" && ("output" in result || "toolEvents" in result) ? result : { output: result, toolEvents: [] };

  const attempts = [];
  for (const ev of res.toolEvents || []) {
    if (!isSelectBranchCall(ev)) continue;
    const fromArgs = selectedFrom(toolArgs(ev));
    if (fromArgs) attempts.push({ selected: fromArgs, source: "select_branch_tool" });
  }
  const fromOutputObject = res.output && typeof res.output === "object" ? selectedFrom(res.output) : null;
  if (fromOutputObject) attempts.push({ selected: fromOutputObject, source: "structured_output" });
  const fromText = typeof res.output === "string" ? parseStructuredText(res.output) : null;
  if (fromText) attempts.push({ selected: fromText, source: "structured_json" });

  for (const attempt of attempts) {
    const unique = Array.from(new Set(attempt.selected));
    if (!unique.length) continue;
    if (unique.some((id) => !valid.has(id))) continue; // invalid id → not a usable signal
    return { selected: unique, source: attempt.source };
  }
  return null;
}

/** The instruction appended to a routing node's task (the tool declaration
 *  itself lives in tools.js's SELECT_BRANCH_TOOL). */
function routingInstruction(candidates, multi) {
  const list = candidates.map((c) => `- ${c.id}${c.description ? ` — ${c.description}` : ""}`).join("\n");
  return [
    "",
    "--- Branch selection (required) ---",
    `As your LAST action you MUST select ${multi ? "one or more" : "exactly one"} of the candidates below by calling the`,
    `\`select_branch\` tool with { "selected": [${multi ? '"<candidate-id>", …' : '"<candidate-id>"'}] }.`,
    "If that tool is not available to you, end your response with ONLY this JSON object on its own line:",
    `{"select_branch": {"selected": [${multi ? '"<candidate-id>", …' : '"<candidate-id>"'}]}}`,
    "Do not describe your choice in prose instead — a prose-only answer is not a selection and will be rejected.",
    "Candidates:",
    list,
  ].join("\n");
}

function clarificationFor(validIds) {
  return (
    `Your previous response did not contain a valid structured branch selection. ` +
    `Call the \`select_branch\` tool with {"selected": ["<candidate-id>"]}, or reply with ONLY the JSON object ` +
    `{"select_branch": {"selected": ["<candidate-id>"]}} — choosing exclusively from [${validIds.join(", ")}]. No prose.`
  );
}

/**
 * Resolve which candidate(s) a node routes to.
 * - No candidates: returns null (caller falls through to normal DAG dependents).
 * - Exactly one candidate: auto-delegates, no agent action needed (FR-019).
 * - Multiple candidates: reads the structured signal from `result`; if absent
 *   or invalid, calls `retryDelegate(clarification)` (expected to re-run the
 *   node and return its `{ output, toolEvents }`) up to `maxRetries` times,
 *   then THROWS (FR-030 — the node fails, it never defaults).
 */
async function resolveCandidates(node, result, retryDelegate, { maxRetries = 3, onRetry } = {}) {
  if (!hasCandidates(node)) return null;
  if (isAutoDelegate(node)) return [node.candidates[0].id];

  const validIds = node.candidates.map((c) => c.id);
  let current = result;
  let attempt = 0;
  while (attempt < maxRetries) {
    const signal = readSelectionSignal(current, validIds);
    if (signal) return signal.selected;
    attempt++;
    if (attempt >= maxRetries) break;
    if (onRetry) onRetry(attempt);
    current = await retryDelegate(clarificationFor(validIds));
  }
  throw new Error(
    `router: node "${node.id}" produced no valid structured branch selection after ${maxRetries} attempt(s) — expected a select_branch signal naming one of [${validIds.join(", ")}]`,
  );
}

// ---------------------------------------------------------------------------
// Option A selection propagation (FR-031)
// ---------------------------------------------------------------------------

/**
 * Build the gating index for a workflow's steps: `gatedBy.get(leafId)` is the
 * set of routing-node ids that declare `leafId` as a candidate. Option A: a
 * node is gated by a selection ONLY if it is a declared candidate leaf; EVERY
 * other node is gated purely by its own `dependencies`, which is what lets a
 * shared step (e.g. `render`) sit between the branch point and the leaves.
 */
function buildCandidateIndex(steps) {
  const gatedBy = new Map();
  const candidatesOf = new Map();
  const ids = new Set(steps.map((s) => s.id));
  for (const s of steps) {
    const list = (s.candidates || []).map((c) => c.id).filter((id) => ids.has(id));
    if (list.length) candidatesOf.set(s.id, list);
    for (const leaf of list) {
      if (!gatedBy.has(leaf)) gatedBy.set(leaf, new Set());
      gatedBy.get(leaf).add(s.id);
    }
  }
  return { gatedBy, candidatesOf };
}

/** True when every routing node gating `nodeId` has selected it (FR-031). */
function selectionAllows(nodeId, gatedBy, selected) {
  const routers = gatedBy.get(nodeId);
  if (!routers || routers.size === 0) return true; // not a candidate leaf → dependencies only
  for (const routerId of routers) {
    const sel = selected.get(routerId);
    if (!sel || !sel.includes(nodeId)) return false;
  }
  return true;
}

/** True when a gating router has already settled WITHOUT selecting `nodeId`. */
function selectionRejects(nodeId, gatedBy, selected) {
  const routers = gatedBy.get(nodeId);
  if (!routers || routers.size === 0) return false;
  for (const routerId of routers) {
    const sel = selected.get(routerId);
    if (sel && !sel.includes(nodeId)) return true;
  }
  return false;
}

module.exports = {
  readSelectionSignal,
  parseStructuredText,
  routingInstruction,
  clarificationFor,
  resolveCandidates,
  buildCandidateIndex,
  selectionAllows,
  selectionRejects,
};
