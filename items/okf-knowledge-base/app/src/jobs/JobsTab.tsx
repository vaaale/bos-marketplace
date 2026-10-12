// JobsTab.tsx — the ingest-run list (FR-041 / US8 / SC-011), exactly the
// mockup's layout: status dots (queued / running / completed / cancelled /
// failed), the bundle, the source, the time and a live elapsed/duration,
// with each row expanding into its detail — plus the per-run CONTROLS:
// Cancel while it is queued or running (FR-050), Delete once it has finished
// (FR-051). Both POST/DELETE to the service and then re-fetch, so what the
// row shows next came from the service, never from optimistic local state.
//
// The job records come from the service's GET /jobs, polled by App.tsx, so a
// run genuinely moves queued → running → completed|failed on screen. The
// service launched the run and watched its stream, so the terminal state is
// derived from the run's own completion signal — not from the agent choosing
// to report. Nothing here simulates progress: a `running` row with no
// reported progress string shows a static running state, not a fake bar.

import React from "react";
import { Icon } from "../lib/icons";
import { cancelJob, deleteJob } from "../lib/serviceClient";
import type { Job, JobStatus } from "../lib/types";
import JobDetail from "./JobDetail";

const DOT: Record<JobStatus, string> = {
  queued: "queued",
  running: "running",
  completed: "green",
  // muted warm amber (--stopped, #d0894e): stopped, not errored. Deliberately
  // NOT the red a failure gets — a cancel is something the user asked for.
  cancelled: "cancelled",
  failed: "red",
};

const TERMINAL: JobStatus[] = ["completed", "cancelled", "failed"];

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

/**
 * The per-run controls. Cancel on a live run, Delete on a finished one —
 * never both, because they are the two halves of a run's lifetime.
 *
 * The service is the authority: each click awaits its route and then asks
 * `onChanged()` to re-fetch. A row that painted itself cancelled on click
 * would be guessing, and would look right even when the call failed.
 */
function JobActions({ job, onChanged }: { job: Job; onChanged: () => void | Promise<void> }) {
  const [busy, setBusy] = React.useState(false);
  const [failed, setFailed] = React.useState<string | null>(null);

  const run = async (action: () => Promise<unknown>) => {
    setBusy(true);
    setFailed(null);
    try {
      await action();
      await onChanged();
    } catch (e) {
      setFailed((e as Error).message);
    } finally {
      setBusy(false);
    }
  };

  const live = job.status === "queued" || job.status === "running";
  const terminal = TERMINAL.includes(job.status);
  if (!live && !terminal) return null;

  return (
    <span className="job-acts" onClick={(e) => e.stopPropagation()}>
      {failed ? (
        <span className="job-act-err" data-testid={`job-action-error-${job.id}`} title={failed}>
          {failed}
        </span>
      ) : null}
      {live ? (
        <button
          className="job-act cancel"
          disabled={busy}
          title={`Cancel this run — POST /jobs/${job.id}/cancel`}
          data-testid={`job-cancel-${job.id}`}
          onClick={() => void run(() => cancelJob(job.id))}
        >
          <Icon name="x" size={13} /> Cancel
        </button>
      ) : null}
      {terminal ? (
        <button
          className="job-act delete"
          disabled={busy}
          title={`Delete this run — DELETE /jobs/${job.id}`}
          data-testid={`job-delete-${job.id}`}
          onClick={() => void run(() => deleteJob(job.id))}
        >
          <Icon name="trash" size={13} /> Delete
        </button>
      ) : null}
    </span>
  );
}

export default function JobsTab({
  jobs,
  activeJobs,
  onJobsChanged,
}: {
  jobs: Job[];
  activeJobs: number;
  onJobsChanged?: () => void | Promise<void>;
}) {
  const [open, setOpen] = React.useState<string | null>(null);
  const reload = React.useCallback(async () => {
    if (onJobsChanged) await onJobsChanged();
  }, [onJobsChanged]);

  if (!jobs.length) {
    return (
      <div className="wrap">
        <div className="empty" data-testid="jobs-empty">
          <h3>No ingest runs</h3>
          <p>
            Start one from a bundle&apos;s <b>Ingest</b> button in Overview, or ask the assistant to call{" "}
            <b>okf_ingest</b>. Either way the run appears here with a live status — queued → running → completed /
            cancelled / failed.
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
          failed. <b>cancelled</b> is an intentional stop, not a failure — a cancelled run keeps everything it had
          already written. The list reflects a run's status as it changes. Click a run to expand its detail; Cancel
          stops a live run, Delete clears a finished one.
        </span>
      </div>

      <div className="jobs-list" data-testid="jobs-list">
        {jobs.map((j) => {
          const isOpen = open === j.id;
          return (
            <div key={j.id} className={`job${isOpen ? " open" : ""}`} data-testid={`job-${j.id}`}>
              <div
                className="job-row"
                onClick={() => setOpen(isOpen ? null : j.id)}
                data-testid={`job-row-${j.id}`}
              >
                <Icon name="caret" size={14} className="jobcaret" />
                <span className={`dot ${DOT[j.status]}`} style={{ width: 9, height: 9, marginRight: 0 }} />
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
                <JobActions job={j} onChanged={reload} />
              </div>
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
