// Default markdown handler (T007; extended in v3 — T109/T119).
//
// A small, dependency-free CommonMark subset: headings, fenced code, blockquotes,
// bullet/ordered lists, horizontal rules, paragraphs, and the usual inline marks
// — plus, since v3, GFM pipe tables (FR-027) and pandoc fenced_div containers
// resolved against the custom-style registry (FR-028). Everything is
// HTML-escaped BEFORE any markup is emitted, and inline code spans are pulled
// out first so their contents can never be re-parsed as markdown.
//
// Block recognizer order inside the line loop is load-bearing: the fenced-code
// check runs FIRST and consumes a whole ``` block before any other logic, so a
// `|` or `:::` inside a code fence is literal by construction — neither the
// table pass nor the fenced_div pass ever sees it.
//
// The v3 parsing algorithms are documented in docs/dev/Editor/markdown-rendering.md.

import { boxCss, effectiveCss } from "../../config/custom-styles";
import type { FormatHandler } from "../../types";

function escapeHtml(s: string): string {
  return s
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;");
}

/** Only http(s), mailto and VFS-absolute targets — never javascript:. */
function safeHref(raw: string): string | null {
  const href = raw.trim();
  if (/^(https?:\/\/|mailto:|\/)/i.test(href)) return escapeHtml(href);
  return null;
}

function renderInline(src: string): string {
  // 1. Escape, then park code spans so their contents stay literal.
  const spans: string[] = [];
  let text = escapeHtml(src).replace(/`([^`]+)`/g, (_m, code: string) => {
    spans.push(`<code>${code}</code>`);
    return `\u0000${spans.length - 1}\u0000`;
  });

  // 2. Images before links — the syntaxes only differ by the leading "!".
  text = text.replace(/!\[([^\]]*)\]\(([^)\s]+)\)/g, (m, alt: string, url: string) => {
    const href = safeHref(url);
    return href ? `<img alt="${alt}" src="${href}" />` : m;
  });
  text = text.replace(/\[([^\]]+)\]\(([^)\s]+)\)/g, (m, label: string, url: string) => {
    const href = safeHref(url);
    return href ? `<a href="${href}" target="_blank" rel="noreferrer noopener">${label}</a>` : m;
  });

  // 3. Emphasis. Bold first so "**x**" doesn't get eaten by the italic rule.
  text = text
    .replace(/\*\*([^*]+)\*\*/g, "<strong>$1</strong>")
    .replace(/__([^_]+)__/g, "<strong>$1</strong>")
    .replace(/(^|[^*])\*([^*\n]+)\*/g, "$1<em>$2</em>")
    .replace(/(^|[^_\w])_([^_\n]+)_/g, "$1<em>$2</em>")
    .replace(/~~([^~]+)~~/g, "<del>$1</del>");

  // 4. Restore code spans.
  return text.replace(/\u0000(\d+)\u0000/g, (_m, i: string) => spans[Number(i)] ?? "");
}

// ---------------------------------------------------------------- GFM tables
//
// A table is recognized when a line contains an unescaped `|` AND the next line
// is a valid delimiter row (`| :--- | :---: | ---: |`) with the same number of
// cells. Cells split on unescaped pipes only — `\|` is a literal `|` (US10.3).

/** True when the line contains a `|` that is not escaped as `\|`. */
function hasUnescapedPipe(line: string): boolean {
  for (let k = 0; k < line.length; k++) {
    if (line[k] === "\\") {
      k++; // whatever follows is escaped
      continue;
    }
    if (line[k] === "|") return true;
  }
  return false;
}

/**
 * Split one table row into trimmed cells on unescaped pipes. A single leading /
 * trailing boundary pipe produces an empty edge segment, which is dropped —
 * `| a | b |` and `a | b` both come out as ["a", "b"].
 */
function splitRow(line: string): string[] {
  const s = line.trim();
  const cells: string[] = [];
  let cur = "";
  for (let k = 0; k < s.length; k++) {
    const ch = s[k];
    if (ch === "\\" && s[k + 1] === "|") {
      cur += "|";
      k++;
      continue;
    }
    if (ch === "|") {
      cells.push(cur);
      cur = "";
      continue;
    }
    cur += ch;
  }
  cells.push(cur);
  if (cells.length > 0 && cells[0].trim() === "") cells.shift();
  if (cells.length > 0 && cells[cells.length - 1].trim() === "") cells.pop();
  return cells.map((c) => c.trim());
}

type CellAlign = "left" | "center" | "right" | null;

/**
 * Parse a delimiter row (`:---` left, `:---:` center, `---:` right, `---`
 * unaligned) into per-column alignments, or null when the line is not one.
 * The line must contain a pipe so a bare `---` stays a horizontal rule.
 */
function parseDelimiterRow(line: string): CellAlign[] | null {
  if (!line.includes("|") || !line.includes("-") || !/^[\s|:-]+$/.test(line)) return null;
  const cells = splitRow(line);
  if (cells.length === 0) return null;
  const aligns: CellAlign[] = [];
  for (const cell of cells) {
    const m = /^(:?)-+(:?)$/.exec(cell);
    if (!m) return null;
    aligns.push(m[1] && m[2] ? "center" : m[2] ? "right" : m[1] ? "left" : null);
  }
  return aligns;
}

/**
 * Render one cell. Inline markdown goes through `renderInline` (which escapes
 * everything, including a literal `<`) — so GFM's soft-break-in-cell convention
 * needs one extra step: an explicit `<br>` in the source is parked as a
 * placeholder BEFORE escaping (except inside code spans, where it stays
 * literal) and restored as a real break after.
 */
function renderCell(src: string): string {
  const codeSpans: string[] = [];
  let text = src.replace(/`[^`]+`/g, (m) => {
    codeSpans.push(m);
    return `\u0001${codeSpans.length - 1}\u0001`;
  });
  text = text.replace(/<br\s*\/?>/gi, "\u0002");
  text = text.replace(/\u0001(\d+)\u0001/g, (_m, i: string) => codeSpans[Number(i)] ?? "");
  return renderInline(text).replace(/\u0002/g, "<br />");
}

function renderTable(header: string[], aligns: CellAlign[], rows: string[][]): string {
  const cell = (tag: "th" | "td", text: string, align: CellAlign): string =>
    `<${tag}${align ? ` style="text-align:${align}"` : ""}>${renderCell(text)}</${tag}>`;
  const head = `<thead><tr>${header.map((h, c) => cell("th", h, aligns[c] ?? null)).join("")}</tr></thead>`;
  // Body rows are normalized to the header's column count: extra cells are
  // dropped, missing cells render empty (GFM behaviour).
  const body =
    rows.length > 0
      ? `<tbody>${rows
          .map((row) => `<tr>${aligns.map((align, c) => cell("td", row[c] ?? "", align)).join("")}</tr>`)
          .join("")}</tbody>`
      : "";
  return `<table>${head}${body}</table>`;
}

// ---------------------------------------------------------------- fenced_div
//
// Pandoc's fenced_div extension (FR-028): `::: {custom-style="Name"} … :::`
// (or the class form `::: {.Name}`). The name resolves through the style
// registry (`effectiveCss`) — built-in / user / neutral fallback — so an
// unknown name still renders its content, just neutrally (US11.3).

const DIV_OPEN = /^\s*:::+\s*\{(.+)\}\s*$/;
const DIV_CLOSE = /^\s*:::+\s*$/;

/**
 * Extract the style name from a pandoc attribute list. `custom-style="Name"`
 * wins; else the first `.Class` token; full attr lists (`{#id .cls key="v"}`)
 * are tolerated — unknown keys are ignored, and no input throws.
 */
function parseDivName(attrs: string): string {
  const kv = /custom-style\s*=\s*(?:"([^"]*)"|'([^']*)')/.exec(attrs);
  if (kv) return (kv[1] ?? kv[2] ?? "").trim();
  const cls = /(?:^|\s)\.([A-Za-z0-9_-]+)/.exec(attrs);
  if (cls) return cls[1];
  return "";
}

/** Class-attribute-safe form of a style name (the raw name goes in data-style). */
function sanitizeStyleName(name: string): string {
  return name.replace(/[^A-Za-z0-9_-]/g, "");
}

/**
 * Escape a CSS declaration block for embedding in a style="" attribute
 * (ADR-3). CSS is not HTML, so the only injection surface is breaking out of
 * the attribute — closed off by escaping `&`, `<` and `"`.
 */
function escapeCssAttr(css: string): string {
  return css.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/"/g, "&quot;");
}

// ---------------------------------------------------------------- block loop

function renderMarkdown(content: string): string {
  const lines = content.replace(/\r\n?/g, "\n").split("\n");
  const out: string[] = [];
  let paragraph: string[] = [];
  let listKind: "ul" | "ol" | null = null;
  let quote: string[] = [];

  const flushParagraph = (): void => {
    if (paragraph.length === 0) return;
    out.push(`<p>${renderInline(paragraph.join("\n"))}</p>`);
    paragraph = [];
  };
  const flushList = (): void => {
    if (!listKind) return;
    out.push(`</${listKind}>`);
    listKind = null;
  };
  const flushQuote = (): void => {
    if (quote.length === 0) return;
    out.push(`<blockquote>${renderMarkdown(quote.join("\n"))}</blockquote>`);
    quote = [];
  };
  const flushAll = (): void => {
    flushParagraph();
    flushList();
    flushQuote();
  };

  for (let i = 0; i < lines.length; i++) {
    const line = lines[i];

    // Fenced code block — consumed whole, contents never parsed. This branch
    // MUST stay first: it is what keeps a `|` or `:::` inside a fence literal.
    const fence = /^\s*```+\s*([\w+-]*)\s*$/.exec(line);
    if (fence) {
      flushAll();
      const body: string[] = [];
      i++;
      while (i < lines.length && !/^\s*```+\s*$/.test(lines[i])) {
        body.push(lines[i]);
        i++;
      }
      const lang = fence[1] ? ` data-lang="${escapeHtml(fence[1])}"` : "";
      out.push(`<pre${lang}><code>${escapeHtml(body.join("\n"))}</code></pre>`);
      continue;
    }

    if (/^\s*$/.test(line)) {
      flushAll();
      continue;
    }

    // GFM table (v3, FR-027) — header row + delimiter row, after the fence
    // check. A line that reads as another block opener (heading, list item,
    // quote) is only a header candidate when it starts with a pipe itself.
    if (
      hasUnescapedPipe(line) &&
      (/^\s*\|/.test(line) || !/^\s*(?:#{1,6}\s|[-*+]\s|\d+[.)]\s|>)/.test(line))
    ) {
      const aligns = i + 1 < lines.length ? parseDelimiterRow(lines[i + 1]) : null;
      if (aligns) {
        const header = splitRow(line);
        if (header.length === aligns.length) {
          const rows: string[][] = [];
          let j = i + 2;
          while (j < lines.length && !/^\s*$/.test(lines[j]) && hasUnescapedPipe(lines[j])) {
            rows.push(splitRow(lines[j]));
            j++;
          }
          const table = renderTable(header, aligns, rows);
          // A table indented under an open list item belongs INSIDE that item
          // (US10.4). The list model emits one closed <li> per line, so the
          // table is folded into the just-emitted item rather than after it.
          const last = out.length - 1;
          if (listKind && /^\s{2,}/.test(line) && last >= 0 && out[last].endsWith("</li>")) {
            out[last] = `${out[last].slice(0, -"</li>".length)}${table}</li>`;
          } else {
            flushAll();
            out.push(table);
          }
          i = j - 1;
          continue;
        }
      }
    }

    // Pandoc fenced div (v3, FR-028) — after the fence and table checks. The
    // inner block is markdown in its own right, so it is collected (nesting-
    // and inner-fence-aware) and rendered by recursion; a missing closer means
    // the rest of the document is inside — content is never dropped.
    const divOpen = DIV_OPEN.exec(line);
    if (divOpen) {
      flushAll();
      const name = parseDivName(divOpen[1]);
      const inner: string[] = [];
      let depth = 1;
      let inCode = false;
      let j = i + 1;
      for (; j < lines.length; j++) {
        const l = lines[j];
        if (/^\s*```/.test(l)) inCode = !inCode;
        if (!inCode) {
          if (DIV_OPEN.test(l)) depth++;
          else if (DIV_CLOSE.test(l)) {
            depth--;
            if (depth === 0) break;
          }
        }
        inner.push(l);
      }
      const cls = sanitizeStyleName(name);
      const style = escapeCssAttr(boxCss(effectiveCss(name)));
      out.push(
        `<div class="custom-style${cls ? ` custom-style--${cls}` : ""}" data-style="${escapeHtml(name)}" style="${style}">` +
          `${renderMarkdown(inner.join("\n"))}</div>`,
      );
      i = j; // the closing ::: line (or EOF)
      continue;
    }

    // Blockquote — buffered so a multi-line quote renders as one block.
    const bq = /^\s*>\s?(.*)$/.exec(line);
    if (bq) {
      flushParagraph();
      flushList();
      quote.push(bq[1]);
      continue;
    }
    flushQuote();

    if (/^\s*(?:[-*_]\s*){3,}$/.test(line)) {
      flushAll();
      out.push("<hr />");
      continue;
    }

    const heading = /^(#{1,6})\s+(.*)$/.exec(line);
    if (heading) {
      flushAll();
      const level = heading[1].length;
      out.push(`<h${level}>${renderInline(heading[2].trim())}</h${level}>`);
      continue;
    }

    const bullet = /^\s*[-*+]\s+(.*)$/.exec(line);
    const ordered = /^\s*\d+[.)]\s+(.*)$/.exec(line);
    if (bullet || ordered) {
      flushParagraph();
      const kind: "ul" | "ol" = bullet ? "ul" : "ol";
      if (listKind !== kind) {
        flushList();
        out.push(`<${kind}>`);
        listKind = kind;
      }
      out.push(`<li>${renderInline((bullet ?? ordered)![1])}</li>`);
      continue;
    }
    flushList();

    paragraph.push(line.trim());
  }

  flushAll();
  return out.join("\n");
}

export const markdownHandler: FormatHandler = {
  id: "markdown",
  name: "Markdown",
  extensions: [".md", ".markdown", ".mdx", ".mdown"],
  supportsPreview: true,
  render: renderMarkdown,
  editorHints: { tabSize: 2, spellcheck: false },
};
