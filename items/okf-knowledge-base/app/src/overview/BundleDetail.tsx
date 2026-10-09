// BundleDetail.tsx — one knowledge base: the health stat cards plus the
// Concept Index / Documents / Health / Import·Export tabs (US7, the mockup's
// bundle-detail view). The Documents tab drills document → stored TOC →
// full chapter.

import React from "react";
import { Icon } from "../lib/icons";
import type { BundleDetail } from "../lib/types";
import ConceptIndexView from "./ConceptIndexView";
import DocumentsView from "./DocumentsView";
import HealthView from "./HealthView";
import ImportExport from "./ImportExport";

type DetailTab = "conceptIndex" | "documents" | "health" | "io";

interface Props {
  bundleName: string;
  detail: BundleDetail | null;
  onBack: () => void;
  onIngest: () => void;
  onImport: () => void;
  onDelete: () => void;
  onReload: () => void;
}

export default function BundleDetailView({ bundleName, detail, onBack, onIngest, onImport, onDelete, onReload }: Props) {
  const [tab, setTab] = React.useState<DetailTab>("conceptIndex");
  const [docId, setDocId] = React.useState<string | null>(null);
  const [chId, setChId] = React.useState<string | null>(null);
  const [jumpTerm, setJumpTerm] = React.useState<string>("");

  if (!detail) return <div className="app-loading">Loading {bundleName}…</div>;

  const h = detail.health;
  const tabs: [DetailTab, string, string, number][] = [
    ["conceptIndex", "Concept Index", "layers", h.conceptTerms],
    ["documents", "Documents", "list", h.docs],
    ["health", "Health", "alert", h.stale + h.deprecated],
    ["io", "Import / Export", "export", 0],
  ];

  const goTab = (t: DetailTab) => {
    setTab(t);
    setDocId(null);
    setChId(null);
  };

  return (
    <div data-testid="bundle-detail">
      <div className="toolbar">
        <button className="btn" onClick={onBack} data-testid="detail-back">
          <Icon name="back" size={15} /> Back
        </button>
        <div className="spacer" />
        <button className="btn primary" onClick={onIngest} data-testid="ingest-btn">
          <Icon name="import" size={15} /> Ingest
        </button>
        <button className="btn" onClick={onReload} data-testid="detail-reload">
          <Icon name="refresh" size={15} /> Refresh
        </button>
        <button className="ibtn danger" title="Delete bundle" onClick={onDelete} data-testid="detail-delete">
          <Icon name="trash" size={16} />
        </button>
      </div>

      <h2 style={{ fontSize: 17, display: "flex", alignItems: "center", gap: 9 }}>
        <span className="glyph">📚</span>
        {bundleName}
      </h2>

      <div className="health" data-testid="health-cards">
        <div className="stat">
          <div className="num" data-testid="stat-docs">
            {h.docs}
          </div>
          <div className="lbl">Documents</div>
        </div>
        <div className="stat">
          <div className="num" data-testid="stat-chapters">
            {h.chapters}
          </div>
          <div className="lbl">Chapters</div>
        </div>
        <div className="stat">
          <div className="num" data-testid="stat-terms">
            {h.conceptTerms}
          </div>
          <div className="lbl">Concept terms</div>
        </div>
        <div className={`stat${h.stale + h.deprecated ? " alert" : ""}`}>
          <div className="num" data-testid="stat-stale">
            {h.stale + h.deprecated}
          </div>
          <div className="lbl">Stale / Deprecated</div>
        </div>
      </div>

      {h.indexNeedsRegeneration ? (
        <div className="stale-banner" data-testid="index-regen-banner">
          <Icon name="alert" size={15} />
          <span>
            <b>This bundle's derived index is partial.</b> Some chapters lack the <code>parent</code> /{" "}
            <code>concepts</code> / <code>summary</code> frontmatter the two-level index is built from — typically a
            pre-redesign bundle. Nothing was dropped or rewritten; re-ingest those sources, or set the missing
            frontmatter with <code>okf_upsert_concept</code>, to complete the routing table.
          </span>
        </div>
      ) : null}

      <div className="tabs" data-testid="detail-tabs">
        {tabs.map(([id, label, icon, cnt]) => (
          <div
            key={id}
            className={`tab${tab === id ? " active" : ""}`}
            onClick={() => goTab(id)}
            data-testid={`detail-tab-${id}`}
          >
            <Icon name={icon} size={15} />
            {label}
            {cnt ? <span className="cnt">{cnt}</span> : null}
          </div>
        ))}
      </div>

      {tab === "conceptIndex" ? (
        <ConceptIndexView
          bundle={bundleName}
          terms={detail.conceptIndex}
          indexGeneratedAt={detail.indexGeneratedAt}
          initialQuery={jumpTerm}
          onChanged={onReload}
          onOpenChapter={(d, c) => {
            setTab("documents");
            setDocId(d);
            setChId(c);
          }}
        />
      ) : null}

      {tab === "documents" ? (
        <DocumentsView
          bundle={bundleName}
          documents={detail.documents}
          docId={docId}
          chId={chId}
          onOpenDoc={(d) => {
            setDocId(d);
            setChId(null);
          }}
          onOpenChapter={(d, c) => {
            setDocId(d);
            setChId(c);
          }}
          onBackToDocs={() => {
            setDocId(null);
            setChId(null);
          }}
          onBackToToc={() => setChId(null)}
          onJumpToTerm={(term) => {
            setJumpTerm(term);
            setTab("conceptIndex");
            setDocId(null);
            setChId(null);
          }}
        />
      ) : null}

      {tab === "health" ? <HealthView bundle={bundleName} /> : null}

      {tab === "io" ? <ImportExport bundle={bundleName} onIngest={onIngest} onImport={onImport} /> : null}
    </div>
  );
}
