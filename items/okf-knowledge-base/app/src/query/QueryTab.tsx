// QueryTab.tsx — the Query tab as ONE unified view (FR-042/FR-043):
//
//   bundle selector · a SHARED search field · a Graph / Table toggle
//   ────────────────────────────────────────────────────────────────
//   [ graph or table ]   ║ resizer ║   [ reader pane ]
//
// ── How the shared search works ─────────────────────────────────────────
//
// FR-043 (as amended 2026-10-14): the field runs the same okf_search the agent
// runs — terms, titles, summaries and full text — server-side, debounced, and
// reflects it in BOTH views:
//
//   • Table: the ranked hits themselves (SearchHits), with what matched and,
//     for a full-text match, the excerpt; "By document" groups them.
//   • Graph: the hits' chapters, their documents and the matched terms light
//     up (lib/graphlayout.mjs matchSet), the rest fades and the view zooms to
//     them (FR-073 e).
//
// A failed search is shown as a failure — never read as "no hits".

import React from "react";
import { Icon } from "../lib/icons";
import { matchSet } from "../lib/graphlayout.mjs";
import { fetchGraph, search as runSearch, searchByDocument } from "../lib/serviceClient";
import type { BundleGraph, BundleHealth, GraphNode, GroupedSearchResult, SearchResult, SearchRow } from "../lib/types";
import GraphView from "./GraphView";
import TableView from "./TableView";
import SearchHits from "./SearchHits";
import ReaderPane, { type PaneTarget } from "./ReaderPane";

const SEARCH_DEBOUNCE_MS = 220;
/** The search's maximum page: the graph lights up every hit it is given. */
const SEARCH_LIMIT = 50;
const MIN_PANE_PX = 300;

interface Props {
  bundles: BundleHealth[];
  bundle: string | null;
  onBundle: (name: string) => void;
}

export default function QueryTab({ bundles, bundle, onBundle }: Props) {
  const [view, setView] = React.useState<"graph" | "table">("graph");
  const [query, setQuery] = React.useState("");
  const [result, setResult] = React.useState<SearchResult | null>(null);
  const [grouped, setGrouped] = React.useState<GroupedSearchResult | null>(null);
  const [byDocument, setByDocument] = React.useState(false);
  const [searchError, setSearchError] = React.useState<string | null>(null);
  const [graph, setGraph] = React.useState<BundleGraph | null>(null);
  const [target, setTarget] = React.useState<PaneTarget | null>(null);
  const [resizeToken, setResizeToken] = React.useState(0);
  const [error, setError] = React.useState<string | null>(null);
  const resizerRef = React.useRef<HTMLDivElement | null>(null);

  // ── data ───────────────────────────────────────────────────────────────
  React.useEffect(() => {
    if (!bundle) return;
    let cancelled = false;
    setGraph(null);
    setTarget(null);
    setError(null);
    fetchGraph(bundle)
      .then((g) => !cancelled && setGraph(g))
      .catch((e) => !cancelled && setError((e as Error).message));
    return () => {
      cancelled = true;
    };
  }, [bundle]);

  // ── the shared search: debounced, server-side — the same okf_search the
  // agent runs (FR-043). A failure is shown, never read as "no hits".
  React.useEffect(() => {
    if (!bundle) return;
    const q = query.trim();
    setSearchError(null);
    if (!q) {
      setResult(null);
      setGrouped(null);
      return;
    }
    let cancelled = false;
    const t = setTimeout(() => {
      runSearch(bundle, q, SEARCH_LIMIT)
        .then((res) => !cancelled && setResult(res))
        .catch((e) => !cancelled && setSearchError((e as Error).message));
      if (byDocument) {
        searchByDocument(bundle, q)
          .then((res) => !cancelled && setGrouped(res))
          .catch((e) => !cancelled && setSearchError((e as Error).message));
      }
    }, SEARCH_DEBOUNCE_MS);
    return () => {
      cancelled = true;
      clearTimeout(t);
    };
  }, [bundle, query, byDocument]);

  // the nodes the hits light up: chapters, their documents, matched terms
  const matches = React.useMemo<Set<string> | null>(() => {
    if (!query.trim() || !graph || !result) return null;
    return matchSet(result.rows, graph.nodes, query);
  }, [result, graph, query]);

  // ── the mouse-resizable divider ────────────────────────────────────────
  React.useEffect(() => {
    const resizer = resizerRef.current;
    // the flex row itself (#app-query) — the resizer's own parent. Measuring a
    // display:contents wrapper would give 0x0 and the drag math would break.
    const host = resizer?.parentElement;
    if (!resizer || !host) return;
    let dragging = false;
    const onDown = (e: MouseEvent) => {
      dragging = true;
      document.body.style.userSelect = "none";
      document.body.style.cursor = "col-resize";
      e.preventDefault();
    };
    const onMove = (e: MouseEvent) => {
      if (!dragging) return;
      const rect = host.getBoundingClientRect();
      const w = Math.max(MIN_PANE_PX, Math.min(rect.right - e.clientX - 3, rect.width * 0.72));
      host.style.setProperty("--pane-w", `${w}px`);
    };
    const onUp = () => {
      if (!dragging) return;
      dragging = false;
      document.body.style.userSelect = "";
      document.body.style.cursor = "";
      // the graph sizes its viewBox from the real container, so it must
      // re-lay-out once the pane has settled at its new width
      setResizeToken((n) => n + 1);
    };
    resizer.addEventListener("mousedown", onDown as EventListener);
    window.addEventListener("mousemove", onMove);
    window.addEventListener("mouseup", onUp);
    return () => {
      resizer.removeEventListener("mousedown", onDown as EventListener);
      window.removeEventListener("mousemove", onMove);
      window.removeEventListener("mouseup", onUp);
    };
  }, [bundle]);

  // A node's id is its namespaced key; the reader pane wants the content
  // reference, which every node carries (docId / chId / term).
  const selectNode = React.useCallback((n: GraphNode) => {
    setTarget(
      n.type === "doc"
        ? { kind: "doc", docId: n.docId || null, chId: null, term: null }
        : n.type === "chap"
          ? { kind: "chap", docId: n.docId || null, chId: n.chId || null, term: null }
          // a person node opens the SAME term view as a concept term — the
          // pane labels it "Person" off the term's own kind (ADR-011)
          : { kind: "concept", docId: null, chId: null, term: n.term || n.label },
    );
  }, []);

  const openRow = React.useCallback((r: SearchRow) => {
    setTarget(r.chId ? { kind: "chap", docId: r.docId, chId: r.chId, term: null } : { kind: "doc", docId: r.docId, chId: null, term: null });
  }, []);

  const selectedId = React.useMemo(() => {
    if (!target || !graph) return null;
    const n = graph.nodes.find((g) =>
      target.kind === "doc"
        ? g.type === "doc" && g.docId === target.docId
        : target.kind === "chap"
          ? g.type === "chap" && g.docId === target.docId && g.chId === target.chId
          : (g.type === "concept" || g.type === "person") && String(g.term || g.label).toLowerCase() === String(target.term).toLowerCase(),
    );
    return n ? n.id : null;
  }, [target, graph]);

  if (!bundles.length) {
    return (
      <div className="q-main">
        <div className="q-content">
          <div className="empty" style={{ margin: 0 }} data-testid="query-empty">
            <h3>No knowledge base selected</h3>
            <p>
              Create or import a bundle in the <b>Overview</b> tab to explore its knowledge graph or browse its node
              table.
            </p>
          </div>
        </div>
      </div>
    );
  }

  return (
    <>
      <div className="q-main">
        <div className="q-head">
          <div className="q-bundle-row">
            <label className="q-bundle">
              Bundle
              <select value={bundle || ""} onChange={(e) => onBundle(e.target.value)} data-testid="query-bundle-select">
                {bundles.map((b) => (
                  <option key={b.name} value={b.name}>
                    {b.name}
                  </option>
                ))}
              </select>
            </label>
            <div className="q-spacer" />
            <span className="count" data-testid="query-match-count">
              {query.trim() && result ? matchSummary(result) : ""}
            </span>
          </div>

          <div className="search q-search">
            <Icon name="search" size={15} />
            <input
              placeholder="Search terms, titles, summaries and full text — the same okf_search the agent runs…"
              value={query}
              onChange={(e) => setQuery(e.target.value)}
              data-testid="query-search"
            />
            {query ? (
              <span
                className="clear"
                style={{ display: "inline-flex" }}
                onClick={() => setQuery("")}
                data-testid="query-clear"
              >
                <Icon name="x" size={14} />
              </span>
            ) : null}
          </div>

          <div className="q-viewtoggle" data-testid="view-toggle">
            <button className={view === "graph" ? "on" : ""} onClick={() => setView("graph")} data-testid="view-graph">
              <Icon name="graph" size={13} /> Graph
            </button>
            <button className={view === "table" ? "on" : ""} onClick={() => setView("table")} data-testid="view-table">
              <Icon name="list" size={13} /> Table
            </button>
          </div>

          {query.trim() ? (
            <div className="q-suggest" data-testid="matched-concepts">
              {searchError ? (
                <span className="app-error" style={{ margin: 0 }}>
                  The search failed: {searchError}
                </span>
              ) : !result ? (
                <span>Searching…</span>
              ) : matchedTerms(result.rows).length ? (
                <>
                  <span>Matched terms:</span>
                  {matchedTerms(result.rows).map((t) => (
                    <span
                      className={`chip${t.kind === "person" ? " person" : ""}`}
                      key={`${t.kind}:${t.name}`}
                      title={t.kind === "person" ? "matched person" : "matched concept"}
                      data-testid={`matched-${t.kind === "person" ? "person" : "topic"}-${t.name}`}
                      onClick={() => setTarget({ kind: "concept", docId: null, chId: null, term: t.name })}
                    >
                      <span className="cdot" />
                      {t.kind === "person" ? <span className="t-key person">matched person</span> : null}
                      {t.name}
                    </span>
                  ))}
                </>
              ) : result.total ? (
                <span>No concept term matched — the hits came from titles, summaries or full text.</span>
              ) : (
                <span>Nothing matched in terms, titles, summaries or full text.</span>
              )}
            </div>
          ) : null}
        </div>

        <div className={`q-content${view === "graph" ? " graph-mode" : ""}`} data-testid="query-content">
          {error ? (
            <div className="app-error">{error}</div>
          ) : !graph ? (
            <div className="app-loading">Deriving the knowledge graph…</div>
          ) : view === "graph" ? (
            <GraphView
              graph={graph}
              matches={matches}
              selectedId={selectedId}
              onSelect={selectNode}
              resizeToken={resizeToken}
            />
          ) : (
            query.trim() ? (
              <SearchHits
                query={query}
                result={result}
                grouped={grouped}
                byDocument={byDocument}
                onByDocument={setByDocument}
                onOpen={openRow}
                onOpenDoc={(docId) => setTarget({ kind: "doc", docId, chId: null, term: null })}
              />
            ) : (
              <TableView nodes={graph.nodes} selectedId={selectedId} onSelect={selectNode} />
            )
          )}
        </div>
      </div>

      <div className="resizer" ref={resizerRef} data-testid="pane-resizer" title="Drag to resize the reader pane" />

      <div className="q-pane" data-testid="reader-pane">
        <ReaderPane
          bundle={bundle || ""}
          target={target}
          onSearch={(q) => {
            setQuery(q);
            setView("table");
          }}
          onOpenChapter={(docId, chId) =>
            // a person term can be covered at DOCUMENT level (the author):
            // such a cover row carries an empty chId, and opens the document
            setTarget(chId ? { kind: "chap", docId, chId, term: null } : { kind: "doc", docId, chId: null, term: null })
          }
          onClose={() => setTarget(null)}
        />
      </div>
    </>
  );
}

/** "7 chapters · 2 concept · 5 full text" — how the hits matched. */
function matchSummary(r: SearchResult): string {
  if (!r.total) return "no match";
  const by = new Map<string, number>();
  for (const row of r.rows) by.set(row.matchKind, (by.get(row.matchKind) || 0) + 1);
  const label: Record<string, string> = { term: "concept", person: "person", title: "title", summary: "summary", text: "full text" };
  return `${r.total} chapter${r.total === 1 ? "" : "s"} · ${Array.from(by, ([k, n]) => `${n} ${label[k]}`).join(" · ")}`;
}

/** The distinct terms that MATCHED (not those a hit is merely anchored to). */
function matchedTerms(rows: SearchRow[]): { name: string; kind: "topic" | "person" }[] {
  const out = new Map<string, "topic" | "person">();
  for (const r of rows) {
    if ((r.matchKind === "term" || r.matchKind === "person") && r.matchedConcept && !out.has(r.matchedConcept)) {
      out.set(r.matchedConcept, r.matchKind === "person" ? "person" : "topic");
    }
  }
  return Array.from(out, ([name, kind]) => ({ name, kind }));
}
