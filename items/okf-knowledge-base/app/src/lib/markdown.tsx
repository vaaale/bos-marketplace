// markdown.tsx — the mockup's tiny markdown renderer, ported to React, plus
// the inline-asset block renderer (`assetBlock`/`.interp` in the mockup).
//
// Why hand-rolled rather than a library: this renders ONE known shape — the
// markdown an okf-ingest run writes (headings, lists, bold/italic/code, links
// and the asset link + interpretation blockquote). A markdown dependency
// would be a new runtime package for strictly less control over the asset
// block, which is the one piece whose rendering the spec actually pins
// (FR-023: the link AND the stored interpretation, together, in the chapter).
//
// The chapter body is split into markdown runs and ASSET BLOCKS: an image
// link whose target is a stored `raw/...` asset, with its interpretation
// blockquote. Everything else is ordinary markdown. This split is what lets
// the reader render a thumbnail + the violet interpretation card exactly as
// the mockup does, while `okf_read_concept` hands an agent the same two
// pieces as plain text.

import React from "react";
import { Icon } from "./icons";
import type { InlineAsset } from "./types";

// ── inline span rendering ────────────────────────────────────────────────

let keySeq = 0;
function k(): string {
  return `md-${keySeq++}`;
}

const INLINE_RE = /(\*\*[^*]+\*\*|\*[^*]+\*|`[^`]+`|!?\[[^\]]*\]\([^)]*\))/g;

function renderInline(text: string): React.ReactNode[] {
  const out: React.ReactNode[] = [];
  let last = 0;
  for (const m of text.matchAll(INLINE_RE)) {
    const idx = m.index ?? 0;
    if (idx > last) out.push(text.slice(last, idx));
    const tok = m[0];
    if (tok.startsWith("**")) out.push(<strong key={k()}>{tok.slice(2, -2)}</strong>);
    else if (tok.startsWith("`")) out.push(<code key={k()}>{tok.slice(1, -1)}</code>);
    else if (tok.startsWith("*")) out.push(<em key={k()}>{tok.slice(1, -1)}</em>);
    else {
      const lm = /!?\[([^\]]*)\]\(([^)]*)\)/.exec(tok);
      const label = lm ? lm[1] : tok;
      const href = lm ? lm[2].trim() : "";
      const external = /^https?:\/\//i.test(href);
      out.push(
        external ? (
          <a key={k()} className="mdlink" href={href} target="_blank" rel="noopener noreferrer">
            {label || href}
          </a>
        ) : (
          <span key={k()} className="mdlink">
            {label || href}
          </span>
        ),
      );
    }
    last = idx + tok.length;
  }
  if (last < text.length) out.push(text.slice(last));
  return out;
}

/** Render a markdown run (no asset blocks — those are split out first). */
export function Markdown({ source }: { source: string }) {
  const nodes: React.ReactNode[] = [];
  let list: React.ReactNode[] = [];
  const flush = () => {
    if (list.length) {
      nodes.push(<ul key={k()}>{list}</ul>);
      list = [];
    }
  };
  for (const line of source.split("\n")) {
    if (/^###\s/.test(line)) {
      flush();
      nodes.push(<h4 key={k()}>{renderInline(line.replace(/^###\s/, ""))}</h4>);
    } else if (/^##\s/.test(line)) {
      flush();
      nodes.push(<h3 key={k()}>{renderInline(line.replace(/^##\s/, ""))}</h3>);
    } else if (/^#\s/.test(line)) {
      flush();
      nodes.push(<h3 key={k()}>{renderInline(line.replace(/^#\s/, ""))}</h3>);
    } else if (/^\s*>\s?/.test(line)) {
      flush();
      nodes.push(
        <blockquote key={k()} className="q">
          {renderInline(line.replace(/^\s*>\s?/, ""))}
        </blockquote>,
      );
    } else if (/^[-*]\s/.test(line)) {
      list.push(<li key={k()}>{renderInline(line.replace(/^[-*]\s/, ""))}</li>);
    } else if (line.trim() === "") {
      flush();
    } else {
      flush();
      nodes.push(<p key={k()}>{renderInline(line)}</p>);
    }
  }
  flush();
  return <>{nodes}</>;
}

// ── asset-block splitting ────────────────────────────────────────────────

export type BodyBlock = { t: "md"; v: string } | { t: "asset"; v: InlineAsset };

const ASSET_LINE_RE = /^\s*!\[([^\]]*)\]\(\s*([^)]+?)\s*\)\s*$/;

function normalizeAssetTarget(raw: string): string | null {
  let t = raw.trim().split(/\s+/)[0];
  if (/^[a-z][a-z0-9+.-]*:/i.test(t)) return null; // a remote reference is NOT a stored asset (FR-022)
  t = t.replace(/^\.\//, "").replace(/(\.\.\/)+/g, "").replace(/^\/+/, "");
  return t.startsWith("raw/") ? t : null;
}

function kindOf(p: string): InlineAsset["kind"] {
  const ext = p.split(".").pop()?.toLowerCase() || "";
  if (["mp4", "webm", "mov", "mkv"].includes(ext)) return "video";
  if (["mp3", "wav"].includes(ext)) return "audio";
  return "image";
}

/**
 * Split a chapter body into markdown runs and stored-asset blocks, matching
 * the service's own `extractAssets` parse so the UI and `okf_read_concept`
 * agree on what an asset block is.
 */
export function splitBody(body: string): BodyBlock[] {
  const lines = body.split("\n");
  const blocks: BodyBlock[] = [];
  let buf: string[] = [];
  const flush = () => {
    const text = buf.join("\n").trim();
    if (text) blocks.push({ t: "md", v: text });
    buf = [];
  };

  for (let i = 0; i < lines.length; i++) {
    const m = ASSET_LINE_RE.exec(lines[i]);
    const target = m ? normalizeAssetTarget(m[2]) : null;
    if (!m || !target) {
      buf.push(lines[i]);
      continue;
    }
    flush();
    let j = i + 1;
    while (j < lines.length && lines[j].trim() === "") j++;
    const quote: string[] = [];
    while (j < lines.length && /^\s*>/.test(lines[j])) {
      quote.push(lines[j].replace(/^\s*>\s?/, ""));
      j++;
    }
    const text = quote.join(" ").trim();
    const isInterp = /^\*\*Interpretation/i.test(text);
    const interpretation = isInterp ? text.replace(/^\*\*Interpretation[^*]*\*\*:?\s*/i, "").trim() : "";
    blocks.push({
      t: "asset",
      v: {
        path: target,
        caption: m[1] || target.split("/").pop() || target,
        kind: kindOf(target),
        interpretation,
        interpretationAvailable: !!interpretation && !/^interpretation unavailable/i.test(interpretation),
      },
    });
    i = (isInterp ? j : i + 1) - 1;
  }
  flush();
  return blocks;
}

/**
 * One inline-asset block: the stored thumbnail (served by the service's asset
 * proxy so an opaque-origin iframe can render it), the raw/ path, and the
 * interpretation written ONCE at ingest. Retrieval carries that text, so
 * nothing here re-runs vision — if the image fails to load, the knowledge is
 * still on screen.
 */
export function AssetBlock({ asset, assetSrc }: { asset: InlineAsset; assetSrc: string | null }) {
  const [broken, setBroken] = React.useState(false);
  const showMedia = assetSrc && !broken && asset.kind !== "audio";
  return (
    <div data-testid="asset-block">
      <div className="asset">
        <div className="a-thumb">
          {showMedia && asset.kind === "image" ? (
            <img src={assetSrc} alt={asset.caption} onError={() => setBroken(true)} data-testid="asset-thumb" />
          ) : showMedia && asset.kind === "video" ? (
            <video src={assetSrc} controls preload="metadata" onError={() => setBroken(true)} data-testid="asset-thumb" />
          ) : (
            <div className="a-ic">
              <Icon name={asset.kind === "video" ? "play" : "image"} size={26} />
              <span>stored asset · {asset.kind}</span>
            </div>
          )}
          <span className="a-cap">{asset.caption}</span>
        </div>
        <div className="a-raw">
          <Icon name="doc" size={13} />
          <code>{asset.path}</code>
          <span>· local immutable copy in raw/</span>
          {assetSrc ? (
            <a href={assetSrc} target="_blank" rel="noopener noreferrer" style={{ marginLeft: "auto" }}>
              view raw
            </a>
          ) : null}
        </div>
      </div>
      <div className={`interp${asset.interpretationAvailable ? "" : " unavail"}`} data-testid="asset-interpretation">
        <div className="i-label">
          <Icon name={asset.interpretationAvailable ? "eye" : "alert"} size={13} />
          {asset.interpretationAvailable
            ? "Interpretation · written at ingest, stored in the chapter"
            : "Interpretation unavailable · recorded at ingest"}
        </div>
        <p>
          {asset.interpretation ||
            "The asset could not be downloaded or interpreted during ingest. okf_lint reports it; re-ingesting the source retries."}
        </p>
      </div>
    </div>
  );
}

/** The raw `.md` an agent sees — what `okf_read_concept` returns verbatim. */
export function sourceOf(frontmatter: Record<string, unknown>, body: string): string {
  const fm = Object.entries(frontmatter)
    .map(([key, v]) => `${key}: ${Array.isArray(v) ? JSON.stringify(v) : typeof v === "object" && v !== null ? JSON.stringify(v) : String(v)}`)
    .join("\n");
  return `---\n${fm}\n---\n\n${body}`;
}
