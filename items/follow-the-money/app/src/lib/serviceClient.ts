// The ONLY app→service path (design §2.6, per BOS services.md §11 — no
// invented URL). Reachability bootstrap:
//   GET /api/services/follow-the-money/config  (same-origin BOS API)
//   -> use ONLY runtime / httpPath / wsPath / values.{port,host}
//   -> httpBaseUrl = httpPath ? origin+httpPath              (Supervisor proxy)
//                  : protocol//hostname:runtime.port/        (standalone)
// runtime === null is a transient mid-bind window: poll ~1 s for up to ~15 s
// before treating the service as offline.
// Offline story (NFR-004): every successful GET is cached (localStorage) per
// route, so a cold open with the service stopped still renders the last data
// with its as-of + a stale banner — never an error page.

import type {
  ConfigOps,
  Health,
  InstrumentDetail,
  Instrument,
  Lookback,
  Pulse,
  Region,
  RegionRollup,
  ServiceConfig,
  WatchlistResponse
} from "./types";

const SERVICE_ID = "follow-the-money";
const CACHE_PREFIX = "ftm.cache.v1:";

export interface FetchResult<T> {
  data: T | null;
  offline: boolean;
  cachedAt: string | null; // set when `data` came from the cache
}

function sleep(ms: number): Promise<void> {
  return new Promise((r) => setTimeout(r, ms));
}

let basePromise: Promise<string | null> | null = null;

async function resolveBaseOnce(): Promise<string | null> {
  // poll ~1 s for up to ~15 s while runtime is null (worker mid-bind)
  for (let attempt = 0; attempt < 15; attempt++) {
    try {
      const res = await fetch(`/api/services/${SERVICE_ID}/config`, { cache: "no-store" });
      if (res.ok) {
        const data = await res.json();
        if (data.httpPath) {
          return `${location.origin}${data.httpPath}`; // Supervisor-fronted (Bastion / Docker)
        }
        if (data.runtime && data.runtime.port) {
          // standalone — runtime.port is OS-assigned (config port 0), never stable
          return `${location.protocol}//${location.hostname}:${data.runtime.port}/`;
        }
      }
    } catch {
      /* transient — keep polling */
    }
    await sleep(1000);
  }
  return null;
}

export function getServiceBaseUrl(): Promise<string | null> {
  if (!basePromise) {
    basePromise = resolveBaseOnce().then((base) => {
      if (base === null) basePromise = null; // allow a later retry
      return base;
    });
  }
  return basePromise;
}

function cacheGet<T>(key: string): { t: string; data: T } | null {
  try {
    const raw = localStorage.getItem(CACHE_PREFIX + key);
    return raw ? (JSON.parse(raw) as { t: string; data: T }) : null;
  } catch {
    return null;
  }
}

function cachePut<T>(key: string, data: T): void {
  try {
    localStorage.setItem(CACHE_PREFIX + key, JSON.stringify({ t: new Date().toISOString(), data }));
  } catch {
    /* quota — cache is best effort */
  }
}

async function getJSON<T>(path: string, cacheKey: string): Promise<FetchResult<T>> {
  const base = await getServiceBaseUrl();
  if (base) {
    try {
      const res = await fetch(base + path, { cache: "no-store" });
      if (res.ok) {
        const data = (await res.json()) as T;
        cachePut(cacheKey, data);
        return { data, offline: false, cachedAt: null };
      }
      if (res.status === 404) {
        // a real answer from a live service (unknown symbol/region) — not offline
        return { data: null, offline: false, cachedAt: null };
      }
    } catch {
      /* fall through to cache */
    }
  }
  const cached = cacheGet<T>(cacheKey);
  return { data: cached ? cached.data : null, offline: true, cachedAt: cached ? cached.t : null };
}

async function sendJSON<T>(path: string, method: "POST" | "PATCH", body: unknown): Promise<T> {
  const base = await getServiceBaseUrl();
  if (!base) throw new Error("service offline");
  const res = await fetch(base + path, {
    method,
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(body ?? {})
  });
  const data = await res.json().catch(() => null);
  if (!res.ok && !(res.status === 200 || res.status === 202)) {
    throw new Error((data && (data.error as string)) || `HTTP ${res.status}`);
  }
  return data as T;
}

// ---- typed fetchers (design §2.5) ----
export function fetchHealth(): Promise<FetchResult<Health>> {
  return getJSON<Health>("api/health", "health");
}

export function fetchSignals(region: Region): Promise<FetchResult<RegionRollup>> {
  return getJSON<RegionRollup>(`api/signals?region=${encodeURIComponent(region)}`, `signals:${region}`);
}

export function fetchInstrument(
  symbol: string,
  region: Region | null,
  lookback: Lookback
): Promise<FetchResult<InstrumentDetail>> {
  const q = new URLSearchParams();
  if (region) q.set("region", region);
  q.set("lookback", lookback);
  return getJSON<InstrumentDetail>(
    `api/instruments/${encodeURIComponent(symbol)}?${q.toString()}`,
    `instrument:${region || "any"}:${symbol}:${lookback}`
  );
}

export function fetchPulse(): Promise<FetchResult<Pulse>> {
  return getJSON<Pulse>("api/pulse", "pulse");
}

export function fetchWatchlist(): Promise<FetchResult<WatchlistResponse>> {
  return getJSON<WatchlistResponse>("api/watchlist", "watchlist");
}

export function fetchUniverse(): Promise<FetchResult<{ instruments: Instrument[] }>> {
  return getJSON<{ instruments: Instrument[] }>("api/universe", "universe");
}

export function fetchConfig(): Promise<FetchResult<ServiceConfig>> {
  return getJSON<ServiceConfig>("api/config", "config");
}

export function patchConfig(ops: ConfigOps): Promise<ServiceConfig & { ok: boolean }> {
  return sendJSON<ServiceConfig & { ok: boolean }>("api/config", "PATCH", ops);
}

export function postRefresh(scope?: Region | "all"): Promise<{ started: boolean; refreshId: string | null; reason?: string }> {
  return sendJSON("api/refresh", "POST", { scope: scope || "all" });
}
