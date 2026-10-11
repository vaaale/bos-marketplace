// QueryTab.tsx — the Query tab as ONE unified view (FR-042/FR-043):
//
//   bundle selector · a SHARED search field · a Graph / Table toggle
//   ────────────────────────────────────────────────────────────────
//   [ graph or table ]   ║ resizer ║   [ reader pane ]
//
// ── How the shared search works (the part worth being precise about) ─────
//
// FR-043 requires the field to run "the same concept-anchored search the
// agent uses" AND to reflect in BOTH views. Those two pull in different
// directions: okf_search returns TOC ROWS (chapters), but the Graph and the
// Table are over NODES (documents, chapters, concept terms). So:
//
//   1. The query goes to the service's /search route — the identical
//      core.search() the okf_search tool runs. No client-side matching.
//   2. Its rows are expanded into a NODE MATCH SET: each matched chapter,
//      its parent document, and the concept term that matched it. The
//      "matched concept" strip shows those terms, so the user can see the
//      routing that produced the highlight.
//   3. Node labels containing the query are added too, so typing a document
//      title finds that document even when no concept term matches — the
//      mockup's behaviour, and the thing a user expects from a search box.
//
// One match set, two renderings: the Table filters to it, the Graph
// highlights it and dims everything else to 30%. That is what makes the
// views genuinely mirror each other.

import React from "react";
import { Icon } from "../lib/icons";
import { fetchBundleDetail, fetchGraph, search as runSearch } from "../lib/serviceClient";
import type { BundleDetail, BundleGraph, BundleHealth, GraphNode, SearchRow, TermKind } from "../lib/types";
import GraphView from "./GraphView";
import TableView from "./TableView";
import ReaderPane, { type PaneTarget } from "./ReaderPane";

const SEARCH_DEBOUNCE_MS = 220;
const MIN_PANE_PX = 300;

interface Props {
  bundles: BundleHealth[];
  bundle: string | null;
  onBundle: (name: string) => void;
}

export default function QueryTab({ bundles, bundle, onBundle }: Props) {
  const [view, setView] = React.useState<"graph" | "table">("graph");
  const [query, setQuery] = React.useState("");
  const [rows, setRows] = React.useState<SearchRow[] | null>(null);
  const [graph, setGraph] = React.useState<BundleGraph | null>(null);
  const [detail, setDetail] = React.useState<BundleDetail | null>(null);
  const [target, setTarget] = React.useState<PaneTarget | null>(null);
  const [resizeToken, setResizeToken] = React.useState(0);
  const [error, setError] = React.useState<string | null>(null);
  const resizerRef = React.useRef<HTMLDivElement | null>(null);

  // ── data ───────────────────────────────────────────────────────────────
  React.useEffect(() => {
    if (!bundle) return;
    let cancelled = false;
    setGraph(null);
    setDetail(null);
    setTarget(null);
    setError(null);
    Promise.all([fetchGraph(bundle), fetchBundleDetail(bundle)])
      .then(([g, d]) => {
        if (cancelled) return;
        setGraph(g);
        setDetail(d);
      })
      .catch((e) => !cancelled && setError((e as Error).message));
    return () => {
      cancelled = true;
    };
  }, [bundle]);

  // ── the shared search: debounced, server-side, concept-anchored ────────
  React.useEffect(() => {
    if (!bundle) return;
    const q = query.trim();
    if (!q) {
      setRows(null);
      return;
    }
    let cancelled = false;
    const t = setTimeout(() => {
      runSearch(bundle, q, 200)
        .then((res) => !cancelled && setRows(res.rows))
        .catch(() => !cancelled && setRows([]));
    }, SEARCH_DEBOUNCE_MS);
    return () => {
      cancelled = true;
      clearTimeout(t);
    };
  }, [bundle, query]);

  const matches = React.useMemo<Set<string> | null>(() => {
    const q = query.trim().toLowerCase();
    if (!q || !graph) return null;
    const set = new Set<string>();
    for (const r of rows || []) {
      set.add(`${r.docId}/${r.chId}`);
      set.add(r.docId);
      set.add(r.matchedConcept);
      // a PERSON term's node id is the lowercased name (its label keeps the
      // original case), so match on both spellings — a person node then
      // highlights/dims exactly like a concept node (ADR-011)
      set.add(r.matchedConcept.toLowerCase());
    }
    for (const n of graph.nodes) if (n.label.toLowerCase().includes(q)) set.add(n.id);
    return set;
  }, [rows, graph, query]);

  // the "matched …" strip: one entry per distinct term that routed a row,
  // carrying the term's kind so a person reads as a person (ADR-011)
  const matchedConcepts = React.useMemo(() => {
    const byName = new Map<string, TermKind>();
    for (const r of rows || []) if (!byName.has(r.matchedConcept)) byName.set(r.matchedConcept, r.kind || "topic");
    return Array.from(byName, ([name, kind]) => ({ name, kind }));
  }, [rows]);

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

  const selectNode = React.useCallback((n: GraphNode) => {
    setTarget(
      n.type === "doc"
        ? { kind: "doc", docId: n.id, chId: null, term: null }
        : n.type === "chap"
          ? { kind: "chap", docId: n.docId || n.id.split("/")[0], chId: n.chId || n.id.split("/").slice(1).join("/"), term: null }
          // a person node opens the SAME term view as a concept term — the
          // pane labels it "Person" off the term's own kind (ADR-011)
          : { kind: "concept", docId: null, chId: null, term: n.id },
    );
  }, []);

  const selectedId =
    target?.kind === "doc" ? target.docId : target?.kind === "chap" ? `${target.docId}/${target.chId}` : target?.term ?? null;

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
              {query.trim() && matches ? `${matches.size} match${matches.size === 1 ? "" : "es"}` : ""}
            </span>
          </div>

          <div className="search q-search">
            <Icon name="search" size={15} />
            <input
              placeholder="Search knowledge base (concept-anchored — the same okf_search the agent runs)…"
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
              {rows === null ? (
                <span>Searching…</span>
              ) : matchedConcepts.length ? (
                <>
                  <span>
                    okf_search matched {rows.length} chapter{rows.length === 1 ? "" : "s"} via:
                  </span>
                  {matchedConcepts.map((t) => (
                    <span
                      className={`chip${t.kind === "person" ? " person" : ""}`}
                      key={`${t.kind}:${t.name}`}
                      title={t.kind === "person" ? "matched person" : "matched concept"}
                      data-testid={`matched-${t.kind}-${t.name}`}
                      onClick={() => setTarget({ kind: "concept", docId: null, chId: null, term: t.name })}
                    >
                      <span className="cdot" />
                      {t.kind === "person" ? <span className="t-key person">matched person</span> : null}
                      {t.name}
                    </span>
                  ))}
                </>
              ) : (
                <span>
                  No concept term matched — the search matches the vocabulary and the stored descriptions, not full
                  text. Node names matching “{query.trim()}” are still highlighted.
                </span>
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
            <TableView
              nodes={graph.nodes}
              matches={matches}
              query={query}
              selectedId={selectedId}
              onSelect={selectNode}
            />
          )}
        </div>
      </div>

      <div className="resizer" ref={resizerRef} data-testid="pane-resizer" title="Drag to resize the reader pane" />

      <div className="q-pane" data-testid="reader-pane">
        <ReaderPane
          bundle={bundle || ""}
          target={target}
          terms={detail?.conceptIndex || []}
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
