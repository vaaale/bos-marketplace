// DocumentsView.tsx — document list → stored TOC → full chapter.
//
// The TOC rendered here is the SERVICE's stored `toc/<docId>.md` (fetched via
// GET /bundles/<b>/toc/<docId>), not a client-side reconstruction: US7 AS2
// asks for the stored artifact, and the whole point of it being derived is
// that the browser and the agent read the same file.

import React from "react";
import { Icon } from "../lib/icons";
import { fetchBundleToc, fetchToc } from "../lib/serviceClient";
import type { BundleToc, BundleTocEntry, DocToc } from "../lib/types";
import ChapterView from "./ChapterView";
import { StatusPill } from "./Overview";

/** Documents per page — the same default an agent's okf_read_toc({bundle}) uses. */
const PAGE = 50;

interface Props {
  bundle: string;
  /** Changes whenever the bundle may have changed (a refresh, a re-ingest). */
  refreshKey: unknown;
  docId: string | null;
  chId: string | null;
  onOpenDoc: (docId: string) => void;
  onOpenChapter: (docId: string, chId: string) => void;
  onBackToDocs: () => void;
  onBackToToc: () => void;
  onJumpToTerm: (term: string) => void;
  onReingestDoc: (doc: BundleTocEntry) => void;
}

/**
 * The Documents tab IS the bundle's table of contents (FR-036/FR-069): one
 * page at a time, newest first by when each document was first added — the
 * same entries, order and page size an agent gets from okf_read_toc({bundle}).
 * It never loads the whole bundle.
 */
export default function DocumentsView(props: Props) {
  const { bundle, refreshKey, docId, chId, onOpenDoc, onOpenChapter, onBackToDocs, onBackToToc, onJumpToTerm, onReingestDoc } = props;
  const [offset, setOffset] = React.useState(0);
  const [page, setPage] = React.useState<BundleToc | null>(null);
  const [error, setError] = React.useState<string | null>(null);

  React.useEffect(() => {
    setOffset(0);
  }, [bundle]);

  React.useEffect(() => {
    let cancelled = false;
    setError(null);
    fetchBundleToc(bundle, offset, PAGE)
      .then((p) => !cancelled && setPage(p))
      .catch((e) => !cancelled && setError((e as Error).message));
    return () => {
      cancelled = true;
    };
  }, [bundle, offset, refreshKey]);

  if (docId && chId) {
    return (
      <ChapterView
        bundle={bundle}
        docId={docId}
        chId={chId}
        onBack={onBackToToc}
        backLabel={page?.documents.find((d) => d.id === docId)?.title || docId}
      />
    );
  }
  if (docId) return <TocView bundle={bundle} docId={docId} onBack={onBackToDocs} onOpenChapter={onOpenChapter} onJumpToTerm={onJumpToTerm} />;

  if (error) return <div className="app-error">Could not read this bundle's table of contents: {error}</div>;
  if (!page) return <div className="app-loading">Loading the table of contents…</div>;

  const from = page.total ? page.offset + 1 : 0;
  const to = Math.min(page.offset + page.documents.length, page.total);
  return (
    <div data-testid="documents-view">
      <div className="note">
        <Icon name="info" size={14} />
        <span>
          <b>Documents</b> — the bundle's <b>table of contents</b>, newest first: each document with its short summary
          and chapter count. This is exactly what an agent gets from <code>okf_read_toc({"{bundle}"})</code>, {PAGE} per
          page. Open a document for its own TOC — its chapters.
        </span>
      </div>
      {!page.total ? (
        <div className="empty" style={{ padding: 40 }} data-testid="documents-empty">
          <h3 style={{ fontSize: 15 }}>No documents yet</h3>
          <p>Ingest a source — the okf-ingest agent decomposes it into chapters and writes this document's TOC.</p>
        </div>
      ) : (
        <>
          <div className="doc-list">
            {page.documents.map((d) => (
              <div key={d.id} className="doc-row" onClick={() => onOpenDoc(d.id)} data-testid={`doc-row-${d.id}`}>
                <span className="d-ic">
                  <Icon name="doc" size={18} />
                </span>
                <div style={{ minWidth: 0 }}>
                  <div className="d-title">{d.title}</div>
                  {d.summary ? <div className="d-sum">{d.summary}</div> : null}
                  <div className="d-meta">
                    {d.chapters} chapter{d.chapters === 1 ? "" : "s"}
                    {d.attention ? <span style={{ color: "var(--amber)" }}> · needs attention</span> : null}
                  </div>
                </div>
                <span className="d-upd" title="first added to this bundle">
                  {d.addedAt ? `added ${d.addedAt.slice(0, 10)}` : "—"}
                </span>
                <button
                  className="ibtn"
                  title="Re-ingest this document from its original source"
                  onClick={(e) => {
                    e.stopPropagation();
                    onReingestDoc(d);
                  }}
                  data-testid={`doc-reingest-${d.id}`}
                >
                  <Icon name="refresh" size={15} />
                </button>
                <span className="d-go">
                  View TOC <Icon name="back" size={12} />
                </span>
              </div>
            ))}
          </div>
          <Pager from={from} to={to} total={page.total} noun="documents" onPrev={offset > 0 ? () => setOffset(Math.max(0, offset - PAGE)) : null} onNext={to < page.total ? () => setOffset(offset + PAGE) : null} />
        </>
      )}
    </div>
  );
}

/** "1–50 of 312 documents   [Previous] [Next]" — shared by the paged lists. */
export function Pager({ from, to, total, noun, onPrev, onNext }: { from: number; to: number; total: number; noun: string; onPrev: (() => void) | null; onNext: (() => void) | null }) {
  return (
    <div className="pager" data-testid="pager">
      <span>
        {from}–{to} of {total.toLocaleString()} {noun}
      </span>
      <span className="spacer" />
      <button className="btn" disabled={!onPrev} onClick={onPrev || undefined} data-testid="pager-prev">
        Previous
      </button>
      <button className="btn" disabled={!onNext} onClick={onNext || undefined} data-testid="pager-next">
        Next
      </button>
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
