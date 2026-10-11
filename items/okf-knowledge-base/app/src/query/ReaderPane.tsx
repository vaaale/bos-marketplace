// ReaderPane.tsx — the mouse-resizable reader (FR-043 / US9 AS3 / SC-012).
//
// Three kinds open here, matching the three node types:
//   • document     → its stored TOC (click a chapter to drill in)
//   • chapter      → the FULL chapter: frontmatter, markdown body, inline
//                    assets with their stored interpretations
//   • concept term → the chapters that term covers (the routing view). A
//                    PERSON-kind term (ADR-011) opens this very same view —
//                    only the header label and its colour differ, because a
//                    person IS an ordinary term in the index.
//
// "Open source" at the top of the pane is the honest provenance target: the
// document's ORIGINAL ingested URL when one exists, otherwise its stored
// `raw/` path (FR-043). The service computes it from the document's `sources`
// frontmatter, so the pane never guesses — a document with no URL shows the
// raw path as plain text rather than a dead link pretending to be one.

import React from "react";
import { Icon } from "../lib/icons";
import { fetchConcept, fetchToc } from "../lib/serviceClient";
import { ChapterBody, FrontmatterCard } from "../overview/ChapterView";
import { StatusPill } from "../overview/Overview";
import type { ConceptRead, ConceptSource, ConceptTerm, DocToc } from "../lib/types";

export interface PaneTarget {
  kind: "doc" | "chap" | "concept";
  docId: string | null;
  chId: string | null;
  term: string | null;
}

interface Props {
  bundle: string;
  target: PaneTarget | null;
  terms: ConceptTerm[];
  onOpenChapter: (docId: string, chId: string) => void;
  onClose: () => void;
}

/** The "Open source" row: a real link for a URL, plain text for a raw/ path. */
function SourceLink({ source }: { source: ConceptSource | null }) {
  if (!source) {
    return (
      <span className="q-pane-src" data-testid="open-source">
        <Icon name="export" size={13} /> Open source: <span className="q-pane-anch">no recorded provenance</span>
      </span>
    );
  }
  return (
    <span className="q-pane-src" data-testid="open-source">
      <Icon name="export" size={13} /> Open source:{" "}
      {source.kind === "url" ? (
        <a href={source.target} target="_blank" rel="noopener noreferrer" data-testid="open-source-link">
          {source.target}
        </a>
      ) : (
        <a
          href={source.target}
          data-testid="open-source-link"
          title="Stored raw source inside the bundle"
          onClick={(e) => e.preventDefault()}
        >
          {source.target}
        </a>
      )}
    </span>
  );
}

export default function ReaderPane({ bundle, target, terms, onOpenChapter, onClose }: Props) {
  const [concept, setConcept] = React.useState<ConceptRead | null>(null);
  const [docConcept, setDocConcept] = React.useState<ConceptRead | null>(null);
  const [toc, setToc] = React.useState<DocToc | null>(null);
  const [showSource, setShowSource] = React.useState(false);
  const [error, setError] = React.useState<string | null>(null);

  React.useEffect(() => {
    let cancelled = false;
    setError(null);
    setShowSource(false);
    setConcept(null);
    setToc(null);
    setDocConcept(null);
    if (!target) return;

    const fail = (e: unknown) => !cancelled && setError((e as Error).message);

    if (target.kind === "doc" && target.docId) {
      fetchToc(bundle, target.docId).then((t) => !cancelled && setToc(t)).catch(fail);
      // the document stub carries the provenance the "Open source" link uses
      fetchConcept(bundle, target.docId).then((c) => !cancelled && setDocConcept(c)).catch(() => {});
    } else if (target.kind === "chap" && target.docId && target.chId) {
      fetchConcept(bundle, `${target.docId}/${target.chId}`).then((c) => !cancelled && setConcept(c)).catch(fail);
      fetchConcept(bundle, target.docId).then((c) => !cancelled && setDocConcept(c)).catch(() => {});
    }
    return () => {
      cancelled = true;
    };
  }, [bundle, target]);

  if (!target) {
    return (
      <>
        <div className="q-pane-head">
          <div className="qpane-empty-h">
            <Icon name="eye" size={15} /> Reader
          </div>
        </div>
        <div className="q-pane-body" data-testid="pane-empty">
          <div className="empty" style={{ padding: "40px 22px" }}>
            <h3 style={{ fontSize: 15 }}>No selection</h3>
            <p>
              Click a <b>graph node</b> or a <b>table row</b> to open it here — frontmatter, markdown body, and inline
              assets with their interpretations, plus a link to the original source at the top.
            </p>
            <div className="pane-hint">
              <Icon name="eye" size={14} />
              <span>
                This pane is <b>mouse-resizable</b> — drag the vertical divider to its left.
              </span>
            </div>
          </div>
        </div>
      </>
    );
  }

  // ── concept-term view ──────────────────────────────────────────────────
  if (target.kind === "concept") {
    // a person node's id is the LOWERCASED name, the term's own `name` keeps
    // the original case — so the lookup is case-insensitive
    const wanted = String(target.term || "").toLowerCase();
    const term = terms.find((t) => t.name.toLowerCase() === wanted) || null;
    const isPerson = term?.kind === "person";
    return (
      <>
        <div className="q-pane-head">
          <div className={`q-pane-kind ${isPerson ? "person" : "concept"}`} data-testid="pane-term-kind">
            <Icon name={isPerson ? "eye" : "layers"} size={14} /> {isPerson ? "Person" : "Concept term"}
          </div>
          <div className={`q-pane-term${isPerson ? " person" : ""}`} data-testid="pane-term">
            {term?.name ?? target.term}
          </div>
          <div className="q-pane-sub">
            {isPerson ? "person-kind term · subject of " : "vocabulary term · covered by "}
            {term?.count ?? 0} chapter{(term?.count ?? 0) === 1 ? "" : "s"} · no single source document
          </div>
          <button className="ibtn" onClick={onClose} title="Close reader" data-testid="pane-close">
            <Icon name="x" size={15} />
          </button>
        </div>
        <div className="q-pane-body" data-testid="pane-concept">
          {!term ? (
            <div className="empty" style={{ margin: 14, padding: 30 }}>
              Concept term not found in this bundle.
            </div>
          ) : (
            <>
              <div className="note" style={{ margin: "0 0 12px" }}>
                <Icon name={isPerson ? "eye" : "layers"} size={14} />
                <span>
                  <b>{term.name}</b> is a{" "}
                  {isPerson ? (
                    <span style={{ color: "var(--teal)" }}>person-kind term</span>
                  ) : (
                    <span style={{ color: "var(--violet)" }}>concept term</span>
                  )}{" "}
                  in the bundle vocabulary (the O(V) routing table). It routes to the{" "}
                  {isPerson ? "documents and chapters this person is the author or the subject of" : "chapters below — concept-anchored"}
                  . Click one to open it in full.
                </span>
              </div>
              <div className="toc">
                {term.covers.map((c) => (
                  <div
                    key={`${c.docId}/${c.chId}`}
                    className="toc-item"
                    onClick={() => onOpenChapter(c.docId, c.chId)}
                    data-testid={`pane-cover-${c.docId}-${c.chId}`}
                  >
                    <span className="toc-num" style={{ color: isPerson ? "var(--teal)" : "var(--violet)" }}>
                      ◆
                    </span>
                    <span className="toc-title">
                      <span style={{ fontWeight: 500, color: "var(--muted)" }}>{c.docTitle}</span> › {c.chTitle}
                    </span>
                    <span className="toc-desc">{c.description || "— no description —"}</span>
                    <span className="toc-go">
                      open <Icon name="back" size={12} />
                    </span>
                  </div>
                ))}
              </div>
            </>
          )}
        </div>
      </>
    );
  }

  // ── document / chapter views ───────────────────────────────────────────
  const source = docConcept?.source ?? concept?.source ?? null;
  const title = target.kind === "doc" ? toc?.docTitle || target.docId : String(concept?.frontmatter.title || target.chId);

  return (
    <>
      <div className="q-pane-head">
        <div className="q-pane-kind">
          <Icon name={target.kind === "doc" ? "book" : "list"} size={14} />{" "}
          {target.kind === "doc" ? "Document" : "Chapter"}
        </div>
        <SourceLink source={source} />
        <button className="ibtn" onClick={onClose} title="Close reader" data-testid="pane-close">
          <Icon name="x" size={15} />
        </button>
      </div>

      <div className="q-pane-body" data-testid={target.kind === "doc" ? "pane-doc" : "pane-chapter"}>
        {error ? <div className="app-error">{error}</div> : null}

        {target.kind === "doc" ? (
          !toc ? (
            <div className="app-loading">Loading the stored TOC…</div>
          ) : (
            <>
              <div className="note" style={{ margin: "0 0 12px" }}>
                <Icon name="info" size={14} />
                <span>
                  This is the stored <b>document TOC</b> (<code>{toc.artifact}</code>) — {toc.chapters.length} chapters.
                  Click a chapter to open it in full.
                </span>
              </div>
              <div className="toc">
                {toc.chapters.map((c, i) => (
                  <div
                    key={c.id}
                    className="toc-item"
                    onClick={() => onOpenChapter(toc.docId, c.id)}
                    data-testid={`pane-toc-${c.id}`}
                  >
                    <span className="toc-num">{String(i + 1).padStart(2, "0")}</span>
                    <span className="toc-title">
                      {c.title} <StatusPill status={c.status} />
                    </span>
                    <span className="toc-desc">{c.summary || "— no description —"}</span>
                    <span className="toc-go">
                      open <Icon name="back" size={12} />
                    </span>
                  </div>
                ))}
              </div>
            </>
          )
        ) : !concept ? (
          <div className="app-loading">Loading the full chapter…</div>
        ) : (
          <>
            <div style={{ fontWeight: 600, fontSize: 14, marginBottom: 10 }} data-testid="pane-chapter-title">
              {title} <StatusPill status={String(concept.frontmatter.status || "")} />
            </div>
            {showSource ? null : <FrontmatterCard concept={concept} />}
            <ChapterBody bundle={bundle} concept={concept} showSource={showSource} />
            <div className="qpane-foot">
              <button
                className="btn"
                style={{ padding: "5px 10px", fontSize: 12 }}
                onClick={() => setShowSource((v) => !v)}
                data-testid="pane-raw-toggle"
              >
                <Icon name="code" size={13} /> {showSource ? "Hide raw .md" : "View raw .md"}
              </button>
            </div>
          </>
        )}
      </div>
    </>
  );
}
