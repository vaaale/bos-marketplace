// tools.js — the 13 workflow_* tool declarations (FR-002/014/016/024/044), the
// 039-compliant native-tool surface replacing the retired BOS-source
// `workflowTools()`. Declarations only — see handlers.js for the
// implementations `index.js` wires each `name` to via tool_call dispatch.
//
// Read-only tools are marked parallelSafe (039) so the agent can batch
// several in one turn (e.g. workflow_list + workflow_status for two
// workflows) without them serializing.

const STRING = { type: "string" };
const OBJECT = { type: "object" };
const BOOLEAN = { type: "boolean" };

function required(properties, req) {
  return { type: "object", properties, required: req };
}

function readOnly(declaration) {
  return { ...declaration, parallelSafe: true };
}

const DECLARATIONS = [
  readOnly({
    name: "workflow_list",
    description:
      "List every workflow in /Workflows/. Returns, per workflow, its workflow_id, name, step count, a status field ('running' or 'idle'), and a run_id when the workflow is currently running — poll workflow_status/workflow_run_get with that run_id for live detail.",
    inputSchema: { type: "object", properties: {} },
  }),
  {
    name: "workflow_create",
    description:
      "Create and persist a new workflow. Pass EITHER `workflow` — a fully-formed workflow object you constructed yourself (id?, name, config?, steps[]; each step has an outputType of delegate/tool/research/ag-ui and an agentSource of kind static/ephemeral — see the Workflow Manager skill for the exact shape), which is the preferred path when you already know the node structure — OR `taskDescription`, a natural-language description of what the workflow should accomplish, which is planned into a workflow for you via one extra delegation. Returns the new workflow's id and a validation summary.",
    inputSchema: required({ workflow: OBJECT, taskDescription: STRING }, []),
  },
  readOnly({
    name: "workflow_read",
    description: "Read a workflow's full JSON (id, name, config, steps).",
    inputSchema: required({ workflowId: STRING }, ["workflowId"]),
  }),
  {
    name: "workflow_modify",
    description: "Apply a JSON-merge patch to an existing workflow, then re-validate. `changes` is a JSON object merged onto the current workflow (arrays are replaced, not merged element-wise).",
    inputSchema: required({ workflowId: STRING, changes: OBJECT }, ["workflowId", "changes"]),
  },
  {
    name: "workflow_run",
    description:
      "Start a workflow run. Fire-and-poll: returns { runId, workflowId } immediately (well under 30s) — it does NOT wait for the run to finish. Poll workflow_status or workflow_run_get with the returned runId to observe progress and the final state (completed/completed_with_warnings/failed/cancelled). Refused if the workflow fails validation, or if it already has a run in progress. Set `dryRun: true` with a `fixtures` map ({ \"<nodeId>\": <cannedOutput> }) to validate the DAG, branch routing, and leaf reachability in seconds: a fixture-designated node's real sub-agent execution is skipped and the canned output is used by its dependents instead. A routing node's fixture may itself be the selection signal, e.g. { \"select_branch\": { \"selected\": [\"leaf-id\"] } }. Nodes with no fixture still execute for real; omitting dryRun leaves behavior completely unchanged.",
    inputSchema: required(
      {
        workflowId: STRING,
        featureBranch: STRING,
        conversationId: STRING,
        dryRun: BOOLEAN,
        fixtures: OBJECT,
      },
      ["workflowId"],
    ),
  },
  readOnly({
    name: "workflow_status",
    description:
      "Get a workflow's current run state. Returns a POPULATED per-step map while the run is in progress (never an empty steps:{}) — per step: status, attempt/maxAttempts, a short current-action string while it runs, per-sub-agent status for a research node's fan-out, and the node's agent trace (executed prompt, reasoning, tool calls with arguments/results, response). Plus the run's overall state, the routing selections it made, and its event log. If no run is in progress, returns the most recent historical run. Use workflow_run_get for a specific historical run by id.",
    inputSchema: required({ workflowId: STRING }, ["workflowId"]),
  }),
  {
    name: "workflow_cancel",
    description: "Cancel a workflow's in-progress run. In-progress steps are marked cancelled and the scheduler halts; steps that never started are marked neutral.",
    inputSchema: required({ workflowId: STRING }, ["workflowId"]),
  },
  {
    name: "workflow_delete",
    description: "Delete a workflow and all of its run logs. Cannot be undone.",
    inputSchema: required({ workflowId: STRING }, ["workflowId"]),
  },
  readOnly({
    name: "workflow_export",
    description: "Return a workflow's full JSON as a string, suitable for copying, diffing, or re-importing via workflow_create's `workflow` parameter.",
    inputSchema: required({ workflowId: STRING }, ["workflowId"]),
  }),
  readOnly({
    name: "workflow_validate",
    description:
      "Validate a workflow: DAG acyclicity, node shape (agentSource/outputType), dependency and dynamic-routing candidate resolvability, and candidate TOPOLOGY — an unreachable candidate leaf (no dependency path from its routing node) and a node that is ambiguously both a gated candidate leaf and a shared dependency of ungated work are reported as structural errors. Pass `workflowId` to validate a saved workflow, or `workflow` to validate one before saving. Returns { ok, errors[], warnings[] }.",
    inputSchema: required({ workflowId: STRING, workflow: OBJECT }, []),
  }),
  readOnly({
    name: "workflow_run_list",
    description: "List a workflow's historical runs (id, start/end timestamp, final state), newest first.",
    inputSchema: required({ workflowId: STRING }, ["workflowId"]),
  }),
  readOnly({
    name: "workflow_run_get",
    description:
      "Read one run's full detail: per-step outcomes (completed/failed/cancelled/skipped/neutral) with attempt counts, current action, per-sub-agent fan-out status and the per-node agent trace (prompt, reasoning, tool calls with arguments/results, response), the routing selections, and the complete event log — replayable identically whether the run is still live or long finished.",
    inputSchema: required({ workflowId: STRING, runId: STRING }, ["workflowId", "runId"]),
  }),
  readOnly({
    name: "workflow_event_types",
    description:
      "Returns the list of event types currently registered in the BOS event system, for use when authoring workflow triggers. Each entry includes the type string, the count of registered handlers, and a display name.",
    inputSchema: { type: "object", properties: {}, additionalProperties: false },
  }),
];

/**
 * The structured branch-selection signal (FR-029). This is NOT one of the 12
 * workflow_* tools the service declares to the assistant — it is injected
 * into a ROUTING node's own ephemeral agent spec by executor.js, so the node's
 * agent has a machine-readable way to name the candidate(s) it chose and
 * router.js never has to parse prose. `enum` is filled per node with that
 * node's own candidate ids, so an invalid id cannot even be expressed.
 */
function selectBranchTool(candidateIds, multi) {
  return {
    name: "select_branch",
    description: multi
      ? "Select one or more of this workflow step's declared downstream candidates. Call this as your LAST action."
      : "Select exactly one of this workflow step's declared downstream candidates. Call this as your LAST action.",
    inputSchema: {
      type: "object",
      properties: {
        selected: {
          type: "array",
          items: { type: "string", enum: [...candidateIds] },
          minItems: 1,
          ...(multi ? {} : { maxItems: 1 }),
          description: "The candidate step id(s) this step routes to.",
        },
      },
      required: ["selected"],
    },
  };
}

const SELECT_BRANCH_TOOL_NAME = "select_branch";

module.exports = { DECLARATIONS, selectBranchTool, SELECT_BRANCH_TOOL_NAME };
