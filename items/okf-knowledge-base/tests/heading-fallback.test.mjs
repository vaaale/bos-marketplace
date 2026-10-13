// heading-fallback.test.mjs — a source with no Markdown headings still has a
// structure the ingest agent can slice by.
//
// The reproduction is production, 2026-10-13: a 2.3 MB technical report
// converted by `file_to_markdown` to 131 KB of markdown with ZERO lines
// starting with `#`. Its sections were plain lines — "2 Model Architecture",
// "2.1 Attention", "2.1.1 GDN Hybrid Architecture" — so the heading map was
// empty, `sourceRange` could express nothing but `whole: true`, and the agent
// re-typed all 130K characters into `okf_add_raw_source({content})` with `#`
// markers inserted, after first reaching for `file_write` to do it. That is
// the exact output-token cost FR-060 exists to remove.
//
// The fixture is real: excerpts of that conversion, cut at every section
// boundary, with the traps that sit beside them — a page number ("9", "15"), a
// figure label ("80 Block 16"), stray "1" lines from tables, and the
// "1" / blank / "Introduction" split pdfminer produces for a section title.
//
//   node --test tests/heading-fallback.test.mjs

import test from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { createRequire } from "node:module";

const require = createRequire(import.meta.url);
const core = require("../services/lib/okf-core.js");

const PDF = readFileSync(new URL("./fixtures/pdf-converted-no-headings.md", import.meta.url), "utf8");

test("a heading-less source's numbered sections and conventional titles become its heading map", () => {
  const { headings } = core.buildHeadingMap(PDF);
  assert.deepEqual(
    headings.map((h) => [h.level, h.text]),
    [
      [1, "Abstract"],
      [1, "1 Introduction"],
      [1, "2 Model Architecture"],
      [2, "2.1 Attention"],
      [3, "2.1.1 GDN Hybrid Architecture"],
      [3, "2.1.2 Qwen Sparse Attention"],
      [2, "2.2 Residual"],
      [2, "2.3 N-gram Embedding"],
      [3, "2.3.1 Placement of the N-gram Embedding Layers"],
      [3, "2.3.2 N-gram Vocabulary Size"],
      [1, "3 Optimization"],
      [2, "3.1 Optimizer"],
      [2, "3.2 Hyperparameter Scaling"],
      [2, "3.3 Stability Stress Test"],
      [1, "4 Evaluation"],
      [1, "5 Conclusion"],
      [1, "6 Authors"],
    ],
  );
});

test("every heading's slice starts AT its title line and the slices tile the source after the preamble", () => {
  const { headings, sourceLength } = core.buildHeadingMap(PDF);
  for (const h of headings) {
    const firstLine = PDF.slice(h.start).split("\n")[0];
    assert.ok(h.text.startsWith(firstLine.trim()), `heading "${h.text}" must start at its own line, got "${firstLine}"`);
  }
  for (let i = 0; i + 1 < headings.length; i++) assert.equal(headings[i].end, headings[i + 1].start);
  assert.equal(headings.at(-1).end, sourceLength);
});

test("the traps stay body text: page numbers, figure labels, stray table numbers, numbered prose", () => {
  const texts = core.buildHeadingMap(PDF).headings.map((h) => h.text);
  for (const trap of ["9", "15", "80 Block 16"]) assert.ok(!texts.includes(trap), `"${trap}" is not a section`);
  // numbered prose after a blank line, and a TOC-style line ending in a page number
  const prose = "Intro.\n\n1 Introduction\n\nBody.\n\n2 of the 8 runs diverged.\n\n2 Method 7\n\n2 Method\n\nMore.\n";
  assert.deepEqual(core.buildHeadingMap(prose).headings.map((h) => h.text), ["1 Introduction", "2 Method"]);
});

test("a source WITH Markdown headings is read exactly as before — the fallback never mixes in", () => {
  const md = "# Title\n\n1 Introduction\n\nText.\n\n## Part\n\n2 Method\n\nMore.\n";
  assert.deepEqual(core.buildHeadingMap(md).headings.map((h) => [h.level, h.text]), [
    [1, "Title"],
    [2, "Part"],
  ]);
});

test("chunking a heading-less source splits at the same sections and hands the agent their indices", () => {
  const chunks = core.chunkSource(PDF, 4000);
  assert.ok(chunks.length > 1);
  const referenced = new Set(chunks.flatMap((c) => c.headings));
  const { headings } = core.buildHeadingMap(PDF);
  for (const h of headings) assert.ok(referenced.has(h.index), `heading ${h.index} "${h.text}" is reachable from some chunk`);
  // and a chunk that opens a section carries that section's path
  const evalChunk = chunks.find((c) => c.content.startsWith("4 Evaluation"));
  assert.ok(evalChunk, "a section starts its own chunk");
  assert.deepEqual(evalChunk.headingPath, ["4 Evaluation"]);
});
