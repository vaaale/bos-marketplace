// JobDetail.tsx — the expanded run: summary cells (chapters / concepts /
// assets / refs skipped / refs failed), the written-chapter chips, the error
// card, the cancelled card and the live progress bar — one state per
// lifecycle status, exactly as the mockup specifies.
//
// `cancelled` gets its OWN card rather than reusing the red error one: it is
// an intentional stop and carries no error, so painting it as a failure would
// misreport what happened (FR-050).

import React from "react";
import { Icon } from "../lib/icons";
import type { Job } from "../lib/types";

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
              <div className="jd-top" data-testid={`job-report-${job.id}`} style={{ whiteSpace: "pre-wrap" }}>
                {job.summary.text}
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
    </>
  );
}
