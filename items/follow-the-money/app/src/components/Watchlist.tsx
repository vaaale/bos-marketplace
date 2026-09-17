// Personal watchlist (FR-015, US6): rows with score + state chip + 3M
// momentum, remove (×), click-through to detail; empty state per mockup.
// Membership is server-side (service config) so it survives app rebuilds.
import React from "react";
import type { Region, WatchlistResponse } from "../lib/types";
import { fmtMom, momClass, scoreColor, STATE_CHIP_CLASS, STATE_DOT_COLOR, STATE_LABEL } from "../lib/format";

interface Props {
  data: WatchlistResponse | null;
  onOpenDetail: (symbol: string, region: Region) => void;
  onRemove: (symbol: string) => void;
}

export default function Watchlist({ data, onOpenDetail, onRemove }: Props) {
  const entries = data?.entries || [];
  return (
    <section data-testid="view-watchlist">
      <div className="viewhead">
        <div>
          <h1>Watchlist</h1>
          <div className="sub">
            Your pinned instruments with live money-flow score and state. Not an alert system — this is your shortlist
            to review.
          </div>
        </div>
      </div>
      <div className="panel wl-list">
        {entries.length === 0 ? (
          <div className="wl-empty" data-testid="wl-empty">
            <div className="big">☆</div>
            No instruments pinned yet.
            <br />
            Add them from the dashboard or detail view.
          </div>
        ) : (
          entries.map((s, idx) => (
            <div
              key={s.symbol}
              className="wl-row"
              onClick={() => onOpenDetail(s.symbol, s.region)}
              data-testid={`wl-row-${s.symbol}`}
            >
              <span className="wl-h">{String(idx + 1).padStart(2, "0")}</span>
              <div>
                <div className="sym">{s.symbol}</div>
                <div className="iname">
                  {s.name} · <span style={{ color: "var(--txt-3)" }}>{s.region}</span>
                </div>
              </div>
              <div
                className="num"
                style={{ textAlign: "right", fontWeight: 700, fontSize: 15, color: s.state === "unavailable" ? "var(--txt-3)" : scoreColor(s.moneyFlowScore) }}
              >
                {s.state === "unavailable" ? "—" : s.moneyFlowScore}
              </div>
              <div>
                <span className={`chip ${STATE_CHIP_CLASS[s.state]}`}>
                  <span className="cd" style={{ background: STATE_DOT_COLOR[s.state] }} />
                  {STATE_LABEL[s.state]}
                </span>
              </div>
              <div className={`num ${momClass(s.momentumPct["3M"])}`} style={{ textAlign: "right" }}>
                {fmtMom(s.momentumPct["3M"])}
                <span style={{ color: "var(--txt-3)", fontSize: 10 }}> 3M</span>
              </div>
              <button
                className="wl-rm"
                title="Remove"
                onClick={(e) => {
                  e.stopPropagation();
                  onRemove(s.symbol);
                }}
                data-testid={`wl-rm-${s.symbol}`}
              >
                ×
              </button>
            </div>
          ))
        )}
      </div>
    </section>
  );
}
