// HealthView.tsx — the bundle's Health tab: the stale/deprecated chapters
// (okf_stale_report) and the lint report (okf_lint), both read live from the
// service so the UI shows the same drift an agent would see.
//
// Lint is a GET that REBUILDS detected drift rather than reporting it and
// leaving it — that is what "derived, never the sole source of truth" buys
// (NFR-004), and the card says so rather than leaving the user wondering why
// the counts went to zero.

import React from "react";
import { Icon } from "../lib/icons";
import { fetchLint, fetchStale } from "../lib/serviceClient";
import type { LintReport, StaleRow } from "../lib/types";
import { StatusPill } from "./Overview";

export default function HealthView({ bundle }: { bundle: string }) {
  const [stale, setStale] = React.useState<StaleRow[] | null>(null);
  const [lint, setLint] = React.useState<LintReport | null>(null);
  const [error, setError] = React.useState<string | null>(null);

  const load = React.useCallback(() => {
    setError(null);
    Promise.all([fetchStale(bundle), fetchLint(bundle)])
      .then(([s, l]) => {
        setStale(s.stale);
        setLint(l);
      })
      .catch((e) => setError((e as Error).message));
  }, [bundle]);

  React.useEffect(load, [load]);

  if (error) return <div className="app-error">Health check failed: {error}</div>;
  if (!stale || !lint) return <div className="app-loading">Running okf_lint and okf_stale_report…</div>;

  const checks: [string, number][] = [
    ["Concept-index drift", lint.checks.conceptIndexDrift],
    ["Document-TOC drift", lint.checks.documentTocDrift],
    ["Broken inline-asset links", lint.checks.brokenInlineAssets],
    ["Orphan chapters (no parent doc)", lint.checks.orphanChapters],
    ["links.json / markdown drift", lint.checks.linksDrift],
  ];

  return (
    <div data-testid="health-view">
      <div className="io-card" style={{ marginBottom: 14 }}>
        <h4>
          <Icon name="alert" size={16} /> Needs attention
        </h4>
        <div className="io-sub">Chapters past their lifecycle threshold or marked deprecated (okf_stale_report).</div>
        {stale.length ? (
          <div className="health-list" data-testid="stale-list">
            {stale.map((s) => (
              <div className="health-item" key={s.id} data-testid={`stale-${s.id}`}>
                <span className={`dot ${s.reason === "deprecated" ? "red" : "amber"}`} />
                <div className="grow">
                  <div>{s.title}</div>
                  <div className="loc">
                    {s.docTitle}
                    {s.daysStale !== null ? ` · ${s.daysStale} days stale` : ""}
                  </div>
                </div>
                <StatusPill status={s.status} stale={s.reason !== "deprecated"} />
              </div>
            ))}
          </div>
        ) : (
          <div className="ok-line">
            <span className="dot green" />
            All chapters are current.
          </div>
        )}
      </div>

      <div className="io-card">
        <h4>
          <Icon name="check" size={16} /> Lint (okf_lint)
        </h4>
        <div className="io-sub">
          Index/TOC drift and broken references. Both index levels are derived, so drift is <b>rebuilt</b>, not patched
          by hand{lint.rebuilt ? " — this run rebuilt them." : "."}
        </div>
        <div data-testid="lint-checks">
          {checks.map(([label, n]) => (
            <div className="ok-line" key={label} data-testid={`lint-${label.replace(/\W+/g, "-").toLowerCase()}`}>
              <span className={`dot ${n === 0 ? "green" : "amber"}`} />
              {label} <span className="m">{n}</span>
            </div>
          ))}
        </div>
        <div className="row" style={{ justifyContent: "flex-start" }}>
          <button className="btn" onClick={load} data-testid="relint-btn">
            <Icon name="refresh" size={14} /> Re-run lint
          </button>
        </div>
      </div>

      {lint.errors.length || lint.warnings.length ? (
        <div className="io-card" style={{ marginTop: 14 }}>
          <h4>
            <Icon name="list" size={16} /> Findings
          </h4>
          <div className="io-sub">
            {lint.errors.length} error{lint.errors.length === 1 ? "" : "s"} · {lint.warnings.length} warning
            {lint.warnings.length === 1 ? "" : "s"}
          </div>
          <div className="health-list" data-testid="lint-findings">
            {[...lint.errors.map((e) => ({ ...e, level: "red" })), ...lint.warnings.map((w) => ({ ...w, level: "amber" }))]
              .slice(0, 50)
              .map((f, i) => (
                <div className="health-item" key={i}>
                  <span className={`dot ${f.level}`} />
                  <div className="grow">
                    <div>{f.issue}</div>
                    <div className="loc">
                      {f.check}
                      {f.conceptId ? ` · ${f.conceptId}` : f.docId ? ` · ${f.docId}` : ""}
                    </div>
                  </div>
                </div>
              ))}
          </div>
        </div>
      ) : null}
    </div>
  );
}
