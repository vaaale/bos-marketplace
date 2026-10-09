// ConceptIndexView.tsx — the bundle's Level-1 routing table, rendered for a
// human (US7 AS1). Each row is a concept TERM; expanding it shows the
// (document, chapter) pairs it covers with their one-line descriptions —
// precisely the rows `okf_search` returns to an agent.
//
// The filter here is a VIEW filter over the already-loaded index (it narrows
// the term list the user is browsing). The concept-anchored SEARCH that
// matches what an agent runs lives in the Query tab, which calls the
// service's /search route. Keeping those separate is deliberate: this one is
// "find a term in the table I'm looking at", that one is "run okf_search".

import React from "react";
import { Icon } from "../lib/icons";
import { mergeConcepts } from "../lib/serviceClient";
import type { ConceptTerm } from "../lib/types";
import { StatusPill } from "./Overview";

interface Props {
  bundle: string;
  terms: ConceptTerm[];
  indexGeneratedAt: string | null;
  initialQuery?: string;
  onOpenChapter: (docId: string, chId: string) => void;
  onChanged: () => void;
}

export default function ConceptIndexView({ bundle, terms, indexGeneratedAt, initialQuery, onOpenChapter, onChanged }: Props) {
  const [query, setQuery] = React.useState(initialQuery || "");
  const [expanded, setExpanded] = React.useState<string | null>(initialQuery || null);
  // US6: the vocabulary grows organically, so near-duplicates accumulate.
  // Merging is the guard, and this index is where a user actually SEES the
  // duplicate pair — so the control belongs here, next to the terms.
  const [mergeFrom, setMergeFrom] = React.useState<string | null>(null);
  const [mergeTo, setMergeTo] = React.useState("");
  const [mergeError, setMergeError] = React.useState<string | null>(null);
  const [merging, setMerging] = React.useState(false);

  const runMerge = async () => {
    if (!mergeFrom || !mergeTo) return;
    setMergeError(null);
    setMerging(true);
    try {
      await mergeConcepts(bundle, mergeFrom, mergeTo);
      setMergeFrom(null);
      setMergeTo("");
      onChanged();
    } catch (e) {
      setMergeError((e as Error).message);
    } finally {
      setMerging(false);
    }
  };

  React.useEffect(() => {
    if (initialQuery) {
      setQuery(initialQuery);
      setExpanded(initialQuery);
    }
  }, [initialQuery]);

  const q = query.toLowerCase().trim();
  const list = terms.filter(
    (t) => !q || t.name.toLowerCase().includes(q) || t.covers.some((c) => c.description.toLowerCase().includes(q)),
  );

  return (
    <div data-testid="concept-index">
      <div className="search">
        <Icon name="search" size={15} />
        <input
          placeholder="Search concept terms (concept-anchored — matches the vocabulary, not full text)…"
          value={query}
          onChange={(e) => setQuery(e.target.value)}
          data-testid="term-filter"
        />
        {query ? (
          <span className="clear" onClick={() => setQuery("")}>
            <Icon name="x" size={14} />
          </span>
        ) : null}
      </div>

      <div className="note">
        <Icon name="info" size={14} />
        <span>
          <b>Concept index</b> — the bundle-level routing table. Each row is a{" "}
          <span style={{ color: "var(--violet)" }}>concept term</span> (the searchable vocabulary); expand it to see the{" "}
          <b>(document, chapter)</b> pairs it covers, each with a one-line description. This is O(V) — bounded by
          distinct terms, not by documents. <b>Derived &amp; regenerable</b> from chapter frontmatter
          {indexGeneratedAt ? <> · last rebuilt {new Date(indexGeneratedAt).toLocaleString()}</> : null}.
        </span>
      </div>

      {!list.length ? (
        <div className="empty" style={{ padding: 40 }} data-testid="terms-empty">
          <h3 style={{ fontSize: 15 }}>No concept terms match</h3>
          <p>
            {q
              ? "Try a broader term, or clear the filter — the vocabulary grows organically as documents are ingested."
              : "Ingest a document, or upsert a chapter with a `concepts` array, and its terms appear here."}
          </p>
        </div>
      ) : (
        <>
          <div className="count" style={{ marginBottom: 10 }} data-testid="terms-count">
            {list.length} of {terms.length} concept terms
          </div>
          {list.map((t) => {
            const open = expanded === t.name;
            return (
              <div key={t.name} className={`term${open ? " open" : ""}`} data-testid={`term-${t.name}`}>
                <div
                  className="t-head"
                  onClick={() => setExpanded(open ? null : t.name)}
                  data-testid={`term-head-${t.name}`}
                >
                  <Icon name="caret" size={15} className="caret" />
                  <span className="t-name">{t.name}</span>
                  <span className="t-key">concept</span>
                  {t.stale ? <span className="pill stale">attention</span> : null}
                  <span className="t-cnt">
                    {t.count} chapter{t.count === 1 ? "" : "s"}
                  </span>
                  <button
                    className="ibtn"
                    title={`Merge "${t.name}" into another term`}
                    data-testid={`merge-term-${t.name}`}
                    onClick={(e) => {
                      e.stopPropagation();
                      setMergeFrom(mergeFrom === t.name ? null : t.name);
                      setMergeTo("");
                      setMergeError(null);
                    }}
                  >
                    <Icon name="layers" size={14} />
                  </button>
                </div>
                {mergeFrom === t.name ? (
                  <div
                    className="t-body"
                    style={{ padding: "10px 14px" }}
                    data-testid={`merge-panel-${t.name}`}
                    onClick={(e) => e.stopPropagation()}
                  >
                    <div className="desc" style={{ marginBottom: 8 }}>
                      Merge <code>{t.name}</code> into a canonical term. Every chapter that lists{" "}
                      <code>{t.name}</code> is rewritten; the index and the affected document TOCs follow.
                    </div>
                    <select
                      value={mergeTo}
                      onChange={(e) => setMergeTo(e.target.value)}
                      data-testid={`merge-target-${t.name}`}
                    >
                      <option value="">Choose the canonical term…</option>
                      {terms
                        .filter((o) => o.name !== t.name)
                        .map((o) => (
                          <option key={o.name} value={o.name}>
                            {o.name} ({o.count})
                          </option>
                        ))}
                    </select>
                    {mergeError ? <div className="app-error" style={{ margin: "10px 0 0" }}>{mergeError}</div> : null}
                    <div className="row" style={{ marginTop: 12 }}>
                      <button className="btn" onClick={() => setMergeFrom(null)}>
                        Cancel
                      </button>
                      <button
                        className="btn primary"
                        disabled={!mergeTo || merging}
                        onClick={runMerge}
                        data-testid={`merge-confirm-${t.name}`}
                      >
                        {merging ? "Merging…" : "Merge"}
                      </button>
                    </div>
                  </div>
                ) : null}
                {open ? (
                  <div className="t-body">
                    {t.covers.map((c) => (
                      <div
                        key={`${c.docId}/${c.chId}`}
                        className="cover"
                        onClick={() => onOpenChapter(c.docId, c.chId)}
                        data-testid={`cover-${c.docId}-${c.chId}`}
                      >
                        <div className="c-loc">
                          <span className="doc">{c.docTitle}</span>
                          <span className="arrow">›</span>
                          {c.chTitle} <StatusPill status={c.status} stale={c.stale} />
                        </div>
                        <div className="c-desc">{c.description || "— no description —"}</div>
                        <span className="c-go">
                          open <Icon name="back" size={12} />
                        </span>
                      </div>
                    ))}
                  </div>
                ) : null}
              </div>
            );
          })}
        </>
      )}
    </div>
  );
}
