import React, { useEffect, useMemo, useRef, useState } from "react";
import type { RunDetail, StepLiveStatus, Workflow } from "../lib/types";
import { Graph, GraphLegend } from "./Graph";
import { api } from "../lib/bridge";
import { liveStepsFor } from "../lib/liveStatus";

interface RunViewProps {
  workflow: Workflow;
  runId: string;
  onBack: () => void;
}

const POLL_MS = 1000;

export function RunView({ workflow, runId, onBack }: RunViewProps) {
  const [run, setRun] = useState<RunDetail | null>(null);
  const [cancelling, setCancelling] = useState(false);
  const timerRef = useRef<ReturnType<typeof setInterval> | null>(null);

  useEffect(() => {
    let stopped = false;
    async function poll() {
      try {
        const detail = (await api.runGet(workflow.id, runId)) as RunDetail;
        if (!stopped) setRun(detail);
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

  async function cancelRun() {
    setCancelling(true);
    try {
      await api.cancel(workflow.id);
    } finally {
      setCancelling(false);
    }
  }

  // `run.steps` (the persisted-log field) is only populated once the run
  // settles — while running, the live event stream is the only channel that
  // updates per-step status, so we replay it here (see lib/liveStatus.ts).
  const steps = useMemo(() => liveStepsFor(run), [run]);
  const statuses: Record<string, StepLiveStatus | undefined> = {};
  for (const [id, s] of Object.entries(steps)) statuses[id] = s.status;
  const activeStepId = Object.entries(steps).find(([, s]) => s.status === "running")?.[0] || null;

  const total = workflow.steps.length;
  const done = Object.values(steps).filter((s) => s.status === "completed" || s.status === "failed" || s.status === "cancelled" || s.status === "neutral").length;
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
            <span className={`wf-pill ${run?.state === "running" ? "wf-pill-info" : run?.state === "failed" ? "wf-pill-danger" : "wf-pill-ok"}`}>
              {run?.state ?? "loading…"}
            </span>
          </div>
          <div className="wf-mono wf-dim" style={{ fontSize: 11 }}>
            run {runId}
          </div>
        </div>
        <div style={{ flex: 1 }} />
        {run?.state === "running" ? (
          <button className="wf-btn wf-btn-danger" disabled={cancelling} onClick={cancelRun}>
            ■ {cancelling ? "Cancelling…" : "Cancel run"} <span className="wf-tool-label">workflow_cancel</span>
          </button>
        ) : null}
      </div>

      <div style={{ marginBottom: 4, display: "flex", justifyContent: "space-between", fontSize: 11, color: "rgba(255,255,255,0.5)" }}>
        <span>
          {done} of {total} steps
        </span>
        <span className="wf-mono">{pct}%</span>
      </div>
      <div className="wf-progress">
        <div className="wf-progress-bar" style={{ width: `${pct}%` }} />
      </div>

      <h3 className="wf-section-title" style={{ marginTop: 12 }}>
        Graph — live execution {activeStepId ? <span className="wf-pill wf-pill-info">{activeStepId} active</span> : null}
      </h3>
      <Graph steps={workflow.steps} statuses={statuses} activeStepId={activeStepId} />
      <GraphLegend />

      <div style={{ marginTop: 12 }}>
        <h3 className="wf-section-title">Step statuses</h3>
        {workflow.steps.map((s) => {
          const st = steps[s.id];
          return (
            <div key={s.id} className={`wf-step-row wf-step-${st?.status || "pending"}`}>
              <span style={{ flex: 1, fontWeight: 500 }}>{s.id}</span>
              <span className="wf-dim" style={{ fontSize: 11 }}>
                {st?.status || "pending"}
                {st?.attempts && st.attempts > 1 ? ` · attempt ${st.attempts}` : ""}
                {st?.error ? ` · ${st.error}` : ""}
              </span>
            </div>
          );
        })}
      </div>

      <div style={{ marginTop: 12 }}>
        <h3 className="wf-section-title">Event stream</h3>
        <div className="wf-stream">
          {(run?.events || []).map((ev, i) => (
            <div key={i} className="wf-stream-line">
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
