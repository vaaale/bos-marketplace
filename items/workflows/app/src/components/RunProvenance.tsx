// RunProvenance.tsx — "who started this run?" (US16/FR-041 + FR-049).
//
// `startSource`/`triggerEventId`/`triggerEventType`/`eventContext` come
// verbatim from the service's own run projection (services/engine/run-state.js,
// echoed by workflow_status / workflow_run_get / GET /run/<runId>) — this
// component only renders them.
//
// An EVENT-triggered run gets a full provenance block (the trigger type, the
// truncated event id, and the payload that was injected into the first node's
// prompt). A user- or tool-started run gets a one-line label: the fact that
// nothing triggered it is still worth stating, but it deserves no real estate.

import React, { useState } from "react";
import type { RunProvenance as RunProvenanceData } from "../lib/types";
import { renderValue } from "../lib/trajectory";

const SOURCE_LABEL: Record<string, string> = {
  user: "Started from the app",
  tool: "Started by the assistant",
  event: "Triggered by event",
};

/** `evt_01J…9Q` — enough to recognize, short enough to sit inline. */
function truncateId(id: string): string {
  return id.length <= 18 ? id : `${id.slice(0, 10)}…${id.slice(-6)}`;
}

export function RunProvenance({ run }: { run: RunProvenanceData | null | undefined }) {
  const [expanded, setExpanded] = useState(false);
  // A pre-US16 run record carries no startSource at all — it was a tool run.
  const source = run?.startSource || "tool";

  if (source !== "event") {
    return (
      <div className="wf-provenance-min" data-testid="wf-run-provenance">
        <span className="wf-provenance-glyph">◈</span>
        {SOURCE_LABEL[source] || `Started by ${source}`}
      </div>
    );
  }

  const eventId = run?.triggerEventId || null;
  const eventType = run?.triggerEventType || "unknown event type";
  const hasContext = run?.eventContext != null;

  return (
    <div className="wf-provenance" data-testid="wf-run-provenance">
      <div className="wf-row">
        <span className="wf-provenance-icon">⚡</span>
        <span className="wf-provenance-title">Triggered by event</span>
        <span className="wf-mono wf-provenance-type" data-testid="wf-provenance-type">
          {eventType}
        </span>
        {eventId ? (
          <button
            className="wf-mono wf-provenance-id"
            title={`${eventId} — click to ${expanded ? "hide" : "show"} the triggering payload`}
            onClick={() => setExpanded((v) => !v)}
          >
            {truncateId(eventId)}
          </button>
        ) : null}
        <div style={{ flex: 1 }} />
        {hasContext ? (
          <button className="wf-btn wf-btn-sm" onClick={() => setExpanded((v) => !v)}>
            {expanded ? "Hide payload" : "Show payload"}
          </button>
        ) : null}
      </div>
      <div className="wf-provenance-note">
        The event payload was injected into this run&apos;s first step as its input.
      </div>
      {expanded ? (
        <pre className="wf-mono wf-provenance-payload">{hasContext ? renderValue(run?.eventContext) : "(the event carried no payload)"}</pre>
      ) : null}
    </div>
  );
}

/** The ⚡ marker a run chip carries when that run was event-triggered. */
export function RunSourceGlyph({ startSource }: { startSource?: string }) {
  if (startSource !== "event") return null;
  return (
    <span className="wf-run-chip-event" title="event-triggered run">
      ⚡
    </span>
  );
}
