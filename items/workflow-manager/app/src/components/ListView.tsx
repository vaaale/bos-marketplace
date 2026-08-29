import React, { useState } from "react";
import type { WorkflowListEntry } from "../lib/types";
import { WorkflowStatusPill } from "./StatusPill";
import { EmptyState } from "./EmptyState";

interface ListViewProps {
  workflows: WorkflowListEntry[];
  loading: boolean;
  onOpen: (id: string) => void;
  onRun: (id: string) => void;
  onCancel: (id: string) => void;
  onCreate: (taskDescription: string) => Promise<void>;
  onWatchRun: (id: string, runId: string) => void;
  onEdit: (id: string) => void;
}

export function ListView({ workflows, loading, onOpen, onRun, onCancel, onCreate, onWatchRun, onEdit }: ListViewProps) {
  const [creating, setCreating] = useState(false);
  const [task, setTask] = useState("");
  const [busy, setBusy] = useState(false);

  async function submitCreate() {
    if (!task.trim()) return;
    setBusy(true);
    try {
      await onCreate(task.trim());
      setTask("");
      setCreating(false);
    } finally {
      setBusy(false);
    }
  }

  return (
    <div className="wf-view">
      <div className="wf-row" style={{ marginBottom: 8 }}>
        <h3 className="wf-section-title">Workflows</h3>
        <span className="wf-mono wf-dim">/Workflows/</span>
        <div style={{ flex: 1 }} />
        <button className="wf-btn" onClick={() => setCreating((v) => !v)}>
          + New workflow <span className="wf-tool-label">workflow_create</span>
        </button>
      </div>

      {creating ? (
        <div className="wf-card" style={{ marginBottom: 12 }}>
          <div style={{ marginBottom: 6, fontSize: 12, color: "rgba(255,255,255,0.6)" }}>
            Describe what the workflow should accomplish — it will be planned for you.
          </div>
          <textarea
            className="wf-textarea"
            rows={3}
            value={task}
            onChange={(e) => setTask(e.target.value)}
            placeholder="e.g. Fetch last week's CSV export, clean it, and email a summary."
          />
          <div className="wf-row" style={{ marginTop: 6 }}>
            <button className="wf-btn wf-btn-primary" disabled={busy || !task.trim()} onClick={submitCreate}>
              {busy ? "Creating…" : "Create"}
            </button>
            <button className="wf-btn" onClick={() => setCreating(false)}>
              Cancel
            </button>
          </div>
        </div>
      ) : null}

      {loading ? (
        <div className="wf-dim">Loading…</div>
      ) : workflows.length === 0 ? (
        <EmptyState onCreate={() => setCreating(true)} />
      ) : (
        <div className="wf-grid">
          {workflows.map((wf) => (
            <div key={wf.workflow_id} className="wf-card wf-card-hover" onClick={() => onOpen(wf.workflow_id)}>
              <div className="wf-row">
                <div className="wf-card-icon">⌗</div>
                <div style={{ minWidth: 0, flex: 1 }}>
                  <div className="wf-card-title">{wf.name}</div>
                  <div className="wf-mono wf-dim" style={{ fontSize: 11 }}>
                    {wf.workflow_id}
                  </div>
                </div>
                <WorkflowStatusPill status={wf.status} />
              </div>
              <div className="wf-row" style={{ fontSize: 11, color: "rgba(255,255,255,0.5)", marginTop: 8 }}>
                <span>{wf.steps} step(s)</span>
              </div>
              <div className="wf-row" style={{ marginTop: 8 }} onClick={(e) => e.stopPropagation()}>
                {wf.status === "running" ? (
                  <>
                    <button
                      className="wf-btn wf-btn-sm"
                      onClick={() => wf.run_id && onWatchRun(wf.workflow_id, wf.run_id)}
                    >
                      Watch <span className="wf-tool-label">workflow_status</span>
                    </button>
                    <button className="wf-btn wf-btn-sm wf-btn-danger" onClick={() => onCancel(wf.workflow_id)}>
                      Cancel <span className="wf-tool-label">workflow_cancel</span>
                    </button>
                  </>
                ) : (
                  <>
                    <button className="wf-btn wf-btn-sm" onClick={() => onRun(wf.workflow_id)}>
                      Run <span className="wf-tool-label">workflow_run</span>
                    </button>
                    <button className="wf-btn wf-btn-sm" onClick={() => onEdit(wf.workflow_id)}>
                      Edit <span className="wf-tool-label">workflow_modify</span>
                    </button>
                  </>
                )}
              </div>
            </div>
          ))}
        </div>
      )}
    </div>
  );
}
