// Cross-region money-flow pulse (FR-021 / SC-009) — built from the design
// §2.7 binding spec (the mockup predates this element): a compact horizontal
// strip pinned under the HealthStrip on the dashboard AND scanner views.
// Up to pulseTopN chips left-to-right by score from GET /api/pulse; each chip
// = uppercase region tag (region color) + symbol + money-flow score + a mini
// state glyph (green dot = confirmed breakout, amber = strong flow).
// Clickable through to the instrument's detail. A region with no data
// contributes no chips — no placeholder, no error.
import React from "react";
import type { Pulse, Region } from "../lib/types";
import { REGION_COLOR } from "../lib/format";

interface Props {
  pulse: Pulse | null;
  onOpenDetail: (symbol: string, region: Region) => void;
}

export default function PulseStrip({ pulse, onOpenDetail }: Props) {
  const entries = pulse?.entries || [];
  return (
    <div className="pulse" data-testid="pulse-strip">
      <span className="plbl">Global Rotation Pulse</span>
      {entries.length === 0 && <span className="pempty">no confirmed cross-region moves this refresh</span>}
      {entries.map((e) => {
        const color = REGION_COLOR[e.region] || "var(--txt-2)";
        const confirmed = e.state === "breaking-out-confirmed";
        return (
          <span
            key={`${e.region}:${e.symbol}`}
            className="pulse-chip"
            onClick={() => onOpenDetail(e.symbol, e.region)}
            title={`${e.symbol} (${e.region}) — score ${e.moneyFlowScore}, ${e.state}`}
            data-testid="pulse-chip"
          >
            <span className="rg" style={{ color, borderColor: color }}>
              {e.region}
            </span>
            <span className="sym">{e.symbol}</span>
            <span className="sc" style={{ color: confirmed ? "var(--up)" : "var(--am)" }}>
              {e.moneyFlowScore}
            </span>
            <span
              className="glyph"
              style={{ background: confirmed ? "var(--up)" : "var(--am)" }}
              title={confirmed ? "confirmed breakout" : "strong money flow"}
            />
          </span>
        );
      })}
    </div>
  );
}
