// JobsTab.tsx — the ingest-run list (FR-041 / US8 / SC-011), exactly the
// mockup's layout: status dots (queued / running / completed / failed), the
// bundle, the source, the time and a live elapsed/duration, with each row
// expanding into its detail.
//
// The job records come from the service's GET /jobs, polled by App.tsx, so a
// run genuinely moves queued → running → completed|failed on screen as the
// okf-ingest sub-agent reports its lifecycle back over the loopback bridge.
// Nothing here simulates progress: a `running` row with no reported progress
// string shows a static running state rather than a fake bar.

import React from "react";
import { Icon } from "../lib/icons";
import type { Job, JobStatus } from "../lib/types";
import JobDetail from "./JobDetail";

const DOT: Record<JobStatus, string> = {
  queued: "queued",
  running: "running",
  completed: "green",
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

export default function JobsTab({ jobs, activeJobs }: { jobs: Job[]; activeJobs: number }) {
  const [open, setOpen] = React.useState<string | null>(null);

  if (!jobs.length) {
    return (
      <div className="wrap">
        <div className="empty" data-testid="jobs-empty">
          <h3>No ingest runs</h3>
          <p>
            Ask the assistant to ingest a document (or call <b>okf_ingest</b>) and the run appears here with a live
            status — queued → running → completed / failed.
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
          <b>Ingest runs (jobs)</b> — each is one delegated invocation of the <code>okf-ingest</code> agent against a
          bundle. Statuses: <span className="dot queued" style={{ margin: "0 4px" }} />
          queued <span className="dot running" style={{ margin: "0 4px" }} />
          running <span className="dot green" style={{ margin: "0 4px" }} />
          completed <span className="dot red" />
          failed. The list reflects a run's status as it changes. Click a run to expand its detail.
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
