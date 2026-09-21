// Refresh Console — the live, per-attempt fetch log (observability layer).
//
// Every defect this item shipped was a silent state; this panel surfaces what
// the refresh actually did, one line per fetch ATTEMPT. The layout, tokens,
// status vocabulary, filter chips, legend and live-tail behavior follow the
// approved mockup contract (spec/mockup.html, the Refresh Console section).
//
// Transport is POLLING (approved; no WebSocket/SSE): while the drawer is open
// we tail GET /api/refresh/log?since=<lastSeq> every ~1.5 s while a refresh is
// in progress, plus one fetch on open and one after `inProgress` flips false.
// The visible log resets when `refreshId` changes (the "reset each run" default
// is enforced by the service, which resets its buffer on each POST /api/refresh).
// If the service is unreachable we show the offline state — never a false empty
// log (core-route 404→offline semantics from serviceClient).

import React, { useCallback, useEffect, useRef, useState } from "react";
import type { Health, RefreshLog, RefreshLogEvent, RefreshEventStatus } from "../lib/types";
import { fetchRefreshLog, postRefresh } from "../lib/serviceClient";
import { fmtAsOf } from "../lib/format";

const POLL_MS = 1500;

// status -> (css class, glyph) per the mockup's .rc-st vocabulary:
// ok green, retry/deferred amber (warn), error red, skip grey (off/awaiting).
const STATUS_CLASS: Record<RefreshEventStatus, string> = {
  ok: "ok",
  retry: "warn",
  deferred: "warn",
  error: "err",
  skip: "off"
};
const GLYPH: Record<RefreshEventStatus, string> = {
  ok: "✓",
  retry: "⚠",
  deferred: "⚠",
  error: "✗",
  skip: "–"
};

// ts is an ISO-8601 UTC string; HH:MM:SS is the mockup's time column.
function fmtTime(iso: string | null): string {
  return iso && iso.length >= 19 ? iso.slice(11, 19) : "—";
}

interface Props {
  open: boolean;
  health: Health | null;
  toast: (msg: string) => void;
}

export default function RefreshConsole({ open, health, toast }: Props) {
  const [events, setEvents] = useState<RefreshLogEvent[]>([]);
  const [meta, setMeta] = useState<RefreshLog | null>(null);
  const [offline, setOffline] = useState(false);
  const [filter, setFilter] = useState<"all" | "issues">("all");

  const lastSeqRef = useRef(0);
  const refreshIdRef = useRef<string | null>(null);
  const prevActiveRef = useRef(false);
  const logRef = useRef<HTMLDivElement | null>(null);

  // Reconcile a response with the visible log. A changed refreshId means a new
  // run started (seqs restart at 1), so a stale since-cursor would return an
  // empty delta and hide the whole run — detect it and re-fetch the full buffer.
  const doFetch = useCallback(async () => {
    const since = lastSeqRef.current > 0 ? lastSeqRef.current : undefined;
    const first = await fetchRefreshLog(since);
    if (first.offline || !first.data) {
      setOffline(true);
      return;
    }
    let d = first.data;
    if (d.refreshId !== refreshIdRef.current) {
      refreshIdRef.current = d.refreshId;
      lastSeqRef.current = 0;
      const full = await fetchRefreshLog(); // whole current/most-recent buffer
      if (!full.data) {
        setOffline(true);
        return;
      }
      d = full.data;
      setEvents(d.events);
      lastSeqRef.current = d.events.reduce((m, e) => Math.max(m, e.seq), 0);
    } else if (d.events.length) {
      const incoming = d.events;
      setEvents((prev) => {
        const seen = new Set(prev.map((e) => e.seq));
        return [...prev, ...incoming.filter((e) => !seen.has(e.seq))];
      });
      lastSeqRef.current = incoming.reduce((m, e) => Math.max(m, e.seq), lastSeqRef.current);
    }
    setOffline(false);
    setMeta(d);
  }, []);

  // One fetch when the drawer opens (loads the current / most recent run).
  useEffect(() => {
    if (!open) return;
    refreshIdRef.current = null;
    lastSeqRef.current = 0;
    prevActiveRef.current = false;
    setEvents([]);
    setMeta(null);
    setOffline(false);
    void doFetch();
  }, [open, doFetch]);

  // "Active" = a refresh is running, whether it was started from THIS console
  // (meta.inProgress — known immediately, no health lag) or from anywhere else
  // (the drawer's other Refresh button, or the scheduler — health.refreshing,
  // picked up on the app's next health poll). Polling from the union means the
  // console tails whichever run is live, not just its own button's.
  const inProgress = Boolean(meta?.inProgress);
  const healthRefreshing = Boolean(health?.refreshing);
  const active = inProgress || healthRefreshing;
  useEffect(() => {
    if (!open || !active) return;
    const iv = setInterval(() => void doFetch(), POLL_MS);
    return () => clearInterval(iv);
  }, [open, active, doFetch]);

  // One final fetch when activity stops, to capture the last tail.
  useEffect(() => {
    if (!open) return;
    if (!active && prevActiveRef.current) void doFetch();
    prevActiveRef.current = active;
  }, [open, active, doFetch]);

  // Auto-scroll to the bottom as new lines land.
  useEffect(() => {
    const el = logRef.current;
    if (el) el.scrollTop = el.scrollHeight;
  }, [events, filter, offline]);

  const onRefresh = async () => {
    try {
      const r = await postRefresh("all");
      if (!r.started) {
        toast(`Not started — ${r.reason || "already running"}`);
        return;
      }
      toast("Refresh started");
      void doFetch(); // pick up the new run (new refreshId -> log resets)
    } catch {
      toast("Service offline");
    }
  };

  const okCount = meta?.okCount ?? 0;
  const issueCount = meta?.issueCount ?? 0;
  const asOf = meta?.asOf ?? null;

  // Heartbeat from /api/health (Fix A/C fields already exist).
  const alive = Boolean(health?.pipelineAlive);
  const hbCause = health?.lastHeartbeatError || null;
  const hbTs = health?.lastHeartbeat || null;

  const filtered = filter === "issues" ? events.filter((e) => e.status !== "ok") : events;

  return (
    <div className="dr-sec" data-testid="refresh-console">
      <h3>
        Refresh Console <span className="ln" />
      </h3>

      <div className="rc-head">
        <span className="rc-rt">
          <span className={`rc-spin${inProgress ? "" : " idle"}`} />
          <span data-testid="rc-status">{inProgress ? "refreshing…" : "Idle"}</span>
        </span>
        <span className="rc-tally">
          <span className="ok" data-testid="rc-ok">
            {okCount} ok
          </span>{" "}
          · <span className="iss" data-testid="rc-issues">{issueCount} issues</span>
        </span>
        <span className="rc-asof" data-testid="rc-asof">{asOf ? `as-of ${fmtAsOf(asOf)}` : "as-of —"}</span>
        <button className="btn primary" data-testid="rc-refresh" onClick={onRefresh} disabled={offline}>
          Refresh now
        </button>
      </div>

      <div className={`rc-hb ${alive ? "alive" : "dead"}`} data-testid="rc-heartbeat">
        <span className="hd" />
        <span>{alive ? "pipeline alive" : "pipeline dead"}</span>
        {!alive && hbCause ? <span className="cause" data-testid="rc-hb-cause">{hbCause}</span> : null}
        <span className="ts" data-testid="rc-hb-ts">{hbTs ? `last ${fmtTime(hbTs)}` : "no heartbeat"}</span>
      </div>

      <div className="rc-filter" data-testid="rc-filter">
        <span className={`fchip${filter === "all" ? " on" : ""}`} onClick={() => setFilter("all")}>
          All
        </span>
        <span className={`fchip${filter === "issues" ? " on" : ""}`} onClick={() => setFilter("issues")}>
          Issues only
        </span>
      </div>

      {offline ? (
        <div className="rc-offline" data-testid="rc-offline">
          Service offline — refresh log unavailable
        </div>
      ) : (
        <div className="rc-log" ref={logRef} data-testid="rc-log">
          {filtered.length === 0 ? (
            <div className="rc-empty" data-testid="rc-empty">
              No lines yet.
            </div>
          ) : (
            filtered.map((e) => (
              <div className="rc-line" key={e.seq} data-st={STATUS_CLASS[e.status]}>
                <span className="t">{fmtTime(e.ts)}</span>
                <span className="s">{e.symbol}</span>
                <span className="p">{e.provider}</span>
                <span className={`st rc-st ${STATUS_CLASS[e.status]}`}>
                  <span className="glyph">{GLYPH[e.status]}</span>
                  {e.detail}
                  {e.probeEnabled ? <span className="rc-tag">probe → enabled</span> : null}
                  {e.keyed ? <span className="rc-tag">keyed</span> : null}
                </span>
              </div>
            ))
          )}
        </div>
      )}

      <div className="rc-legend">
        <span>
          <i style={{ background: "var(--up)" }} />
          ok
        </span>
        <span>
          <i style={{ background: "var(--am)" }} />
          retry / deferred
        </span>
        <span>
          <i style={{ background: "var(--dn)" }} />
          failed
        </span>
        <span>
          <i style={{ background: "var(--txt-3)" }} />
          awaiting
        </span>
      </div>
      <div className="rc-legend" style={{ marginTop: 5 }}>
        <span>log keeps last 200 lines · resets each run</span>
      </div>
    </div>
  );
}
