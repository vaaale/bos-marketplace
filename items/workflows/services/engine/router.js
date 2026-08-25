// router.js — dynamic routing (US7/FR-018/FR-019). A node MAY declare
// `candidates` (downstream step ids). When it has more than one, the node's
// agent must select the appropriate candidate(s) as its LAST action; a node
// with exactly one candidate skips selection and auto-delegates (FR-019).
//
// Selection contract (this service's own design — there is no BOS-source
// precedent for dynamic routing to port from): the node's delegate task is
// augmented with an instruction to end its response with a line of the form
//   SELECT: <candidate-id>[, <candidate-id> ...]
// choosing from the declared candidate ids — one id for a single-choice node,
// several for a parallel/research node. If the response is missing a valid
// SELECT line, the node is re-delegated with a stronger clarifying
// instruction, up to `maxRetries` times (retry-loop enforcement, FR-018).

const { isAutoDelegate, hasCandidates } = require("./node-model");

const SELECT_RE = /^\s*SELECT:\s*(.+)$/im;

function parseSelection(text, validIds) {
  if (typeof text !== "string") return [];
  const m = text.match(SELECT_RE);
  if (!m) return [];
  const ids = m[1]
    .split(",")
    .map((s) => s.trim())
    .filter(Boolean);
  const validSet = new Set(validIds);
  const picked = ids.filter((id) => validSet.has(id));
  return picked;
}

function routingInstruction(candidates, multi) {
  const list = candidates.map((c) => `${c.id}${c.description ? ` — ${c.description}` : ""}`).join("\n");
  return [
    "",
    "--- Dynamic routing (required) ---",
    `As your LAST action, choose ${multi ? "one or more" : "exactly one"} of the following candidates and end your response with a line of the exact form:`,
    `SELECT: <candidate-id>${multi ? "[, <candidate-id> ...]" : ""}`,
    "Candidates:",
    list,
  ].join("\n");
}

/**
 * Resolve which candidate(s) a node routes to.
 * - No candidates: returns null (caller falls through to normal DAG dependents).
 * - Exactly one candidate: auto-delegates, no agent action needed (FR-019).
 * - Multiple candidates: parses `delegateOutput` for a SELECT line; if missing/
 *   invalid, calls `retryDelegate(clarifyingTask)` (expected to re-run the
 *   node's delegate call and return its output text) up to `maxRetries` times.
 */
async function resolveCandidates(node, delegateOutput, retryDelegate, { maxRetries = 3 } = {}) {
  if (!hasCandidates(node)) return null;
  if (isAutoDelegate(node)) return [node.candidates[0].id];

  const validIds = node.candidates.map((c) => c.id);
  let text = typeof delegateOutput === "string" ? delegateOutput : JSON.stringify(delegateOutput ?? "");
  let attempt = 0;
  while (attempt < maxRetries) {
    const picked = parseSelection(text, validIds);
    if (picked.length > 0) return picked;
    attempt++;
    if (attempt >= maxRetries) break;
    text = await retryDelegate(
      `Your previous response did not include a valid "SELECT:" line choosing from [${validIds.join(", ")}]. ` +
        `End your response with a line "SELECT: <candidate-id>[, <candidate-id> ...]" naming only ids from that list.`,
    );
  }
  throw new Error(`router: node "${node.id}" failed to select a valid candidate after ${maxRetries} attempt(s)`);
}

module.exports = { parseSelection, routingInstruction, resolveCandidates };
