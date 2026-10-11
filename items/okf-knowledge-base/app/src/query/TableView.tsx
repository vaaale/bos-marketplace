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
  matches: Set<string> | null;
  query: string;
  selectedId: string | null;
  onSelect: (node: GraphNode) => void;
}

const TYPE_LABEL: Record<string, string> = { doc: "Document", chap: "Chapter", concept: "Concept", person: "Person" };
const TYPE_DOT: Record<string, string> = {
  doc: "dot-doc",
  chap: "dot-chap",
  concept: "dot-concept",
  person: "dot-person",
};

/** The Kind column (ADR-011): a term row reports `topic`/`person`; a document
 *  or chapter row has no term kind, so it reads "—". */
function KindCell({ type }: { type: string }) {
  if (type === "person") return <span className="t-key person">person</span>;
  if (type === "concept") return <span className="t-key">topic</span>;
  return <span style={{ color: "var(--muted)" }}>—</span>;
}

export default function TableView({ nodes, matches, query, selectedId, onSelect }: Props) {
  const rows = matches ? nodes.filter((n) => matches.has(n.id)) : nodes;

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
              <th style={{ width: 96 }}>Kind</th>
              <th>Description / Label</th>
            </tr>
          </thead>
          <tbody>
            {rows.map((n) => (
              <tr
                // A graph node id is unique only WITHIN its type: the service
                // emits a doc node and a concept node that both have id
                // "api-design" when a document's id is also a concept term.
                // Keyed on `n.id` alone that was a duplicate React key AND two
                // rows sharing one data-testid (a Playwright strict-mode
                // violation). Type-qualify both.
                key={`${n.type}-${n.id}`}
                className="clickable"
                onClick={() => onSelect(n)}
                data-testid={`table-row-${n.type}-${n.id}`}
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
                <td data-testid={`table-kind-${n.type}-${n.id}`}>
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
