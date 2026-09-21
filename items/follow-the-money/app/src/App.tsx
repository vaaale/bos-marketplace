// Shell (design §2.7): header (brand + NFA pill + region/lookback controls +
// Data & Config), always-visible HealthStrip, PulseStrip beneath it, left
// rail (4 views + Data Health), main view router, footer with as-of.
// UI prefs (active region/lookback/sort) persist in localStorage (FR-007);
// watchlist/thresholds/universe/key live server-side in the service config.
import React, { useCallback, useEffect, useRef, useState } from "react";
import type {
  Health,
  Instrument,
  Lookback,
  Pulse,
  Region,
  RegionRollup,
  ServiceConfig,
  WatchlistResponse
} from "./lib/types";
import {
  fetchConfig,
  fetchHealth,
  fetchPulse,
  fetchSignals,
  fetchUniverse,
  fetchWatchlist,
  patchConfig
} from "./lib/serviceClient";
import { fmtAsOf, hoursOld } from "./lib/format";
import HealthStrip from "./components/HealthStrip";
import PulseStrip from "./components/PulseStrip";
import RegionBar from "./components/RegionBar";
import Dashboard from "./components/Dashboard";
import Scanner from "./components/Scanner";
import Detail from "./components/Detail";
import Watchlist from "./components/Watchlist";
import ConfigDrawer from "./components/ConfigDrawer";

export type View = "dashboard" | "scanner" | "detail" | "watchlist";
export type SortKey = "score" | "mom" | "flow";

const PREFS_KEY = "ftm.prefs";
const PREFS_SCHEMA_VERSION = 1;

interface Prefs {
  schemaVersion: number;
  activeRegion: Region;
  activeLookback: Lookback;
  sortKey: SortKey;
  sortDir: -1 | 1;
}

function loadPrefs(): Prefs {
  const fallback: Prefs = {
    schemaVersion: PREFS_SCHEMA_VERSION,
    activeRegion: "US",
    activeLookback: "3M",
    sortKey: "score",
    sortDir: -1
  };
  try {
    const raw = localStorage.getItem(PREFS_KEY);
    if (!raw) return fallback;
    const p = JSON.parse(raw);
    if (p.schemaVersion !== PREFS_SCHEMA_VERSION) return fallback; // migration path: reset
    return { ...fallback, ...p };
  } catch {
    return fallback;
  }
}

const VIEW_META: { id: View; label: string }[] = [
  { id: "dashboard", label: "Money Flow" },
  { id: "scanner", label: "Scanner" },
  { id: "detail", label: "Instrument Detail" },
  { id: "watchlist", label: "Watchlist" }
];

export default function App() {
  const [prefs, setPrefs] = useState<Prefs>(loadPrefs);
  const [view, setView] = useState<View>("dashboard");
  const [detailTarget, setDetailTarget] = useState<{ symbol: string; region: Region | null } | null>(null);
  const [health, setHealth] = useState<Health | null>(null);
  const [pulse, setPulse] = useState<Pulse | null>(null);
  const [rollup, setRollup] = useState<RegionRollup | null>(null);
  const [config, setConfig] = useState<ServiceConfig | null>(null);
  const [watchlistData, setWatchlistData] = useState<WatchlistResponse | null>(null);
  const [universe, setUniverse] = useState<{ instruments: Instrument[] } | null>(null);
  const [offline, setOffline] = useState(false);
  const [cachedAt, setCachedAt] = useState<string | null>(null);
  const [drawerOpen, setDrawerOpen] = useState(false);
  const [toastMsg, setToastMsg] = useState("");
  const toastTimer = useRef<ReturnType<typeof setTimeout> | null>(null);

  useEffect(() => {
    try {
      localStorage.setItem(PREFS_KEY, JSON.stringify(prefs));
    } catch {
      /* best effort */
    }
  }, [prefs]);

  const toast = useCallback((msg: string) => {
    setToastMsg(msg);
    if (toastTimer.current) clearTimeout(toastTimer.current);
    toastTimer.current = setTimeout(() => setToastMsg(""), 2200);
  }, []);

  const loadGlobal = useCallback(async () => {
    const [h, p, c, w, u] = await Promise.all([fetchHealth(), fetchPulse(), fetchConfig(), fetchWatchlist(), fetchUniverse()]);
    if (h.data) setHealth(h.data);
    if (p.data) setPulse(p.data);
    if (c.data) setConfig(c.data);
    if (w.data) setWatchlistData(w.data);
    if (u.data) setUniverse(u.data);
    setOffline(h.offline);
    setCachedAt(h.cachedAt);
  }, []);

  const loadRollup = useCallback(async (region: Region) => {
    const r = await fetchSignals(region);
    if (r.data) setRollup(r.data);
    if (r.offline) {
      setOffline(true);
      if (r.cachedAt) setCachedAt(r.cachedAt);
    }
  }, []);

  useEffect(() => {
    loadGlobal();
    const iv = setInterval(loadGlobal, 60000);
    return () => clearInterval(iv);
  }, [loadGlobal]);

  useEffect(() => {
    loadRollup(prefs.activeRegion);
  }, [prefs.activeRegion, loadRollup]);

  const watchSymbols = config ? config.watchlist : [];

  const openDetail = useCallback((symbol: string, region: Region | null) => {
    setDetailTarget({ symbol, region });
    setView("detail");
  }, []);

  const toggleWatch = useCallback(
    async (symbol: string) => {
      const has = watchSymbols.includes(symbol);
      try {
        const res = await patchConfig(has ? { watchlistRemove: symbol } : { watchlistAdd: symbol });
        setConfig(res);
        toast(has ? `Removed ${symbol} from watchlist` : `Added ${symbol} to watchlist`);
        const w = await fetchWatchlist();
        if (w.data) setWatchlistData(w.data);
      } catch {
        toast("Service offline — watchlist unchanged");
      }
    },
    [watchSymbols, toast]
  );

  const setRegion = (r: Region) => setPrefs((p) => ({ ...p, activeRegion: r }));
  const setLookback = (l: Lookback) => setPrefs((p) => ({ ...p, activeLookback: l }));
  const setSort = (key: SortKey) =>
    setPrefs((p) =>
      p.sortKey === key ? { ...p, sortDir: p.sortDir === -1 ? 1 : -1 } : { ...p, sortKey: key, sortDir: -1 }
    );

  const asOf = rollup?.asOf || health?.asOf || null;
  const staleHours = offline ? hoursOld(cachedAt || asOf) : null;
  const showPulse = view === "dashboard" || view === "scanner"; // FR-021: dashboard + scanner

  return (
    <>
      <header>
        <div className="hdr-top">
          <div className="brand">
            <div className="logo">
              <svg width="18" height="18" viewBox="0 0 24 24" fill="none">
                <path d="M3 17 L9 11 L13 14 L21 5" stroke="#37d67a" strokeWidth="2.2" strokeLinecap="round" strokeLinejoin="round" />
                <path d="M21 5 L21 10 M21 5 L16 5" stroke="#37d67a" strokeWidth="2.2" strokeLinecap="round" />
              </svg>
            </div>
            <div>
              <div className="t">Follow the Money</div>
              <div className="s">Sector Capital Rotation</div>
            </div>
          </div>
          <span className="pill-nfa" data-testid="nfa-pill">
            <span className="dot" />
            Not Financial Advice
          </span>
          <div className="spacer" />
          <RegionBar
            region={prefs.activeRegion}
            lookback={prefs.activeLookback}
            onRegion={setRegion}
            onLookback={setLookback}
          />
          <button className="btn" style={{ marginTop: 14 }} onClick={() => setDrawerOpen(true)} data-testid="config-btn">
            <svg width="15" height="15" viewBox="0 0 24 24" fill="none">
              <path d="M12 15a3 3 0 100-6 3 3 0 000 6z" stroke="#9aa7ba" strokeWidth="1.8" />
              <circle cx="12" cy="12" r="9.2" stroke="#9aa7ba" strokeWidth="1.4" strokeDasharray="3 3" />
            </svg>
            Data &amp; Config
          </button>
        </div>
        <HealthStrip health={health} offline={offline} onOpenDrawer={() => setDrawerOpen(true)} />
        {showPulse && <PulseStrip pulse={pulse} onOpenDetail={openDetail} />}
      </header>

      <div className="layout">
        <nav className="rail">
          <div className="rlbl">Views</div>
          {VIEW_META.map((v) => (
            <button
              key={v.id}
              className={view === v.id ? "on" : ""}
              onClick={() => setView(v.id)}
              data-testid={`nav-${v.id}`}
            >
              {v.label}
              {v.id === "watchlist" && <span className="badge">{watchSymbols.length}</span>}
            </button>
          ))}
          <div className="grow" />
          <div className="cfg">
            <button onClick={() => setDrawerOpen(true)}>Data Health</button>
          </div>
        </nav>

        <main>
          {offline && (
            <div className="offline-banner" data-testid="offline-banner">
              <span className="d" />
              Service offline — showing last saved data
              {staleHours !== null ? ` (${staleHours} hour${staleHours === 1 ? "" : "s"} old)` : ""}. As-of {fmtAsOf(asOf)}.
            </div>
          )}
          {view === "dashboard" && (
            <Dashboard
              rollup={rollup}
              lookback={prefs.activeLookback}
              sortKey={prefs.sortKey}
              sortDir={prefs.sortDir}
              onSort={setSort}
              watchlist={watchSymbols}
              onToggleWatch={toggleWatch}
              onOpenDetail={openDetail}
            />
          )}
          {view === "scanner" && <Scanner rollup={rollup} onOpenDetail={openDetail} />}
          {view === "detail" && (
            <Detail
              target={detailTarget}
              fallbackRegion={prefs.activeRegion}
              lookback={prefs.activeLookback}
              onLookback={setLookback}
              watchlist={watchSymbols}
              onToggleWatch={toggleWatch}
            />
          )}
          {view === "watchlist" && (
            <Watchlist data={watchlistData} onOpenDetail={openDetail} onRemove={toggleWatch} />
          )}
        </main>
      </div>

      <ConfigDrawer
        open={drawerOpen}
        onClose={() => setDrawerOpen(false)}
        health={health}
        config={config}
        universe={universe}
        onConfigChanged={(c) => {
          setConfig(c);
          loadGlobal();
        }}
        toast={toast}
      />

      <div className={`toast${toastMsg ? " on" : ""}`}>{toastMsg}</div>

      <div className="foot">
        <span>
          Follow the Money · analytical tool, not an advisor · as-of <span className="num">{fmtAsOf(asOf)}</span>
        </span>
        <span className="num">
          {(health?.regions || [])
            .map((r) => `${r.region} ${r.reason ? "awaiting" : `${r.ok}/${r.total}`}`)
            .join(" · ")}
        </span>
      </div>
    </>
  );
}
