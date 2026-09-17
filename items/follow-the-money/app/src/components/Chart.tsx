// SVG price + volume chart (FR-008), following the mockup drawChart geometry
// but driven by REAL persisted series data: price line, volume bars (green
// when >= trailing avg), base range band (blue, dashed bounds), breakout
// level (amber dashed, "BO" tag), trailing-avg-volume dashed line, breakout-
// bar marker (▲ + ratio), last-price tag, grid + axis labels.
import React from "react";
import type { InstrumentDetail } from "../lib/types";
import { currencySymbol, fmtDateShort } from "../lib/format";

function fmtVal(v: number): string {
  if (v >= 1000) return Math.round(v).toLocaleString("en-US");
  if (v >= 100) return v.toFixed(0);
  return v.toFixed(2);
}

export default function Chart({ detail }: { detail: InstrumentDetail }) {
  const S = detail.series;
  if (S.length < 2) {
    return (
      <div className="empty-chart">
        <div className="em">Not enough series data to draw a chart.</div>
      </div>
    );
  }
  const cur = currencySymbol(detail.currency);
  const W = 1040;
  const H = 360;
  const padL = 54;
  const padR = 66;
  const padT = 16;
  const padB = 70;
  const plotW = W - padL - padR;
  const plotH = H - padT - padB;
  const priceH = plotH * 0.66;
  const volTop = padT + priceH + 14;
  const volH = plotH * 0.3 - 14;

  const base = detail.base;
  const breakout = detail.breakout;
  const closes = S.map((p) => p.close);
  const allP = closes.slice();
  if (base.present && base.lowerBound !== null && base.upperBound !== null) allP.push(base.lowerBound, base.upperBound);
  if (breakout.present && breakout.level !== null) allP.push(breakout.level);
  let pmin = Math.min(...allP);
  let pmax = Math.max(...allP);
  const pr = pmax - pmin || 1;
  pmin -= pr * 0.06;
  pmax += pr * 0.06;

  const hasVolume = S.some((p) => p.dollarVolume > 0);
  const vmax = Math.max(...S.map((p) => p.dollarVolume), detail.trailingAvgDollarVolume, 1) * 1.1;

  const X = (i: number) => padL + (i / (S.length - 1)) * plotW;
  const Y = (p: number) => padT + (1 - (p - pmin) / (pmax - pmin)) * priceH;
  const VY = (v: number) => volTop + (1 - v / vmax) * volH;

  const last = closes[closes.length - 1];
  const first = closes[0];
  const dirColor = last >= first ? "var(--up)" : "var(--dn)";

  const gridLines: React.ReactNode[] = [];
  for (let g = 0; g <= 4; g++) {
    const val = pmin + ((pmax - pmin) * g) / 4;
    const y = Y(val);
    gridLines.push(
      <line key={`g${g}`} x1={padL} y1={y} x2={W - padR} y2={y} stroke="#161c28" strokeWidth={1} />,
      <text key={`gl${g}`} x={padL - 8} y={y + 3} textAnchor="end" fontFamily="var(--mono)" fontSize={10} fill="#5f6b7d">
        {cur}
        {fmtVal(val)}
      </text>
    );
  }
  const xIdx = [0, Math.floor(S.length * 0.25), Math.floor(S.length * 0.5), Math.floor(S.length * 0.75), S.length - 1];
  const xLabels = xIdx.map((i) => (
    <text key={`x${i}`} x={X(i)} y={H - padB + 18} textAnchor="middle" fontFamily="var(--mono)" fontSize={10} fill="#5f6b7d">
      {fmtDateShort(S[i].date)}
    </text>
  ));

  let path = "";
  closes.forEach((p, i) => {
    path += `${i ? "L" : "M"}${X(i).toFixed(1)},${Y(p).toFixed(1)} `;
  });

  const bw = Math.max(1.5, (plotW / S.length) * 0.62);
  const avy = VY(detail.trailingAvgDollarVolume);
  const lastY = Y(last);

  return (
    <svg className="chart" viewBox={`0 0 ${W} ${H}`} data-testid="detail-chart">
      {gridLines}
      {xLabels}

      {base.present && base.lowerBound !== null && base.upperBound !== null && (
        <g data-testid="base-band">
          <rect
            x={padL}
            y={Y(base.upperBound)}
            width={plotW}
            height={Math.max(2, Y(base.lowerBound) - Y(base.upperBound))}
            fill="rgba(91,157,255,.12)"
            stroke="rgba(91,157,255,.35)"
            strokeWidth={1}
          />
          <line x1={padL} y1={Y(base.upperBound)} x2={W - padR} y2={Y(base.upperBound)} stroke="var(--cy)" strokeWidth={1} strokeDasharray="3 4" opacity={0.7} />
          <line x1={padL} y1={Y(base.lowerBound)} x2={W - padR} y2={Y(base.lowerBound)} stroke="var(--cy)" strokeWidth={1} strokeDasharray="3 4" opacity={0.5} />
        </g>
      )}

      {breakout.present && breakout.level !== null && (
        <g data-testid="breakout-line">
          <line x1={padL} y1={Y(breakout.level)} x2={W - padR} y2={Y(breakout.level)} stroke="var(--am)" strokeWidth={1.4} strokeDasharray="6 4" />
          <rect x={W - padR + 2} y={Y(breakout.level) - 9} width={padR - 4} height={18} fill="rgba(245,184,74,.12)" rx={3} />
          <text x={W - padR + 6} y={Y(breakout.level) + 4} fontFamily="var(--mono)" fontSize={10} fill="var(--am)">
            BO {cur}
            {fmtVal(breakout.level)}
          </text>
        </g>
      )}

      {hasVolume && (
        <g>
          {S.map((p, i) => {
            const col = p.dollarVolume >= detail.trailingAvgDollarVolume ? "var(--up)" : "rgba(120,140,170,.5)";
            return (
              <rect
                key={p.date}
                x={X(i) - bw / 2}
                y={VY(p.dollarVolume)}
                width={bw}
                height={Math.max(1, volTop + volH - VY(p.dollarVolume))}
                fill={col}
                opacity={0.72}
              >
                <title>
                  {p.date} · {cur}
                  {fmtVal(p.dollarVolume)} $vol{p.gapFlag ? " · GAP FLAG" : ""}
                </title>
              </rect>
            );
          })}
          <line x1={padL} y1={avy} x2={W - padR} y2={avy} stroke="var(--up)" strokeWidth={1.2} strokeDasharray="5 4" opacity={0.8} />
          <text x={W - padR + 6} y={avy + 3} fontFamily="var(--mono)" fontSize={9} fill="var(--up)">
            avg
          </text>
        </g>
      )}

      <path d={path} fill="none" stroke={dirColor} strokeWidth={1.8} strokeLinejoin="round" />

      {breakout.present && (
        <g data-testid="breakout-marker">
          <circle cx={X(S.length - 1)} cy={lastY} r={4} fill={breakout.direction === "down" ? "var(--dn)" : "var(--up)"} stroke="#0a0c10" strokeWidth={1.5} />
          <text
            x={X(S.length - 1) - 6}
            y={lastY - 10}
            textAnchor="end"
            fontFamily="var(--sans)"
            fontSize={10}
            fontWeight={700}
            fill={breakout.direction === "down" ? "var(--dn)" : "var(--up)"}
          >
            {breakout.direction === "down" ? "▼" : "▲"} {breakout.volumeRatio.toFixed(1)}× vol
          </text>
        </g>
      )}

      <line x1={padL} y1={lastY} x2={W - padR} y2={lastY} stroke={dirColor} strokeWidth={1} strokeDasharray="2 3" opacity={0.5} />
      <rect x={W - padR + 2} y={lastY - 10} width={padR - 4} height={20} fill={last >= first ? "rgba(55,214,122,.14)" : "rgba(255,93,93,.14)"} rx={3} />
      <text x={W - padR + 6} y={lastY + 4} fontFamily="var(--mono)" fontSize={11} fontWeight={700} fill={dirColor}>
        {cur}
        {fmtVal(last)}
      </text>
    </svg>
  );
}
