// TrajectoryPanel.tsx — the per-node AGENT DEBUG surface (US10 / FR-025-028).
//
// Docked to the right of the graph in both the run view (live) and the
// historical replay, horizontally resizable via the divider exported below.
// Its content is a node-scoped projection of the run log — see
// lib/trajectory.ts — so live and historical modes render through exactly the
// same code path; only where the RunDetail came from differs.
//
// The section order, labels, and status vocabulary follow spec/mockup.html
// (the binding UI contract): identity header → "currently" line → retry line
// → executed prompt → reasoning → tool calls (in/out) → sub-agents · fan-out
// → agent response (or "generating…") → lifecycle events → output / artifact.

import React, { useCallback, useEffect, useRef, useState } from "react";
import type { AgentToolCall, StepLiveStatus, SubAgentState } from "../lib/types";
import type { LifecycleKind, LifecycleRow, NodeTrajectory } from "../lib/trajectory";
import { renderValue } from "../lib/trajectory";

const STATUS_LABEL: Record<string, string> = {
  running: "running",
  completed: "completed",
  failed: "failed",
  cancelled: "cancelled",
  skipped: "skipped · branch not selected",
  neutral: "neutral · never ran",
  pending: "pending",
};

function statusChipClass(status: StepLiveStatus | string): string {
  switch (status) {
    case "running":
      return "wf-chip-running";
    case "completed":
      return "wf-chip-completed";
    case "failed":
      return "wf-chip-failed";
    case "cancelled":
    case "skipped":
      return "wf-chip-cancelled";
    default:
      return "wf-chip-neutral";
  }
}

export function StatusChip({ status }: { status: StepLiveStatus | string }) {
  return <span className={`wf-chip ${statusChipClass(status)}`}>{STATUS_LABEL[status] || status}</span>;
}

const EVENT_GLYPH: Record<LifecycleKind, { glyph: string; cls: string }> = {
  start: { glyph: "▶", cls: "wf-ev-start" },
  retry: { glyph: "↻", cls: "wf-ev-retry" },
  running: { glyph: "◐", cls: "wf-ev-running" },
  complete: { glyph: "✓", cls: "wf-ev-complete" },
  fail: { glyph: "✕", cls: "wf-ev-fail" },
  cancel: { glyph: "⊘", cls: "wf-ev-cancel" },
  skip: { glyph: "−", cls: "wf-ev-skip" },
};

function SectionHead({ glyph, label, count }: { glyph: string; label: string; count?: number }) {
  return (
    <div className="wf-ps-head">
      <span className="wf-ps-glyph">{glyph}</span>
      {label}
      {count !== undefined ? <span className="wf-ps-count">{count}</span> : null}
    </div>
  );
}

function ToolCallRow({ call }: { call: AgentToolCall }) {
  const inflight = call.inflight === true;
  const ok = call.ok !== false;
  const tag = inflight ? "running" : ok ? "ok" : "error";
  const tone = inflight ? "wf-tc-running" : ok ? "wf-tc-ok" : "wf-tc-error";
  return (
    <div className="wf-toolcall">
      <div className="wf-toolcall-head">
        <span className={`wf-toolcall-badge ${tone}`}>{inflight ? <span className="wf-spin">◐</span> : ok ? "✓" : "✕"}</span>
        <span className="wf-mono wf-toolcall-name">{call.name}</span>
        <span className={`wf-mono wf-toolcall-tag ${tone}`}>{tag}</span>
      </div>
      <div className="wf-toolcall-io">
        <span className="wf-mono wf-io-label">in</span>
        <pre className="wf-mono wf-io-value">{renderValue(call.args)}</pre>
      </div>
      <div className="wf-toolcall-io">
        <span className="wf-mono wf-io-label">out</span>
        <pre className={`wf-mono wf-io-value ${ok ? "" : "wf-io-error"}`}>{inflight && call.result === undefined ? "… (running)" : renderValue(call.result)}</pre>
      </div>
    </div>
  );
}

function SubAgentRow({ subAgent }: { subAgent: SubAgentState }) {
  const glyph = subAgent.status === "running" ? "◐" : subAgent.status === "completed" ? "✓" : subAgent.status === "failed" ? "✕" : "○";
  const tone =
    subAgent.status === "running" ? "wf-tc-running" : subAgent.status === "completed" ? "wf-tc-ok" : subAgent.status === "failed" ? "wf-tc-error" : "wf-tc-pending";
  return (
    <div className="wf-subagent">
      <span className={`wf-subagent-glyph ${tone}`}>{subAgent.status === "running" ? <span className="wf-spin">{glyph}</span> : glyph}</span>
      <span className="wf-mono wf-subagent-label">{subAgent.label}</span>
      <span className={`wf-subagent-action ${tone}`}>{subAgent.action || subAgent.status}</span>
    </div>
  );
}

function LifecycleEventRow({ row }: { row: LifecycleRow }) {
  const { glyph, cls } = EVENT_GLYPH[row.kind];
  return (
    <div className="wf-traj-row">
      <span className={`wf-traj-badge ${cls}`}>{row.kind === "running" && row.live ? <span className="wf-spin">{glyph}</span> : glyph}</span>
      <div className="wf-traj-body">
        <div className="wf-traj-line">
          <span className="wf-mono wf-traj-time">{row.time}</span>
          <span className="wf-mono wf-traj-label">{row.label}</span>
        </div>
        {row.meta ? <div className={`wf-traj-meta ${row.kind === "fail" ? "wf-traj-meta-error" : ""}`}>{row.meta}</div> : null}
      </div>
    </div>
  );
}

export interface TrajectoryPanelProps {
  trajectory: NodeTrajectory;
  /** e.g. "run abc12345" — shown as the badge in the panel header. */
  runBadge: string;
  /** live = sky badge (tailing the running log), historical = violet (replay). */
  mode: "live" | "historical";
  width: number;
  onClose: () => void;
}

export function TrajectoryPanel({ trajectory, runBadge, mode, width, onClose }: TrajectoryPanelProps) {
  const trace = trajectory.agentTrace;
  const running = trajectory.status === "running";

  return (
    <div className="wf-traj-panel" style={{ width }}>
      <div className="wf-traj-panel-head">
        <span className="wf-traj-panel-icon">⌗</span>
        <span className="wf-traj-panel-title">Node trajectory</span>
        <span className={`wf-mono wf-traj-panel-badge ${mode === "live" ? "wf-badge-live" : "wf-badge-historical"}`}>{runBadge}</span>
        <span className="wf-mono wf-traj-panel-tag">agent debug</span>
        <div style={{ flex: 1 }} />
        <button className="wf-traj-panel-close" onClick={onClose} title="Close">
          ✕
        </button>
      </div>

      <div className="wf-traj-panel-body">
        <div className="wf-traj-identity">
          <div className="wf-traj-identity-icon">
            {trajectory.outputType === "tool" ? "⚒" : trajectory.outputType === "research" ? "⑂" : trajectory.outputType === "event" ? "⚡" : "⌬"}
          </div>
          <div style={{ minWidth: 0, flex: 1 }}>
            <div className="wf-traj-identity-title">
              <span className="wf-traj-identity-name">{trajectory.id}</span>
              <StatusChip status={trajectory.status} />
            </div>
            <div className="wf-mono wf-traj-identity-meta">
              <span>
                {trajectory.outputType === "tool" ? "⚒" : trajectory.outputType === "event" ? "⚡" : "⌬"} {trajectory.agentSource}
              </span>
              <span>⬒ {trajectory.outputLabel}</span>
            </div>
          </div>
        </div>

        {trajectory.currentAction ? (
          <div className="wf-traj-currently">
            <span className="wf-traj-currently-glyph">◈</span>
            <span className="wf-mono wf-traj-currently-label">currently</span>
            <span className="wf-traj-currently-text">{trajectory.currentAction}</span>
          </div>
        ) : null}

        {trajectory.retrying ? (
          <div className="wf-traj-retrying">
            ↻ Retrying — attempt {trajectory.attempt}
            {trajectory.maxAttempts ? `/${trajectory.maxAttempts}` : ""}
          </div>
        ) : null}

        {!trajectory.hasContent ? (
          <div className="wf-traj-empty">
            No events yet
            {trajectory.status === "neutral" ? " — this node never ran in this run" : ""}
            {trajectory.status === "skipped" ? " — this branch was not selected" : ""}.
          </div>
        ) : (
          <>
            {trace?.prompt ? (
              <div className="wf-panel-section">
                <SectionHead glyph="≡" label="Executed prompt" />
                <div className="wf-traj-prompt">{trace.prompt}</div>
              </div>
            ) : null}

            {trace?.thinking ? (
              <div className="wf-panel-section">
                <SectionHead glyph="✻" label="Reasoning" />
                <div className="wf-traj-reasoning">{trace.thinking}</div>
              </div>
            ) : null}

            {trace?.toolCalls?.length ? (
              <div className="wf-panel-section">
                <SectionHead glyph="⚒" label="Tool calls" count={trace.toolCalls.length} />
                <div className="wf-stack">
                  {trace.toolCalls.map((call, i) => (
                    <ToolCallRow key={`${call.name}-${i}`} call={call} />
                  ))}
                </div>
              </div>
            ) : null}

            {trajectory.subAgents.length ? (
              <div className="wf-panel-section">
                <SectionHead glyph="⑂" label="Sub-agents · fan-out" count={trajectory.subAgents.length} />
                <div className="wf-stack">
                  {trajectory.subAgents.map((sa) => (
                    <SubAgentRow key={sa.id || sa.label} subAgent={sa} />
                  ))}
                </div>
              </div>
            ) : null}

            {trace?.response ? (
              <div className="wf-panel-section">
                <SectionHead glyph="❝" label="Agent response" />
                <div className="wf-traj-response">{trace.response}</div>
              </div>
            ) : running ? (
              <div className="wf-panel-section">
                <SectionHead glyph="◐" label="Agent response" />
                <div className="wf-traj-generating">
                  <span className="wf-pulse-dot" style={{ background: "#7dd3fc" }} /> generating…
                </div>
              </div>
            ) : null}

            {trajectory.selected?.length ? (
              <div className="wf-panel-section">
                <SectionHead glyph="⑂" label="Selected branch" />
                <div className="wf-mono wf-traj-selected">{trajectory.selected.join(", ")}</div>
              </div>
            ) : null}

            {trajectory.events.length ? (
              <div className="wf-panel-section">
                <SectionHead glyph="⋮" label="Lifecycle events" count={trajectory.events.length} />
                <div className="wf-traj-events">
                  {trajectory.events.map((row, i) => (
                    <LifecycleEventRow key={`${row.label}-${row.ts}-${i}`} row={row} />
                  ))}
                </div>
              </div>
            ) : null}

            {trajectory.output !== undefined ? (
              <div className="wf-panel-section">
                <SectionHead glyph="⬒" label="Output / artifact" />
                <pre className="wf-mono wf-traj-output">{renderValue(trajectory.output)}</pre>
              </div>
            ) : null}

            {trajectory.error ? (
              <div className="wf-panel-section">
                <SectionHead glyph="✕" label="Error" />
                <div className="wf-traj-error">{trajectory.error}</div>
              </div>
            ) : null}
          </>
        )}
      </div>
    </div>
  );
}

export const PANEL_MIN_WIDTH = 260;
export const PANEL_MAX_WIDTH = 680;
export const PANEL_DEFAULT_WIDTH = 380;

/** Pointer-drag width state for the panel, clamped to 260–680px (FR-025). */
export function usePanelWidth(initial = PANEL_DEFAULT_WIDTH) {
  const [width, setWidth] = useState(initial);
  const draggingRef = useRef(false);

  const onPointerDown = useCallback((e: React.PointerEvent<HTMLDivElement>) => {
    draggingRef.current = true;
    e.currentTarget.setPointerCapture(e.pointerId);
    document.body.style.userSelect = "none";
    document.body.style.cursor = "col-resize";
  }, []);

  const onPointerMove = useCallback((e: React.PointerEvent<HTMLDivElement>) => {
    if (!draggingRef.current) return;
    // Width is measured from the pointer to the panel's RIGHT edge, so the
    // graph reflows to fill whatever is left (mockup's setupResize).
    const container = e.currentTarget.parentElement;
    if (!container) return;
    const right = container.getBoundingClientRect().right;
    const next = Math.max(PANEL_MIN_WIDTH, Math.min(PANEL_MAX_WIDTH, right - e.clientX));
    setWidth(next);
  }, []);

  const stop = useCallback((e: React.PointerEvent<HTMLDivElement>) => {
    if (!draggingRef.current) return;
    draggingRef.current = false;
    try {
      e.currentTarget.releasePointerCapture(e.pointerId);
    } catch {
      // the pointer may already be released
    }
    document.body.style.userSelect = "";
    document.body.style.cursor = "";
  }, []);

  useEffect(
    () => () => {
      document.body.style.userSelect = "";
      document.body.style.cursor = "";
    },
    [],
  );

  return { width, setWidth, dividerProps: { onPointerDown, onPointerMove, onPointerUp: stop, onPointerCancel: stop } };
}

/** The draggable divider between the graph and the panel. */
export function PanelDivider(props: React.ComponentProps<"div">) {
  return <div className="wf-resize-handle" title="Drag to resize the trajectory panel" {...props} />;
}
