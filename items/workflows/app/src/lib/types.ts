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

export type StepLiveStatus = "pending" | "running" | "completed" | "failed" | "cancelled" | "neutral";

export interface StepState {
  status: StepLiveStatus;
  attempts?: number;
  output?: unknown;
  error?: string;
}

export type RunFinalState = "running" | "completed" | "failed" | "cancelled" | "never_run";

export interface RunEvent {
  type: string;
  runId: string;
  workflowId: string;
  ts: number;
  stepId?: string;
  attempt?: number;
  error?: string;
  payload?: unknown;
  selected?: string[];
}

export interface RunSummary {
  runId: string;
  startedAt?: number;
  endedAt?: number;
  state: RunFinalState;
}

export interface RunDetail extends RunSummary {
  workflowId: string;
  running?: boolean;
  steps?: Record<string, StepState>;
  events?: RunEvent[];
  error?: string;
}

export interface ValidationResult {
  ok: boolean;
  errors: string[];
  warnings: string[];
}
