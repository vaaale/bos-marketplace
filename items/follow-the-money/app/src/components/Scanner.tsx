// Base-level / breakout scanner (FR-002/003/004, US2): two columns —
// Breaking Out (confirmed highlighted, CONFIRMED/UNCONFIRMED ×VOL badge,
// base range/duration/breakout level/volume ratio) and In Base — Candidates
// (duration desc then width asc, "tightest in region" / "longest base" tags).
// Filter chips: All / Confirmed / Unconfirmed / In Base.
import React, { useState } from "react";
import type { Region, RegionRollup, SignalLite } from "../lib/types";
import { currencySymbol, ratioColor } from "../lib/format";

type Filter = "all" | "confirmed" | "unconfirmed" | "inbase";

interface Props {
  rollup: RegionRollup | null;
  onOpenDetail: (symbol: string, region: Region) => void;
}

const FILTERS: { id: Filter; label: string }[] = [
  { id: "all", label: "All states" },
  { id: "confirmed", label: "Confirmed" },
  { id: "unconfirmed", label: "Unconfirmed" },
  { id: "inbase", label: "In Base" }
];

export default function Scanner({ rollup, onOpenDetail }: Props) {
  const [filter, setFilter] = useState<Filter>("all");
  if (!rollup) {
    return (
      <div className="empty-chart">
        <div className="em">Waiting for the data service…</div>
      </div>
    );
  }
  const cur = currencySymbol(rollup.currency);
  const usable = rollup.instruments.filter((s) => s.state !== "unavailable" && s.state !== "insufficient-data");

  let bo = usable.filter((s) => s.state === "breaking-out-confirmed" || s.state === "breaking-out-unconfirmed");
  let ib = usable.filter((s) => s.state === "in-base" && s.base);
  if (filter === "confirmed") {
    bo = bo.filter((s) => s.state === "breaking-out-confirmed");
    ib = [];
  } else if (filter === "unconfirmed") {
    bo = bo.filter((s) => s.state === "breaking-out-unconfirmed");
    ib = [];
  } else if (filter === "inbase") {
    bo = [];
  }

  bo.sort((a, b) => (b.breakout?.volumeRatio || 0) - (a.breakout?.volumeRatio || 0));
  ib.sort((a, b) => (b.base!.durationDays - a.base!.durationDays) || (a.base!.tightness || 0) - (b.base!.tightness || 0));
  const tightest = ib.length ? Math.min(...ib.map((s) => s.base!.tightness || 0)) : 0;
  const longest = ib.length ? Math.max(...ib.map((s) => s.base!.durationDays)) : 0;

  return (
    <section data-testid="view-scanner">
      <div className="viewhead">
        <div>
          <h1>Scanner — {rollup.region}</h1>
          <div className="sub">
            Breaking-out signals (with volume confirmation) on the left; long, tight bases — future candidates — on the
            right.
          </div>
        </div>
      </div>
      <div className="scan-filters">
        <span style={{ font: "600 11px var(--sans)", color: "var(--txt-3)", letterSpacing: ".4px" }}>FILTER</span>
        {FILTERS.map((f) => (
          <span
            key={f.id}
            className={`fchip${filter === f.id ? " on" : ""}`}
            onClick={() => setFilter(f.id)}
            data-testid={`filter-${f.id}`}
          >
            {f.label}
          </span>
        ))}
      </div>
      <div className="scan-grid">
        <div className="scan-col bo">
          <h2>
            <span className="dotc" />
            Breaking Out <span className="cnt">{bo.length}</span>
          </h2>
          <div>
            {bo.length === 0 && (
              <div className="empty-chart" style={{ height: 120 }}>
                <div className="em">No breakouts match this filter.</div>
              </div>
            )}
            {bo.map((s) => {
              const conf = s.state === "breaking-out-confirmed";
              const b = s.breakout!;
              const base = s.base;
              return (
                <div
                  key={s.symbol}
                  className={`srow${conf ? " confirmed" : ""}`}
                  onClick={() => onOpenDetail(s.symbol, s.region)}
                  data-testid={`bo-row-${s.symbol}`}
                >
                  <div className="srow-top">
                    <span className="sym">{s.symbol}</span>
                    <span className="iname">{s.name}</span>
                    <span className={`vbadge ${conf ? "c" : "u"}`}>
                      {conf ? "CONFIRMED" : "UNCONFIRMED"} {b.volumeRatio.toFixed(1)}× VOL
                    </span>
                  </div>
                  <div className="srow-meta">
                    <div>
                      <span className="k">Base range</span>
                      <br />
                      <span className="v">
                        {base && base.lowerBound !== null
                          ? `${cur}${base.lowerBound.toFixed(2)} – ${cur}${base.upperBound!.toFixed(2)}`
                          : "—"}
                      </span>
                    </div>
                    <div>
                      <span className="k">Base duration</span>
                      <br />
                      <span className="v">{base ? `${base.durationDays}-day base` : "—"}</span>
                    </div>
                    <div>
                      <span className="k">Breakout level</span>
                      <br />
                      <span className="v">{b.level !== null ? `${cur}${b.level.toFixed(2)}` : "—"}</span>
                    </div>
                    <div>
                      <span className="k">Volume ratio</span>
                      <br />
                      <span className="v" style={{ color: ratioColor(b.volumeRatio) }}>
                        {b.volumeRatio.toFixed(1)}×
                      </span>
                    </div>
                  </div>
                </div>
              );
            })}
          </div>
        </div>
        <div className="scan-col ib">
          <h2>
            <span className="dotc" />
            In Base — Candidates <span className="cnt">{ib.length}</span>
          </h2>
          <div>
            {ib.length === 0 && (
              <div className="empty-chart" style={{ height: 120 }}>
                <div className="em">No instruments in base for this filter.</div>
              </div>
            )}
            {ib.map((s, idx) => {
              const base = s.base!;
              const widthPct = (base.tightness || 0) * 100;
              return (
                <div key={s.symbol} className="srow" onClick={() => onOpenDetail(s.symbol, s.region)} data-testid={`ib-row-${s.symbol}`}>
                  <div className="ib-rank">
                    <span className="rk">{idx + 1}</span>
                    <span className="sym">{s.symbol}</span>
                    <span className="iname">{s.name}</span>
                    {(base.tightness || 0) === tightest && <span className="ib-tag">tightest in region</span>}
                    {base.durationDays === longest && <span className="ib-tag ty">longest base</span>}
                  </div>
                  <div className="ib-big">
                    <span className="dur">{base.durationDays}-day base</span> · {widthPct.toFixed(1)}% width ·{" "}
                    {base.lowerBound !== null ? `${cur}${base.lowerBound.toFixed(2)}–${cur}${base.upperBound!.toFixed(2)}` : "—"}
                  </div>
                </div>
              );
            })}
          </div>
        </div>
      </div>
    </section>
  );
}
