// TS types mirroring the service contract (design §2.5 + §3).
// The app is a pure read surface — these shapes are produced by the service.

export type Region = "US" | "Europe" | "Norway" | "Asia";
export type Lookback = "3M" | "6M" | "1Y" | "2Y";
export type Direction = "up" | "down" | "flat";

export type SignalState =
  | "in-base"
  | "breaking-out-confirmed"
  | "breaking-out-unconfirmed"
  | "trending"
  | "no-base"
  | "insufficient-data"
  | "unavailable";

export interface MomentumPct {
  "3M": number | null;
  "6M": number | null;
  "1Y": number | null;
  "2Y": number | null;
}

export interface BaseInfo {
  present: boolean;
  lowerBound: number | null;
  upperBound: number | null;
  durationDays: number;
  tightness: number | null;
  sufficientData?: boolean;
}

export interface BreakoutInfo {
  present: boolean;
  level: number | null;
  direction: "up" | "down" | null;
  volumeRatio: number;
  confirmed: boolean;
}

export interface Score {
  moneyFlowScore: number;
  momentumScore: number;
  flowScore: number;
}

export interface Instrument {
  symbol: string;
  name: string;
  region: Region;
  category: "broad" | "sector" | "proxy" | "stock";
  provider: "primary" | "fallback" | "both";
  providerIds: string[];
  currency: string;
  enabled: boolean;
  weight: number | null;
  source: "default" | "user";
  availability?: "ok" | "stale" | "unavailable" | "disabled" | "pending";
  // Fix B: a keyed symbol whose first probe hit NOT_FOUND on the provider is
  // permanently marked so later cycles skip it (no credit waste). The app shows
  // it grey ("ticker not found"), distinct from the amber "pending probe" state.
  notFound?: boolean;
}

export interface SignalLite {
  symbol: string;
  name: string;
  category: Instrument["category"];
  region: Region;
  direction: Direction;
  momentumPct: MomentumPct;
  moneyFlowScore: number;
  moneyFlowRatio: number;
  recentDollarVolume: number;
  state: SignalState;
  base: BaseInfo | null;
  breakout: BreakoutInfo | null;
  asOf: string | null;
}

export interface Signal extends Omit<SignalLite, "name" | "category" | "direction" | "base" | "breakout"> {
  currency: string;
  providerUsed: string | null;
  momentum: Record<Lookback, { complete: boolean; barsUsed: number }>;
  trailingAvgDollarVolume: number;
  base: BaseInfo;
  breakout: BreakoutInfo;
  score: Score;
  stale: boolean;
}

export interface RegionRollup {
  region: Region;
  currency: string;
  asOf: string | null;
  instruments: SignalLite[];
  counts: {
    total: number;
    inBase: number;
    breakingOutConfirmed: number;
    breakingOutUnconfirmed: number;
    trending: number;
    unavailable: number;
    insufficient: number;
  };
}

export interface SeriesPoint {
  date: string;
  close: number;
  volume: number;
  dollarVolume: number;
  gapFlag: boolean;
}

export interface InstrumentDetail {
  instrument: Instrument;
  currency: string;
  asOf: string | null;
  lookback: Lookback;
  series: SeriesPoint[];
  trailingAvgDollarVolume: number;
  recentDollarVolume: number;
  base: BaseInfo;
  breakout: BreakoutInfo;
  momentumPct: MomentumPct;
  score: Score;
  stale: boolean;
  state: SignalState;
}

export interface PulseEntry {
  symbol: string;
  region: Region;
  moneyFlowScore: number;
  state: SignalState;
  momentumPct3M: number | null;
  moneyFlowRatio: number;
  asOf: string | null;
}

export interface Pulse {
  asOf: string | null;
  entries: PulseEntry[];
}

export interface ProviderStatus {
  id: string;
  // Fix A: a keyed provider whose key was REJECTED (401/403) is "auth_error" —
  // distinct from "limited" (no key configured) so the UI can say "re-enter or
  // rotate" instead of the silent "not configured".
  status: "ok" | "limited" | "off" | "auth_error";
  lastRefresh: string | null;
  symbolsOk: number;
  symbolsFailed: number;
  keyRequired: boolean;
  keyConfigured: boolean | null;
  creditsUsedToday?: number;
  dailyCreditBudget?: number;
  // Fix A: short human-readable cause when status === "auth_error".
  lastError?: string;
}

export interface RegionSummary {
  region: Region;
  total: number;
  ok: number;
  failed: number;
  stale: number;
  asOf: string | null;
  reason?: string;
}

export interface Health {
  asOf: string | null;
  pipelineAlive: boolean;
  lastHeartbeat: string | null;
  lastFullRefresh: string | null;
  nextRefreshAt: string | null;
  refreshing: boolean;
  providers: ProviderStatus[];
  regions: RegionSummary[];
  keyConfigured: boolean;
  unavailable: { symbol: string; region: Region; reason: string }[];
  events: string[];
}

export interface WatchlistResponse {
  asOf: string | null;
  entries: SignalLite[];
}

export interface ServiceConfig {
  thresholds: Record<string, unknown> & {
    baseMinDuration: number;
    baseMaxWidth: number;
    breakoutVolumeRatio: number;
    baselineWindow: number;
    flowWindow: number;
    lookbackDays: Record<Lookback, number>;
    dirFlatEpsilon: number;
    noBaseDriftEpsilon: number;
  };
  watchlist: string[];
  customInstruments: Instrument[];
  cadence: { refreshHour: number; refreshMinute: number; heartbeatEveryMs: number };
  // Per-provider presence (keyed providers only). Presence only — the key
  // values are never returned (NFR-009). E.g. { twelvedata: false }.
  keyConfigured: Record<string, boolean>;
}

export interface RefreshRecord {
  ts: string;
  scope: string;
  provider: string;
  symbolsOk: number;
  symbolsFailed: number;
  creditsUsedToday?: number;
  keyConfigured: boolean;
  asOf: string | null;
  events: string[];
}

// PATCH /api/config op object (partial, idempotent, independent ops)
export interface ConfigOps {
  // Key ops are PER PROVIDER (NFR-008): providerId from the provider registry
  // (e.g. "twelvedata"). The key value is written server-side, never echoed.
  setKey?: { providerId: string; apiKey: string };
  clearKey?: { providerId: string };
  thresholds?: Record<string, unknown>;
  cadence?: Partial<ServiceConfig["cadence"]>;
  watchlistAdd?: string;
  watchlistRemove?: string;
  instrumentAdd?: Partial<Instrument> & { symbol: string };
  instrumentEdit?: Partial<Instrument> & { symbol: string };
  instrumentRemove?: string;
  instrumentDisable?: { symbol: string; enabled: boolean };
}
