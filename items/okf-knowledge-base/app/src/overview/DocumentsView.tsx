// DocumentsView.tsx — document list → stored TOC → full chapter.
//
// The TOC rendered here is the SERVICE's stored `toc/<docId>.md` (fetched via
// GET /bundles/<b>/toc/<docId>), not a client-side reconstruction: US7 AS2
// asks for the stored artifact, and the whole point of it being derived is
// that the browser and the agent read the same file.

import React from "react";
import { Icon } from "../lib/icons";
import { fetchToc } from "../lib/serviceClient";
import type { DocToc, DocumentRow } from "../lib/types";
import ChapterView from "./ChapterView";
import { StatusPill } from "./Overview";

interface Props {
  bundle: string;
  documents: DocumentRow[];
  docId: string | null;
  chId: string | null;
  onOpenDoc: (docId: string) => void;
  onOpenChapter: (docId: string, chId: string) => void;
  onBackToDocs: () => void;
  onBackToToc: () => void;
  onJumpToTerm: (term: string) => void;
}

export default function DocumentsView(props: Props) {
  const { bundle, documents, docId, chId, onOpenDoc, onOpenChapter, onBackToDocs, onBackToToc, onJumpToTerm } = props;

  if (docId && chId) {
    return (
      <ChapterView
        bundle={bundle}
        docId={docId}
        chId={chId}
        onBack={onBackToToc}
        backLabel={documents.find((d) => d.id === docId)?.title || docId}
      />
    );
  }
  if (docId) return <TocView bundle={bundle} docId={docId} onBack={onBackToDocs} onOpenChapter={onOpenChapter} onJumpToTerm={onJumpToTerm} />;

  return (
    <div data-testid="documents-view">
      <div className="note">
        <Icon name="info" size={14} />
        <span>
          <b>Documents</b> — the ingested sources in this bundle. Each has a stored <b>table of contents</b> (the
          level-2 drill-down an agent uses to fetch specific chapters). Click a document to open its TOC.
        </span>
      </div>
      {!documents.length ? (
        <div className="empty" style={{ padding: 40 }} data-testid="documents-empty">
          <h3 style={{ fontSize: 15 }}>No documents yet</h3>
          <p>Ingest a source — the okf-ingest agent decomposes it into chapters and writes this document's TOC.</p>
        </div>
      ) : (
        <div className="doc-list">
          {documents.map((d) => (
            <div key={d.id} className="doc-row" onClick={() => onOpenDoc(d.id)} data-testid={`doc-row-${d.id}`}>
              <span className="d-ic">
                <Icon name="doc" size={18} />
              </span>
              <div>
                <div className="d-title">{d.title}</div>
                <div className="d-meta">
                  {d.chapters} chapters · {d.conceptRefs} concept refs
                  {d.needsAttention ? <span style={{ color: "var(--amber)" }}> · needs attention</span> : null}
                </div>
              </div>
              <span className="d-upd">{d.updated ? d.updated.slice(0, 10) : "—"}</span>
              <span className="d-go">
                View TOC <Icon name="back" size={12} />
              </span>
            </div>
          ))}
        </div>
      )}
    </div>
  );
}

function TocView({
  bundle,
  docId,
  onBack,
  onOpenChapter,
  onJumpToTerm,
}: {
  bundle: string;
  docId: string;
  onBack: () => void;
  onOpenChapter: (docId: string, chId: string) => void;
  onJumpToTerm: (term: string) => void;
}) {
  const [toc, setToc] = React.useState<DocToc | null>(null);
  const [error, setError] = React.useState<string | null>(null);

  React.useEffect(() => {
    let cancelled = false;
    setToc(null);
    setError(null);
    fetchToc(bundle, docId)
      .then((t) => !cancelled && setToc(t))
      .catch((e) => !cancelled && setError((e as Error).message));
    return () => {
      cancelled = true;
    };
  }, [bundle, docId]);

  if (error) return <div className="app-error">Could not read the stored TOC for {docId}: {error}</div>;
  if (!toc) return <div className="app-loading">Loading the stored TOC…</div>;

  return (
    <div data-testid="toc-view">
      <button className="btn" style={{ marginBottom: 12 }} onClick={onBack} data-testid="toc-back">
        <Icon name="back" size={15} /> Back to Documents
      </button>
      <div className="note">
        <Icon name="info" size={14} />
        <span>
          This is the document's <b>stored table of contents</b> — the level-2 artifact. It lists each chapter with a
          one-line description and the <span style={{ color: "var(--violet)" }}>concept terms</span> it covers. An agent
          calls <code>okf_read_toc</code> to get exactly this, then <code>okf_read_concept</code> for a full chapter.
        </span>
      </div>
      <div className="toc">
        <div className="toc-head">
          <div className="h">
            <Icon name="book" size={16} /> {toc.docTitle}
          </div>
          <div className="s">
            {toc.chapters.length} chapters · TOC artifact: <span style={{ fontFamily: "monospace" }}>{toc.artifact}</span>
            {toc.indexGeneratedAt ? <> · rebuilt {new Date(toc.indexGeneratedAt).toLocaleString()}</> : null}
          </div>
        </div>
        {toc.chapters.map((c, i) => (
          <div
            key={c.id}
            className="toc-item"
            onClick={() => onOpenChapter(docId, c.id)}
            data-testid={`toc-item-${c.id}`}
          >
            <span className="toc-num">{String(i + 1).padStart(2, "0")}</span>
            <span className="toc-title">
              {c.title} <StatusPill status={c.status} />
            </span>
            <span className="toc-desc">{c.summary || "— no description —"}</span>
            <span className="toc-tags">
              {c.concepts.map((t) => (
                <span
                  key={t}
                  className="chip"
                  title={`Jump to the concept index: ${t}`}
                  onClick={(e) => {
                    e.stopPropagation();
                    onJumpToTerm(t);
                  }}
                >
                  <span className="cdot" />
                  {t}
                </span>
              ))}
            </span>
            <span className="toc-go">
              open <Icon name="back" size={12} />
            </span>
          </div>
        ))}
      </div>
    </div>
  );
}
