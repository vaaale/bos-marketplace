// RunsTable.tsx — US19: the detail view's historical runs as a
// datetime-descending TABLE with per-row + select-all selection and a bulk
// "Delete (n)" of the persisted run logs (mockup.html #view-detail,
// "Historical runs"). Selection state is purely ephemeral client state.
//
// Two behaviors are load-bearing:
//   - Inspect is INDEPENDENT of the delete-selection: a row click (or the eye
//     affordance) replays the run via workflow_run_get (FR-017, retained);
//     the checkbox cell stops propagation so selecting never opens a run.
//   - Delete goes through the service's own POST /workflows/<id>/runs/delete
//     (bridge.ts `api.runDelete`, riding the app's existing invoke channel /
//     `services:read` broker) — never a direct VFS delete, which would need
//     the fs:write capability this app deliberately does not hold.

import React, { useEffect, useMemo, useRef, useState } from "react";
import type { RunDeleteResult, RunSummary } from "../lib/types";
import { RunSourceGlyph } from "./RunProvenance";

interface RunsTableProps {
  /** TERMINAL runs only — an in-progress run has no persisted log yet, so it
   *  is not listed here and cannot be deleted (cancel it instead). */
  runs: RunSummary[];
  inspectedRunId: string | null;
  onInspect: (runId: string) => void;
  /** Performs the delete; resolves null when the request itself failed (the
   *  selection is then kept so the user can retry). */
  onDelete: (runIds: string[]) => Promise<RunDeleteResult | null>;
}

const STATE_PILL: Record<string, { label: string; cls: string }> = {
  completed: { label: "completed", cls: "wf-pill-ok" },
  completed_with_warnings: { label: "completed · warnings", cls: "wf-pill-warn" },
  failed: { label: "failed", cls: "wf-pill-danger" },
  cancelled: { label: "cancelled", cls: "wf-pill-neutral" },
};

function RunStatePill({ state }: { state?: string }) {
  const pill = (state && STATE_PILL[state]) || { label: state || "unknown", cls: "wf-pill-neutral" };
  return <span className={`wf-pill ${pill.cls}`}>{pill.label}</span>;
}

function relativeTime(ts: number, now: number): string {
  const diff = Math.max(0, now - ts);
  if (diff < 60_000) return `${Math.max(1, Math.round(diff / 1000))}s ago`;
  if (diff < 3_600_000) return `${Math.round(diff / 60_000)}m ago`;
  if (diff < 86_400_000) return `${Math.round(diff / 3_600_000)}h ago`;
  return `${Math.round(diff / 86_400_000)}d ago`;
}

function absoluteTime(ts: number): string {
  const d = new Date(ts);
  const date = d.toLocaleDateString(undefined, { month: "short", day: "numeric" });
  const time = d.toLocaleTimeString(undefined, { hour: "2-digit", minute: "2-digit", hour12: false });
  return `${date}, ${time}`;
}

/** Derived from the run's existing start/end timestamps — never persisted. */
function duration(run: RunSummary): string {
  if (!run.startedAt || !run.endedAt) return "—";
  const ms = run.endedAt - run.startedAt;
  if (ms < 1000) return "<1s";
  const s = Math.round(ms / 1000);
  if (s < 60) return `${s}s`;
  const m = Math.floor(s / 60);
  if (m < 60) return `${m}m ${String(s % 60).padStart(2, "0")}s`;
  return `${Math.floor(m / 60)}h ${String(m % 60).padStart(2, "0")}m`;
}

/** `run-abc123-xyz` renders as `#abc123-x`, same slice the run chips used. */
function shortRunId(runId: string): string {
  return runId.slice(4, 12);
}

export function RunsTable({ runs, inspectedRunId, onInspect, onDelete }: RunsTableProps) {
  const [selected, setSelected] = useState<Set<string>>(new Set());
  const [deleting, setDeleting] = useState(false);
  const selectAllRef = useRef<HTMLInputElement>(null);
  const now = Date.now();

  const sorted = useMemo(() => [...runs].sort((a, b) => (b.startedAt ?? 0) - (a.startedAt ?? 0)), [runs]);

  // A poll refresh (or a delete) can drop rows — never keep a ghost selected.
  useEffect(() => {
    setSelected((prev) => {
      const ids = new Set(sorted.map((r) => r.runId));
      const next = new Set([...prev].filter((id) => ids.has(id)));
      return next.size === prev.size ? prev : next;
    });
  }, [sorted]);

  const allSelected = sorted.length > 0 && selected.size === sorted.length;
  const someSelected = selected.size > 0 && !allSelected;

  // The native mixed state — only reachable via the DOM property.
  useEffect(() => {
    if (selectAllRef.current) selectAllRef.current.indeterminate = someSelected;
  }, [someSelected]);

  function toggleRow(runId: string) {
    setSelected((prev) => {
      const next = new Set(prev);
      if (next.has(runId)) next.delete(runId);
      else next.add(runId);
      return next;
    });
  }

  function toggleAll() {
    setSelected(allSelected ? new Set() : new Set(sorted.map((r) => r.runId)));
  }

  // Immediate — no confirm modal; the blast radius is stated on the button
  // and restated by the post-delete flash the parent shows.
  async function handleDelete() {
    if (!selected.size || deleting) return;
    setDeleting(true);
    try {
      const result = await onDelete([...selected]);
      if (result) setSelected(new Set());
    } finally {
      setDeleting(false);
    }
  }

  return (
    <div className="wf-runs">
      <div className="wf-row" style={{ marginBottom: 6 }}>
        <h3 className="wf-section-title" style={{ margin: 0 }}>
          Historical runs <span className="wf-tool-label">workflow_run_list</span>
        </h3>
        <div style={{ flex: 1 }} />
        <span className="wf-runs-delete-note">run logs only — workflow definition untouched</span>
        <button
          className="wf-btn wf-btn-sm wf-btn-danger wf-runs-delete-btn"
          disabled={selected.size === 0 || deleting}
          onClick={handleDelete}
          title="run logs only — workflow definition untouched"
        >
          🗑 Delete ({selected.size}) <span className="wf-tool-label">workflow_run_delete</span>
        </button>
      </div>

      <table className="wf-runs-table">
        <thead>
          <tr>
            <th className="wf-runs-check">
              <input
                ref={selectAllRef}
                type="checkbox"
                className="wf-runs-select-all"
                checked={allSelected}
                onChange={toggleAll}
                disabled={sorted.length === 0}
                title="Select all runs"
              />
            </th>
            <th>Datetime</th>
            <th>Run</th>
            <th>Final state</th>
            <th>Duration</th>
            <th className="wf-runs-inspect-col" aria-label="Inspect" />
          </tr>
        </thead>
        <tbody>
          {sorted.length === 0 ? (
            <tr className="wf-runs-empty-row">
              <td colSpan={6} className="wf-dim">
                No runs yet
              </td>
            </tr>
          ) : (
            sorted.map((r) => (
              <tr
                key={r.runId}
                className={`wf-runs-row ${inspectedRunId === r.runId ? "wf-runs-row-inspected" : ""}`}
                onClick={() => onInspect(r.runId)}
                data-run-id={r.runId}
              >
                {/* stopPropagation: selecting a run must never open it. */}
                <td className="wf-runs-check" onClick={(e) => e.stopPropagation()}>
                  <input type="checkbox" className="wf-runs-row-checkbox" checked={selected.has(r.runId)} onChange={() => toggleRow(r.runId)} />
                </td>
                <td className="wf-runs-when">
                  {r.startedAt ? (
                    <>
                      <span>{relativeTime(r.startedAt, now)}</span>
                      <span className="wf-mono wf-dim"> · {absoluteTime(r.startedAt)}</span>
                    </>
                  ) : (
                    <span className="wf-dim">—</span>
                  )}
                </td>
                <td className="wf-mono wf-runs-id" title={r.runId}>
                  <RunSourceGlyph startSource={r.startSource} />#{shortRunId(r.runId)}
                </td>
                <td>
                  <RunStatePill state={r.finalState || r.state} />
                </td>
                <td className="wf-mono wf-dim">{duration(r)}</td>
                <td className="wf-runs-inspect-col">
                  <button
                    className="wf-runs-inspect"
                    title="Inspect this run — replay its graph and node trajectories"
                    onClick={(e) => {
                      e.stopPropagation();
                      onInspect(r.runId);
                    }}
                  >
                    👁 Inspect
                  </button>
                </td>
              </tr>
            ))
          )}
        </tbody>
      </table>
    </div>
  );
}
