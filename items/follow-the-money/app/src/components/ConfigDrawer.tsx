// Data Sources & Configuration drawer (FR-012/016/017, US7): provider-health
// cards (health.providers[]), per-region cards (health.regions[]), market-data
// key entry (presence-only display — the key value never comes back), add-
// instrument form, and detection-threshold inputs. All writes go through the
// service's masked PATCH /api/config; key changes take effect on the next
// refresh.
import React, { useEffect, useState } from "react";
import type { Health, Instrument, Region, ServiceConfig } from "../lib/types";
import { patchConfig, postRefresh } from "../lib/serviceClient";
import { fmtAsOf } from "../lib/format";

interface Props {
  open: boolean;
  onClose: () => void;
  health: Health | null;
  config: ServiceConfig | null;
  // Fix B: the live universe (GET /api/universe) — carries per-symbol `enabled`
  // + `availability` + the probe's `notFound` marker, so the drawer can show
  // the 9 keyed symbols' real status instead of a flat "awaiting".
  universe: { instruments: Instrument[] } | null;
  onConfigChanged: (c: ServiceConfig) => void;
  toast: (msg: string) => void;
}

const PROVIDER_LABEL: Record<string, string> = { nasdaq: "Nasdaq API", twelvedata: "Twelve Data" };
const PROVIDER_ROLE: Record<string, string> = { nasdaq: "primary · no key", twelvedata: "fallback · keyed" };
// The one keyed provider today. Used only as a fallback for the field list
// when the service is offline (config === null) — when online, the keyed
// providers come from config.keyConfigured (per provider), so adding a second
// keyed provider is data, not a refactor (NFR-008).
const DEFAULT_KEYED_PROVIDERS = ["twelvedata"];
// Per-provider helper text for the key field. A second keyed provider would
// just add a case here (data, not a refactor — NFR-008).
function keyHelp(id: string): React.ReactNode {
  if (id === "twelvedata") {
    return (
      <>
        A free key from <b>twelvedata.com</b>. Used for the <b>Norway</b> region, exact{" "}
        <b>home-exchange index</b> levels (OBX, DAX, FTSE, Nikkei…), and <b>individual stocks</b>{" "}
        (the keyed fallback provider). Stored only in the service config — never in the app bundle,
        never echoed back. No key is needed for US / Europe / Asia broad, sector &amp; proxy ETFs
        (Nasdaq, no-key). Takes effect on the next refresh.
      </>
    );
  }
  return (
    <>Stored only in the service config — never in the app bundle, never echoed back. Takes effect on the next refresh.</>
  );
}

export default function ConfigDrawer({ open, onClose, health, config, universe, onConfigChanged, toast }: Props) {
  const [keyInputs, setKeyInputs] = useState<Record<string, string>>({});
  const [newSym, setNewSym] = useState("");
  const [newRegion, setNewRegion] = useState<Region>("US");
  const [newCat, setNewCat] = useState<Instrument["category"]>("sector");
  const [newProv, setNewProv] = useState<Instrument["provider"]>("both");
  const [baseMinDuration, setBaseMinDuration] = useState("");
  const [breakoutVolumeRatio, setBreakoutVolumeRatio] = useState("");
  const [baselineWindow, setBaselineWindow] = useState("");

  useEffect(() => {
    if (config) {
      setBaseMinDuration(String(config.thresholds.baseMinDuration));
      setBreakoutVolumeRatio(String(config.thresholds.breakoutVolumeRatio));
      setBaselineWindow(String(config.thresholds.baselineWindow));
    }
  }, [config]);

  const run = async (label: string, ops: Parameters<typeof patchConfig>[0]) => {
    try {
      const res = await patchConfig(ops);
      onConfigChanged(res);
      toast(label);
    } catch (e) {
      toast(`Failed: ${e instanceof Error ? e.message : "service offline"}`);
    }
  };

  // Keyed providers, per provider, from the service's per-provider config.
  // Online: derived from config.keyConfigured (a second keyed provider would
  // just appear here — data, not a refactor, NFR-008). Offline: the known one.
  const keyMap: Record<string, boolean> = config ? config.keyConfigured || {} : {};
  const keyedProviders: string[] = config ? Object.keys(keyMap) : DEFAULT_KEYED_PROVIDERS;

  return (
    <>
      <div className={`overlay${open ? " on" : ""}`} onClick={onClose} />
      <aside className={`drawer${open ? " on" : ""}`} data-testid="config-drawer">
        <div className="dr-head">
          <h2>Data Sources &amp; Configuration</h2>
          <button className="x" onClick={onClose} data-testid="drawer-close">
            ✕
          </button>
        </div>
        <div className="dr-body">
          <div className="dr-sec">
            <h3>
              Provider Health <span className="ln" />
            </h3>
            {(health?.providers || []).map((p) => {
              const authErr = p.status === "auth_error";
              // Fix A: a rejected key renders RED ("err") — not the neutral amber
              // "limited" that means "no key set". The two are different actions.
              const cls = p.status === "ok" ? "ok" : authErr ? "err" : p.status === "limited" ? "warn" : "off";
              const stat = authErr ? "KEY REJECTED" : p.keyRequired && !p.keyConfigured ? "LIMITED" : p.status.toUpperCase();
              return (
                <div key={p.id} className={`prov ${cls}`}>
                  <span className="pd" />
                  <div>
                    <div className="pname">{PROVIDER_LABEL[p.id] || p.id}</div>
                    <div className="pmeta">
                      {PROVIDER_ROLE[p.id] || ""} · {p.symbolsOk} ok / {p.symbolsFailed} failed
                      {p.keyRequired
                        ? ` · key ${p.keyConfigured ? "set" : "NOT set"} · ${p.creditsUsedToday ?? 0}/${p.dailyCreditBudget ?? "—"} credits`
                        : ""}
                    </div>
                    {authErr && p.lastError ? (
                      <div className="perr" data-testid={`provider-auth-error-${p.id}`}>
                        ⚠ {p.lastError} — re-enter or rotate the key
                      </div>
                    ) : null}
                  </div>
                  <span className="pstat">{stat}</span>
                </div>
              );
            })}
          </div>

          {(() => {
            // Fix B: the keyed-only symbols (provider "fallback" = the 9 T10-gated
            // home-exchange indices / Norway rows) auto-enable on their first
            // successful fetch. Show each one's real status so the user sees
            // "pending / will probe" instead of a wall of silent "awaiting".
            const keyed = (universe?.instruments || []).filter((i) => i.provider === "fallback");
            if (keyed.length === 0) return null;
            const keySet = Boolean(health?.keyConfigured) || Object.values(config?.keyConfigured || {}).some(Boolean);
            return (
              <div className="dr-sec">
                <h3>
                  Keyed Symbols <span className="ln" />
                </h3>
                <div className="note" style={{ marginBottom: 8 }}>
                  These need the key above. Each auto-enables on its first successful
                  fetch — no manual step. {keySet ? "A key is set, so pending ones probe on the next refresh." : "No key set — they stay pending until a key is saved."}
                </div>
                {keyed.map((i) => {
                  const notFound = Boolean(i.notFound);
                  const dot = i.enabled ? "ok" : notFound ? "off" : "warn";
                  const label = i.enabled ? "enabled" : notFound ? "ticker not found" : "will probe on next refresh";
                  return (
                    <div key={i.symbol} className={`sym-status ${dot}`} data-testid={`keyed-sym-${i.symbol}`}>
                      <span className="ss-dot" />
                      <span className="ss-sym num">{i.symbol}</span>
                      <span className="ss-name">{i.name}</span>
                      <span className="ss-label">{label}</span>
                    </div>
                  );
                })}
              </div>
            );
          })()}

          <div className="dr-sec">
            <h3>
              Regions <span className="ln" />
            </h3>
            {(health?.regions || []).map((r) => {
              // Fix A: a region whose reason is a key rejection renders red, not
              // the neutral amber "awaiting" used for the no-key / pending states.
              const rejected = r.reason !== undefined && /rejected/i.test(r.reason);
              const cls = r.reason ? (rejected ? "err" : "warn") : r.ok > 0 ? "ok" : "off";
              return (
                <div key={r.region} className={`prov ${cls}`} data-testid={`region-card-${r.region}`}>
                  <span className="pd" />
                  <div>
                    <div className="pname">{r.region}</div>
                    <div className="pmeta">
                      {r.ok}/{r.total} ok · {r.stale} stale · as-of {fmtAsOf(r.asOf)}
                      {r.reason ? ` · ${r.reason}` : ""}
                    </div>
                  </div>
                  <span className="pstat">{r.reason ? (rejected ? "KEY REJECTED" : "AWAITING") : r.ok === r.total ? "OK" : "PARTIAL"}</span>
                </div>
              );
            })}
          </div>

          <div className="dr-sec">
            <h3>
              Market-Data API Keys <span className="ln" />
            </h3>
            {keyedProviders.length === 0 && <div className="note">No data provider currently requires an API key.</div>}
            {keyedProviders.map((id) => {
              const label = PROVIDER_LABEL[id] || id;
              const configured = Boolean(keyMap[id]);
              return (
                <React.Fragment key={id}>
                  <div className="field">
                    <label htmlFor={`apikey-${id}`}>
                      {label} API key {configured ? "(configured)" : "(not configured)"}
                    </label>
                    <input
                      type="password"
                      id={`apikey-${id}`}
                      placeholder={configured ? "••••••••••••••••  (stored — never displayed)" : `paste a free ${label} key`}
                      value={keyInputs[id] || ""}
                      onChange={(e) => setKeyInputs((m) => ({ ...m, [id]: e.target.value }))}
                      data-testid={`key-input-${id}`}
                    />
                    <div className="note">{keyHelp(id)}</div>
                  </div>
                  <button
                    className="btn primary"
                    data-testid={`save-key-${id}`}
                    onClick={() => {
                      const v = (keyInputs[id] || "").trim();
                      if (!v) {
                        toast(`Enter a ${label} key first`);
                        return;
                      }
                      run(`${label} key saved — takes effect on the next refresh`, {
                        setKey: { providerId: id, apiKey: v }
                      });
                      setKeyInputs((m) => ({ ...m, [id]: "" }));
                    }}
                  >
                    Save {label} key
                  </button>{" "}
                  {configured && (
                    <button
                      className="btn"
                      data-testid={`clear-key-${id}`}
                      onClick={() => run(`${label} key cleared`, { clearKey: { providerId: id } })}
                    >
                      Clear {label} key
                    </button>
                  )}
                </React.Fragment>
              );
            })}
          </div>

          <div className="dr-sec">
            <h3>
              Add Instrument <span className="ln" />
            </h3>
            <div className="field">
              <label>Symbol</label>
              <input value={newSym} onChange={(e) => setNewSym(e.target.value)} placeholder="e.g. XSD or EQNR.OL" data-testid="add-symbol" />
            </div>
            <div className="row2">
              <div className="field">
                <label>Region</label>
                <select value={newRegion} onChange={(e) => setNewRegion(e.target.value as Region)}>
                  <option>US</option>
                  <option>Europe</option>
                  <option>Norway</option>
                  <option>Asia</option>
                </select>
              </div>
              <div className="field">
                <label>Category</label>
                <select value={newCat} onChange={(e) => setNewCat(e.target.value as Instrument["category"])}>
                  <option>broad</option>
                  <option>sector</option>
                  <option>proxy</option>
                  <option>stock</option>
                </select>
              </div>
            </div>
            <div className="field">
              <label>Provider</label>
              <select value={newProv} onChange={(e) => setNewProv(e.target.value as Instrument["provider"])}>
                <option value="both">primary + fallback</option>
                <option value="primary">primary (no key)</option>
                <option value="fallback">fallback (key required)</option>
              </select>
            </div>
            <button
              className="btn"
              data-testid="add-instrument"
              onClick={() => {
                const symbol = newSym.trim().toUpperCase();
                if (!symbol) {
                  toast("Enter a symbol");
                  return;
                }
                run(`${symbol} added to universe — included next refresh`, {
                  instrumentAdd: { symbol, region: newRegion, category: newCat, provider: newProv }
                });
                setNewSym("");
              }}
            >
              Add to universe
            </button>
            <div className="field">
              <div className="note" style={{ marginTop: 8 }}>
                Added instruments join the next scheduled refresh. The app reads precomputed signals — no live
                recomputation on view.
              </div>
            </div>
          </div>

          <div className="dr-sec">
            <h3>
              Detection Thresholds <span className="ln" />
            </h3>
            <div className="row2">
              <div className="field">
                <label>Base min. duration (trading days)</label>
                <input value={baseMinDuration} onChange={(e) => setBaseMinDuration(e.target.value)} />
              </div>
              <div className="field">
                <label>Breakout vol. ratio (×)</label>
                <input value={breakoutVolumeRatio} onChange={(e) => setBreakoutVolumeRatio(e.target.value)} />
              </div>
            </div>
            <div className="field">
              <label>Baseline window (trading days)</label>
              <input value={baselineWindow} onChange={(e) => setBaselineWindow(e.target.value)} />
            </div>
            <button
              className="btn"
              onClick={() => {
                const ops: Record<string, number> = {};
                const d = Number(baseMinDuration);
                const r = Number(breakoutVolumeRatio);
                const w = Number(baselineWindow);
                if (Number.isFinite(d) && d > 0) ops.baseMinDuration = d;
                if (Number.isFinite(r) && r > 0) ops.breakoutVolumeRatio = r;
                if (Number.isFinite(w) && w > 0) ops.baselineWindow = w;
                run("Thresholds saved — applied on next refresh", { thresholds: ops });
              }}
            >
              Save thresholds
            </button>
          </div>

          <div className="dr-sec">
            <h3>
              Refresh <span className="ln" />
            </h3>
            <button
              className="btn primary"
              data-testid="refresh-now"
              onClick={async () => {
                try {
                  const r = await postRefresh("all");
                  toast(r.started ? "Refresh started" : `Not started — ${r.reason || "already running"}`);
                } catch {
                  toast("Service offline");
                }
              }}
            >
              Refresh now
            </button>
            <div className="field">
              <div className="note" style={{ marginTop: 8 }}>
                Daily refresh runs at{" "}
                {config ? `${String(config.cadence.refreshHour).padStart(2, "0")}:${String(config.cadence.refreshMinute).padStart(2, "0")} UTC` : "17:05 UTC"}
                ; a 5-minute heartbeat confirms the pipeline is alive between refreshes.
              </div>
            </div>
          </div>
        </div>
      </aside>
    </>
  );
}
