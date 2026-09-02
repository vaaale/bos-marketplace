// executor.js — the execution contract (design.md ADR-1). A worker thread
// cannot run the BOS assistant stack itself (no runSubAgent/runAgentLoop, no
// tool registry) — so a node's actual execution is one loopback
// `POST /api/subagents/delegate` call to BOS's main thread, which streams
// NDJSON. Everything else (scheduling, routing, persistence) is owned by this
// service; executor.js is only the "run one node" primitive scheduler.js and
// router.js call into.
//
// This file now also owns three scope-add responsibilities:
//
//   * AGENT TRACE (US10/FR-028) — it emits `agent.*` events (prompt,
//     reasoning, per tool call with args/result/ok, response) through
//     `ctx.emit`, which run-state.js folds into the per-node agentTrace the
//     trajectory panel renders. The NDJSON reader is deliberately tolerant of
//     both the historical `{type:"tool", tool, input}` shape and the enriched
//     `{type:"tool"|"tool_result"|"reasoning_delta"}` + `done.result.text`
//     shape, so it works against either version of the delegate route.
//   * TOOL FIDELITY (US12/FR-034) — an ephemeral node's FULL declared tool
//     list is forwarded to the delegate's ephemeral spec, together with a
//     `deferredTools` list (so a declared tool that the platform keeps behind
//     `find_tools` is still discoverable) and the node's `skills`.
//   * DRY-RUN FIXTURES (US14/FR-037) — a fixture-designated node never
//     touches the network at all; its canned output is returned directly.
//   * EVENT EMISSION (US18/FR-046/FR-047) — an `outputType:"event"` node has
//     no agent at all: it resolves its payload (static or `{{nodeId.field}}`
//     template) and does ONE loopback `POST /api/events`. No delegate call, no
//     model, no sub-process — the cheapest node type in the engine.

const http = require("http");
const { resolvePort, jsonRequest } = require("../vfs");
const { routingInstruction } = require("./router");
const { selectBranchTool, SELECT_BRANCH_TOOL_NAME } = require("../tools");
const { hasCandidates, isAutoDelegate, isEventNode, parseTemplateRef, TEMPLATE_REF_PATTERN } = require("./node-model");

/** This item's own event source identity on every event it emits (FR-047). */
const EVENT_SOURCE = { appId: "workflows", name: "Workflow Manager" };

function delegateBaseUrl() {
  return `http://127.0.0.1:${resolvePort()}`;
}

/** Normalize one NDJSON line from the delegate stream into a trace event. */
function readStreamEvent(ev) {
  if (!ev || typeof ev !== "object") return null;
  switch (ev.type) {
    case "tool":
      return {
        kind: "tool_call",
        callId: ev.callId ?? ev.id,
        name: ev.name ?? ev.tool ?? "tool",
        args: ev.args ?? ev.input,
        // A bare `{type:"tool"}` announces a call that has not returned yet;
        // a stream that also carries a result inlines it.
        result: ev.result,
        ok: ev.ok,
        inflight: ev.result === undefined && ev.ok === undefined,
      };
    case "tool_result":
      return {
        kind: "tool_call",
        callId: ev.callId ?? ev.id,
        name: ev.name ?? ev.tool ?? "tool",
        result: ev.result ?? ev.output ?? ev.content,
        ok: ev.ok !== undefined ? ev.ok : !ev.error,
        error: ev.error,
        inflight: false,
      };
    case "reasoning_delta":
    case "thinking_delta":
      return { kind: "reasoning", text: ev.text ?? ev.delta ?? "" };
    case "text_delta":
      return { kind: "response_delta", text: ev.text ?? ev.delta ?? "" };
    case "done":
      return { kind: "done", result: ev.result };
    case "error":
      return { kind: "error", error: ev.error };
    default:
      return null;
  }
}

/**
 * Low-level primitive: POST /api/subagents/delegate, consume the NDJSON
 * stream, return { output, error, toolEvents, reasoning, response }. `signal`
 * (an AbortSignal) lets a caller cancel the in-flight request — this IS the
 * cancellation mechanism (ADR-1 §7 Option (b)): the worker aborts its own
 * fetch rather than the delegate route gaining a runId-keyed abort
 * controller. `onEvent` receives each normalized stream event AS IT ARRIVES,
 * which is what makes a live run's trajectory panel update in real time.
 */
function delegateOnce(body, { signal, onEvent } = {}) {
  return new Promise((resolve, reject) => {
    const url = new URL("/api/subagents/delegate", delegateBaseUrl());
    const payload = JSON.stringify(body);
    const req = http.request(
      {
        method: "POST",
        hostname: url.hostname,
        port: url.port,
        path: url.pathname,
        headers: { "Content-Type": "application/json", "Content-Length": Buffer.byteLength(payload) },
      },
      (res) => {
        let buffered = "";
        const toolEvents = [];
        let reasoning = "";
        let streamedText = "";
        let doneResult = null;
        let errorMessage = null;
        res.setEncoding("utf8");
        res.on("data", (chunk) => {
          buffered += chunk;
          let idx;
          while ((idx = buffered.indexOf("\n")) >= 0) {
            const line = buffered.slice(0, idx).trim();
            buffered = buffered.slice(idx + 1);
            if (!line) continue;
            let ev;
            try {
              ev = JSON.parse(line);
            } catch {
              continue;
            }
            const norm = readStreamEvent(ev);
            if (!norm) continue;
            if (norm.kind === "tool_call") toolEvents.push(norm);
            else if (norm.kind === "reasoning") reasoning += norm.text;
            else if (norm.kind === "response_delta") streamedText += norm.text;
            else if (norm.kind === "done") doneResult = norm.result;
            else if (norm.kind === "error") errorMessage = norm.error;
            if (onEvent) {
              try {
                onEvent(norm);
              } catch {
                // a trace consumer must never break the delegate stream
              }
            }
          }
        });
        res.on("end", () => {
          if (errorMessage) return reject(new Error(errorMessage));
          if (!doneResult) return reject(new Error("delegate stream ended without a done/error event"));
          resolve({
            output: doneResult.output,
            error: doneResult.error,
            toolEvents,
            reasoning: doneResult.reasoning ?? doneResult.thinking ?? reasoning ?? "",
            response: doneResult.text ?? (typeof doneResult.output === "string" ? doneResult.output : streamedText),
          });
        });
      },
    );
    req.on("error", reject);
    if (signal) {
      if (signal.aborted) {
        req.destroy(new Error("aborted"));
        return reject(new Error("aborted"));
      }
      signal.addEventListener(
        "abort",
        () => {
          req.destroy(new Error("aborted"));
        },
        { once: true },
      );
    }
    req.write(payload);
    req.end();
  });
}

/** True when this node's agent must emit a structured branch selection. */
function needsSelectBranch(node) {
  return hasCandidates(node) && !isAutoDelegate(node) && node.outputType !== "ag-ui";
}

/**
 * Build the /api/subagents/delegate request body for a node's agentSource.
 *
 * FR-034: the ephemeral spec carries the node's FULL declared tool list. It
 * also carries `deferredTools` — mirroring the declared list, because a tool
 * the platform keeps behind `find_tools` must still be *discoverable* to the
 * spawned agent; a node that lists `file_read`/`file_write` must genuinely
 * have them rather than falling back to `run_command` heredocs. `skills` is
 * forwarded for the same reason (an ephemeral node's declared skills are part
 * of its declared capability set, not decoration).
 */
function delegateRequestFor(node, task, { featureBranch, conversationId } = {}) {
  const base = { task, contentOnly: true };
  if (featureBranch) base.featureBranch = featureBranch;
  if (conversationId) base.conversationId = conversationId;

  const candidateIds = (node.candidates || []).map((c) => c.id);
  const routing = needsSelectBranch(node);

  if (node.agentSource?.kind === "static") {
    return {
      ...base,
      agent: node.agentSource.agentId,
      ...(routing ? { extraTools: [selectBranchTool(candidateIds, candidateIds.length > 1)] } : {}),
    };
  }

  const declaredTools = node.agentSource?.tools || [];
  const skills = node.agentSource?.skills || [];
  const tools = routing ? [...declaredTools, SELECT_BRANCH_TOOL_NAME] : [...declaredTools];
  return {
    ...base,
    ephemeral: {
      name: `workflow-node-${node.id}`,
      systemPrompt: node.agentSource?.systemPrompt || `You are executing workflow node "${node.id}". ${node.agentSource?.task || ""}`.trim(),
      tools,
      // Every declared tool is ALSO listed as deferred so `find_tools` can
      // resolve it — a declared tool must never be silently dropped (FR-034).
      deferredTools: [...declaredTools],
      skills,
      type: "local",
      ...(routing ? { extraTools: [selectBranchTool(candidateIds, candidateIds.length > 1)] } : {}),
    },
  };
}

/** Render one upstream output for the downstream task text. Research/delegate
 *  fan-out outputs are first-class STRUCTURED data (FR-035) — a dependent node
 *  receives them inline as JSON, so a "parallel research → merge" handoff
 *  never requires a file write. */
function renderUpstream(id, out) {
  if (out == null) return `- ${id}: (no textual output)`;
  if (typeof out === "string") return out ? `- ${id}: ${out.slice(0, 4000)}` : `- ${id}: (no textual output)`;
  if (Array.isArray(out)) {
    const parts = out.map((entry, i) => {
      if (entry && typeof entry === "object" && ("output" in entry || "error" in entry)) {
        const label = entry.agentSource?.agentId || entry.agentSource?.task || entry.label || `#${i + 1}`;
        const body = entry.error ? `ERROR: ${entry.error}` : typeof entry.output === "string" ? entry.output : JSON.stringify(entry.output ?? null);
        return `  ${i + 1}. [${String(label).slice(0, 80)}] ${String(body).slice(0, 4000)}`;
      }
      return `  ${i + 1}. ${JSON.stringify(entry).slice(0, 4000)}`;
    });
    return `- ${id}: ${out.length} result(s)\n${parts.join("\n")}`;
  }
  return `- ${id}: ${JSON.stringify(out).slice(0, 4000)}`;
}

function buildTaskText(node, ctx) {
  const deps = (node.dependencies ?? []).map((d) => renderUpstream(d, ctx.outputs.get(d))).join("\n");
  const inputJson = node.input == null ? "" : `\n\nInput:\n${JSON.stringify(node.input, null, 2)}`;
  const convention = node.outputConvention ? `\n\nOutput convention: ${node.outputConvention}` : "";
  const upstream = deps ? `\n\nUpstream step outputs:\n${deps}` : "";
  const base = node.agentSource?.kind === "ephemeral" ? node.agentSource.task : `Workflow step "${node.id}" in workflow "${ctx.workflowName}".`;
  const routing = needsSelectBranch(node) ? `\n${routingInstruction(node.candidates, node.candidates.length > 1)}` : "";
  return `${base}${inputJson}${upstream}${convention}${routing}`;
}

/** outputType:"tool" constrains the delegate to calling exactly one tool. */
function buildToolTaskText(node, ctx) {
  const inputJson = node.input == null ? "(none)" : JSON.stringify(node.input);
  return [
    `You are executing a single workflow step.`,
    `Call ONLY the tool named "${node.toolName}". Do not call any other tool.`,
    `Tool input: ${inputJson}`,
    node.outputConvention ? `Output convention: ${node.outputConvention}` : "",
    `When the tool returns, briefly summarize its result in plain text.`,
    needsSelectBranch(node) ? routingInstruction(node.candidates, node.candidates.length > 1) : "",
  ]
    .filter(Boolean)
    .join("\n");
}

function isPlainObject(v) {
  return v != null && typeof v === "object" && !Array.isArray(v);
}

/** A config/authoring mistake, not a transient failure — never retried
 *  (scheduler.js's isTransientError only retries network-shaped errors). */
function eventConfigError(message) {
  const err = new Error(message);
  err.code = "event_config";
  return err;
}

/** Whichever error text BOS's event API returned ({ error: { code, message } }). */
function apiErrorMessage(body, fallback) {
  if (typeof body === "string" && body) return body;
  if (isPlainObject(body)) {
    const e = body.error;
    if (typeof e === "string" && e) return e;
    if (isPlainObject(e) && typeof e.message === "string" && e.message) return e.message;
    if (typeof body.message === "string" && body.message) return body.message;
  }
  return fallback;
}

/** One upstream node's recorded output. `ctx.outputs` is a Map in a real run;
 *  a plain object is accepted too so a caller can hand in a run projection. */
function outputFor(ctx, nodeId) {
  const outputs = ctx && ctx.outputs;
  if (!outputs) return { present: false };
  if (typeof outputs.get === "function") {
    return outputs.has(nodeId) ? { present: true, value: outputs.get(nodeId) } : { present: false };
  }
  if (Object.prototype.hasOwnProperty.call(outputs, nodeId)) return { present: true, value: outputs[nodeId] };
  return { present: false };
}

/** Walk a dot-path into a node output; a numeric segment indexes an array. */
function readPath(value, path) {
  let cur = value;
  for (const segment of path) {
    if (cur == null) return { found: false };
    if (Array.isArray(cur)) {
      const index = Number(segment);
      if (!Number.isInteger(index) || index < 0 || index >= cur.length) return { found: false };
      cur = cur[index];
      continue;
    }
    if (typeof cur !== "object" || !Object.prototype.hasOwnProperty.call(cur, segment)) return { found: false };
    cur = cur[segment];
  }
  return { found: true, value: cur };
}

/**
 * Template-mode payload resolution (design.md §13). Every
 * `{{nodeId.field.path}}` placeholder in `payload.text` is replaced by the
 * JSON-serialized upstream value — so a string lands quoted, a number/boolean
 * bare, and a missing node/field becomes `null` (or `payload.fallback` when
 * one is declared). The result is then parsed as JSON: a template that renders
 * to something that is not a JSON OBJECT is a config error, and the node
 * fails rather than emitting a malformed event.
 */
function resolveEventTemplate(node, ctx) {
  const payload = (node.config && node.config.payload) || {};
  const fallback = Object.prototype.hasOwnProperty.call(payload, "fallback") ? payload.fallback : null;
  const text = typeof payload.text === "string" ? payload.text : "";
  const unresolved = [];

  const rendered = text.replace(TEMPLATE_REF_PATTERN, (_match, refText) => {
    const { nodeId, path } = parseTemplateRef(refText);
    const upstream = outputFor(ctx, nodeId);
    let value;
    if (!upstream.present) {
      unresolved.push(refText);
      value = fallback;
    } else {
      const hit = readPath(upstream.value, path);
      if (!hit.found) {
        unresolved.push(refText);
        value = fallback;
      } else {
        value = hit.value;
      }
    }
    return JSON.stringify(value === undefined ? null : value);
  });

  let parsed;
  try {
    parsed = JSON.parse(rendered);
  } catch (err) {
    throw eventConfigError(
      `event step "${node.id}": the payload template did not render to valid JSON (${err.message}) — rendered: ${rendered.slice(0, 500)}`,
    );
  }
  if (!isPlainObject(parsed)) {
    throw eventConfigError(`event step "${node.id}": the payload template rendered to ${Array.isArray(parsed) ? "an array" : typeof parsed}, but an event payload must be a JSON object — rendered: ${rendered.slice(0, 500)}`);
  }
  return { payload: parsed, unresolved, rendered };
}

/** The event payload this node emits: `payload.value` verbatim (static mode)
 *  or the resolved template (template mode). */
function resolveEventPayload(node, ctx) {
  const payload = (node.config && node.config.payload) || {};
  if (payload.mode === "template") return resolveEventTemplate(node, ctx);
  if (!isPlainObject(payload.value)) {
    throw eventConfigError(`event step "${node.id}": a static payload must be a JSON object (got ${payload.value === undefined ? "nothing" : JSON.stringify(payload.value)}).`);
  }
  return { payload: payload.value, unresolved: [], rendered: undefined };
}

/**
 * The `POST /api/events` body, including the `_wf` provenance envelope
 * (FR-047) — every event this engine emits says which workflow, run, and node
 * produced it, so a downstream handler (or the Event Viewer) can trace it back.
 */
function eventEmitBody(node, ctx, payload) {
  const workflowId = (ctx && ((ctx.workflow && ctx.workflow.id) || ctx.workflowId)) || null;
  return {
    type: node.config && node.config.eventType,
    source: { ...EVENT_SOURCE },
    payload: {
      ...payload,
      _wf: { workflowId, runId: (ctx && ctx.runId) || null, nodeId: node.parentId || node.id },
    },
  };
}

/** Resolve + emit. Returns the node's output — `{ emitted, eventId }` — or
 *  throws (config error, or the event API's own error body). */
async function emitWorkflowEvent(node, ctx, { signal } = {}) {
  const { payload, unresolved, rendered } = resolveEventPayload(node, ctx);
  const body = eventEmitBody(node, ctx, payload);
  if (signal && signal.aborted) throw new Error("aborted");
  const res = await jsonRequest("POST", "/api/events", body);
  if (res.status < 200 || res.status >= 300) {
    throw new Error(`emitting event "${body.type}" failed (POST /api/events -> ${res.status}): ${apiErrorMessage(res.body, "no error body")}`);
  }
  return { output: { emitted: true, eventId: (res.body && res.body.id) || null }, body, unresolved, rendered };
}

/** US14/FR-037: the canned output designated for this node, if any. `null`
 *  means "no fixture" — `undefined` is a legitimate fixture value, so
 *  presence is tested with hasOwnProperty, never truthiness. */
function fixtureFor(node, ctx) {
  if (!ctx || !ctx.dryRun || !ctx.fixtures) return null;
  for (const key of [node.fixtureKey, node.id, node.parentId]) {
    if (key && Object.prototype.hasOwnProperty.call(ctx.fixtures, key)) return { key, value: ctx.fixtures[key] };
  }
  return null;
}

function describeAgentSource(node) {
  if (node.agentSource?.kind === "static") return node.agentSource.agentId || "agent";
  return "ephemeral agent";
}

/**
 * Execute one node (delegate | tool). research/ag-ui fan-out is handled by the
 * caller (scheduler/router). Emits the node's agent trace through `ctx.emit`
 * — `(type, patch) => void`, stamped by the scheduler with runId/workflowId.
 */
async function executeNode(node, ctx, { signal, extraInstruction, subAgentId, label } = {}) {
  const emit = typeof ctx?.emit === "function" ? ctx.emit : () => {};
  const stepId = node.parentId || node.id;
  const scope = subAgentId ? { stepId, subAgentId, label } : { stepId };

  if (node.outputType === "ag-ui") return { output: node.input ?? null, toolEvents: [] };

  // outputType:"event" — pure I/O (US18/FR-046). One loopback POST, no agent,
  // no model, no delegate stream. A dry run still honors a fixture for this
  // node, so a rehearsal never fires a real event.
  if (isEventNode(node)) {
    const eventType = (node.config && node.config.eventType) || "(no eventType)";
    const mode = (node.config && node.config.payload && node.config.payload.mode) || "static";
    const eventFixture = fixtureFor(node, ctx);
    if (eventFixture) {
      emit("agent.prompt", { ...scope, prompt: `Emit BOS event "${eventType}" (payload mode: ${mode}).` });
      emit("agent.action", { ...scope, action: `dry-run fixture for "${eventFixture.key}" — no event emitted` });
      emit("agent.response", { ...scope, text: `(dry-run fixture)\n${JSON.stringify(eventFixture.value, null, 2)}` });
      return { output: eventFixture.value, toolEvents: [], dryRun: true, reasoning: "", response: "" };
    }
    emit("agent.prompt", { ...scope, prompt: `Emit BOS event "${eventType}" (payload mode: ${mode}).` });
    emit("agent.action", { ...scope, action: `emitting ${eventType}` });
    const emitted = await emitWorkflowEvent(node, ctx, { signal });
    if (emitted.unresolved.length) {
      emit("agent.action", { ...scope, action: `unresolved placeholder(s) emitted as ${JSON.stringify(((node.config.payload || {}).fallback) ?? null)}: ${emitted.unresolved.join(", ")}` });
    }
    emit("agent.response", {
      ...scope,
      text: `Emitted "${emitted.body.type}" (event id ${emitted.output.eventId})\n${JSON.stringify(emitted.body.payload, null, 2)}`,
    });
    emit("agent.action", { ...scope, action: "" });
    return { output: emitted.output, toolEvents: [], reasoning: "", response: "" };
  }

  let task = node.outputType === "tool" ? buildToolTaskText(node, ctx) : buildTaskText(node, ctx);
  if (extraInstruction) task = `${task}\n\n${extraInstruction}`;

  const fixture = fixtureFor(node, ctx);
  if (fixture) {
    // Dry run: no delegate call, no network, no model — the canned output is
    // returned as if the agent had produced it (NFR-006).
    emit("agent.prompt", { ...scope, prompt: task });
    emit("agent.action", { ...scope, action: `dry-run fixture for "${fixture.key}"` });
    emit("agent.response", {
      ...scope,
      text: typeof fixture.value === "string" ? fixture.value : `(dry-run fixture)\n${JSON.stringify(fixture.value, null, 2)}`,
    });
    return { output: fixture.value, toolEvents: [], dryRun: true, reasoning: "", response: "" };
  }

  emit("agent.prompt", { ...scope, prompt: task });
  emit("agent.action", { ...scope, action: `delegating to ${describeAgentSource(node)}` });

  const body = delegateRequestFor(node, task, ctx);
  const result = await delegateOnce(body, {
    signal,
    onEvent: (ev) => {
      if (ev.kind === "tool_call") {
        emit("agent.tool_call", {
          ...scope,
          callId: ev.callId,
          name: ev.name,
          args: ev.args,
          result: ev.error ? String(ev.error) : ev.result,
          ok: ev.ok,
          inflight: ev.inflight,
        });
        emit("agent.action", { ...scope, action: ev.inflight ? `calling ${ev.name}…` : `${ev.name} returned` });
      } else if (ev.kind === "reasoning" && ev.text) {
        emit("agent.reasoning", { ...scope, text: ev.text });
      } else if (ev.kind === "response_delta" && ev.text) {
        emit("agent.response", { ...scope, text: ev.text, append: true });
      }
    },
  });
  if (result.error) throw new Error(result.error);

  if (result.reasoning) emit("agent.reasoning", { ...scope, text: result.reasoning, replace: true });
  const responseText = result.response ?? (typeof result.output === "string" ? result.output : JSON.stringify(result.output ?? null));
  emit("agent.response", { ...scope, text: responseText });
  emit("agent.action", { ...scope, action: "" });

  return { output: result.output, toolEvents: result.toolEvents, reasoning: result.reasoning, response: responseText };
}

module.exports = {
  EVENT_SOURCE,
  delegateOnce,
  delegateRequestFor,
  emitWorkflowEvent,
  eventEmitBody,
  resolveEventPayload,
  resolveEventTemplate,
  buildTaskText,
  buildToolTaskText,
  executeNode,
  fixtureFor,
  needsSelectBranch,
  readStreamEvent,
  renderUpstream,
};
