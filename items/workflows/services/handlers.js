// handlers.js — tool handlers for the 13 workflow_* tools (FR-002/014/016/024,
// plus workflow_event_types — US17/FR-044/045),
// wired to the engine (store/validate/generate) and to runs.js for execution
// + historical inspection. Each handler is `(args, ctx) => Promise<any>`; ctx
// carries `log(level, message)` for structured logging (NFR-005) and
// `defaultMaxConcurrentSteps` from the service's own config.
//
// Every handler validates its own args shape defensively (a malformed call
// should never throw an unhandled exception across the tool_call boundary —
// index.js's tool_call dispatch already catches/reports errors as tool_error,
// but handlers surface a clear message rather than a raw TypeError).

const store = require("./engine/store");
const vfs = require("./vfs");
const { validateWorkflow } = require("./engine/validate");
const { generateWorkflowFromTask } = require("./engine/generate");
const runs = require("./runs");

function deepMerge(target, patch) {
  if (patch == null || typeof patch !== "object") return target;
  if (Array.isArray(patch)) return patch;
  const out = { ...target };
  for (const [k, v] of Object.entries(patch)) {
    const cur = out[k];
    if (v && typeof v === "object" && !Array.isArray(v) && cur && typeof cur === "object" && !Array.isArray(cur)) {
      out[k] = deepMerge(cur, v);
    } else {
      out[k] = v;
    }
  }
  return out;
}

function requireString(args, field) {
  const v = args?.[field];
  if (typeof v !== "string" || !v.trim()) throw new Error(`${field} is required`);
  return v.trim();
}

function makeHandlers(ctx) {
  const log = ctx.log || (() => {});

  return {
    workflow_list: async () => {
      const workflows = await store.listWorkflows();
      return workflows.map((wf) => {
        const running = runs.isRunning(wf.id);
        return {
          workflow_id: wf.id,
          name: wf.name,
          steps: (wf.steps || []).length,
          status: running ? "running" : "idle",
          ...(running ? { run_id: runs.activeRunId(wf.id) } : {}),
        };
      });
    },

    workflow_create: async (args) => {
      let wf;
      if (args && typeof args.workflow === "object" && args.workflow) {
        wf = args.workflow;
      } else {
        const task = String(args?.taskDescription || "").trim();
        if (!task) throw new Error("workflow_create requires either `workflow` (a workflow object) or `taskDescription` (a natural-language description)");
        log("info", `workflow_create: generating a workflow from taskDescription via planner delegate`);
        wf = await generateWorkflowFromTask(task, { featureBranch: args.featureBranch, conversationId: args.conversationId });
      }
      const saved = await store.saveWorkflow(wf);
      const validation = validateWorkflow(saved);
      log("info", `workflow_create: saved workflow ${saved.id} (${saved.steps.length} step(s)), valid=${validation.ok}`);
      return { workflow_id: saved.id, name: saved.name, steps: saved.steps.length, validation };
    },

    workflow_read: async (args) => {
      const id = requireString(args, "workflowId");
      const wf = await store.getWorkflow(id);
      if (!wf) throw new Error(`no such workflow: ${id}`);
      return wf;
    },

    workflow_modify: async (args) => {
      const id = requireString(args, "workflowId");
      if (!args || typeof args.changes !== "object" || args.changes == null) throw new Error("changes (a JSON object) is required");
      const current = await store.getWorkflow(id);
      if (!current) throw new Error(`no such workflow: ${id}`);
      const merged = deepMerge(current, args.changes);
      const saved = await store.saveWorkflow({ ...merged, id });
      const validation = validateWorkflow(saved);
      log("info", `workflow_modify: updated workflow ${id}, valid=${validation.ok}`);
      return { workflow_id: saved.id, steps: saved.steps.length, validation };
    },

    workflow_run: async (args) => {
      const id = requireString(args, "workflowId");
      const wf = await store.getWorkflow(id);
      if (!wf) throw new Error(`no such workflow: ${id}`);
      const validation = validateWorkflow(wf);
      if (!validation.ok) throw new Error(`workflow ${id} failed validation: ${validation.errors.join("; ")}`);
      if (runs.isRunning(id)) throw new Error(`workflow ${id} already has a run in progress: ${runs.activeRunId(id)}`);
      // US14/FR-037 — dry-run is opt-in: `fixtures` alone does nothing unless
      // dryRun is set, and a run with neither behaves exactly as before.
      const fixtures = args && typeof args.fixtures === "object" && args.fixtures ? args.fixtures : undefined;
      const dryRun = args?.dryRun === true;
      if (dryRun && !fixtures) log("warn", `workflow_run: dryRun requested for ${id} with no fixtures — every node will still execute for real`);
      const { runId } = runs.startRun(wf, {
        featureBranch: args.featureBranch,
        conversationId: args.conversationId,
        maxConcurrentSteps: ctx.defaultMaxConcurrentSteps,
        dryRun,
        fixtures,
      });
      log("info", `workflow_run: started run ${runId} for workflow ${id} (fire-and-poll${dryRun ? `, dry-run with ${Object.keys(fixtures || {}).length} fixture(s)` : ""})`);
      return { runId, workflowId: id, ...(dryRun ? { dryRun: true, fixtures: Object.keys(fixtures || {}) } : {}) };
    },

    // US13/FR-036: this NEVER returns an empty `steps: {}` for a run that has
    // started — the per-step map (status, attempt/maxAttempts, current action,
    // per-sub-agent fan-out status, agent trace) is the same live projection
    // the app's trajectory panel reads (engine/run-state.js).
    workflow_status: async (args) => {
      const id = requireString(args, "workflowId");
      const wf = await store.getWorkflow(id);
      if (!wf) throw new Error(`no such workflow: ${id}`);
      const since = Number.isFinite(Number(args?.since)) ? Number(args.since) : undefined;
      return runs.getStatus(id, { since });
    },

    workflow_cancel: async (args) => {
      const id = requireString(args, "workflowId");
      const cancelled = runs.cancelRun(id);
      log("info", `workflow_cancel: workflow ${id} ${cancelled ? "cancelled" : "was not running"}`);
      return { workflowId: id, cancelled };
    },

    workflow_delete: async (args) => {
      const id = requireString(args, "workflowId");
      await store.deleteWorkflow(id);
      await runs.deleteRuns(id);
      log("info", `workflow_delete: deleted workflow ${id} and its run logs`);
      return { workflowId: id, deleted: true };
    },

    workflow_export: async (args) => {
      const id = requireString(args, "workflowId");
      const wf = await store.getWorkflow(id);
      if (!wf) throw new Error(`no such workflow: ${id}`);
      return JSON.stringify(wf, null, 2);
    },

    workflow_validate: async (args) => {
      let wf;
      if (args && typeof args.workflow === "object" && args.workflow) {
        wf = args.workflow;
      } else {
        const id = requireString(args, "workflowId");
        wf = await store.getWorkflow(id);
        if (!wf) throw new Error(`no such workflow: ${id}`);
      }
      return validateWorkflow(wf);
    },

    workflow_run_list: async (args) => {
      const id = requireString(args, "workflowId");
      return runs.listRuns(id);
    },

    // US17/FR-044/045: event-type discovery for trigger authoring. Reads BOS's
    // OWN handler registry over the same loopback origin vfs.js resolves
    // (GET /api/events/handlers → { "<type>": { ui: [...], headless: [...] } }).
    // An empty registry is an empty list, NOT an error (FR-045); an HTTP
    // failure IS an error, so the assistant never mistakes "the registry is
    // unreachable" for "nothing is registered" (NFR-002).
    workflow_event_types: async () => {
      const res = await vfs.jsonRequest("GET", "/api/events/handlers");
      if (res.status !== 200) {
        const detail = (res.body && ((res.body.error && (res.body.error.message || res.body.error)) || res.body.message)) || "no error body";
        throw new Error(`could not read the BOS event registry (GET /api/events/handlers -> ${res.status}): ${detail}`);
      }
      const grouped = res.body && typeof res.body === "object" && !Array.isArray(res.body) ? res.body : {};
      const types = Object.entries(grouped)
        .map(([type, group]) => {
          const ui = Array.isArray(group && group.ui) ? group.ui : [];
          const headless = Array.isArray(group && group.headless) ? group.headless : [];
          const first = [...ui, ...headless][0];
          return { type, handlerCount: ui.length + headless.length, displayName: (first && first.displayName) ?? null };
        })
        .sort((a, b) => a.type.localeCompare(b.type));
      log("info", `workflow_event_types: ${types.length} event type(s) registered`);
      return types;
    },

    workflow_run_get: async (args) => {
      const workflowId = requireString(args, "workflowId");
      const runId = requireString(args, "runId");
      const since = Number.isFinite(Number(args?.since)) ? Number(args.since) : undefined;
      const run = await runs.getRun(workflowId, runId, { since });
      if (!run) throw new Error(`no such run: ${runId} for workflow ${workflowId}`);
      return run;
    },
  };
}

module.exports = { makeHandlers, deepMerge };
