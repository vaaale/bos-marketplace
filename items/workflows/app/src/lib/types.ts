// types.ts — shapes shared by the app's components, mirroring the service's
// own engine (services/engine/node-model.js, scheduler.js, runs.js). Kept
// loose (mostly `unknown`/optional) since the app only ever reads these over
// HTTP — it never re-implements validation, that's the service's job.

export type OutputType = "delegate" | "tool" | "research" | "ag-ui" | "event";

/** How an `event` node builds the payload it emits (services/engine/node-model.js). */
export type EventPayloadMode = "static" | "template";

/**
 * An `event` node's `config` (US18/FR-046). `payload.value` is the literal
 * object emitted in static mode; `payload.text` is a JSON template string with
 * `{{nodeId.field}}` placeholders resolved against upstream outputs.
 */
export interface EventNodeConfig {
  eventType?: string;
  payload?: {
    mode?: EventPayloadMode;
    value?: unknown;
    text?: string;
    fallback?: unknown;
  };
}

/** ADR-14/FR-048b: this item may only emit events under its own namespace. */
export const WORKFLOWS_EVENT_NAMESPACE = "com.bos.workflows.";

/** FR-046/FR-048a: dot-separated, lowercase — the service's own pattern. */
export const EVENT_TYPE_PATTERN = /^[a-z0-9]+(\.[a-z0-9_-]+)+$/;

export interface AgentSource {
  kind: "static" | "ephemeral";
  agentId?: string;
  task?: string;
  tools?: string[];
  skills?: string[];
  systemPrompt?: string;
}

export interface WorkflowStep {
  id: string;
  outputType: OutputType;
  agentSource?: AgentSource;
  toolName?: string;
  researchAgents?: AgentSource[];
  candidates?: Array<{ id: string; agentId?: string; description?: string }>;
  dependencies?: string[];
  input?: unknown;
  outputConvention?: string;
  retryLimit?: number;
  timeout?: number;
  /** Only meaningful for `outputType: "event"` (US18/FR-046). */
  config?: EventNodeConfig;
}

export interface WorkflowConfig {
  maxConcurrentSteps?: number;
  defaultRetryLimit?: number;
  defaultTimeout?: number;
}

export interface Workflow {
  id: string;
  name: string;
  version: number;
  config?: WorkflowConfig;
  /** US16/FR-039: event types whose arrival starts a run of this workflow. */
  triggers?: string[];
  steps: WorkflowStep[];
  createdAt?: number;
  updatedAt?: number;
}

export type WorkflowListStatus = "running" | "idle";

export interface WorkflowListEntry {
  workflow_id: string;
  name: string;
  steps: number;
  status: WorkflowListStatus;
  run_id?: string;
}

export type StepLiveStatus = "pending" | "running" | "completed" | "failed" | "cancelled" | "skipped" | "neutral";

/** One tool call inside a node's agent trace (FR-028). */
export interface AgentToolCall {
  name: string;
  args?: unknown;
  result?: unknown;
  ok?: boolean;
  inflight?: boolean;
}

export interface AgentTrace {
  prompt?: string;
  thinking?: string;
  response?: string;
  toolCalls: AgentToolCall[];
}

/** A research node's fan-out entry (FR-022/FR-036). */
export interface SubAgentState {
  id?: string;
  label: string;
  status: StepLiveStatus;
  action?: string;
  error?: string;
  agentTrace?: AgentTrace;
}

/**
 * The service's per-step live projection (services/engine/run-state.js
 * `StepRuntimeState`). This is the SAME object `workflow_status`,
 * `workflow_run_get` and `GET /run/<runId>` return — the app never
 * re-derives it (FR-036, "one live state, two consumers").
 */
export interface StepState {
  status: StepLiveStatus;
  attempt?: number;
  /** v1 field name for `attempt`, still emitted for compatibility. */
  attempts?: number;
  maxAttempts?: number;
  currentAction?: string;
  reason?: string;
  timedOut?: boolean;
  selected?: string[];
  subAgents?: Record<string, SubAgentState>;
  outputs?: unknown;
  output?: unknown;
  agentTrace?: AgentTrace;
  error?: string;
}

/** US17/FR-044: one entry of `workflow_event_types`. */
export interface EventTypeEntry {
  type: string;
  handlerCount: number;
  displayName?: string | null;
}

/** US16/FR-041: who started a run. Pre-US16 run records have none — "tool". */
export type RunStartSource = "user" | "tool" | "event";

export type RunFinalState = "running" | "completed" | "completed_with_warnings" | "failed" | "cancelled" | "never_run";

export interface RunEvent {
  type: string;
  seq?: number;
  runId: string;
  workflowId: string;
  ts: number;
  stepId?: string;
  subAgentId?: string;
  label?: string;
  attempt?: number;
  maxAttempts?: number;
  action?: string;
  reason?: string;
  error?: string;
  payload?: unknown;
  selected?: string[];
}

export interface BranchWarning {
  stepId?: string;
  selected?: string[];
  reason?: string;
}

/** US16/FR-041 run PROVENANCE, carried identically by the live projection and
 *  the persisted log (services/engine/run-state.js + runs.js). */
export interface RunProvenance {
  startSource?: RunStartSource;
  triggerEventId?: string | null;
  triggerEventType?: string | null;
  eventContext?: unknown;
}

export interface RunSummary extends RunProvenance {
  runId: string;
  startedAt?: number;
  endedAt?: number;
  state: RunFinalState;
  finalState?: RunFinalState;
}

export interface RunDetail extends RunSummary {
  workflowId: string;
  running?: boolean;
  finalState?: RunFinalState;
  steps?: Record<string, StepState>;
  events?: RunEvent[];
  selected?: Record<string, string[]>;
  warnings?: BranchWarning[];
  /** Head of the append-only event log — feed it back as `?since=` to tail. */
  seq?: number;
  error?: string;
}

export interface ValidationResult {
  ok: boolean;
  errors: string[];
  warnings: string[];
}

/** US19 — one per-run outcome of `workflow_run_delete` / POST runs/delete. */
export type RunDeleteStatus = "deleted" | "not_found" | "error";

export interface RunDeleteEntry {
  runId: string;
  status: RunDeleteStatus;
  error?: string;
}

/** US19 — the result shape of the service's bulk run-log delete. */
export interface RunDeleteResult {
  workflowId: string;
  /** Count of entries whose status is "deleted" (not_found is not counted). */
  deleted: number;
  results: RunDeleteEntry[];
}
