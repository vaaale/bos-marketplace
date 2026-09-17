// Presentational formatting ONLY (ADR-d: no signal math in the app).
// Mirrors mockup.html's helpers: fmtFlow / fmtMom / momClass / ratioClass /
// ratioColor / ratioText / meterW, plus currency + as-of/date formatting and
// the (presentational) direction arrow for the active lookback.

import type { Direction, Lookback, MomentumPct, SignalState } from "./types";

const CURRENCY_SYMBOL: Record<string, string> = {
  USD: "$",
  EUR: "€",
  GBP: "£",
  NOK: "kr",
  JPY: "¥",
  HKD: "HK$",
  KRW: "₩"
};

export function currencySymbol(code: string): string {
  return CURRENCY_SYMBOL[code] || code + " ";
}

// Recent dollar volume -> "$12.6B" / "$890.2M" / "—" for 0 (NDX price-only).
export function fmtFlow(cur: string, dollarVolume: number): string {
  if (!dollarVolume) return "—";
  const sym = currencySymbol(cur);
  const abs = Math.abs(dollarVolume);
  if (abs >= 1e12) return `${sym}${(dollarVolume / 1e12).toFixed(1)}T`;
  if (abs >= 1e9) return `${sym}${(dollarVolume / 1e9).toFixed(1)}B`;
  if (abs >= 1e6) return `${sym}${(dollarVolume / 1e6).toFixed(1)}M`;
  if (abs >= 1e3) return `${sym}${(dollarVolume / 1e3).toFixed(1)}K`;
  return `${sym}${dollarVolume.toFixed(0)}`;
}

export function fmtMom(v: number | null | undefined): string {
  if (v === null || v === undefined) return "—";
  return `${v > 0 ? "+" : ""}${v.toFixed(1)}%`;
}

export function momClass(v: number | null | undefined): string {
  if (v === null || v === undefined) return "flat";
  return v > 0 ? "pos" : v < 0 ? "neg" : "flat";
}

export function ratioClass(r: number): string {
  return r >= 1.5 ? "m-up" : r >= 1.0 ? "m-am" : "m-dn";
}
export function ratioColor(r: number): string {
  return r >= 1.5 ? "var(--up)" : r >= 1.0 ? "var(--am)" : "var(--dn)";
}
export function ratioText(r: number): string {
  return r === 0 ? "—" : `${r.toFixed(1)}×`;
}
export function meterW(r: number): number {
  return Math.max(6, Math.min(100, Math.round((r / 3) * 100)));
}

// Direction arrow for the ACTIVE lookback — presentational (the service
// persists a 3M-based `direction`; the arrow follows the user's lookback with
// the same default flat epsilon, 0.5%).
const DIR_FLAT_EPSILON = 0.5;
export function dirOf(momentumPct: MomentumPct, lookback: Lookback): Direction {
  const v = momentumPct[lookback];
  if (v === null || v === undefined || Math.abs(v) < DIR_FLAT_EPSILON) return "flat";
  return v > 0 ? "up" : "down";
}
export function dirSymbol(dir: Direction): string {
  return dir === "up" ? "▲" : dir === "down" ? "▼" : "▶";
}

export const STATE_LABEL: Record<SignalState, string> = {
  "in-base": "In Base",
  "breaking-out-confirmed": "Breaking Out (confirmed)",
  "breaking-out-unconfirmed": "Breaking Out (unconfirmed)",
  trending: "Trending",
  "no-base": "No Base",
  "insufficient-data": "Insufficient Data",
  unavailable: "Awaiting Data"
};

export const STATE_CHIP_CLASS: Record<SignalState, string> = {
  "in-base": "base",
  "breaking-out-confirmed": "bo-c",
  "breaking-out-unconfirmed": "bo-u",
  trending: "trend",
  "no-base": "nobase",
  "insufficient-data": "await",
  unavailable: "await"
};

export const STATE_DOT_COLOR: Record<SignalState, string> = {
  "in-base": "var(--cy)",
  "breaking-out-confirmed": "var(--up)",
  "breaking-out-unconfirmed": "var(--am)",
  trending: "var(--up)",
  "no-base": "var(--dn)",
  "insufficient-data": "var(--txt-3)",
  unavailable: "var(--txt-3)"
};

export const REGION_COLOR: Record<string, string> = {
  US: "var(--cy)",
  Europe: "var(--up)",
  Norway: "var(--am)",
  Asia: "#b57bff"
};

export function fmtVal(cur: string, v: number): string {
  const sym = currencySymbol(cur);
  if (v >= 1000) return sym + Math.round(v).toLocaleString("en-US");
  if (v >= 100) return sym + v.toFixed(0);
  return sym + v.toFixed(2);
}

export function fmtAsOf(iso: string | null): string {
  if (!iso) return "—";
  return iso.length > 10 ? iso.slice(0, 16).replace("T", " ") + " UTC" : iso;
}

export function fmtDateShort(isoDate: string): string {
  const d = new Date(isoDate + (isoDate.length === 10 ? "T00:00:00Z" : ""));
  if (Number.isNaN(d.getTime())) return isoDate;
  return d.toLocaleDateString("en-GB", { day: "2-digit", month: "short", timeZone: "UTC" }).replace(" ", "");
}

export function hoursOld(iso: string | null): number | null {
  if (!iso) return null;
  const t = Date.parse(iso);
  if (Number.isNaN(t)) return null;
  return Math.max(0, Math.round((Date.now() - t) / 3600000));
}

export function scoreColor(score: number): string {
  return score >= 70 ? "var(--up)" : score >= 45 ? "var(--am)" : "var(--dn)";
}
