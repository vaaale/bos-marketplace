// REPRODUCTION — "the Jobs tab summary shows all zeros even though the run
// completed and content was ingested".
//
// `summaryFromOutput` reads the agent's final prose for counts. Its patterns
// were written against ONE phrasing of each count:
//
//     chapters:    /(\d+)\s+chapters?\b/i
//     concepts:    /(\d+)\s+concepts?\s*(?:terms?)?\b/i
//     assets:      /(\d+)\s+assets?\b/i
//     refsSkipped: /(\d+)\s+(?:references?|refs?)\s+skipped/i
//     refsFailed:  /(\d+)\s+(?:references?|refs?)\s+failed/i
//
// The agent is a language model writing a report, so it says "6 sections",
// "8 topics", "1 image", "skipped 2 references" — every one of which the
// patterns above read as 0. A run that ingested a whole document then renders
// as a card of zeros, which reads as a failed run.
//
//   node --test data/user-apps/items/okf-knowledge-base/tests/

import test from "node:test";
import assert from "node:assert/strict";
import { createRequire } from "node:module";

const require = createRequire(import.meta.url);
const core = require("../services/lib/okf-core.js");

const read = (text) => core.summaryFromOutput(text, []);

test("reads the literal template AGENT.md mandates", () => {
  const s = read("All done.\n\nIngested: 6 chapters, 8 concepts, 1 assets, 2 refs skipped, 0 refs failed.");
  assert.deepEqual(
    { chapters: s.chapters, concepts: s.concepts, assets: s.assets, refsSkipped: s.refsSkipped, refsFailed: s.refsFailed },
    { chapters: 6, concepts: 8, assets: 1, refsSkipped: 2, refsFailed: 0 },
  );
});

test("chapters: 'chapters', 'sections', 'parts'", () => {
  assert.equal(read("6 chapters").chapters, 6);
  assert.equal(read("Wrote 6 sections").chapters, 6);
  assert.equal(read("Split into 4 parts").chapters, 4);
});

test("concepts: 'concepts', 'concept terms', 'topics'", () => {
  assert.equal(read("8 concepts").concepts, 8);
  assert.equal(read("8 concept terms").concepts, 8);
  assert.equal(read("8 topics").concepts, 8);
});

test("assets: 'assets', 'images', 'figures', 'media', 'videos', 'interpretations'", () => {
  assert.equal(read("3 assets").assets, 3);
  assert.equal(read("1 image").assets, 1);
  assert.equal(read("2 figures").assets, 2);
  assert.equal(read("5 media files").assets, 5);
  assert.equal(read("1 video").assets, 1);
  assert.equal(read("4 interpretations").assets, 4);
});

test("refs skipped: both word orders", () => {
  assert.equal(read("2 references skipped").refsSkipped, 2);
  assert.equal(read("skipped 2 references").refsSkipped, 2);
  assert.equal(read("skipped 3 refs").refsSkipped, 3);
});

test("refs failed: both word orders", () => {
  assert.equal(read("0 refs failed").refsFailed, 0);
  assert.equal(read("1 reference failed").refsFailed, 1);
  assert.equal(read("failed 2 references").refsFailed, 2);
});

test("a count the agent never states stays 0 — never guessed", () => {
  const s = read("I wrote the document but could not reach any of its references.");
  assert.deepEqual(
    { chapters: s.chapters, concepts: s.concepts, assets: s.assets, refsSkipped: s.refsSkipped, refsFailed: s.refsFailed },
    { chapters: 0, concepts: 0, assets: 0, refsSkipped: 0, refsFailed: 0 },
  );
});

test("skipped and failed are not confused for one another", () => {
  const s = read("Ingested: 1 chapters, 2 concepts, 0 assets, 5 refs skipped, 1 refs failed.");
  assert.equal(s.refsSkipped, 5);
  assert.equal(s.refsFailed, 1);
});

test("the template wins over an earlier stray number in the prose", () => {
  const s = read(
    "I looked at 2 chapters of the source before deciding to split differently.\n\n" +
      "Ingested: 7 chapters, 9 concepts, 0 assets, 0 refs skipped, 0 refs failed.",
  );
  assert.equal(s.chapters, 7);
  assert.equal(s.concepts, 9);
});

test("empty output is a zeroed summary, not a crash", () => {
  const s = read("");
  assert.equal(s.chapters, 0);
  assert.equal(s.text, "");
});

test("the full prose is always preserved verbatim", () => {
  const prose = "Wrote 6 sections and assigned 8 topics.";
  assert.equal(read(prose).text, prose);
});
