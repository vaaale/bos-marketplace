// mdparse.mjs — the app's ONE markdown parser: text -> a small block/inline
// tree that lib/markdown.tsx renders. Behind the job report, the chapter view
// and the reader pane.
//
// Plain JS on purpose: it has no React and no DOM, so the item's node tests
// (tests/markdown-parse.test.mjs) run it directly, and the app imports it
// through esbuild like any other module. Types: mdparse.d.mts.
//
// Why hand-rolled and not a library: BOS provides no markdown package of its
// own — the only ones in its node_modules arrive transitively through
// CopilotKit, at mismatched versions — and the app renders a known shape (an
// agent's report; a chapter body written by an ingest, often from a PDF). It
// covers GFM's working set: paragraphs (wrapped lines joined), ATX headings,
// nested bullet / numbered lists, tables with alignment, fenced code,
// blockquotes, rules; inline bold / italic / code / strikethrough / links /
// images. Raw HTML is never interpreted — it stays text.

const FENCE = /^\s{0,3}(`{3,}|~{3,})\s*([\w+#.-]*)\s*$/;
const HEADING = /^\s{0,3}(#{1,6})\s+(.*?)(?:\s+#+)?\s*$/;
const HR = /^\s{0,3}([-*_])(?:\s*\1){2,}\s*$/;
const QUOTE = /^\s{0,3}>\s?/;
const ITEM = /^(\s*)([-*+]|\d{1,9}[.)])(\s+)(.*)$/;
const DELIM_CELL = /^\s*:?-+:?\s*$/;

const indentOf = (line) => line.match(/^\s*/)[0].replace(/\t/g, "    ").length;
const isBlank = (line) => line.trim() === "";

/** Split a table row on unescaped pipes outside code spans; `\|` is a pipe. */
function splitRow(line) {
  let s = line.trim();
  if (s.startsWith("|")) s = s.slice(1);
  if (s.endsWith("|") && !s.endsWith("\\|")) s = s.slice(0, -1);
  const cells = [];
  let cur = "";
  let inCode = false;
  for (let i = 0; i < s.length; i++) {
    const ch = s[i];
    if (ch === "\\" && s[i + 1] === "|") {
      cur += "|";
      i++;
    } else if (ch === "`") {
      inCode = !inCode;
      cur += ch;
    } else if (ch === "|" && !inCode) {
      cells.push(cur.trim());
      cur = "";
    } else cur += ch;
  }
  cells.push(cur.trim());
  return cells;
}

function isDelimiterRow(line) {
  if (!line || !line.includes("-")) return false;
  const cells = splitRow(line);
  return cells.length > 0 && cells.every((c) => DELIM_CELL.test(c)) && (line.includes("|") || cells.length > 1);
}

const isTableStart = (lines, i) => lines[i].includes("|") && isDelimiterRow(lines[i + 1]);

/** Does this line begin a block other than a paragraph? (Paragraph interrupters.) */
function startsBlock(lines, i) {
  const line = lines[i];
  return FENCE.test(line) || HEADING.test(line) || HR.test(line) || QUOTE.test(line) || ITEM.test(line) || isTableStart(lines, i);
}

function parseList(lines, i) {
  const first = ITEM.exec(lines[i]);
  const baseIndent = indentOf(first[1]);
  const ordered = /\d/.test(first[2]);
  const start = ordered ? parseInt(first[2], 10) : undefined;
  const items = [];
  let cur = null;
  while (i < lines.length) {
    const line = lines[i];
    const m = ITEM.exec(line);
    if (m && indentOf(m[1]) === baseIndent && /\d/.test(m[2]) === ordered) {
      cur = { contentIndent: baseIndent + m[2].length + m[3].length, lines: [m[4]] };
      items.push(cur);
      i++;
      continue;
    }
    if (isBlank(line)) {
      // A blank line ends the list unless more of it follows: a sibling item,
      // or a line indented into the current item.
      let j = i + 1;
      while (j < lines.length && isBlank(lines[j])) j++;
      const next = lines[j];
      const nm = next !== undefined ? ITEM.exec(next) : null;
      const sibling = nm && indentOf(nm[1]) === baseIndent && /\d/.test(nm[2]) === ordered;
      const inside = next !== undefined && cur && indentOf(next) >= cur.contentIndent;
      if (!sibling && !inside) break;
      cur.lines.push("");
      i++;
      continue;
    }
    if (cur && indentOf(line) > baseIndent) {
      cur.lines.push(line.slice(Math.min(cur.contentIndent, indentOf(line))));
      i++;
      continue;
    }
    // Lazy continuation: an unindented line that continues the item's text.
    if (cur && !startsBlock(lines, i) && cur.lines.length && !isBlank(cur.lines[cur.lines.length - 1])) {
      cur.lines.push(line.trim());
      i++;
      continue;
    }
    break;
  }
  const out = items.map((it) => {
    const text = [];
    let k = 0;
    while (k < it.lines.length && !isBlank(it.lines[k]) && (k === 0 || !startsBlock(it.lines, k))) text.push(it.lines[k++].trim());
    return { text: text.join(" "), children: parseLines(it.lines.slice(k)) };
  });
  return { block: { type: "list", ordered, ...(ordered ? { start } : {}), items: out }, next: i };
}

function parseLines(lines) {
  const blocks = [];
  let i = 0;
  while (i < lines.length) {
    const line = lines[i];
    if (isBlank(line)) {
      i++;
      continue;
    }
    const fence = FENCE.exec(line);
    if (fence) {
      const marker = fence[1];
      const body = [];
      i++;
      while (i < lines.length && !new RegExp(`^\\s{0,3}${marker[0]}{${marker.length},}\\s*$`).test(lines[i])) body.push(lines[i++]);
      i++; // the closing fence (or the end)
      blocks.push({ type: "code", lang: fence[2] || "", text: body.join("\n") });
      continue;
    }
    const heading = HEADING.exec(line);
    if (heading) {
      blocks.push({ type: "heading", level: heading[1].length, text: heading[2] });
      i++;
      continue;
    }
    if (HR.test(line)) {
      blocks.push({ type: "hr" });
      i++;
      continue;
    }
    if (QUOTE.test(line)) {
      const inner = [];
      while (i < lines.length && QUOTE.test(lines[i])) inner.push(lines[i++].replace(QUOTE, ""));
      blocks.push({ type: "blockquote", children: parseLines(inner) });
      continue;
    }
    if (isTableStart(lines, i)) {
      const header = splitRow(lines[i]);
      const align = splitRow(lines[i + 1]).map((c) => {
        const t = c.trim();
        if (t.startsWith(":") && t.endsWith(":")) return "center";
        if (t.endsWith(":")) return "right";
        if (t.startsWith(":")) return "left";
        return null;
      });
      i += 2;
      const rows = [];
      while (i < lines.length && !isBlank(lines[i]) && lines[i].includes("|")) {
        const cells = splitRow(lines[i++]);
        rows.push(header.map((_, c) => cells[c] ?? ""));
      }
      blocks.push({ type: "table", header, align, rows });
      continue;
    }
    if (ITEM.test(line)) {
      const { block, next } = parseList(lines, i);
      blocks.push(block);
      i = next;
      continue;
    }
    const para = [line.trim()];
    i++;
    while (i < lines.length && !isBlank(lines[i]) && !startsBlock(lines, i)) para.push(lines[i++].trim());
    blocks.push({ type: "paragraph", text: para.join(" ") });
  }
  return blocks;
}

/** Markdown source -> blocks. */
export function parseBlocks(source) {
  return parseLines(String(source ?? "").replace(/\r\n?/g, "\n").split("\n"));
}

// ── inline ──────────────────────────────────────────────────────────────

const IMAGE = /^!\[([^\]]*)\]\(\s*([^)\s]+)(?:\s+"[^"]*")?\s*\)/;
const LINK = /^\[((?:[^[\]]|\[[^\]]*\])*)\]\(\s*([^)\s]+)(?:\s+"[^"]*")?\s*\)/;
const isWord = (ch) => !!ch && /[\p{L}\p{N}]/u.test(ch);

/** Index of the closing `delim` for an opener ending at `from`, skipping code
 *  spans; -1 when there is none. The closer may not follow whitespace. */
function findCloser(text, from, delim) {
  for (let i = from; i < text.length; i++) {
    if (text[i] === "`") {
      const run = text.slice(i).match(/^`+/)[0];
      const end = text.indexOf(run, i + run.length);
      if (end !== -1) i = end + run.length - 1;
      continue;
    }
    if (text.startsWith(delim, i) && i > from && !/\s/.test(text[i - 1])) {
      if (delim.length === 1 && text[i + 1] === delim) {
        i++; // part of a double delimiter — not this closer
        continue;
      }
      if (delim === "_" && isWord(text[i + 1])) continue; // intraword
      return i;
    }
  }
  return -1;
}

/** Inline markdown -> nodes. Unbalanced markers stay literal text. */
export function parseInline(text) {
  const s = String(text ?? "");
  const out = [];
  let buf = "";
  const push = (node) => {
    if (buf) out.push({ t: "text", v: buf });
    buf = "";
    out.push(node);
  };
  for (let i = 0; i < s.length; ) {
    const ch = s[i];
    if (ch === "\\" && i + 1 < s.length && /[\\`*_~[\]()#|!>-]/.test(s[i + 1])) {
      buf += s[i + 1];
      i += 2;
      continue;
    }
    if (ch === "`") {
      const run = s.slice(i).match(/^`+/)[0];
      const end = s.indexOf(run, i + run.length);
      if (end !== -1) {
        push({ t: "code", v: s.slice(i + run.length, end).replace(/^ (.*) $/, "$1") });
        i = end + run.length;
        continue;
      }
    }
    if (ch === "!" && s[i + 1] === "[") {
      const m = IMAGE.exec(s.slice(i));
      if (m) {
        push({ t: "image", alt: m[1], src: m[2] });
        i += m[0].length;
        continue;
      }
    }
    if (ch === "[") {
      const m = LINK.exec(s.slice(i));
      if (m) {
        push({ t: "link", href: m[2], children: parseInline(m[1]) });
        i += m[0].length;
        continue;
      }
    }
    const pairs = [
      ["**", "strong"],
      ["__", "strong"],
      ["~~", "del"],
      ["*", "em"],
      ["_", "em"],
    ];
    let matched = false;
    for (const [delim, kind] of pairs) {
      if (!s.startsWith(delim, i)) continue;
      const after = s[i + delim.length];
      if (!after || /\s/.test(after)) continue; // an opener must touch its content
      if (delim[0] === "_" && isWord(s[i - 1])) continue; // intraword underscore
      const close = findCloser(s, i + delim.length, delim);
      if (close === -1) continue;
      push({ t: kind, children: parseInline(s.slice(i + delim.length, close)) });
      i = close + delim.length;
      matched = true;
      break;
    }
    if (matched) continue;
    buf += ch;
    i++;
  }
  if (buf) out.push({ t: "text", v: buf });
  return out;
}
