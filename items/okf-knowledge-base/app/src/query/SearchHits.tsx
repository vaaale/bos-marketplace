// SearchHits.tsx — the ranked okf_search hits, as the Query tab's Table view
// shows them while a query is active (spec FR-043 as amended; mockup: Query →
// Table with a query).
//
// Each hit: document › chapter, its one-line summary, what matched (a badge:
// concept / person / title / summary / full text) and, for a full-text match,
// the excerpt with the matched words highlighted. The excerpt shows WHERE a
// match is; opening the hit reads the chapter in full. "By document" asks the
// same search grouped — one row per document with its best chapters beneath.

import React from "react";
import { Icon } from "../lib/icons";
import type { GroupedSearchResult, MatchKind, SearchResult, SearchRow } from "../lib/types";
import { StatusPill } from "../overview/Overview";

const KIND_LABEL: Record<MatchKind, string> = {
  term: "concept",
  person: "person",
  title: "title",
  summary: "summary",
  text: "full text",
};

interface Props {
  query: string;
  result: SearchResult | null;
  grouped: GroupedSearchResult | null;
  byDocument: boolean;
  onByDocument: (on: boolean) => void;
  onOpen: (row: SearchRow) => void;
  onOpenDoc: (docId: string) => void;
}

const fold = (s: string) => s.normalize("NFKD").replace(/\p{M}+/gu, "").toLowerCase();

/** Highlight the matched words in `text` — by folding character by character,
 *  so an accented original ("Córdoba") lights up for a plain query word. */
function Highlighted({ text, words }: { text: string; words: string[] }) {
  if (!words.length) return <>{text}</>;
  let folded = "";
  const at: number[] = [];
  let i = 0;
  for (const ch of text) {
    const f = fold(ch);
    for (let k = 0; k < f.length; k++) at.push(i);
    folded += f;
    i += ch.length;
  }
  const spans: [number, number][] = [];
  for (const w of words) {
    const re = new RegExp(`(?:^|[^\\p{L}\\p{N}])(${w.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")})`, "gu");
    let m: RegExpExecArray | null;
    while ((m = re.exec(folded))) {
      const start = m.index + m[0].length - m[1].length;
      const end = start + m[1].length;
      spans.push([at[start] ?? 0, end < at.length ? at[end] : text.length]);
    }
  }
  if (!spans.length) return <>{text}</>;
  spans.sort((a, b) => a[0] - b[0]);
  const out: React.ReactNode[] = [];
  let pos = 0;
  spans.forEach(([s, e], n) => {
    if (s < pos) return;
    if (s > pos) out.push(text.slice(pos, s));
    out.push(
      <mark key={n} className="hl">
        {text.slice(s, e)}
      </mark>,
    );
    pos = e;
  });
  if (pos < text.length) out.push(text.slice(pos));
  return <>{out}</>;
}

function Hit({ row, onOpen }: { row: SearchRow; onOpen: (row: SearchRow) => void }) {
  const words = row.matchedWords || [];
  return (
    <div className={`srow${row.matchKind === "person" ? " person" : ""}`} onClick={() => onOpen(row)} data-testid={`hit-${row.docId}-${row.chId || "doc"}`}>
      <div className="s-loc">
        <span className="doc">{row.docTitle}</span>
        {row.chId ? (
          <>
            <span className="arrow">›</span>
            {row.matchKind === "title" ? <Highlighted text={row.chTitle} words={words} /> : row.chTitle}
          </>
        ) : null}{" "}
        <StatusPill status={row.status} stale={row.stale} />
      </div>
      {row.description ? (
        <div className="s-desc">{row.matchKind === "summary" ? <Highlighted text={row.description} words={words} /> : row.description}</div>
      ) : null}
      {row.excerpt ? (
        <div className="s-excerpt" data-testid="hit-excerpt">
          <Highlighted text={row.excerpt} words={words} />
        </div>
      ) : null}
      <div className="s-term">
        <span className={`mk ${row.matchKind}`} data-testid="hit-kind">
          {KIND_LABEL[row.matchKind]}
        </span>
        {(row.matchKind === "term" || row.matchKind === "person") && row.matchedConcept ? <span className="st">{row.matchedConcept}</span> : null}
      </div>
      <span className="s-go">
        open <Icon name="back" size={12} />
      </span>
    </div>
  );
}

export default function SearchHits({ query, result, grouped, byDocument, onByDocument, onOpen, onOpenDoc }: Props) {
  const current = byDocument ? grouped : result;
  const total = current?.total ?? 0;
  return (
    <div data-testid="search-hits">
      <div className="pager" style={{ margin: "0 0 10px" }}>
        <span data-testid="hits-count">
          {current ? (total ? `${total} chapter${total === 1 ? "" : "s"} match “${query.trim()}”` : "") : "Searching…"}
        </span>
        <span className="spacer" />
        <div className="seg">
          <button className={byDocument ? "" : "on"} onClick={() => onByDocument(false)} data-testid="hits-chapters">
            Chapters
          </button>
          <button className={byDocument ? "on" : ""} onClick={() => onByDocument(true)} data-testid="hits-by-document">
            By document
          </button>
        </div>
      </div>

      {current && !total ? (
        <div className="empty" style={{ padding: 36 }} data-testid="hits-empty">
          <h3 style={{ fontSize: 15 }}>Nothing matched</h3>
          <p>
            Searched {current.searched.join(", ")} of every chapter. Rephrase, or browse the bundle's <b>Documents</b> — its table of contents —
            in Overview.
          </p>
        </div>
      ) : null}

      {!byDocument && result && result.rows.length ? (
        <>
          <div className="srow-list">
            {result.rows.map((r) => (
              <Hit key={`${r.docId}/${r.chId}`} row={r} onOpen={onOpen} />
            ))}
          </div>
          {result.total > result.rows.length ? (
            <div className="count">
              Showing the top {result.rows.length} of {result.total} — refine the query to narrow it.
            </div>
          ) : null}
        </>
      ) : null}

      {byDocument && grouped && grouped.groups.length
        ? grouped.groups.map((g) => (
            <div className="hit-group" key={g.docId} data-testid={`hit-group-${g.docId}`}>
              <div className="hg-head">
                <Icon name="doc" size={14} />
                <span style={{ cursor: "pointer" }} onClick={() => onOpenDoc(g.docId)}>
                  {g.docTitle}
                </span>
                <span className="hg-sum">
                  {g.total} matching chapter{g.total === 1 ? "" : "s"}
                </span>
              </div>
              {g.hits.map((r) => (
                <Hit key={`${r.docId}/${r.chId}`} row={r} onOpen={onOpen} />
              ))}
              {g.total > g.hits.length ? <div className="count" style={{ marginLeft: 14 }}>+{g.total - g.hits.length} more in this document</div> : null}
            </div>
          ))
        : null}
    </div>
  );
}
