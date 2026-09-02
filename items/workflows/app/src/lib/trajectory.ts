// trajectory.ts — the node-scoped projection the trajectory panel renders
// (US10/FR-026). It is deliberately a PROJECTION, not a second source of
// truth: the per-step state (status, attempt, current action, sub-agents,
// agent trace) comes verbatim from the service's own run-state
// (services/engine/run-state.js) via `workflow_status` / `GET /run/<runId>` /
// `workflow_run_get`. All this module adds is the node-scoped slice of the
// event log (lifecycle rows with timestamps + durations) and the identity
// header fields, which are derived from the workflow definition.

import type { AgentTrace, RunDetail, RunEvent, StepLiveStatus, StepState, SubAgentState, WorkflowStep } from "./types";

export type LifecycleKind = "start" | "retry" | "running" | "complete" | "fail" | "cancel" | "skip";

export interface LifecycleRow {
  kind: LifecycleKind;
  /** Raw event type, shown verbatim in the panel (`step.start`, …). */
  label: string;
  ts: number;
  time: string;
  meta?: string;
  live?: boolean;
}

export interface NodeTrajectory {
  id: string;
  status: StepLiveStatus;
  attempt?: number;
  maxAttempts?: number;
  retrying: boolean;
  currentAction?: string;
  /** "tool node" | "Ephemeral agent" | "<agent-id>" — the identity line. */
  agentSource: string;
  outputType: string;
  outputLabel: string;
  agentTrace?: AgentTrace;
  subAgents: SubAgentState[];
  events: LifecycleRow[];
  output?: unknown;
  error?: string;
  reason?: string;
  selected?: string[];
  hasContent: boolean;
}

const EVENT_KIND: Record<string, LifecycleKind> = {
  "step.start": "start",
  "step.retry": "retry",
  "step.running": "running",
  "step.complete": "complete",
  "step.fail": "fail",
  "step.cancel": "cancel",
  "step.skip": "skip",
};

export function formatTime(ts: number): string {
  try {
    return new Date(ts).toLocaleTimeString();
  } catch {
    return "";
  }
}

function formatDuration(ms: number): string {
  if (ms < 1000) return `${ms}ms`;
  if (ms < 60_000) return `${(ms / 1000).toFixed(1)}s`;
  const min = Math.floor(ms / 60_000);
  return `${min}m ${Math.round((ms % 60_000) / 1000)}s`;
}

/** "tool · fetch:csv"-style descriptor used by the graph and the panel header. */
export function describeStep(step: WorkflowStep): string {
  if (step.outputType === "tool") return step.toolName || "unnamed-tool";
  if (step.outputType === "research") return `${(step.researchAgents || step.candidates || []).length} agent(s)`;
  if (step.outputType === "ag-ui") return step.outputConvention || "artifact";
  // An event node's identity IS the type it emits (node-model.js describeNode).
  if (step.outputType === "event") return step.config?.eventType || "unnamed-event";
  return step.agentSource?.kind === "ephemeral" ? "ephemeral" : step.agentSource?.agentId || "agent";
}

function agentSourceLabel(step: WorkflowStep | undefined): string {
  if (!step) return "agent";
  if (step.outputType === "tool") return "tool node";
  if (step.outputType === "research") return `research fan-out · ${(step.researchAgents || []).length} agent(s)`;
  if (step.outputType === "ag-ui") return "no delegation";
  // An event node has no agent at all — it is a pure I/O step (FR-046).
  if (step.outputType === "event") return "no agent · emits an event";
  return step.agentSource?.kind === "ephemeral" ? "Ephemeral agent" : step.agentSource?.agentId || "agent";
}

/** Ordered lifecycle rows for one node, with per-row duration since the
 *  previous row (the mockup's `3.4s` meta). */
export function lifecycleRowsFor(nodeId: string, events: RunEvent[] | undefined): LifecycleRow[] {
  const rows: LifecycleRow[] = [];
  let previousTs: number | null = null;
  for (const ev of events || []) {
    if (ev.stepId !== nodeId) continue;
    const kind = EVENT_KIND[ev.type];
    if (!kind) continue; // agent.* events are trace, not lifecycle
    const parts: string[] = [];
    if (kind === "retry" && ev.attempt) parts.push(`attempt ${ev.attempt + 1}${ev.maxAttempts ? `/${ev.maxAttempts}` : ""}`);
    if (ev.error) parts.push(ev.error);
    if (ev.reason && ev.reason !== ev.error) parts.push(ev.reason);
    if (kind === "running" && ev.action) parts.push(ev.action);
    if ((kind === "complete" || kind === "fail") && previousTs != null) parts.push(formatDuration(ev.ts - previousTs));
    rows.push({
      kind,
      label: ev.type,
      ts: ev.ts,
      time: formatTime(ev.ts),
      meta: parts.length ? parts.join(" · ") : undefined,
      live: kind === "running",
    });
    previousTs = ev.ts;
  }
  // A "running" row is only live while it is still the last thing that
  // happened (the mockup spins that row's icon).
  for (let i = 0; i < rows.length - 1; i++) rows[i].live = false;
  return rows;
}

function subAgentList(step: StepState | undefined): SubAgentState[] {
  if (!step?.subAgents) return [];
  return Object.entries(step.subAgents).map(([id, sa]) => ({ id, ...sa }));
}

function hasTraceContent(trace: AgentTrace | undefined): boolean {
  if (!trace) return false;
  return Boolean(trace.prompt || trace.thinking || trace.response || (trace.toolCalls && trace.toolCalls.length));
}

/**
 * Build the panel's view model for one node. Works identically for a LIVE run
 * (the run detail is a tail of the running log) and a HISTORICAL one (the run
 * detail is replayed from the persisted log) — the caller does not branch.
 */
export function nodeTrajectory(nodeId: string, workflowSteps: WorkflowStep[], run: RunDetail | null | undefined): NodeTrajectory {
  const step = workflowSteps.find((s) => s.id === nodeId);
  const state: StepState | undefined = run?.steps?.[nodeId];
  const events = lifecycleRowsFor(nodeId, run?.events);
  const status = (state?.status || "pending") as StepLiveStatus;
  const attempt = state?.attempt ?? state?.attempts;
  const maxAttempts = state?.maxAttempts;
  const output = state?.outputs !== undefined ? state.outputs : state?.output;
  const subAgents = subAgentList(state);

  return {
    id: nodeId,
    status,
    attempt,
    maxAttempts,
    retrying: status === "running" && !!attempt && attempt > 1,
    currentAction: state?.currentAction,
    agentSource: agentSourceLabel(step),
    outputType: step?.outputType || "delegate",
    outputLabel: `${step?.outputType || "delegate"} output`,
    agentTrace: state?.agentTrace,
    subAgents,
    events,
    output,
    error: state?.error,
    reason: state?.reason,
    selected: state?.selected || run?.selected?.[nodeId],
    hasContent: hasTraceContent(state?.agentTrace) || events.length > 0 || subAgents.length > 0 || output !== undefined,
  };
}

/** Render any structured value for the panel's monospace blocks. */
export function renderValue(value: unknown): string {
  if (value == null) return "";
  if (typeof value === "string") return value;
  try {
    return JSON.stringify(value, null, 2);
  } catch {
    return String(value);
  }
}
