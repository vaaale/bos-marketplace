// JobDetail.tsx — the expanded run: summary cells (chapters / concepts /
// assets / refs skipped / refs failed), the written-chapter chips, the error
// card, the cancelled card and the live progress bar — one state per
// lifecycle status, exactly as the mockup specifies.
//
// `cancelled` gets its OWN card rather than reusing the red error one: it is
// an intentional stop and carries no error, so painting it as a failure would
// misreport what happened (FR-050).
//
// Below all of that sits the RUN TRAJECTORY (FR-058, ADR-013) — what the agent
// actually did, as a collapsible tool-call timeline. It is fetched here rather
// than read off the polled job list: `GET /jobs` reports only an event COUNT,
// because dragging every run's events through a 3-second poll to render a
// section nobody has expanded would be tens of kilobytes per tick. One
// expanded run, one `GET /jobs/<id>` — and while that run is still live, that
// detail read repeats on the same cadence, so the timeline grows on screen as
// the events arrive.

import React from "react";
import { Icon } from "../lib/icons";
import { Markdown } from "../lib/markdown";
import { fetchJob } from "../lib/serviceClient";
import type { Job, TrajectoryEvent } from "../lib/types";
import Trajectory from "./Trajectory";

/** Matches App.tsx's job poll — a live run's trajectory grows at the same rate
 *  the rest of its row does. */
const DETAIL_POLL_MS = 3000;

function useTrajectory(job: Job): { events: TrajectoryEvent[] | null; failed: boolean } {
  const [events, setEvents] = React.useState<TrajectoryEvent[] | null>(null);
  const [failed, setFailed] = React.useState(false);
  const live = job.status === "queued" || job.status === "running";

  React.useEffect(() => {
    let alive = true;
    const load = async () => {
      try {
        const detail = await fetchJob(job.id);
        if (!alive) return;
        setEvents(Array.isArray(detail.trajectory) ? detail.trajectory : []);
        setFailed(false);
      } catch {
        // A failed detail read is NOT "the run produced no events" — saying so
        // would blame the run for the reader's problem. Keep whatever is
        // already on screen and say which of the two happened; a live run
        // retries on the next tick anyway.
        if (alive) setFailed(true);
      }
    };
    void load();
    if (!live) return () => { alive = false; };
    const timer = setInterval(() => void load(), DETAIL_POLL_MS);
    return () => {
      alive = false;
      clearInterval(timer);
    };
  }, [job.id, live]);

  return { events, failed };
}

function SummaryCell({ icon, value, label }: { icon: string; value: number; label: string }) {
  return (
    <div className="js-cell">
      <span className="js-ic">
        <Icon name={icon} size={15} />
      </span>
      <span className="js-num">{value}</span>
      <span className="js-lbl">{label}</span>
    </div>
  );
}

export default function JobDetail({ job }: { job: Job }) {
  const { events: trajectory, failed: trajectoryFailed } = useTrajectory(job);
  return (
    <>
      <div className="jd-top">
        Source: <code>{job.source}</code> · into <b>{job.bundleId}</b> · run <code>{job.id}</code>
      </div>

      {job.status === "completed" && job.summary ? (
        <>
          <div className="job-summary" data-testid={`job-summary-${job.id}`}>
            <SummaryCell icon="list" value={job.summary.chapters} label="chapters written" />
            <SummaryCell icon="layers" value={job.summary.concepts} label="concepts assigned" />
            <SummaryCell icon="image" value={job.summary.assets} label="assets interpreted" />
            <SummaryCell icon="import" value={job.summary.refsSkipped} label="references skipped" />
            <SummaryCell icon="alert" value={job.summary.refsFailed} label="references failed" />
          </div>
          {job.summary.text ? (
            <>
              <div className="jd-sub">Agent report</div>
              <div className="md-body job-report" data-testid={`job-report-${job.id}`}>
                <Markdown source={job.summary.text} />
              </div>
            </>
          ) : null}
          {job.summary.written?.length ? (
            <>
              <div className="jd-sub">Chapters written</div>
              <div className="job-written" data-testid={`job-written-${job.id}`}>
                {job.summary.written.map((w) => (
                  <span className="wj" key={w}>
                    <Icon name="check" size={12} /> {w}
                  </span>
                ))}
              </div>
            </>
          ) : null}
        </>
      ) : null}

      {job.status === "completed" && !job.summary ? (
        <div className="job-queued">
          <Icon name="info" size={15} />
          <div>
            This run completed but the agent's final message was empty, so there are no numbers to show. The run itself
            did finish — the bundle's Overview tab shows what landed.
          </div>
        </div>
      ) : null}

      {job.status === "failed" ? (
        <>
          <div className="job-error" data-testid={`job-error-${job.id}`}>
            <Icon name="alert" size={15} />
            <div>
              <b>Run failed.</b> {job.error || "No reason was reported."}
            </div>
          </div>
          <div className="jd-foot">
            <Icon name="import" size={13} /> Retry from the bundle's <b>Ingest</b> button, or with{" "}
            <code>okf_ingest</code>. Chapter files and the concept index were not left half-written — each write is
            atomic and the derived index rebuilds from content, so a partial run leaves a smaller bundle, not a broken
            one.
          </div>
        </>
      ) : null}

      {job.status === "cancelled" ? (
        <div className="job-cancelled" data-testid={`job-cancelled-${job.id}`}>
          <Icon name="x" size={15} />
          <div>
            <b>Cancelled.</b> Stopped on request — this is not a failure, and there is no error to report. Everything
            the run had already written is still in the bundle: writes are atomic and the derived index rebuilds from
            content, so a cancelled run leaves a smaller bundle, never a half-updated one. Re-run it any time from the
            bundle's <b>Ingest</b> button, or with <code>okf_ingest</code>.
          </div>
        </div>
      ) : null}

      {job.status === "running" ? (
        <div className="job-progress" data-testid={`job-progress-${job.id}`}>
          {job.progress ? (
            <>
              <div className="prog-bar">
                <span className="prog-fill" />
              </div>
              <div className="prog-txt">{job.progress}</div>
            </>
          ) : (
            <div className="prog-txt">Running — the ingest agent has not reported a progress step yet.</div>
          )}
          <div className="prog-sub">
            Live · updates as the agent decomposes and writes chapters. The run reflects its status as it changes.
          </div>
        </div>
      ) : null}

      {job.status === "queued" ? (
        <div className="job-queued" data-testid={`job-queued-${job.id}`}>
          <Icon name="clock" size={15} />
          <div>
            Queued. The service has launched the <b>okf-ingest</b> agent and is waiting for its first step. No bundle
            content has been modified yet — a run only writes once decomposition begins.
          </div>
        </div>
      ) : null}

      <Trajectory job={job} events={trajectory} failed={trajectoryFailed} />
    </>
  );
}
