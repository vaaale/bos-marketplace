// types.ts — shapes shared by the app's components, mirroring the service's
// own engine (services/engine/node-model.js, scheduler.js, runs.js). Kept
// loose (mostly `unknown`/optional) since the app only ever reads these over
// HTTP — it never re-implements validation, that's the service's job.

export type OutputType = "delegate" | "tool" | "research" | "ag-ui";

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

export interface RunSummary {
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
