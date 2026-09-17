// Instrument deep-dive (FR-008, US4): head with symbol/name/tags, big 0–100
// score with bar + state chip, watchlist button; SVG chart (Chart.tsx); a
// 6-column stat grid; lookback switcher re-scopes the window + momentum.
// sufficientData:false -> "insufficient data for base detection" placeholder;
// unavailable -> "Awaiting data source" panel. Never a fabricated range.
import React, { useEffect, useState } from "react";
import type { InstrumentDetail, Lookback, Region } from "../lib/types";
import { fetchInstrument } from "../lib/serviceClient";
import {
  currencySymbol,
  fmtFlow,
  fmtMom,
  momClass,
  ratioColor,
  ratioText,
  scoreColor,
  STATE_CHIP_CLASS,
  STATE_DOT_COLOR,
  STATE_LABEL
} from "../lib/format";
import Chart from "./Chart";

const LOOKBACKS: Lookback[] = ["3M", "6M", "1Y", "2Y"];

interface Props {
  target: { symbol: string; region: Region | null } | null;
  fallbackRegion: Region;
  lookback: Lookback;
  onLookback: (l: Lookback) => void;
  watchlist: string[];
  onToggleWatch: (symbol: string) => void;
}

export default function Detail({ target, fallbackRegion, lookback, onLookback, watchlist, onToggleWatch }: Props) {
  const [detail, setDetail] = useState<InstrumentDetail | null>(null);
  const [loading, setLoading] = useState(false);
  const [missing, setMissing] = useState(false);

  useEffect(() => {
    let cancelled = false;
    if (!target) return;
    setLoading(true);
    setMissing(false);
    fetchInstrument(target.symbol, target.region, lookback).then((r) => {
      if (cancelled) return;
      setLoading(false);
      if (r.data) setDetail(r.data);
      else setMissing(true);
    });
    return () => {
      cancelled = true;
    };
  }, [target, lookback]);

  if (!target) {
    return (
      <div className="empty-chart" data-testid="view-detail">
        <div className="em">
          Pick an instrument from the {fallbackRegion} dashboard, the scanner, or the pulse strip to open its deep-dive.
        </div>
      </div>
    );
  }
  if (missing) {
    return (
      <div className="empty-chart" data-testid="view-detail">
        <div className="em">Instrument not found: {target.symbol}</div>
      </div>
    );
  }
  if (!detail || loading) {
    return (
      <div className="empty-chart" data-testid="view-detail">
        <div className="em">Loading {target.symbol}…</div>
      </div>
    );
  }

  const awaiting = detail.state === "unavailable";
  const insufficient = detail.state === "insufficient-data" || detail.base.sufficientData === false;
  const cur = currencySymbol(detail.currency);
  const score = detail.score.moneyFlowScore;
  const wl = watchlist.includes(detail.instrument.symbol);
  const m = detail.momentumPct;
  const widthPct = detail.base.tightness !== null ? detail.base.tightness * 100 : null;
  // display only — the service computed this ratio; recompute for the label
  const flowRatio = detail.trailingAvgDollarVolume > 0 ? detail.recentDollarVolume / detail.trailingAvgDollarVolume : 0;

  return (
    <section data-testid="view-detail">
      <div className="det-head">
        <div className="det-id">
          <div className="sym" data-testid="detail-symbol">{detail.instrument.symbol}</div>
          <div className="iname">{detail.instrument.name}</div>
          <div className="det-tags">
            <span className={`cat ${detail.instrument.category}`}>{detail.instrument.category}</span>
            <span className="tag">Region · {detail.instrument.region}</span>
            <span className="tag">
              As-of <span className="num">{detail.asOf || "—"}</span>
              {detail.stale ? " · stale" : ""}
            </span>
          </div>
        </div>
        <div className="det-score">
          <span className="lbl">Money-Flow Score</span>
          <span className="big" style={{ color: awaiting ? "var(--txt-3)" : scoreColor(score) }}>
            {awaiting ? "—" : score}
          </span>
          <span className="bar">
            <i style={{ width: `${awaiting ? 0 : score}%` }} />
          </span>
          <span className="state">
            <span className={`chip ${STATE_CHIP_CLASS[detail.state]}`}>
              <span className="cd" style={{ background: STATE_DOT_COLOR[detail.state] }} />
              {STATE_LABEL[detail.state]}
            </span>
          </span>
        </div>
        <div className="det-spacer" />
        <div className="ctl-group">
          <span className="ctl-lbl">Lookback</span>
          <div className="seg">
            {LOOKBACKS.map((l) => (
              <button key={l} className={lookback === l ? "on" : ""} onClick={() => onLookback(l)}>
                {l}
              </button>
            ))}
          </div>
        </div>
        <button className={`btn star${wl ? " on" : ""}`} onClick={() => onToggleWatch(detail.instrument.symbol)} data-testid="detail-star">
          {wl ? "★ Watchlisted" : "☆ Add to watchlist"}
        </button>
      </div>

      <div className="det-grid">
        <div className="chart-panel">
          <div className="chart-head">
            <span className="ttl">
              Price · Base Range · Volume&nbsp;&nbsp;
              <span style={{ color: "var(--txt-3)", fontWeight: 500 }}>{lookback} window</span>
            </span>
            <div className="legend">
              <span>
                <i style={{ borderColor: "var(--txt-2)" }} />
                Price
              </span>
              <span>
                <span className="sw" style={{ background: "rgba(91,157,255,.25)", border: "1px solid var(--cy)" }} />
                Base range
              </span>
              <span>
                <i className="dash" style={{ borderColor: "var(--am)" }} />
                Breakout level
              </span>
              <span>
                <span className="sw" style={{ background: "var(--up)", opacity: 0.7 }} />
                Volume
              </span>
              <span>
                <i className="dash" style={{ borderColor: "var(--up)" }} />
                Trailing avg vol
              </span>
            </div>
          </div>
          {awaiting ? (
            <div className="empty-chart" data-testid="awaiting-panel">
              <div>
                <div className="em" style={{ color: "var(--am)", fontWeight: 600 }}>
                  Awaiting data source
                </div>
                <div style={{ marginTop: 8, maxWidth: 420 }}>
                  This instrument requires the keyed market-data provider. Add a free API key under Data &amp; Config to
                  unlock it — nothing else in the app needs a key.
                </div>
              </div>
            </div>
          ) : insufficient ? (
            <div className="empty-chart" data-testid="insufficient-panel">
              <div>
                <div className="em">insufficient data for base detection</div>
                <div style={{ marginTop: 8 }}>
                  {detail.series.length} bars of history — base/breakout detection needs more. Momentum is computed on
                  what exists and labeled by length.
                </div>
                {detail.series.length >= 2 && (
                  <div style={{ marginTop: 16 }}>
                    <Chart detail={detail} />
                  </div>
                )}
              </div>
            </div>
          ) : (
            <Chart detail={detail} />
          )}
        </div>

        <div className="stats" data-testid="stat-grid">
          {awaiting ? (
            <div className="stat" style={{ gridColumn: "1/-1" }}>
              <div className="k">Data</div>
              <div className="v" style={{ fontSize: 14, color: "var(--am)" }}>
                Awaiting data source — add a free market-data key to unlock this region.
              </div>
            </div>
          ) : (
            <>
              <div className="stat">
                <div className="k">Momentum 3M</div>
                <div className={`v ${momClass(m["3M"])}`}>{fmtMom(m["3M"])}</div>
              </div>
              <div className="stat">
                <div className="k">Momentum 6M</div>
                <div className={`v ${momClass(m["6M"])}`}>{fmtMom(m["6M"])}</div>
              </div>
              <div className="stat">
                <div className="k">Momentum 1Y</div>
                <div className={`v ${momClass(m["1Y"])}`}>{fmtMom(m["1Y"])}</div>
              </div>
              <div className="stat">
                <div className="k">Momentum 2Y</div>
                <div className={`v ${momClass(m["2Y"])}`}>{fmtMom(m["2Y"])}</div>
              </div>
              <div className="stat">
                <div className="k">Recent $ Volume</div>
                <div className="v">{fmtFlow(detail.currency, detail.recentDollarVolume)}</div>
              </div>
              <div className="stat">
                <div className="k">Flow Ratio</div>
                <div className="v" style={{ color: ratioColor(flowRatio) }}>{ratioText(flowRatio)}</div>
              </div>
              <div className="stat">
                <div className="k">Base Duration</div>
                <div className="v">
                  {detail.base.present ? (
                    <>
                      {detail.base.durationDays} <small>days</small>
                    </>
                  ) : (
                    "—"
                  )}
                </div>
              </div>
              <div className="stat">
                <div className="k">Base Width</div>
                <div className="v">
                  {detail.base.present && widthPct !== null ? (
                    <>
                      {widthPct.toFixed(1)}
                      <small>%</small>
                    </>
                  ) : (
                    "—"
                  )}
                </div>
              </div>
              <div className="stat">
                <div className="k">Breakout Level</div>
                <div className="v" style={{ color: "var(--am)" }}>
                  {detail.breakout.present && detail.breakout.level !== null
                    ? `${cur}${detail.breakout.level.toFixed(2)}`
                    : "—"}
                </div>
              </div>
              <div className="stat">
                <div className="k">Volume Confirmation</div>
                <div className="v" style={{ color: detail.breakout.present ? ratioColor(detail.breakout.volumeRatio) : "var(--txt-3)" }}>
                  {detail.breakout.present ? `${detail.breakout.volumeRatio.toFixed(1)}×` : "—"}
                </div>
              </div>
              <div className="stat">
                <div className="k">Trailing Avg $ Vol</div>
                <div className="v">{fmtFlow(detail.currency, detail.trailingAvgDollarVolume)}</div>
              </div>
              <div className="stat">
                <div className="k">Score Components</div>
                <div className="v" style={{ fontSize: 13 }}>
                  M {Math.round(detail.score.momentumScore)} · F {Math.round(detail.score.flowScore)}
                </div>
              </div>
            </>
          )}
        </div>
      </div>
      <div className="muted-note">
        Signals are computed once per refresh by the background service and served read-only. This is an analytical
        view, not a recommendation — not financial advice.
      </div>
    </section>
  );
}
