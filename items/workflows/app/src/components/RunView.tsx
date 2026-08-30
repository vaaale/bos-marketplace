import React, { useCallback, useEffect, useMemo, useRef, useState } from "react";
import type { RunDetail, RunEvent, StepLiveStatus, Workflow } from "../lib/types";
import { Graph, GraphLegend } from "./Graph";
import { api } from "../lib/bridge";
import { liveStepsFor } from "../lib/liveStatus";
import { nodeTrajectory } from "../lib/trajectory";
import { PanelDivider, TrajectoryPanel, usePanelWidth } from "./TrajectoryPanel";
import { WorkflowStatusPill } from "./StatusPill";

interface RunViewProps {
  workflow: Workflow;
  runId: string;
  onBack: () => void;
}

const POLL_MS = 1000;

/** Merge a `?since=` tail into the accumulated log, dropping duplicates. */
function mergeEvents(existing: RunEvent[], incoming: RunEvent[]): RunEvent[] {
  if (!incoming.length) return existing;
  const seen = new Set(existing.map((e) => e.seq ?? `${e.type}:${e.ts}:${e.stepId ?? ""}`));
  const merged = existing.slice();
  for (const ev of incoming) {
    const key = ev.seq ?? `${ev.type}:${ev.ts}:${ev.stepId ?? ""}`;
    if (seen.has(key)) continue;
    seen.add(key);
    merged.push(ev);
  }
  return merged.sort((a, b) => (a.seq ?? 0) - (b.seq ?? 0) || a.ts - b.ts);
}

export function RunView({ workflow, runId, onBack }: RunViewProps) {
  const [run, setRun] = useState<RunDetail | null>(null);
  const [cancelling, setCancelling] = useState(false);
  const [selectedNode, setSelectedNode] = useState<string | null>(null);
  const { width, dividerProps } = usePanelWidth();
  const timerRef = useRef<ReturnType<typeof setInterval> | null>(null);
  const eventsRef = useRef<RunEvent[]>([]);
  const seqRef = useRef<number>(0);

  useEffect(() => {
    eventsRef.current = [];
    seqRef.current = 0;
    let stopped = false;

    async function poll() {
      try {
        let detail: RunDetail;
        try {
          // The service's own live projection, tailed by event seq
          // (services/engine/run-state.js) — the SAME state workflow_status
          // returns, so panel and agent never disagree (FR-036).
          detail = (await api.runLive(runId, { since: seqRef.current, workflowId: workflow.id })) as RunDetail;
        } catch {
          // Fallback for an older service build (or a run only readable
          // through the tool surface): poll workflow_status, which returns
          // the whole log each time.
          const status = (await api.status(workflow.id)) as RunDetail;
          detail = status?.runId === runId ? status : ((await api.runGet(workflow.id, runId)) as RunDetail);
          eventsRef.current = [];
          seqRef.current = 0;
        }
        if (stopped) return;
        eventsRef.current = mergeEvents(eventsRef.current, detail.events || []);
        if (detail.seq) seqRef.current = detail.seq;
        setRun({ ...detail, events: eventsRef.current });
        if (detail.state !== "running" && timerRef.current) {
          clearInterval(timerRef.current);
          timerRef.current = null;
        }
      } catch {
        // transient — try again next tick
      }
    }

    void poll();
    timerRef.current = setInterval(poll, POLL_MS);
    return () => {
      stopped = true;
      if (timerRef.current) clearInterval(timerRef.current);
    };
  }, [workflow.id, runId]);

  const cancelRun = useCallback(async () => {
    setCancelling(true);
    try {
      await api.cancel(workflow.id);
    } finally {
      setCancelling(false);
    }
  }, [workflow.id]);

  // The service populates `steps` live now (FR-036); liveStepsFor still
  // replays the event log as a fallback for an older service build.
  const steps = useMemo(() => liveStepsFor(run), [run]);
  const statuses: Record<string, StepLiveStatus | undefined> = {};
  for (const [id, s] of Object.entries(steps)) statuses[id] = s.status;
  const activeStepId = Object.entries(steps).find(([, s]) => s.status === "running")?.[0] || null;

  const trajectory = useMemo(() => (selectedNode ? nodeTrajectory(selectedNode, workflow.steps, run) : null), [selectedNode, workflow.steps, run]);

  const total = workflow.steps.length;
  const done = Object.values(steps).filter((s) => s.status !== "pending" && s.status !== "running").length;
  const pct = total > 0 ? Math.round((done / total) * 100) : 0;

  return (
    <div className="wf-view">
      <div className="wf-row" style={{ marginBottom: 12 }}>
        <button className="wf-btn wf-btn-sm" onClick={onBack}>
          ← Back
        </button>
        <div style={{ minWidth: 0 }}>
          <div className="wf-row">
            <span style={{ fontWeight: 600 }}>{workflow.name}</span>
            {run?.state ? <WorkflowStatusPill status={run.state} /> : <span className="wf-pill wf-pill-neutral">loading…</span>}
          </div>
          <div className="wf-mono wf-dim" style={{ fontSize: 11 }}>
            run {runId}
            {run?.startedAt ? ` · started ${new Date(run.startedAt).toLocaleTimeString()}` : ""}
          </div>
        </div>
        <div style={{ flex: 1 }} />
        {run?.state === "running" ? (
          <button className="wf-btn wf-btn-danger" disabled={cancelling} onClick={cancelRun}>
            ■ {cancelling ? "Cancelling…" : "Cancel run"} <span className="wf-tool-label">workflow_cancel</span>
          </button>
        ) : null}
      </div>

      {run?.warnings?.length ? (
        <div className="wf-warning-banner">
          ⚠ {run.warnings.length === 1 ? "A branch was selected but executed no leaf step" : `${run.warnings.length} selected branches executed no leaf step`}:{" "}
          {run.warnings.map((w) => w.stepId).join(", ")} — the run completed with warnings.
        </div>
      ) : null}

      <div style={{ marginBottom: 4, display: "flex", justifyContent: "space-between", fontSize: 11, color: "rgba(255,255,255,0.5)" }}>
        <span>
          {done} of {total} steps
        </span>
        <span className="wf-mono">{pct}%</span>
      </div>
      <div className="wf-progress">
        <div className="wf-progress-bar" style={{ width: `${pct}%` }} />
      </div>

      <div className="wf-split" style={{ marginTop: 12 }}>
        <div className="wf-split-main">
          <div className="wf-row" style={{ marginBottom: 6 }}>
            <h3 className="wf-section-title" style={{ margin: 0 }}>
              Graph — live execution
            </h3>
            {activeStepId ? <span className="wf-pill wf-pill-info">{activeStepId} active</span> : null}
            <div style={{ flex: 1 }} />
            <span className="wf-dim" style={{ fontSize: 10 }}>
              ⊹ click a node to debug it
            </span>
          </div>
          <Graph steps={workflow.steps} statuses={statuses} activeStepId={activeStepId} selectedId={selectedNode} onSelectNode={setSelectedNode} />
          <GraphLegend />
        </div>
        {trajectory ? (
          <>
            <PanelDivider {...dividerProps} />
            <TrajectoryPanel trajectory={trajectory} runBadge={`run ${runId.slice(4, 14)}`} mode="live" width={width} onClose={() => setSelectedNode(null)} />
          </>
        ) : null}
      </div>

      {/* FR-027: the per-step status list that used to live here is gone —
          per-step status is the graph's node coloring plus the trajectory
          panel above. The raw event stream stays: it is the run-wide log,
          not a per-step duplicate of the graph. */}
      <div style={{ marginTop: 12 }}>
        <h3 className="wf-section-title">Event stream</h3>
        <div className="wf-stream">
          {(run?.events || []).map((ev, i) => (
            <div key={ev.seq ?? i} className="wf-stream-line">
              <span className="wf-dim">{new Date(ev.ts).toLocaleTimeString()}</span> {ev.type}
              {ev.stepId ? ` ${ev.stepId}` : ""}
              {ev.attempt && ev.attempt > 1 ? ` (attempt ${ev.attempt})` : ""}
              {ev.error ? ` — ${ev.error}` : ""}
            </div>
          ))}
        </div>
      </div>
    </div>
  );
}
