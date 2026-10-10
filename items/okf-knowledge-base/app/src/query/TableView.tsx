// TableView.tsx — the Table half of the Query tab's Graph/Table toggle
// (FR-042): the SAME nodes the graph renders — documents, chapters and
// concept terms — as a list of (type, name, description), filtered by the
// shared search field.
//
// "Filtered by the shared search" means the same match set the graph
// highlights: the node ids implicated by the service's concept-anchored
// okf_search result, plus direct label hits. One query, one match set, two
// renderings — which is what makes the two views genuinely reflect each
// other rather than merely both having a search box.

import React from "react";
import type { GraphNode } from "../lib/types";

interface Props {
  nodes: GraphNode[];
  /** Node `key`s, not semantic ids. */
  matches: Set<string> | null;
  query: string;
  /** The selected node's `key`. */
  selectedId: string | null;
  onSelect: (node: GraphNode) => void;
}

const TYPE_LABEL: Record<string, string> = { doc: "Document", chap: "Chapter", concept: "Concept" };
const TYPE_DOT: Record<string, string> = { doc: "dot-doc", chap: "dot-chap", concept: "dot-concept" };

export default function TableView({ nodes, matches, query, selectedId, onSelect }: Props) {
  const rows = matches ? nodes.filter((n) => matches.has(n.key)) : nodes;

  return (
    <div data-testid="table-view">
      <div className="count" style={{ margin: "0 0 10px" }} data-testid="table-count">
        {query.trim()
          ? `${rows.length} of ${nodes.length} nodes match “${query.trim()}”`
          : `${nodes.length} nodes · documents, chapters and concept terms`}
      </div>

      {!rows.length ? (
        <div className="empty" style={{ padding: 36 }} data-testid="table-empty">
          <h3 style={{ fontSize: 15 }}>No nodes match</h3>
          <p>
            The search is concept-anchored: it matches the bundle's concept vocabulary and the one-line descriptions in
            the index, plus node names. Try a broader term.
          </p>
        </div>
      ) : (
        <table>
          <thead>
            <tr>
              <th style={{ width: 128 }}>Type</th>
              <th>Name</th>
              <th>Description / Label</th>
            </tr>
          </thead>
          <tbody>
            {rows.map((n) => (
              <tr
                key={n.key}
                className="clickable"
                onClick={() => onSelect(n)}
                data-testid={`table-row-${n.key}`}
                style={selectedId === n.key ? { outline: "1px solid var(--accent)" } : undefined}
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
                <td style={{ color: "var(--muted)" }}>{n.description || "—"}</td>
              </tr>
            ))}
          </tbody>
        </table>
      )}
    </div>
  );
}
