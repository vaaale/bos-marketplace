// ChapterView.tsx — one chapter IN FULL: the frontmatter card, the markdown
// body with its inline-asset blocks (thumbnail + the interpretation stored at
// ingest), and the "View source (.md)" toggle that shows exactly what
// `okf_read_concept` hands an agent (US1 AS2, FR-023, SC-003).
//
// Nothing is truncated and nothing is summarised: the body rendered here is
// byte-for-byte the body the tool returns.

import React from "react";
import { Icon } from "../lib/icons";
import { assetUrl, fetchConcept } from "../lib/serviceClient";
import { AssetBlock, Markdown, splitBody } from "../lib/markdown";
import type { ConceptRead } from "../lib/types";
import { StatusPill } from "./Overview";

export function FrontmatterCard({ concept }: { concept: ConceptRead }) {
  const fm = concept.frontmatter as Record<string, unknown>;
  const row = (key: string, value: React.ReactNode) => (
    <div className="fm-row" key={key}>
      <span className="fm-k">{key}</span>
      <span className="fm-v">{value}</span>
    </div>
  );
  const concepts = Array.isArray(fm.concepts) ? (fm.concepts as string[]) : [];
  return (
    <div className="fm" data-testid="chapter-frontmatter">
      {row("type", <code>{String(fm.type || concept.type)}</code>)}
      {fm.parent ? row("parent", <code>{String(fm.parent)}</code>) : null}
      {concepts.length
        ? row(
            "concepts",
            concepts.map((t) => (
              <code key={t} style={{ marginRight: 6 }}>
                {t}
              </code>
            )),
          )
        : null}
      {fm.summary ? row("summary", String(fm.summary)) : null}
      {fm.status && fm.status !== "stable" ? row("status", <StatusPill status={String(fm.status)} />) : null}
      {fm.stale_after ? row("stale_after", <code>{String(fm.stale_after)}</code>) : null}
    </div>
  );
}

/** The markdown body + its asset blocks, or the raw `.md` source. */
export function ChapterBody({
  bundle,
  concept,
  showSource,
}: {
  bundle: string;
  concept: ConceptRead;
  showSource: boolean;
}) {
  if (showSource) {
    return (
      <div className="src-view" data-testid="chapter-source">
        <pre>{concept.body}</pre>
      </div>
    );
  }
  const blocks = splitBody(concept.body);
  return (
    <div className="md-body" data-testid="chapter-body">
      {blocks.map((b, i) =>
        b.t === "md" ? (
          <Markdown key={i} source={b.v} />
        ) : (
          <AssetBlock key={i} asset={b.v} assetSrc={assetUrl(bundle, b.v.path)} />
        ),
      )}
    </div>
  );
}

interface Props {
  bundle: string;
  docId: string;
  chId: string;
  onBack: () => void;
  backLabel: string;
}

export default function ChapterView({ bundle, docId, chId, onBack, backLabel }: Props) {
  const [concept, setConcept] = React.useState<ConceptRead | null>(null);
  const [error, setError] = React.useState<string | null>(null);
  const [showSource, setShowSource] = React.useState(false);

  React.useEffect(() => {
    let cancelled = false;
    setConcept(null);
    setError(null);
    fetchConcept(bundle, `${docId}/${chId}`)
      .then((c) => !cancelled && setConcept(c))
      .catch((e) => !cancelled && setError((e as Error).message));
    return () => {
      cancelled = true;
    };
  }, [bundle, docId, chId]);

  if (error) return <div className="app-error">Could not read {docId}/{chId}: {error}</div>;
  if (!concept) return <div className="app-loading">Loading the full chapter…</div>;

  const title = String(concept.frontmatter.title || chId);
  return (
    <div data-testid="chapter-view">
      <button className="btn" style={{ marginBottom: 12 }} onClick={onBack} data-testid="chapter-back">
        <Icon name="back" size={15} /> Back to {backLabel}
      </button>

      <div className="chap-card">
        <div className="chap-bar">
          <span className="cb-title">{title}</span>
          <StatusPill status={String(concept.frontmatter.status || "")} />
          <label className="src-toggle" style={{ display: "flex", alignItems: "center", gap: 6, cursor: "pointer", fontSize: 12, color: "var(--muted)", margin: 0, marginLeft: "auto" }}>
            <input
              type="checkbox"
              checked={showSource}
              onChange={(e) => setShowSource(e.target.checked)}
              data-testid="view-source-toggle"
            />{" "}
            View source (.md)
          </label>
        </div>
        {showSource ? (
          <div className="chap-bar" style={{ background: "transparent" }}>
            <span style={{ fontSize: 11, color: "var(--muted)", display: "flex", alignItems: "center", gap: 6 }}>
              <Icon name="code" size={13} /> Raw chapter markdown — exactly what <code>okf_read_concept</code> returns
              (full text, not a snippet)
            </span>
          </div>
        ) : (
          <FrontmatterCard concept={concept} />
        )}
        <ChapterBody bundle={bundle} concept={concept} showSource={showSource} />
      </div>

      <div className="note" style={{ marginTop: 14 }}>
        <Icon name="info" size={14} />
        <span>
          <b>Inline assets</b> are non-HTML artifacts (image/video) that ingest downloads into <code>raw/</code>,
          interprets once, and writes back into the chapter as a <b>link + interpretation</b>. Retrieving this chapter
          hands the agent that interpretation without re-running vision — the asset's knowledge travels with the text.
          HTML hyperlinks stay remote references (not downloaded).
        </span>
      </div>
    </div>
  );
}
