// Ranked money-flow table for the active region (FR-001 / SC-001), matching
// the mockup's dashboard exactly: #, instrument, category chip, dir arrow,
// momentum % (active lookback, sortable), money-flow (recent $ volume,
// native-currency label; NDX price-only -> "—"), flow-ratio meter, state
// chip, watchlist star. Rows are precomputed SignalLites — no signal math.
import React from "react";
import type { Lookback, Region, RegionRollup, SignalLite } from "../lib/types";
import type { SortKey } from "../App";
import {
  dirOf,
  dirSymbol,
  fmtFlow,
  fmtMom,
  meterW,
  momClass,
  ratioClass,
  ratioColor,
  ratioText,
  STATE_CHIP_CLASS,
  STATE_DOT_COLOR,
  STATE_LABEL
} from "../lib/format";

interface Props {
  rollup: RegionRollup | null;
  lookback: Lookback;
  sortKey: SortKey;
  sortDir: -1 | 1;
  onSort: (key: SortKey) => void;
  watchlist: string[];
  onToggleWatch: (symbol: string) => void;
  onOpenDetail: (symbol: string, region: Region) => void;
}

function StateChip({ s }: { s: SignalLite }) {
  return (
    <span className={`chip ${STATE_CHIP_CLASS[s.state]}`}>
      <span className="cd" style={{ background: STATE_DOT_COLOR[s.state] }} />
      {STATE_LABEL[s.state]}
    </span>
  );
}

export default function Dashboard({
  rollup,
  lookback,
  sortKey,
  sortDir,
  onSort,
  watchlist,
  onToggleWatch,
  onOpenDetail
}: Props) {
  if (!rollup) {
    return (
      <div className="empty-chart">
        <div className="em">Waiting for the data service…</div>
      </div>
    );
  }
  const rows = rollup.instruments.slice();
  rows.sort((a, b) => {
    let av: number;
    let bv: number;
    if (sortKey === "mom") {
      av = a.momentumPct[lookback] ?? -Infinity;
      bv = b.momentumPct[lookback] ?? -Infinity;
    } else if (sortKey === "flow") {
      av = a.recentDollarVolume;
      bv = b.recentDollarVolume;
    } else {
      av = a.moneyFlowScore;
      bv = b.moneyFlowScore;
    }
    return (av - bv) * sortDir;
  });

  const awaiting = rows.filter((s) => s.state === "unavailable").length;
  const arrow = (key: SortKey) => (sortKey === key ? (sortDir < 0 ? "▼" : "▲") : "↕");

  return (
    <section data-testid="view-dashboard">
      <div className="viewhead">
        <div>
          <h1 data-testid="dash-title">{rollup.region} — Money-Flow Ranking</h1>
          <div className="sub">
            Instruments ranked by composite money-flow score (momentum × dollar volume). Click a row to open the
            deep-dive.
          </div>
        </div>
        <div className="region-note">
          <span className="cat" style={{ cursor: "default" }}>
            as-of {rollup.asOf || "—"} · {rollup.counts.total} instruments
            {awaiting ? ` · ${awaiting} awaiting` : ""}
          </span>
        </div>
      </div>
      <div className="panel">
        <table data-testid="dash-table">
          <thead>
            <tr>
              <th className="c-hash">#</th>
              <th>Instrument</th>
              <th>Category</th>
              <th>Dir</th>
              <th
                className={`r sortable${sortKey === "mom" ? " sorted" : ""}`}
                onClick={() => onSort("mom")}
                data-testid="sort-mom"
              >
                Momentum ({lookback})<span className="arr">{arrow("mom")}</span>
              </th>
              <th
                className={`r sortable${sortKey === "flow" ? " sorted" : ""}`}
                onClick={() => onSort("flow")}
                data-testid="sort-flow"
              >
                Money-Flow <span className="arr">{arrow("flow")}</span>
              </th>
              <th className="r">Flow Ratio</th>
              <th>State</th>
              <th
                className={`sortable${sortKey === "score" ? " sorted" : ""}`}
                onClick={() => onSort("score")}
                data-testid="sort-score"
              >
                Score<span className="arr">{arrow("score")}</span>
              </th>
              <th />
            </tr>
          </thead>
          <tbody>
            {rows.map((s, idx) => {
              const isAwaiting = s.state === "unavailable";
              const m = s.momentumPct[lookback];
              const dir = isAwaiting ? "flat" : dirOf(s.momentumPct, lookback);
              const wl = watchlist.includes(s.symbol);
              return (
                <tr
                  key={s.symbol}
                  className={`dir-${dir}${isAwaiting ? " await-row" : ""}${wl ? " is-wl" : ""}`}
                  onClick={() => onOpenDetail(s.symbol, s.region)}
                  data-testid={`dash-row-${s.symbol}`}
                >
                  <td className="c-hash">
                    <span className="hash">{String(idx + 1).padStart(2, "0")}</span>
                  </td>
                  <td>
                    <div className="sym">{s.symbol}</div>
                    <div className="iname">{s.name}</div>
                  </td>
                  <td>
                    <span className={`cat ${s.category}`}>{s.category}</span>
                  </td>
                  <td>
                    <span className={`dir ${dir}`}>{isAwaiting ? "—" : dirSymbol(dir)}</span>
                  </td>
                  <td className="r">
                    <span className={`mom ${isAwaiting ? "" : momClass(m)}`} data-testid="mom-cell">
                      {isAwaiting ? "—" : fmtMom(m)}
                    </span>
                  </td>
                  <td className="r">
                    <span className={`flow ${!isAwaiting && dir === "down" ? "neg" : ""}`}>
                      {isAwaiting ? "—" : fmtFlow(rollup.currency, s.recentDollarVolume)}
                    </span>
                  </td>
                  <td className="r">
                    {isAwaiting || s.moneyFlowRatio === 0 ? (
                      <span className="ratio">—</span>
                    ) : (
                      <span className="ratio">
                        <span className="rv" style={{ color: ratioColor(s.moneyFlowRatio) }}>
                          {ratioText(s.moneyFlowRatio)}
                        </span>
                        <span className={`meter ${ratioClass(s.moneyFlowRatio)}`}>
                          <i style={{ width: `${meterW(s.moneyFlowRatio)}%` }} />
                        </span>
                      </span>
                    )}
                  </td>
                  <td>
                    <StateChip s={s} />
                  </td>
                  <td className="r num">{isAwaiting ? "—" : s.moneyFlowScore}</td>
                  <td
                    className="r"
                    onClick={(e) => {
                      e.stopPropagation();
                      onToggleWatch(s.symbol);
                    }}
                  >
                    <span className={`wl-star ${wl ? "" : "off"}`} title="Toggle watchlist" data-testid={`star-${s.symbol}`}>
                      {wl ? "★" : "☆"}
                    </span>
                  </td>
                </tr>
              );
            })}
          </tbody>
        </table>
      </div>
      <div className="muted-note">
        {awaiting
          ? `${awaiting} instrument(s) awaiting a data source — see Data & Config.`
          : `Ranked by composite score. Momentum is over the ${lookback} lookback.`}{" "}
        Not financial advice — analytical signals only.
      </div>
    </section>
  );
}
