// markdown-parse.test.mjs — the app's ONE markdown parser (app/src/lib/mdparse.mjs),
// behind the job report, the chapter view and the reader pane.
//
// The Jobs tab printed the agent's report as raw text (`white-space: pre-wrap`):
// `**bold**`, backticks, bullet markers and the closing ```-fenced
// `Ingested:` line all showed literally. And the renderer the chapter view
// used knew only headings, flat bullets, blockquotes and inline emphasis —
// every line its own paragraph, no tables (a converted PDF's chapters are full
// of them), no numbered or nested lists, no code blocks.
//
// The fixture is a real okf-ingest report from production (2026-10-13).
//
//   node --test tests/markdown-parse.test.mjs

import test from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { parseBlocks, parseInline } from "../app/src/lib/mdparse.mjs";

const REPORT = readFileSync(new URL("./fixtures/agent-report.md", import.meta.url), "utf8");
const types = (blocks) => blocks.map((b) => b.type);

test("the real agent report parses into paragraphs, a list and the fenced Ingested line", () => {
  const blocks = parseBlocks(REPORT);
  const list = blocks.find((b) => b.type === "list");
  assert.ok(list, "the chapter bullets are a list");
  assert.equal(list.ordered, false);
  assert.equal(list.items.length, 5);
  assert.match(list.items[0].text, /`abstract`/);
  const code = blocks.at(-1);
  assert.equal(code.type, "code");
  assert.equal(code.text, "Ingested: 13 chapters, 43 concepts, 0 assets, 0 refs skipped, 0 refs failed.");
  assert.ok(!blocks.some((b) => b.type === "paragraph" && /```/.test(b.text)), "no fence marker survives as text");
});

test("consecutive lines are ONE paragraph; a blank line ends it", () => {
  const blocks = parseBlocks("first line\nsecond line\n\nnext paragraph");
  assert.deepEqual(blocks, [
    { type: "paragraph", text: "first line second line" },
    { type: "paragraph", text: "next paragraph" },
  ]);
});

test("headings at every level, and a horizontal rule", () => {
  const blocks = parseBlocks("# One\n## Two\n### Three\n#### Four\n##### Five\n###### Six\n\n---\n\ntext");
  assert.deepEqual(
    blocks.filter((b) => b.type === "heading").map((b) => [b.level, b.text]),
    [[1, "One"], [2, "Two"], [3, "Three"], [4, "Four"], [5, "Five"], [6, "Six"]],
  );
  assert.ok(types(blocks).includes("hr"));
});

test("numbered lists keep their start; nested items become a child list", () => {
  const [ol] = parseBlocks("3. three\n4. four\n   - nested a\n   - nested b\n5. five");
  assert.equal(ol.type, "list");
  assert.equal(ol.ordered, true);
  assert.equal(ol.start, 3);
  assert.deepEqual(ol.items.map((i) => i.text), ["three", "four", "five"]);
  const child = ol.items[1].children[0];
  assert.equal(child.type, "list");
  assert.deepEqual(child.items.map((i) => i.text), ["nested a", "nested b"]);
});

test("a wrapped list item continues on its next indented line", () => {
  const [ul] = parseBlocks("- an item that\n  wraps here\n- second");
  assert.deepEqual(ul.items.map((i) => i.text), ["an item that wraps here", "second"]);
});

test("GFM tables: header, alignment, rows, and an escaped pipe", () => {
  const [t] = parseBlocks("| Model | Score | Note |\n|:--|--:|:-:|\n| A | 1.5 | ok |\n| B \\| C | 2 | `x|y` |");
  assert.equal(t.type, "table");
  assert.deepEqual(t.header, ["Model", "Score", "Note"]);
  assert.deepEqual(t.align, ["left", "right", "center"]);
  assert.deepEqual(t.rows, [["A", "1.5", "ok"], ["B | C", "2", "`x|y`"]]);
});

test("a fenced block is verbatim — no inline or block parsing inside it", () => {
  const [c] = parseBlocks("```js\n**not bold**\n- not a list\n\n# not a heading\n```");
  assert.deepEqual(c, { type: "code", lang: "js", text: "**not bold**\n- not a list\n\n# not a heading" });
});

test("a blockquote spans its lines and may hold blocks", () => {
  const [q] = parseBlocks("> **Note** first\n> second\n>\n> - item");
  assert.equal(q.type, "blockquote");
  assert.deepEqual(types(q.children), ["paragraph", "list"]);
  assert.equal(q.children[0].text, "**Note** first second");
});

test("inline: bold, italic, code, strikethrough, links — and nothing parsed inside code", () => {
  assert.deepEqual(parseInline("a **b** *c* `**d**` ~~e~~ [f](https://x.test) g"), [
    { t: "text", v: "a " },
    { t: "strong", children: [{ t: "text", v: "b" }] },
    { t: "text", v: " " },
    { t: "em", children: [{ t: "text", v: "c" }] },
    { t: "text", v: " " },
    { t: "code", v: "**d**" },
    { t: "text", v: " " },
    { t: "del", children: [{ t: "text", v: "e" }] },
    { t: "text", v: " " },
    { t: "link", href: "https://x.test", children: [{ t: "text", v: "f" }] },
    { t: "text", v: " g" },
  ]);
});

test("inline nesting: code inside bold, as the real report writes it", () => {
  assert.deepEqual(parseInline("**`tech-report` stub**"), [
    { t: "strong", children: [{ t: "code", v: "tech-report" }, { t: "text", v: " stub" }] },
  ]);
});

test("an image is kept as an image node — the chapter view decides how to show it", () => {
  assert.deepEqual(parseInline("![Fig 1](raw/assets/doc/fig1.png)"), [{ t: "image", alt: "Fig 1", src: "raw/assets/doc/fig1.png" }]);
});

test("unbalanced markers stay literal text rather than swallowing the line", () => {
  assert.deepEqual(parseInline("2 * 3 and a ** stray"), [{ t: "text", v: "2 * 3 and a ** stray" }]);
});
