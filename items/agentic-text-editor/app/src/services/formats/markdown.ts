// Default markdown handler (T007).
//
// A small, dependency-free CommonMark subset: headings, fenced code, blockquotes,
// bullet/ordered lists, horizontal rules, paragraphs, and the usual inline marks.
// Everything is HTML-escaped BEFORE any markup is emitted, and inline code spans
// are pulled out first so their contents can never be re-parsed as markdown.
//
// Adding a richer renderer later means swapping this one module — the registry
// is what the rest of the app talks to.

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

    // Fenced code block — consumed whole, contents never parsed.
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
