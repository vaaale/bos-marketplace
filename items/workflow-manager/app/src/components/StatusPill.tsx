import React from "react";

export function ServiceStatusPill({ running }: { running: boolean | null }) {
  if (running === null) {
    return <span className="wf-pill wf-pill-neutral">checking service…</span>;
  }
  return running ? (
    <span className="wf-pill wf-pill-ok">● Service running</span>
  ) : (
    <span className="wf-pill wf-pill-warn">● Service stopped</span>
  );
}

// The five run outcomes the app renders (FR-032 added the fifth:
// `completed_with_warnings` — a run whose selected branch executed no leaf,
// which must never be shown as a plain success).
const OUTCOME_LABEL: Record<string, string> = {
  running: "Running",
  completed: "Ready",
  completed_with_warnings: "Completed · warnings",
  idle: "Ready",
  failed: "Failed",
  cancelled: "Cancelled",
  never_run: "Ready",
};

const OUTCOME_CLASS: Record<string, string> = {
  running: "wf-pill-info",
  completed_with_warnings: "wf-pill-warn",
  failed: "wf-pill-danger",
  cancelled: "wf-pill-neutral",
};

export function WorkflowStatusPill({ status }: { status: string }) {
  const label = OUTCOME_LABEL[status] || status;
  const cls = OUTCOME_CLASS[status] || "wf-pill-ok";
  return <span className={`wf-pill ${cls}`}>{label}</span>;
}
