// BundleList.tsx — the Overview tab's root: every knowledge base with its
// per-bundle health (FR-027 / US7 AS3). Docs / Chapters / Concepts / Stale
// come straight from okf-core's derived model via GET /bundles.

import React from "react";
import { Icon } from "../lib/icons";
import type { BundleHealth } from "../lib/types";

interface Props {
  bundles: BundleHealth[];
  onOpen: (name: string) => void;
  onNew: () => void;
  onImport: () => void;
  onDelete: (b: BundleHealth) => void;
}

export default function BundleList({ bundles, onOpen, onNew, onImport, onDelete }: Props) {
  if (!bundles.length) {
    return (
      <div className="empty" data-testid="bundles-empty">
        <h3>No knowledge bases yet</h3>
        <p>
          Create an OKF bundle to start building your knowledge base,
          <br />
          or import an existing one. Each bundle is a self-contained, exportable OKF directory.
        </p>
        <button className="btn primary" onClick={onNew} data-testid="new-bundle-btn">
          + New Knowledge Base
        </button>
        <button className="btn" onClick={onImport} data-testid="import-bundle-btn">
          Import Bundle
        </button>
      </div>
    );
  }

  return (
    <div data-testid="bundle-list">
      <div className="toolbar">
        <button className="btn primary" onClick={onNew} data-testid="new-bundle-btn">
          + New Knowledge Base
        </button>
        <button className="btn" onClick={onImport} data-testid="import-bundle-btn">
          Import Bundle
        </button>
        <div className="spacer" />
        <span className="count" data-testid="bundle-count">
          {bundles.length} bundle{bundles.length === 1 ? "" : "s"}
        </span>
      </div>

      <table>
        <thead>
          <tr>
            <th>Knowledge base</th>
            <th>Docs</th>
            <th>Chapters</th>
            <th>Concepts</th>
            <th>Stale / Deprecated</th>
            <th>Status</th>
            <th />
          </tr>
        </thead>
        <tbody>
          {bundles.map((b) => {
            const attention = b.stale + b.deprecated;
            return (
              <tr key={b.name} className="clickable" onClick={() => onOpen(b.name)} data-testid={`bundle-row-${b.name}`}>
                <td>
                  <span className="name">
                    <span className="glyph">📚</span>
                    {b.name}
                  </span>
                </td>
                <td className="num-col">{b.docs}</td>
                <td className="num-col">{b.chapters}</td>
                <td className="num-col" data-testid={`bundle-terms-${b.name}`}>
                  {b.conceptTerms}
                </td>
                <td className="num-col">
                  {attention ? <span className="dot amber" /> : null}
                  {attention}
                </td>
                <td>
                  <span className={`dot ${b.status === "healthy" ? "green" : "amber"}`} />
                  {b.status}
                </td>
                <td style={{ textAlign: "right" }}>
                  <button
                    className="ibtn danger"
                    title="Delete bundle"
                    data-testid={`delete-bundle-${b.name}`}
                    onClick={(e) => {
                      e.stopPropagation();
                      onDelete(b);
                    }}
                  >
                    <Icon name="trash" size={15} />
                  </button>
                </td>
              </tr>
            );
          })}
        </tbody>
      </table>

      <div className="note" style={{ marginTop: 14 }}>
        <Icon name="info" size={14} />
        <span>
          <b>Concepts</b> = distinct concept terms in the bundle's concept index (the O(V) routing table).{" "}
          <b>Stale / Deprecated</b> = chapters past their lifecycle threshold. Open a bundle to browse its concept index
          and document tables of contents.
        </span>
      </div>
    </div>
  );
}
