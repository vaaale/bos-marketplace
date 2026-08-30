// generate.js — re-implements the retired src/lib/workflows/generate.ts.
// The worker cannot call an LLM directly, so generation from a natural-
// language task description is itself one loopback delegate call to an
// ephemeral "planner" agent (design.md §7 open item #2), which returns a
// fenced JSON workflow document that this module parses and normalizes.
//
// workflow_create's OTHER path — an assistant (following the bundled skill)
// constructs the workflow object directly and passes it as `workflow` — never
// goes through this module at all; that path is preferred whenever the
// caller already knows the node shapes (agentSource x outputType), since it
// avoids a second LLM round-trip. generateWorkflowFromTask exists for the
// convenience "just build me something reasonable" case.

const { delegateOnce } = require("./executor");
const { generateWorkflowId } = require("./store");

const PLANNER_SYSTEM = `You are a workflow planner for BrowserOS. Given a task description, output a SINGLE JSON object describing a workflow.

Schema:
{
  "id": string,        // short slug; omit to let the server assign one
  "name": string,
  "version": 1,
  "config": { "maxConcurrentSteps": 5, "defaultRetryLimit": 3, "defaultTimeout": 300 },
  "steps": [
    {
      "id": string,
      "outputType": "delegate" | "tool" | "research" | "ag-ui",
      "agentSource": { "kind": "static", "agentId": string } | { "kind": "ephemeral", "task": string, "tools": string[], "skills": string[] },
      "toolName": string,              // required when outputType is "tool"
      "researchAgents": string[],      // required when outputType is "research" — one entry per fan-out agent
      "candidates": [{ "id": string, "description": string }],  // OPTIONAL dynamic routing: downstream step ids this node's agent chooses between
      "input": object,
      "outputConvention": string,      // e.g. "write a short summary; the next step will read it from your output"
      "dependencies": string[],
      "retryLimit": number,
      "timeout": number
    }
  ]
}

Hard rules:
- Prefer "ephemeral" agentSource unless the task clearly names an existing BOS agent by id.
- Steps form a DAG via "dependencies". Independent branches should be separate steps with no dependency between them so they run in parallel.
- Use "research" for a step that should fan out several sub-agents concurrently and collect their outputs (e.g. several independent research questions).
- Use "tool" only for a single, well-defined tool invocation.
- Use "candidates" only when the workflow should adapt at run time based on information gathered earlier (e.g. routing to different downstream handling depending on a classification made by an upstream step).
- When you DO use "candidates": every candidate must be reachable from its routing node through "dependencies" (directly, or through a shared step in between), and a candidate must be a TERMINAL step — never make an ungated step depend on a candidate, since a candidate only runs when it is selected. Put shared work ABOVE the branch point instead.
- Return ONLY the JSON in a fenced \`\`\`json block, nothing else.`;

function extractJson(text) {
  const fence = text.match(/```(?:json)?\s*([\s\S]*?)```/);
  if (fence?.[1]) return fence[1].trim();
  const start = text.indexOf("{");
  const end = text.lastIndexOf("}");
  if (start >= 0 && end > start) return text.slice(start, end + 1);
  return text.trim();
}

async function generateWorkflowFromTask(task, { featureBranch, conversationId, signal } = {}) {
  const prompt = `Task:\n${task}\n\nReturn the workflow JSON now.`;
  const body = {
    task: prompt,
    contentOnly: true,
    ephemeral: { name: "workflow-planner", systemPrompt: PLANNER_SYSTEM, tools: [], type: "local" },
  };
  if (featureBranch) body.featureBranch = featureBranch;
  if (conversationId) body.conversationId = conversationId;

  const result = await delegateOnce(body, { signal });
  if (result.error) throw new Error(result.error);
  const raw = typeof result.output === "string" ? result.output : JSON.stringify(result.output ?? "");

  let parsed;
  try {
    parsed = JSON.parse(extractJson(raw));
  } catch (err) {
    throw new Error(`Failed to parse workflow JSON from planner output: ${err.message}`);
  }

  const name = String(parsed.name || "Untitled Workflow");
  return {
    id: String(parsed.id || generateWorkflowId(name)),
    name,
    version: parsed.version ?? 1,
    config: parsed.config ?? { maxConcurrentSteps: 5, defaultRetryLimit: 3, defaultTimeout: 300 },
    steps: Array.isArray(parsed.steps) ? parsed.steps : [],
  };
}

module.exports = { generateWorkflowFromTask, extractJson };
