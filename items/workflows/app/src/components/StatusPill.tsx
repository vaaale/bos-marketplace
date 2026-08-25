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

const OUTCOME_LABEL: Record<string, string> = {
  running: "Running",
  completed: "Ready",
  idle: "Ready",
  failed: "Failed",
  cancelled: "Cancelled",
  never_run: "Ready",
};

export function WorkflowStatusPill({ status }: { status: string }) {
  const label = OUTCOME_LABEL[status] || status;
  const cls = status === "running" ? "wf-pill-info" : status === "failed" ? "wf-pill-danger" : status === "cancelled" ? "wf-pill-neutral" : "wf-pill-ok";
  return <span className={`wf-pill ${cls}`}>{label}</span>;
}
