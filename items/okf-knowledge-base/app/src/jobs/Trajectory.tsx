// Trajectory.tsx — the run's captured NDJSON stream as a collapsible
// tool-call timeline (FR-058 / SC-018, ADR-013), ported from the mockup's
// renderTrajectory / trajToolCard / trajDoneCard / trajErrorCard /
// trajStartedCard and their .traj-* classes.
//
// ── What the launcher stored, and what this shows ────────────────────────
//
// The service's delegate bridge appends EVERY line of the run's stream to the
// job record, verbatim. This renders the subset that answers "what did the
// agent actually do":
//
//   run_started            a static header card
//   tool + tool_result     ONE collapsible card — the pairing is POSITIONAL
//                          (there is no callId on the wire), so a `tool` is
//                          matched with the next `tool_result` after it
//   done                   the terminal card, colour-coded by endedReason
//   error                  the terminal card for a run that threw mid-stream
//   reasoning_delta /      skipped for v1: the tool calls are the debug
//   final_text             surface, and the deltas would bury them
//
// A `tool` with no result yet is the IN-FLIGHT state — a live run, caught
// between the call and its answer. That is why the pairing walks forward past
// reasoning/final_text lines rather than demanding the next line be the
// result: a result that exists must never render as "still in flight".

import React from "react";
import { Icon } from "../lib/icons";
import type { Job, TrajectoryEvent } from "../lib/types";

function trunc(s: string, n: number): string {
  return s.length <= n ? s : `${s.slice(0, n - 1)}…`;
}

function trajJson(x: unknown): string {
  if (x === null || x === undefined) return "null";
  if (typeof x === "string") return x;
  try {
    return JSON.stringify(x, null, 2);
  } catch {
    return String(x);
  }
}

/** The payload of a tool_result, under whichever key this event kind used. */
function resultValue(ev: TrajectoryEvent | null): unknown {
  if (!ev) return null;
  if (ev.result !== undefined) return ev.result;
  if (ev.output !== undefined) return ev.output;
  if (ev.content !== undefined) return ev.content;
  return ev;
}

/**
 * The one line of input shown while a card is collapsed. Prefers the keys that
 * identify WHAT was acted on — a row reading `bundle: engineering` for every
 * call would be a row carrying no information.
 */
function inputSummary(input: unknown): string {
  if (input === null || input === undefined) return "—";
  if (typeof input !== "object") return trunc(String(input), 80);
  const obj = input as Record<string, unknown>;
  const keys = Object.keys(obj);
  if (!keys.length) return "—";
  const prefer = ["url", "filename", "sourcePath", "path", "id", "parent", "target", "query", "source", "bundle", "title", "label"];
  let chosen = prefer.filter((k) => keys.includes(k)).slice(0, 2);
  if (!chosen.length) chosen = keys.slice(0, 1);
  return trunc(
    chosen
      .map((k) => {
        const v = obj[k];
        return `${k}: ${v !== null && typeof v === "object" ? JSON.stringify(v) : String(v)}`;
      })
      .join("  ·  "),
    80,
  );
}

function Caret() {
  return <Icon name="caret" size={13} className="traj-caret" />;
}

function StartedCard({ ev, job }: { ev: TrajectoryEvent; job: Job }) {
  const runId = ev.runId || job.runId || "…";
  const agent = ev.agent || "okf-ingest";
  return (
    <div className="traj-card run-started" data-testid={`traj-card-${job.id}-run_started`}>
      <div className="traj-head static">
        <span className="traj-ic">
          <Icon name="play" size={13} />
        </span>
        <span className="traj-toolname">Run started</span>
        <span className="traj-summary">
          agent: {agent} · runId: {runId}
        </span>
        <span className="traj-badge run">start</span>
      </div>
    </div>
  );
}

function ToolCard({
  ev,
  res,
  jobId,
  idx,
  open,
  onToggle,
}: {
  ev: TrajectoryEvent;
  res: TrajectoryEvent | null;
  jobId: string;
  idx: number;
  open: boolean;
  onToggle: () => void;
}) {
  return (
    <div className={`traj-card tool${open ? " open" : ""}`} data-testid={`traj-card-${jobId}-${idx}`}>
      <div className="traj-head" onClick={onToggle} data-testid={`traj-toggle-${jobId}-${idx}`}>
        <Caret />
        <span className="traj-ic">
          <Icon name="zap" size={13} />
        </span>
        <span className="traj-toolname" data-testid={`traj-tool-${jobId}-${idx}`}>
          {ev.tool || "tool"}
        </span>
        <span className="traj-summary">{inputSummary(ev.input)}</span>
        <span className={`traj-badge ${res ? "ok" : "run"}`}>{res ? "result" : "…"}</span>
      </div>
      {open ? (
        <div className="traj-body" data-testid={`traj-body-${jobId}-${idx}`}>
          <div className="blk">
            <div className="blk-lbl">
              <Icon name="code" size={12} /> Input
            </div>
            <pre data-testid={`traj-input-${jobId}-${idx}`}>{trajJson(ev.input)}</pre>
          </div>
          <div className="blk">
            <div className="blk-lbl">
              <Icon name="check" size={12} /> Result
            </div>
            {res ? (
              <pre data-testid={`traj-result-${jobId}-${idx}`}>{trajJson(resultValue(res))}</pre>
            ) : (
              <div className="traj-nores">No result captured yet — the call is still in flight (run is live).</div>
            )}
          </div>
        </div>
      ) : null}
    </div>
  );
}

function DoneCard({
  ev,
  jobId,
  idx,
  open,
  onToggle,
}: {
  ev: TrajectoryEvent;
  jobId: string;
  idx: number;
  open: boolean;
  onToggle: () => void;
}) {
  const result = (ev.result || {}) as Record<string, unknown>;
  const reason = String(result.endedReason || ev.endedReason || "completed");
  const badge = reason === "completed" ? "ok" : reason === "cancelled" ? "stopped" : "err";
  const cardCls = reason === "completed" ? "" : reason === "cancelled" ? " cancelled" : " failed";
  const finalOut = ev.text !== undefined ? ev.text : result.text !== undefined ? result.text : null;
  const finalText = finalOut === null || finalOut === undefined ? "—" : typeof finalOut === "string" ? finalOut : trajJson(finalOut);

  return (
    <div className={`traj-card done${cardCls}${open ? " open" : ""}`} data-testid={`traj-card-${jobId}-done`}>
      <div className="traj-head" onClick={onToggle} data-testid={`traj-toggle-${jobId}-${idx}`}>
        <Caret />
        <span className="traj-ic">
          <Icon name="check" size={13} />
        </span>
        <span className="traj-toolname">Done</span>
        <span className="traj-summary">{trunc(finalText, 72)}</span>
        <span className={`traj-badge ${badge}`} data-testid={`traj-endedreason-${jobId}`}>
          {reason}
        </span>
      </div>
      {open ? (
        <div className="traj-body">
          <div className="blk">
            <div className="blk-lbl">
              <Icon name="x" size={12} /> endedReason
            </div>
            <pre>{reason}</pre>
          </div>
          <div className="blk">
            <div className="blk-lbl">
              <Icon name="doc" size={12} /> Final output
            </div>
            <pre className="muted">{finalText}</pre>
          </div>
        </div>
      ) : null}
    </div>
  );
}

function ErrorCard({
  ev,
  jobId,
  idx,
  open,
  onToggle,
}: {
  ev: TrajectoryEvent;
  jobId: string;
  idx: number;
  open: boolean;
  onToggle: () => void;
}) {
  const raw = ev.message !== undefined && ev.message !== null ? ev.message : ev.error !== undefined && ev.error !== null ? ev.error : "Run ended in error";
  const msg = typeof raw === "string" ? raw : trajJson(raw);
  return (
    <div className={`traj-card error${open ? " open" : ""}`} data-testid={`traj-card-${jobId}-error`}>
      <div className="traj-head" onClick={onToggle} data-testid={`traj-toggle-${jobId}-${idx}`}>
        <Caret />
        <span className="traj-ic">
          <Icon name="alert" size={13} />
        </span>
        <span className="traj-toolname">Run ended in error</span>
        <span className="traj-summary">{trunc(msg, 72)}</span>
        <span className="traj-badge err">error</span>
      </div>
      {open ? (
        <div className="traj-body">
          <div className="blk">
            <div className="blk-lbl">
              <Icon name="alert" size={12} /> Error
            </div>
            <pre>{msg}</pre>
          </div>
        </div>
      ) : null}
    </div>
  );
}

export default function Trajectory({
  job,
  events,
  failed = false,
}: {
  job: Job;
  /** null while the detail read is still in flight. */
  events: TrajectoryEvent[] | null;
  /** the detail read itself failed — distinct from "the run captured nothing" */
  failed?: boolean;
}) {
  const [open, setOpen] = React.useState<Record<number, boolean>>({});
  const toggle = (idx: number) => setOpen((prev) => ({ ...prev, [idx]: !prev[idx] }));

  const count = events ? events.length : 0;

  const cards: React.ReactNode[] = [];
  if (events) {
    let i = 0;
    let cardIdx = 0;
    while (i < events.length) {
      const ev = events[i];
      if (ev.type === "run_started") {
        cards.push(<StartedCard key={cardIdx} ev={ev} job={job} />);
        cardIdx++;
        i++;
      } else if (ev.type === "tool") {
        // positional pairing, skipping the narration lines v1 does not render
        let j = i + 1;
        while (j < events.length && (events[j].type === "reasoning_delta" || events[j].type === "final_text")) j++;
        const res = j < events.length && events[j].type === "tool_result" ? events[j] : null;
        const idx = cardIdx;
        cards.push(
          <ToolCard key={idx} ev={ev} res={res} jobId={job.id} idx={idx} open={!!open[idx]} onToggle={() => toggle(idx)} />,
        );
        cardIdx++;
        i = res ? j + 1 : i + 1;
      } else if (ev.type === "done") {
        const idx = cardIdx;
        cards.push(<DoneCard key={idx} ev={ev} jobId={job.id} idx={idx} open={!!open[idx]} onToggle={() => toggle(idx)} />);
        cardIdx++;
        i++;
      } else if (ev.type === "error") {
        const idx = cardIdx;
        cards.push(<ErrorCard key={idx} ev={ev} jobId={job.id} idx={idx} open={!!open[idx]} onToggle={() => toggle(idx)} />);
        cardIdx++;
        i++;
      } else {
        i++; // reasoning_delta / final_text / anything new: omitted for v1
      }
    }
  }

  return (
    <>
      <div className="jd-sub" data-testid={`traj-header-${job.id}`}>
        Run trajectory{count ? ` · ${count} event${count === 1 ? "" : "s"}` : ""}
      </div>
      {events === null && failed ? (
        <div className="traj-note" data-testid={`traj-unavailable-${job.id}`}>
          <Icon name="alert" size={15} />
          <div>
            The run&apos;s trajectory could not be read from the service just now. This says nothing about the run
            itself — reopen this row to try again.
          </div>
        </div>
      ) : events === null ? (
        <div className="traj-note" data-testid={`traj-loading-${job.id}`}>
          <Icon name="clock" size={15} />
          <div>Loading the run&apos;s trajectory…</div>
        </div>
      ) : count === 0 ? (
        <div className="traj-note" data-testid={`traj-empty-${job.id}`}>
          <Icon name="info" size={15} />
          <div>No trajectory captured — the run failed before producing events.</div>
        </div>
      ) : (
        <div className="traj-list" data-testid={`traj-list-${job.id}`}>
          {cards}
        </div>
      )}
    </>
  );
}
