// ConceptIndexView.tsx — the bundle's concept vocabulary, for a human (US7
// AS1). Each row is a concept TERM — a topic (violet `concept` pill) or a
// PERSON (teal `person` pill, ADR-011) — and expanding it shows up to five of
// the (document, chapter) pairs it covers.
//
// A bundle of hundreds of documents has thousands of terms, so this view
// never loads them all (FR-036, ADR-019): the name filter runs in the service
// — the same okf_list_concepts an ingest uses to reuse a term — and the
// result is paged, 100 at a time. Finding CONTENT is the Query tab's search.

import React from "react";
import { Icon } from "../lib/icons";
import { fetchConcepts, mergeConcepts } from "../lib/serviceClient";
import type { VocabPage, VocabTerm } from "../lib/types";
import { Pager } from "./DocumentsView";
import { StatusPill } from "./Overview";

const PAGE = 100;
const DEBOUNCE_MS = 250;

interface Props {
  bundle: string;
  /** Changes whenever the bundle may have changed. */
  refreshKey: unknown;
  indexGeneratedAt: string | null;
  initialQuery?: string;
  onOpenChapter: (docId: string, chId: string) => void;
  onChanged: () => void;
}

function useDebounced<T>(value: T, ms: number): T {
  const [v, setV] = React.useState(value);
  React.useEffect(() => {
    const t = setTimeout(() => setV(value), ms);
    return () => clearTimeout(t);
  }, [value, ms]);
  return v;
}

export default function ConceptIndexView({ bundle, refreshKey, indexGeneratedAt, initialQuery, onOpenChapter, onChanged }: Props) {
  const [query, setQuery] = React.useState(initialQuery || "");
  const [offset, setOffset] = React.useState(0);
  const [page, setPage] = React.useState<VocabPage | null>(null);
  const [error, setError] = React.useState<string | null>(null);
  const [expanded, setExpanded] = React.useState<string | null>(initialQuery || null);
  const [mergeFrom, setMergeFrom] = React.useState<string | null>(null);
  const debounced = useDebounced(query.trim(), DEBOUNCE_MS);

  React.useEffect(() => {
    if (initialQuery) {
      setQuery(initialQuery);
      setExpanded(initialQuery);
    }
  }, [initialQuery]);

  React.useEffect(() => {
    setOffset(0);
  }, [debounced, bundle]);

  React.useEffect(() => {
    let cancelled = false;
    setError(null);
    fetchConcepts(bundle, { query: debounced || undefined, offset, limit: PAGE })
      .then((p) => !cancelled && setPage(p))
      .catch((e) => !cancelled && setError((e as Error).message));
    return () => {
      cancelled = true;
    };
  }, [bundle, debounced, offset, refreshKey]);

  const from = page && page.total ? page.offset + 1 : 0;
  const to = page ? Math.min(page.offset + page.terms.length, page.total) : 0;

  return (
    <div data-testid="concept-index">
      <div className="search">
        <Icon name="search" size={15} />
        <input placeholder="Filter terms by name…" value={query} onChange={(e) => setQuery(e.target.value)} data-testid="term-filter" />
        {query ? (
          <span className="clear" onClick={() => setQuery("")}>
            <Icon name="x" size={14} />
          </span>
        ) : null}
      </div>

      <div className="note">
        <Icon name="info" size={14} />
        <span>
          <b>Concept index</b> — the bundle's vocabulary. Each row is a <span style={{ color: "var(--violet)" }}>concept term</span> or a{" "}
          <span style={{ color: "var(--teal)" }}>person-kind term</span> (a salient person the bundle is by or about); expand it to see the
          chapters it covers. The vocabulary grows with the bundle, so it is <b>filtered by name and paged</b> ({PAGE} at a time) — the same{" "}
          <code>okf_list_concepts</code> an ingest uses to reuse a term. To find <i>content</i>, use the Query tab's search.{" "}
          <b>Derived &amp; regenerable</b> from chapter frontmatter
          {indexGeneratedAt ? <> · last rebuilt {new Date(indexGeneratedAt).toLocaleString()}</> : null}.
        </span>
      </div>

      {error ? <div className="app-error">Could not read the vocabulary: {error}</div> : null}
      {!page && !error ? <div className="app-loading">Loading the vocabulary…</div> : null}

      {page && !page.total ? (
        <div className="empty" style={{ padding: 40 }} data-testid="terms-empty">
          <h3 style={{ fontSize: 15 }}>No concept terms match</h3>
          <p>
            {debounced
              ? "No term's name contains that. To find content by any word, use the Query tab's search."
              : "Ingest a document, or upsert a chapter with a `concepts` array, and its terms appear here."}
          </p>
        </div>
      ) : null}

      {page && page.total ? (
        <>
          <div className="count" style={{ marginBottom: 10 }} data-testid="terms-count">
            {debounced ? `${page.total.toLocaleString()} terms match` : `${page.total.toLocaleString()} concept terms`}
          </div>
          {page.terms.map((t) => (
            <TermRow
              key={`${t.kind}:${t.term}`}
              bundle={bundle}
              t={t}
              open={expanded === t.term}
              onToggle={() => setExpanded(expanded === t.term ? null : t.term)}
              merging={mergeFrom === t.term}
              onToggleMerge={() => setMergeFrom(mergeFrom === t.term ? null : t.term)}
              onMerged={() => {
                setMergeFrom(null);
                onChanged();
              }}
              onOpenChapter={onOpenChapter}
            />
          ))}
          <Pager
            from={from}
            to={to}
            total={page.total}
            noun="terms"
            onPrev={offset > 0 ? () => setOffset(Math.max(0, offset - PAGE)) : null}
            onNext={to < page.total ? () => setOffset(offset + PAGE) : null}
          />
        </>
      ) : null}
    </div>
  );
}

function TermRow({
  bundle,
  t,
  open,
  onToggle,
  merging,
  onToggleMerge,
  onMerged,
  onOpenChapter,
}: {
  bundle: string;
  t: VocabTerm;
  open: boolean;
  onToggle: () => void;
  merging: boolean;
  onToggleMerge: () => void;
  onMerged: () => void;
  onOpenChapter: (docId: string, chId: string) => void;
}) {
  const person = t.kind === "person";
  const attention = t.covers.some((c) => c.stale || c.status === "deprecated");
  return (
    <div className={`term${open ? " open" : ""}${person ? " person" : ""}`} data-testid={`term-${t.term}`}>
      <div className="t-head" onClick={onToggle} data-testid={`term-head-${t.term}`}>
        <Icon name="caret" size={15} className="caret" />
        <span className="t-name">{t.term}</span>
        <span className={`t-key${person ? " person" : ""}`} data-testid={`term-kind-${t.term}`}>
          {person ? "person" : "concept"}
        </span>
        {attention ? <span className="pill stale">attention</span> : null}
        <span className="t-cnt">
          {t.count} chapter{t.count === 1 ? "" : "s"}
        </span>
        <button
          className="ibtn"
          title={`Merge "${t.term}" into another term`}
          data-testid={`merge-term-${t.term}`}
          onClick={(e) => {
            e.stopPropagation();
            onToggleMerge();
          }}
        >
          <Icon name="layers" size={14} />
        </button>
      </div>
      {merging ? <MergePanel bundle={bundle} from={t.term} onCancel={onToggleMerge} onMerged={onMerged} /> : null}
      {open ? (
        <div className="t-body">
          {t.covers.map((c) => (
            <div key={`${c.docId}/${c.chId}`} className="cover" onClick={() => onOpenChapter(c.docId, c.chId)} data-testid={`cover-${c.docId}-${c.chId}`}>
              <div className="c-loc">
                <span className="doc">{c.docTitle}</span>
                {c.chId ? (
                  <>
                    <span className="arrow">›</span>
                    {c.title}
                  </>
                ) : null}{" "}
                <StatusPill status={c.status} stale={c.stale} />
              </div>
              <div className="c-desc">{c.description || "— no description —"}</div>
              <span className="c-go">
                open <Icon name="back" size={12} />
              </span>
            </div>
          ))}
          {t.coversTotal > t.covers.length ? (
            <div className="count" style={{ padding: "8px 14px" }} data-testid={`covers-more-${t.term}`}>
              …and {t.coversTotal - t.covers.length} more — search “{t.term}” in the Query tab to see every chapter.
            </div>
          ) : null}
        </div>
      ) : null}
    </div>
  );
}

/** Merge `from` into a canonical term chosen by TYPING its name — a list of
 *  every term would not fit, and a page of them would hide the right one. */
function MergePanel({ bundle, from, onCancel, onMerged }: { bundle: string; from: string; onCancel: () => void; onMerged: () => void }) {
  const [to, setTo] = React.useState("");
  const [options, setOptions] = React.useState<VocabTerm[]>([]);
  const [error, setError] = React.useState<string | null>(null);
  const [busy, setBusy] = React.useState(false);
  const typed = useDebounced(to.trim(), DEBOUNCE_MS);
  const listId = `merge-options-${from}`;

  React.useEffect(() => {
    let cancelled = false;
    if (!typed) {
      setOptions([]);
      return;
    }
    fetchConcepts(bundle, { query: typed, limit: 20 })
      .then((p) => !cancelled && setOptions(p.terms.filter((o) => o.term !== from)))
      .catch((e) => !cancelled && setError((e as Error).message));
    return () => {
      cancelled = true;
    };
  }, [bundle, typed, from]);

  const run = async () => {
    setError(null);
    setBusy(true);
    try {
      await mergeConcepts(bundle, from, to.trim());
      onMerged();
    } catch (e) {
      setError((e as Error).message);
    } finally {
      setBusy(false);
    }
  };

  return (
    <div className="t-body" style={{ padding: "10px 14px" }} data-testid={`merge-panel-${from}`} onClick={(e) => e.stopPropagation()}>
      <div className="desc" style={{ marginBottom: 8 }}>
        Merge <code>{from}</code> into a canonical term. Every chapter that lists <code>{from}</code> is rewritten; the index and the affected
        document TOCs follow.
      </div>
      <input
        list={listId}
        placeholder="Type the canonical term…"
        value={to}
        onChange={(e) => setTo(e.target.value)}
        data-testid={`merge-target-${from}`}
      />
      <datalist id={listId}>
        {options.map((o) => (
          <option key={o.term} value={o.term}>
            {o.term} ({o.count})
          </option>
        ))}
      </datalist>
      {error ? <div className="app-error" style={{ margin: "10px 0 0" }}>{error}</div> : null}
      <div className="row" style={{ marginTop: 12 }}>
        <button className="btn" onClick={onCancel}>
          Cancel
        </button>
        <button className="btn primary" disabled={!to.trim() || busy} onClick={run} data-testid={`merge-confirm-${from}`}>
          {busy ? "Merging…" : "Merge"}
        </button>
      </div>
    </div>
  );
}
