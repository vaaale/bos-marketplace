// bundle-toc.test.mjs — the bundle's table of contents: newest first by when a
// document was FIRST added, paged, and stable across a re-ingest
// (spec FR-069, Clarifications 2026-10-14; design.md ADR-017).
//
// The trap ADR-017 was revised for: recordSource() merges each new ledger
// entry over the old one, so a re-ingest — which re-acquires the document and
// calls okf_add_raw_source with the same originUrl — overwrote ingestedAt, and
// "newest first" would have put every re-ingested document back on top.
//
//   node --test tests/bundle-toc.test.mjs
import test, { before, after } from "node:test";
import assert from "node:assert/strict";
import { createRequire } from "node:module";
import { startMemFs } from "./memfs-server.mjs";
import { genBundle } from "./fixtures/gen-bundle.mjs";

const require = createRequire(import.meta.url);
const core = require("../services/lib/okf-core.js");

const ROOT = "/KnowledgeBase";
let fs;
let previousPort;
before(async () => {
  fs = await startMemFs();
  previousPort = process.env.PORT;
  process.env.PORT = String(fs.port);
});
after(async () => {
  if (previousPort === undefined) delete process.env.PORT;
  else process.env.PORT = previousPort;
  await fs.close();
});

const ledger = (b) => JSON.parse(fs.read(`${ROOT}/${b}/raw/sources.json`)).sources;

test("AF1: a re-acquired source keeps its first-added time; a legacy entry falls back to ingestedAt", async () => {
  genBundle(fs, ROOT, "ledger", { docs: 3, chapters: 1 });
  const url = "https://example.test/article-0001";
  const first = ledger("ledger")[url].ingestedAt;

  await core.addRawSource(ROOT, "ledger", { filename: "again.md", content: "# Again\n\nNew text.\n", originUrl: url });

  const entry = ledger("ledger")[url];
  assert.equal(entry.firstIngestedAt, first, "the first time is kept");
  assert.notEqual(entry.ingestedAt, first, "ingestedAt still says when it was last acquired");
});

test("AF2: okf_read_toc({bundle}) pages every document, newest first, stable across a real re-ingest", async () => {
  const { docIds } = genBundle(fs, ROOT, "big", { docs: 500, chapters: 1 });
  const newestFirst = [...docIds].reverse();

  const page1 = await core.readToc(ROOT, "big", null, {});
  assert.equal(page1.total, 500);
  assert.equal(page1.offset, 0);
  assert.equal(page1.limit, 50);
  assert.equal(page1.documents.length, 50);
  assert.deepEqual(Object.keys(page1.documents[0]).sort(), ["addedAt", "attention", "chapters", "id", "summary", "title"]);
  assert.ok(!("terms" in page1) && !("conceptIndex" in page1), "the vocabulary is not part of the bundle TOC");

  const seen = [];
  for (let offset = 0; offset < 500; offset += 200) {
    const page = await core.readToc(ROOT, "big", null, { offset, limit: 200 });
    seen.push(...page.documents.map((d) => d.id));
  }
  assert.deepEqual(seen, newestFirst, "every document exactly once, newest first");

  const clamped = await core.readToc(ROOT, "big", null, { limit: 999 });
  assert.equal(clamped.limit, 200);
  assert.equal(clamped.clamped, true);
  assert.equal(clamped.maxLimit, 200);

  // re-ingest the OLDEST document the way a run does: re-acquire from its origin
  const oldest = docIds[0];
  await core.addRawSource(ROOT, "big", { filename: "re.md", content: "# Re\n", originUrl: `https://example.test/${oldest}` });
  const last = await core.readToc(ROOT, "big", null, { offset: 450, limit: 50 });
  assert.equal(last.documents.at(-1).id, oldest, "a re-ingested document keeps its place");
});

test("AF3: index.md lists documents in the same order and no longer lists every term", async () => {
  const { docIds } = genBundle(fs, ROOT, "indexed", { docs: 5, chapters: 2 });
  await core.rebuildDerived(ROOT, "indexed");
  const index = fs.read(`${ROOT}/indexed/index.md`);
  const order = [...index.matchAll(/\]\(concepts\/([^)]+)\.md\)/g)].map((m) => m[1]);
  assert.deepEqual(order, [...docIds].reverse());
  assert.doesNotMatch(index, /## Concepts covered\n\n`/, "no full term list");
  assert.match(index, /concept-index\.md/);
  assert.match(index, /\b\d+ concept terms?\b/);
});
