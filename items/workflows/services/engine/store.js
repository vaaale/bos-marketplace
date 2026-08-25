// store.js — workflow + run CRUD over the loopback VFS bridge (ADR-2).
// Re-implements the retired src/lib/workflows/store.ts, plus the run-state
// additions from ADR-9 (runs are first-class, not folded into a single
// per-workflow execution log). Workflows live at /Workflows/<id>-workflow.json;
// runs live at /Workflows/.runs/<workflowId>/<runId>.json (see runs.js).

const vfs = require("../vfs");

const ROOT = "/Workflows";
const RUNS_ROOT = `${ROOT}/.runs`;

function workflowPath(id) {
  return `${ROOT}/${id}-workflow.json`;
}

function slugify(name) {
  return (
    String(name || "")
      .toLowerCase()
      .replace(/[^a-z0-9]+/g, "-")
      .replace(/^-+|-+$/g, "") || `workflow-${Date.now().toString(36)}`
  );
}

function generateWorkflowId(name) {
  return `${slugify(name)}-${Math.random().toString(36).slice(2, 6)}`;
}

async function ensureRoot() {
  await vfs.mkdir(ROOT);
  await vfs.mkdir(RUNS_ROOT);
}

async function readJson(path) {
  try {
    const txt = await vfs.readText(path);
    return JSON.parse(txt);
  } catch {
    return undefined;
  }
}

async function listWorkflows() {
  await ensureRoot();
  let entries = [];
  try {
    entries = await vfs.list(ROOT);
  } catch {
    return [];
  }
  const out = [];
  for (const e of entries) {
    if (e.type !== "file" || !e.name.endsWith("-workflow.json")) continue;
    const wf = await readJson(e.path);
    if (wf && wf.id) out.push(wf);
  }
  return out.sort((a, b) => (b.updatedAt ?? 0) - (a.updatedAt ?? 0));
}

async function getWorkflow(id) {
  await ensureRoot();
  return readJson(workflowPath(id));
}

async function saveWorkflow(input) {
  await ensureRoot();
  const now = Date.now();
  const wf = {
    ...input,
    id: input.id || generateWorkflowId(input.name || "workflow"),
    version: input.version ?? 1,
    steps: Array.isArray(input.steps) ? input.steps : [],
    createdAt: input.createdAt ?? now,
    updatedAt: now,
  };
  await vfs.writeText(workflowPath(wf.id), JSON.stringify(wf, null, 2));
  return wf;
}

async function deleteWorkflow(id) {
  await ensureRoot();
  await vfs.remove(workflowPath(id)).catch(() => {});
  await vfs.remove(`${RUNS_ROOT}/${id}`).catch(() => {});
}

module.exports = {
  ROOT,
  RUNS_ROOT,
  generateWorkflowId,
  ensureRoot,
  listWorkflows,
  getWorkflow,
  saveWorkflow,
  deleteWorkflow,
};
