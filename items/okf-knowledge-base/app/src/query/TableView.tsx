// TableView.tsx — the Table half of the Query tab's Graph/Table toggle
// (FR-042): the SAME nodes the graph renders — documents, chapters and
// concept terms — as a list of (type, name, description).
//
// While a query is active the Query tab shows the ranked search hits
// (SearchHits.tsx) in this place instead: a search answers with hits, and the
// graph lights up the same hits (FR-043 as amended 2026-10-14).

import React from "react";
import type { GraphNode } from "../lib/types";
import { nodeRef } from "./nodeRef";

const TYPE_LABEL: Record<string, string> = { doc: "Document", chap: "Chapter", concept: "Concept", person: "Person" };
const TYPE_DOT: Record<string, string> = {
  doc: "dot-doc",
  chap: "dot-chap",
  concept: "dot-concept",
  person: "dot-person",
};

interface Props {
  nodes: GraphNode[];
  selectedId: string | null;
  onSelect: (node: GraphNode) => void;
}

/** The Kind column (ADR-011): a term row reports `topic`/`person`; a document
 *  or chapter row has no term kind, so it reads "—". */
function KindCell({ type }: { type: string }) {
  if (type === "person") return <span className="t-key person">person</span>;
  if (type === "concept") return <span className="t-key">topic</span>;
  return <span style={{ color: "var(--muted)" }}>—</span>;
}

/**
 * Every node of the bundle's graph as a table. While a query is active the
 * Query tab shows the ranked search hits instead (SearchHits) — a hit list is
 * what a search answers with; this is the unfiltered view.
 */
export default function TableView({ nodes, selectedId, onSelect }: Props) {
  const rows = nodes;
  return (
    <div data-testid="table-view">
      <div className="count" style={{ margin: "0 0 10px" }} data-testid="table-count">
        {`${nodes.length} nodes · documents, chapters and concept terms`}
      </div>

      {!rows.length ? (
        <div className="empty" style={{ padding: 36 }} data-testid="table-empty">
          <h3 style={{ fontSize: 15 }}>No nodes yet</h3>
          <p>Ingest a document and its chapters and terms appear here.</p>
        </div>
      ) : (
        <table>
          <thead>
            <tr>
              <th style={{ width: 128 }}>Type</th>
              <th>Name</th>
              <th style={{ width: 96 }}>Kind</th>
              <th>Description / Label</th>
            </tr>
          </thead>
          <tbody>
            {rows.map((n) => (
              <tr
                // `n.id` is the namespaced key, unique across kinds (FR-073(f));
                // the test id keeps the bare content reference it always had
                key={n.id}
                className="clickable"
                onClick={() => onSelect(n)}
                data-testid={`table-row-${n.type}-${nodeRef(n)}`}
                style={selectedId === n.id ? { outline: "1px solid var(--accent)" } : undefined}
              >
                <td>
                  <span className={`dot ${TYPE_DOT[n.type]}`} />
                  <span style={{ color: "var(--muted)", fontSize: 12 }}>{TYPE_LABEL[n.type]}</span>
                </td>
                <td>
                  <span className="name" style={{ fontWeight: n.type === "doc" ? 600 : 500 }}>
                    {n.label}
                  </span>
                </td>
                <td data-testid={`table-kind-${n.type}-${nodeRef(n)}`}>
                  <KindCell type={n.type} />
                </td>
                <td style={{ color: "var(--muted)" }}>{n.description || "—"}</td>
              </tr>
            ))}
          </tbody>
        </table>
      )}
    </div>
  );
}
