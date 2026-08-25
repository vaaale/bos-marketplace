import React, { useEffect, useState } from "react";
import type { RunDetail, RunSummary, StepLiveStatus, Workflow, ValidationResult } from "../lib/types";
import { Graph, GraphLegend } from "./Graph";
import { GraphEditor } from "./GraphEditor";
import { WorkflowStatusPill } from "./StatusPill";
import { api } from "../lib/bridge";

interface DetailViewProps {
  workflow: Workflow;
  liveStatus: string;
  onBack: () => void;
  onRun: () => void;
  onCancel: () => void;
  onDelete: () => void;
  onWatchRun: (runId: string) => void;
  onModified: () => void;
}

export function DetailView({ workflow, liveStatus, onBack, onRun, onCancel, onDelete, onWatchRun, onModified }: DetailViewProps) {
  const [runs, setRuns] = useState<RunSummary[]>([]);
  const [selectedRun, setSelectedRun] = useState<RunDetail | null>(null);
  const [validation, setValidation] = useState<ValidationResult | null>(null);
  const [exportText, setExportText] = useState<string | null>(null);
  const [editing, setEditing] = useState(false);

  useEffect(() => {
    let cancelled = false;
    api
      .runList(workflow.id)
      .then((r) => {
        if (!cancelled) setRuns(r as RunSummary[]);
      })
      .catch(() => {});
    return () => {
      cancelled = true;
    };
  }, [workflow.id, liveStatus]);

  async function openRun(runId: string) {
    const run = (await api.runGet(workflow.id, runId)) as RunDetail;
    setSelectedRun(run);
  }

  async function runValidate() {
    setValidation((await api.validate(workflow.id)) as ValidationResult);
  }

  async function runExport() {
    const wf = await api.export(workflow.id);
    setExportText(JSON.stringify(wf, null, 2));
  }

  const historicalOutcomes: Record<string, StepLiveStatus | undefined> = {};
  if (selectedRun?.steps) {
    for (const [id, s] of Object.entries(selectedRun.steps)) {
      historicalOutcomes[id] = s.status === "completed" ? "completed" : s.status === "failed" ? "failed" : s.status === "cancelled" ? "cancelled" : "neutral";
    }
  }

  return (
    <div className="wf-view">
      <div className="wf-row" style={{ marginBottom: 12 }}>
        <button className="wf-btn wf-btn-sm" onClick={onBack}>
          ← Back
        </button>
        <div className="wf-card-icon" style={{ height: 32, width: 32 }}>

        </div>
        <div style={{ minWidth: 0 }}>
          <div className="wf-row">
            <span style={{ fontWeight: 600 }}>{workflow.name}</span>
            <WorkflowStatusPill status={liveStatus} />
          </div>
          <div className="wf-mono wf-dim" style={{ fontSize: 11 }}>
            {workflow.id} · v{workflow.version} · {workflow.steps.length} step(s)
          </div>
        </div>
        <div style={{ flex: 1 }} />
        {liveStatus === "running" ? (
          <button className="wf-btn wf-btn-danger" onClick={onCancel}>
            ■ Cancel <span className="wf-tool-label">workflow_cancel</span>
          </button>
        ) : (
          <button className="wf-btn" onClick={onRun}>
            ▶ Run <span className="wf-tool-label">workflow_run</span>
          </button>
        )}
        <button className="wf-btn" onClick={() => setEditing((v) => !v)}>
          {editing ? "Close editor" : "Edit"} <span className="wf-tool-label">workflow_modify</span>
        </button>
        <button className="wf-btn" onClick={runExport}>
          Export <span className="wf-tool-label">workflow_export</span>
        </button>
        <button className="wf-btn" onClick={runValidate}>
          Validate <span className="wf-tool-label">workflow_validate</span>
        </button>
        <button className="wf-btn wf-btn-danger" onClick={onDelete}>
          Delete <span className="wf-tool-label">workflow_delete</span>
        </button>
      </div>

      {validation ? (
        <div className={`wf-card ${validation.ok ? "wf-card-ok" : "wf-card-danger"}`} style={{ marginBottom: 12 }}>
          <div style={{ fontWeight: 600 }}>{validation.ok ? "Valid" : "Invalid"}</div>
          {validation.errors.map((e, i) => (
            <div key={i} style={{ fontSize: 12, color: "#fecaca" }}>
              ✗ {e}
            </div>
          ))}
          {validation.warnings.map((w, i) => (
            <div key={i} style={{ fontSize: 12, color: "#fde68a" }}>
              ⚠ {w}
            </div>
          ))}
        </div>
      ) : null}

      {editing ? (
        <GraphEditor
          workflow={workflow}
          onCancel={() => setEditing(false)}
          onSaved={() => {
            setEditing(false);
            onModified();
          }}
        />
      ) : null}

      {exportText ? (
        <div className="wf-card" style={{ marginBottom: 12 }}>
          <div className="wf-row">
            <span style={{ fontWeight: 600 }}>Exported JSON</span>
            <div style={{ flex: 1 }} />
            <button className="wf-btn wf-btn-sm" onClick={() => setExportText(null)}>
              Close
            </button>
          </div>
          <pre className="wf-pre">{exportText}</pre>
        </div>
      ) : null}

      {!editing ? (
        <>
          <h3 className="wf-section-title">Graph</h3>
          <Graph steps={workflow.steps} />
          <GraphLegend />
        </>
      ) : null}

      <div style={{ marginTop: 16 }}>
        <h3 className="wf-section-title">
          Historical runs <span className="wf-tool-label">workflow_run_list</span>
        </h3>
        {runs.length === 0 ? (
          <div className="wf-dim" style={{ fontSize: 12 }}>
            No runs yet.
          </div>
        ) : (
          <div className="wf-row" style={{ flexWrap: "wrap" }}>
            {runs.map((r) => (
              <button
                key={r.runId}
                className={`wf-run-chip ${selectedRun?.runId === r.runId ? "wf-run-chip-active" : ""}`}
                onClick={() => (r.state === "running" ? onWatchRun(r.runId) : openRun(r.runId))}
              >
                <span className="wf-mono">#{r.runId.slice(4, 12)}</span>
                <WorkflowStatusPill status={r.state} />
              </button>
            ))}
          </div>
        )}
      </div>

      {selectedRun ? (
        <div className="wf-card wf-card-history" style={{ marginTop: 12 }}>
          <div className="wf-row">
            <span className="wf-mono" style={{ color: "#ddd6fe" }}>
              Run {selectedRun.runId} · {selectedRun.state} · replaying from log
            </span>
            <div style={{ flex: 1 }} />
            <button className="wf-btn wf-btn-sm" onClick={() => setSelectedRun(null)}>
              Exit replay
            </button>
          </div>
          <h3 className="wf-section-title">
            Graph — final outcome <span className="wf-tool-label">historical · static</span>
          </h3>
          <Graph steps={workflow.steps} statuses={historicalOutcomes} />
          <GraphLegend historical />
          <h3 className="wf-section-title" style={{ marginTop: 12 }}>
            Replayed event stream <span className="wf-tool-label">workflow_run_get</span>
          </h3>
          <div className="wf-stream">
            {(selectedRun.events || []).map((ev, i) => (
              <div key={i} className="wf-stream-line">
                <span className="wf-dim">{new Date(ev.ts).toLocaleTimeString()}</span> {ev.type}
                {ev.stepId ? ` ${ev.stepId}` : ""}
                {ev.error ? ` — ${ev.error}` : ""}
              </div>
            ))}
          </div>
        </div>
      ) : null}
    </div>
  );
}
