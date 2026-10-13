// markdown.tsx — the app's markdown rendering (parsed by mdparse.mjs) plus the
// inline-asset block renderer (`assetBlock`/`.interp` in the mockup).
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
import { parseBlocks, parseInline } from "./mdparse.mjs";
import type { Block, Inline } from "./mdparse.mjs";

// ── rendering ────────────────────────────────────────────────────────────
//
// Parsing is mdparse.mjs (plain JS, unit-tested by the item's node tests);
// this file only maps its tree to React. Raw HTML is never interpreted.

let keySeq = 0;
function k(): string {
  return `md-${keySeq++}`;
}

function renderNodes(nodes: Inline[]): React.ReactNode[] {
  return nodes.map((n) => {
    switch (n.t) {
      case "text":
        return n.v;
      case "code":
        return <code key={k()}>{n.v}</code>;
      case "strong":
        return <strong key={k()}>{renderNodes(n.children)}</strong>;
      case "em":
        return <em key={k()}>{renderNodes(n.children)}</em>;
      case "del":
        return <del key={k()}>{renderNodes(n.children)}</del>;
      case "link":
        // Only an http(s) target is a real link out of the sandboxed app; a
        // relative one (a raw/ path, another concept) is shown, not followed.
        return /^https?:\/\//i.test(n.href) ? (
          <a key={k()} className="mdlink" href={n.href} target="_blank" rel="noopener noreferrer">
            {renderNodes(n.children)}
          </a>
        ) : (
          <span key={k()} className="mdlink">
            {renderNodes(n.children)}
          </span>
        );
      case "image":
        // A stored asset is rendered by AssetBlock (splitBody pulls it out
        // first); an image left inside running text is named, not fetched.
        return (
          <span key={k()} className="mdlink">
            {n.alt || n.src}
          </span>
        );
    }
  });
}

function renderInline(text: string): React.ReactNode[] {
  return renderNodes(parseInline(text));
}

function renderBlocks(blocks: Block[]): React.ReactNode[] {
  return blocks.map((b) => {
    switch (b.type) {
      case "paragraph":
        return <p key={k()}>{renderInline(b.text)}</p>;
      case "heading": {
        // The chapter / report is a section of a page, so its top heading
        // levels map below the app's own titles.
        const Tag = b.level <= 2 ? "h3" : b.level === 3 ? "h4" : "h5";
        return <Tag key={k()}>{renderInline(b.text)}</Tag>;
      }
      case "hr":
        return <hr key={k()} />;
      case "code":
        return (
          <pre key={k()} className="md-code" data-lang={b.lang || undefined}>
            <code>{b.text}</code>
          </pre>
        );
      case "blockquote":
        return (
          <blockquote key={k()} className="q">
            {renderBlocks(b.children)}
          </blockquote>
        );
      case "list": {
        const items = b.items.map((it) => (
          <li key={k()}>
            {renderInline(it.text)}
            {it.children.length ? renderBlocks(it.children) : null}
          </li>
        ));
        return b.ordered ? (
          <ol key={k()} start={b.start}>
            {items}
          </ol>
        ) : (
          <ul key={k()}>{items}</ul>
        );
      }
      case "table":
        return (
          <div key={k()} className="md-table">
            <table>
              <thead>
                <tr>
                  {b.header.map((h, i) => (
                    <th key={i} style={b.align[i] ? { textAlign: b.align[i]! } : undefined}>
                      {renderInline(h)}
                    </th>
                  ))}
                </tr>
              </thead>
              <tbody>
                {b.rows.map((r, ri) => (
                  <tr key={ri}>
                    {r.map((c, i) => (
                      <td key={i} style={b.align[i] ? { textAlign: b.align[i]! } : undefined}>
                        {renderInline(c)}
                      </td>
                    ))}
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        );
    }
  });
}

/** Render a markdown run (no asset blocks — those are split out first). */
export function Markdown({ source }: { source: string }) {
  return <>{renderBlocks(parseBlocks(source))}</>;
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
