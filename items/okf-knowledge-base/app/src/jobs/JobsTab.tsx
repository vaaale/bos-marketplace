// JobsTab.tsx — the ingest-run list (FR-041 / US8 / SC-011), exactly the
// mockup's layout: status dots (queued / running / completed / cancelled /
// failed), the bundle, the source, the time, a live elapsed/duration, and the
// per-row Cancel / Delete controls, with each row expanding into its detail.
//
// The job records come from the service's GET /jobs, polled by App.tsx, so a
// run genuinely moves queued → running → completed | cancelled | failed on
// screen. The service launched the run and watched its stream, so the terminal
// state is derived from the run's own completion signal — not from the agent
// choosing to report. Nothing here simulates progress: a `running` row with no
// reported progress string shows a static running state, not a fake bar.
//
// ── The controls, and why they are state-dependent ───────────────────────
//
//   running          → Cancel        (stop the run; it lands `cancelled`)
//   queued           → Cancel + Delete
//   completed |      → Delete        (remove the record; the knowledge the
//   cancelled |                       run produced is NOT touched)
//   failed
//
// A running run has no Delete, because deleting the record of a live run
// would leave it writing into a bundle with nothing watching it — the service
// refuses that with a 409, and offering a button for it would just be an
// error the user has to discover. A finished run has no Cancel, because
// there is nothing left to stop; the service answers that no-op honestly
// ({cancelled:false, reason:"already terminal"}) for the case where a run
// finishes between a poll and a click.
//
// Both controls call the SAME service operations the okf_cancel_job /
// okf_delete_job tools call (ADR-003), so a run stopped from here and a run
// stopped by an agent are the same stop.

import React from "react";
import { Icon } from "../lib/icons";
import { cancelJob, deleteJob } from "../lib/serviceClient";
import type { Job, JobStatus } from "../lib/types";
import JobDetail from "./JobDetail";

const DOT: Record<JobStatus, string> = {
  queued: "queued",
  running: "running",
  completed: "green",
  cancelled: "cancelled",
  failed: "red",
};

function shortSrc(s: string): string {
  if (!s) return "—";
  return s.length <= 44 ? s : `${s.slice(0, 20)}…${s.slice(-20)}`;
}

function clock(ms: number): string {
  const total = Math.max(0, Math.floor(ms / 1000));
  return `${String(Math.floor(total / 60)).padStart(2, "0")}:${String(total % 60).padStart(2, "0")}`;
}

/** Live elapsed for a running job; the recorded duration once it is done. */
function Elapsed({ job }: { job: Job }) {
  const [, tick] = React.useReducer((n: number) => n + 1, 0);
  const running = job.status === "running";
  React.useEffect(() => {
    if (!running) return;
    const t = setInterval(tick, 1000);
    return () => clearInterval(t);
  }, [running]);

  if (running && job.startedAt) {
    return (
      <span className="run-elapsed" data-testid={`job-elapsed-${job.id}`}>
        {clock(Date.now() - Date.parse(job.startedAt))}
      </span>
    );
  }
  if (job.durationMs !== null) return <>{clock(job.durationMs)}</>;
  return <>—</>;
}

export default function JobsTab({
  jobs,
  activeJobs,
  onJobsChanged,
}: {
  jobs: Job[];
  activeJobs: number;
  /** Re-poll GET /jobs now, rather than waiting out the poll interval, so a
   *  cancel or a delete shows up the moment the service confirms it. */
  onJobsChanged?: () => void;
}) {
  const [open, setOpen] = React.useState<string | null>(null);
  const [busy, setBusy] = React.useState<string | null>(null);
  const [actionError, setActionError] = React.useState<{ id: string; message: string } | null>(null);

  const run = React.useCallback(
    async (id: string, what: "cancel" | "delete") => {
      setBusy(id);
      setActionError(null);
      try {
        if (what === "cancel") await cancelJob(id);
        else await deleteJob(id);
        if (what === "delete" && open === id) setOpen(null);
        onJobsChanged?.();
      } catch (e) {
        // The service's own reason, verbatim — a 409 on a running run says
        // "cancel it first", and paraphrasing that into "something went
        // wrong" would throw away the only useful part.
        setActionError({ id, message: (e as Error).message });
      } finally {
        setBusy(null);
      }
    },
    [onJobsChanged, open],
  );

  if (!jobs.length) {
    return (
      <div className="wrap">
        <div className="empty" data-testid="jobs-empty">
          <h3>No ingest runs</h3>
          <p>
            Start one from a bundle&apos;s <b>Ingest</b> button in Overview, or ask the assistant to call{" "}
            <b>okf_ingest</b>. Either way the run appears here with a live status — queued → running → completed ·
            cancelled · failed.
          </p>
        </div>
      </div>
    );
  }

  return (
    <div className="wrap">
      <div className="toolbar">
        <div className="spacer" />
        <span className="count" data-testid="jobs-count">
          {jobs.length} run{jobs.length === 1 ? "" : "s"} · {activeJobs} active
        </span>
      </div>

      <div className="note">
        <Icon name="info" size={14} />
        <span>
          <b>Ingest runs (jobs)</b> — each is one run of the <code>okf-ingest</code> agent against a bundle, launched
          by the service itself. Statuses: <span className="dot queued" style={{ margin: "0 4px" }} />
          queued <span className="dot running" style={{ margin: "0 4px" }} />
          running <span className="dot green" style={{ margin: "0 4px" }} />
          completed <span className="dot cancelled" style={{ margin: "0 4px" }} />
          cancelled <span className="dot red" />
          failed. <b>cancelled</b> is an intentional stop, not a failure — whatever the run had already written stays
          in the bundle. <b>Cancel</b> stops a run; <b>Delete</b> removes a finished run&apos;s record and nothing
          else. The list reflects a run&apos;s status as it changes. Click a run to expand its detail.
        </span>
      </div>

      <div className="jobs-list" data-testid="jobs-list">
        {jobs.map((j) => {
          const isOpen = open === j.id;
          const canCancel = j.status === "running" || j.status === "queued";
          const canDelete = j.status !== "running";
          return (
            <div key={j.id} className={`job${isOpen ? " open" : ""}`} data-testid={`job-${j.id}`}>
              <div
                className="job-row"
                onClick={() => setOpen(isOpen ? null : j.id)}
                data-testid={`job-row-${j.id}`}
              >
                <Icon name="caret" size={14} className="jobcaret" />
                <span
                  className={`dot ${DOT[j.status]}`}
                  data-testid={`job-dot-${j.id}`}
                  style={{ width: 9, height: 9, marginRight: 0 }}
                />
                <span className={`job-status ${j.status}`} data-testid={`job-status-${j.id}`}>
                  {j.status}
                </span>
                <span className="job-bundle">
                  <span className="glyph" style={{ fontSize: 14 }}>
                    📚
                  </span>
                  {j.bundleId}
                </span>
                <span className="job-src">
                  <Icon name="export" size={12} />
                  <span className="txt" title={j.source}>
                    {shortSrc(j.source)}
                  </span>
                </span>
                <span className="job-time">{(j.startedAt || j.queuedAt || "").replace("T", " ").slice(0, 16) || "—"}</span>
                <span className="job-dur">
                  <Elapsed job={j} />
                </span>
                {canCancel || canDelete ? (
                  <span className="job-acts" data-testid={`job-acts-${j.id}`}>
                    {canCancel ? (
                      <button
                        className="job-act cancel"
                        title={`Cancel this run — POST /jobs/${j.id}/cancel`}
                        disabled={busy === j.id}
                        data-testid={`job-cancel-${j.id}`}
                        onClick={(e) => {
                          e.stopPropagation();
                          void run(j.id, "cancel");
                        }}
                      >
                        <Icon name="x" size={13} /> Cancel
                      </button>
                    ) : null}
                    {canDelete ? (
                      <button
                        className="job-act delete"
                        title={`Delete this run — DELETE /jobs/${j.id}`}
                        disabled={busy === j.id}
                        data-testid={`job-delete-${j.id}`}
                        onClick={(e) => {
                          e.stopPropagation();
                          void run(j.id, "delete");
                        }}
                      >
                        <Icon name="trash" size={13} /> Delete
                      </button>
                    ) : null}
                  </span>
                ) : null}
              </div>
              {actionError && actionError.id === j.id ? (
                <div className="job-act-error" data-testid={`job-act-error-${j.id}`}>
                  {actionError.message}
                </div>
              ) : null}
              {isOpen ? (
                <div className="job-detail" data-testid={`job-detail-${j.id}`}>
                  <JobDetail job={j} />
                </div>
              ) : null}
            </div>
          );
        })}
      </div>
    </div>
  );
}
