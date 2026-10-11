// JobDetail.tsx — the expanded run: summary cells (chapters / concepts /
// assets / refs skipped / refs failed), the written-chapter chips, the error
// card, the cancelled card, and the live progress bar — the five states the
// mockup specifies, one per lifecycle status.
//
// `cancelled` gets its own card rather than borrowing the error one on
// purpose: a stop the user asked for is not a failure, and the thing someone
// needs to know when they look at it is not "what went wrong" but "what
// survived" — which is everything the run had already written.

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
        {job.runId ? (
          <>
            {" "}
            · headless run <code data-testid={`job-runid-${job.id}`}>{job.runId}</code>
          </>
        ) : null}
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
        <>
          <div className="job-cancelled" data-testid={`job-cancelled-${job.id}`}>
            <Icon name="stop" size={15} />
            <div>
              <b>Cancelled</b> — stopped on request, not an error. Everything this run had already written to the
              bundle is still there: each write is atomic and the derived index rebuilds from content, so a cancelled
              run leaves a smaller knowledge base, never a broken one.
            </div>
          </div>
          <div className="jd-foot">
            <Icon name="import" size={13} /> Re-run it from the bundle&apos;s <b>Ingest</b> button or with{" "}
            <code>okf_ingest</code>; anything already ingested is skipped by the provenance ledger. Use{" "}
            <b>Delete</b> on this row to drop the record — it removes the run from this list and touches no bundle
            content.
          </div>
        </>
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
