import React, { useEffect, useMemo, useState } from "react";
import type { RunDetail, RunSummary, StepLiveStatus, Workflow, ValidationResult } from "../lib/types";
import { Graph, GraphLegend } from "./Graph";
import { GraphEditor } from "./GraphEditor";
import { WorkflowStatusPill } from "./StatusPill";
import { PanelDivider, TrajectoryPanel, usePanelWidth } from "./TrajectoryPanel";
import { TriggersPanel } from "./TriggersPanel";
import { RunProvenance, RunSourceGlyph } from "./RunProvenance";
import { nodeTrajectory } from "../lib/trajectory";
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
  // Historical replay: which node's trajectory is open, and how wide.
  const [selectedNode, setSelectedNode] = useState<string | null>(null);
  const { width, dividerProps } = usePanelWidth();

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
    // Switching runs resets the panel; the user picks a node in the new run.
    setSelectedNode(null);
  }

  async function runValidate() {
    setValidation((await api.validate(workflow.id)) as ValidationResult);
  }

  async function runExport() {
    const wf = await api.export(workflow.id);
    setExportText(JSON.stringify(wf, null, 2));
  }

  // The persisted per-step outcomes are already the exact status vocabulary
  // the graph renders (completed/failed/cancelled/skipped/neutral) — a
  // skipped leaf must stay distinguishable from one that simply never ran.
  const historicalOutcomes: Record<string, StepLiveStatus | undefined> = {};
  if (selectedRun?.steps) {
    for (const [id, s] of Object.entries(selectedRun.steps)) historicalOutcomes[id] = s.status;
  }

  const historicalTrajectory = useMemo(
    () => (selectedNode && selectedRun ? nodeTrajectory(selectedNode, workflow.steps, selectedRun) : null),
    [selectedNode, selectedRun, workflow.steps],
  );

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

      {/* US16/FR-049 — the workflow's event triggers. Lives beside the graph
          rather than inside the editor: a trigger is a property of the
          WORKFLOW, not of any node, and changing it re-subscribes the service
          immediately (no "Save graph" round-trip). */}
      <div style={{ marginTop: 16 }}>
        <TriggersPanel workflow={workflow} onModified={onModified} />
      </div>

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
                <RunSourceGlyph startSource={r.startSource} />
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
          <RunProvenance run={selectedRun} />
          {selectedRun.warnings?.length ? (
            <div className="wf-warning-banner" style={{ marginBottom: 8 }}>
              ⚠ Selected branch executed no leaf step: {selectedRun.warnings.map((w) => w.stepId).join(", ")}
            </div>
          ) : null}
          <div className="wf-split">
            <div className="wf-split-main">
              <div className="wf-row" style={{ marginBottom: 6 }}>
                <h3 className="wf-section-title" style={{ margin: 0 }}>
                  Graph — final outcome
                </h3>
                <span className="wf-tool-label">historical · static</span>
                <div style={{ flex: 1 }} />
                <span className="wf-dim" style={{ fontSize: 10 }}>
                  ⊹ click a node to debug it
                </span>
              </div>
              <Graph steps={workflow.steps} statuses={historicalOutcomes} selectedId={selectedNode} onSelectNode={setSelectedNode} />
              <GraphLegend historical />
            </div>
            {historicalTrajectory ? (
              <>
                <PanelDivider {...dividerProps} />
                <TrajectoryPanel
                  trajectory={historicalTrajectory}
                  runBadge={`run ${selectedRun.runId.slice(4, 14)}`}
                  mode="historical"
                  width={width}
                  onClose={() => setSelectedNode(null)}
                />
              </>
            ) : null}
          </div>
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
