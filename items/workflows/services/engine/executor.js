// executor.js — the execution contract (design.md ADR-1). A worker thread
// cannot run the BOS assistant stack itself (no runSubAgent/runAgentLoop, no
// tool registry) — so a node's actual execution is one loopback
// `POST /api/subagents/delegate` call to BOS's main thread, which streams
// NDJSON (`{type:"tool"}*`, then `{type:"done", result}` or `{type:"error"}`).
// Everything else (scheduling, routing, persistence) is owned by this
// service; executor.js is only the "run one node" primitive scheduler.js and
// router.js call into.

const http = require("http");
const { resolvePort } = require("../vfs");

function delegateBaseUrl() {
  return `http://127.0.0.1:${resolvePort()}`;
}

/**
 * Low-level primitive: POST /api/subagents/delegate, consume the NDJSON
 * stream, return { output, error, toolEvents }. `signal` (an AbortSignal)
 * lets a caller cancel the in-flight request — this IS the cancellation
 * mechanism (ADR-1 §7 Option (b)): the worker aborts its own fetch rather
 * than the delegate route gaining a runId-keyed abort controller.
 */
function delegateOnce(body, { signal } = {}) {
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
            if (ev.type === "tool") toolEvents.push(ev);
            else if (ev.type === "done") doneResult = ev.result;
            else if (ev.type === "error") errorMessage = ev.error;
          }
        });
        res.on("end", () => {
          if (errorMessage) return reject(new Error(errorMessage));
          if (!doneResult) return reject(new Error("delegate stream ended without a done/error event"));
          resolve({ output: doneResult.output, error: doneResult.error, toolEvents });
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

/** Build the /api/subagents/delegate request body for a node's agentSource. */
function delegateRequestFor(node, task, { featureBranch, conversationId } = {}) {
  const base = { task, contentOnly: true };
  if (featureBranch) base.featureBranch = featureBranch;
  if (conversationId) base.conversationId = conversationId;
  if (node.agentSource?.kind === "static") {
    return { ...base, agent: node.agentSource.agentId };
  }
  return {
    ...base,
    ephemeral: {
      name: `workflow-node-${node.id}`,
      systemPrompt: node.agentSource?.systemPrompt || `You are executing workflow node "${node.id}". ${node.agentSource?.task || ""}`.trim(),
      tools: node.agentSource?.tools || [],
      type: "local",
    },
  };
}

function buildTaskText(node, ctx) {
  const deps = (node.dependencies ?? [])
    .map((d) => {
      const out = ctx.outputs.get(d);
      const summary = typeof out === "string" ? out : out == null ? "" : JSON.stringify(out);
      return summary ? `- ${d}: ${summary.slice(0, 4000)}` : `- ${d}: (no textual output)`;
    })
    .join("\n");
  const inputJson = node.input == null ? "" : `\n\nInput:\n${JSON.stringify(node.input, null, 2)}`;
  const convention = node.outputConvention ? `\n\nOutput convention: ${node.outputConvention}` : "";
  const upstream = deps ? `\n\nUpstream step outputs:\n${deps}` : "";
  const base = node.agentSource?.kind === "ephemeral" ? node.agentSource.task : `Workflow step "${node.id}" in workflow "${ctx.workflowName}".`;
  return `${base}${inputJson}${upstream}${convention}`;
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
  ]
    .filter(Boolean)
    .join("\n");
}

/** Execute one node (delegate | tool). research/ag-ui are handled by the caller (scheduler/router). */
async function executeNode(node, ctx, { signal, extraInstruction } = {}) {
  if (node.outputType === "ag-ui") return { output: node.input ?? null, toolEvents: [] };

  let task = node.outputType === "tool" ? buildToolTaskText(node, ctx) : buildTaskText(node, ctx);
  if (extraInstruction) task = `${task}\n\n${extraInstruction}`;
  const body = delegateRequestFor(node, task, ctx);
  const result = await delegateOnce(body, { signal });
  if (result.error) throw new Error(result.error);
  return { output: result.output, toolEvents: result.toolEvents };
}

module.exports = { delegateOnce, delegateRequestFor, buildTaskText, buildToolTaskText, executeNode };
