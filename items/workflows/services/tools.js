// tools.js — the 12 workflow_* tool declarations (FR-002/014/016/024), the
// 039-compliant native-tool surface replacing the retired BOS-source
// `workflowTools()`. Declarations only — see handlers.js for the
// implementations `index.js` wires each `name` to via tool_call dispatch.
//
// Read-only tools are marked parallelSafe (039) so the agent can batch
// several in one turn (e.g. workflow_list + workflow_status for two
// workflows) without them serializing.

const STRING = { type: "string" };
const OBJECT = { type: "object" };

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
      "Start a workflow run. Fire-and-poll: returns { runId, workflowId } immediately (well under 30s) — it does NOT wait for the run to finish. Poll workflow_status or workflow_run_get with the returned runId to observe progress and the final state (completed/failed/cancelled). Refused if the workflow fails validation, or if it already has a run in progress.",
    inputSchema: required({ workflowId: STRING, featureBranch: STRING, conversationId: STRING }, ["workflowId"]),
  },
  readOnly({
    name: "workflow_status",
    description: "Get a workflow's current run state: if a run is in progress, its live per-step statuses and event log; otherwise the most recent historical run's final state. Use workflow_run_get for a specific historical run by id.",
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
    description: "Validate a workflow: DAG acyclicity, node shape (agentSource/outputType), dependency and dynamic-routing candidate resolvability. Pass `workflowId` to validate a saved workflow, or `workflow` to validate one before saving. Returns { ok, errors[], warnings[] }.",
    inputSchema: required({ workflowId: STRING, workflow: OBJECT }, []),
  }),
  readOnly({
    name: "workflow_run_list",
    description: "List a workflow's historical runs (id, start/end timestamp, final state), newest first.",
    inputSchema: required({ workflowId: STRING }, ["workflowId"]),
  }),
  readOnly({
    name: "workflow_run_get",
    description: "Read one run's full detail: per-step final outcomes (completed/failed/cancelled/neutral) and the complete event log, replayable independent of whether the run is still live.",
    inputSchema: required({ workflowId: STRING, runId: STRING }, ["workflowId", "runId"]),
  }),
];

module.exports = { DECLARATIONS };
