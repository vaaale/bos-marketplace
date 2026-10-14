// derived-model.test.mjs — the derived model is incremental, serialized per
// bundle, and checked for freshness on read (design.md ADR-016, phase AE).
//
// What it replaces, measured on production 2026-10-13: every chapter write
// re-read EVERY concept file one /api/fs request at a time and rewrote every
// document's TOC — okf_upsert_concept p50 257 ms on a ~60-file bundle, ~12 s a
// write at 3,000 chapters. The cached model was never checked against the
// disk, a failed directory listing read as "empty", and links.json / the
// ledger were unlocked read-modify-writes two concurrent runs could lose.
//
//   node --test tests/derived-model.test.mjs
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

/** Concept files (not derived artifacts) read since the last reset. */
function conceptReads(bundle) {
  const reads = fs.counts().get("read") || new Map();
  return [...reads.keys()].filter((p) => p.startsWith(`${ROOT}/${bundle}/concepts/`));
}
function writes(bundle) {
  const w = fs.counts().get("write") || new Map();
  return [...w.keys()].filter((p) => p.startsWith(`${ROOT}/${bundle}/`)).map((p) => p.slice(`${ROOT}/${bundle}/`.length)).sort();
}
const chapterDoc = (title, concepts, body = "Body.\n") =>
  core.stringifyDocument({ type: "section", parent: "article-0004", title, status: "stable", concepts, summary: `${title} summary.` }, body);

test("AE1: a chapter write reads only what it wrote, and rewrites only its own document's TOC", async () => {
  genBundle(fs, ROOT, "scale", { docs: 200, chapters: 5 });
  await core.search(ROOT, "scale", "inference"); // first use: the full read happens here, once
  fs.resetCounts();

  await core.upsertConcept(ROOT, "scale", "article-0004/ch-2", { frontmatter: { summary: "Rewritten summary." } });

  const reads = conceptReads("scale");
  assert.ok(reads.every((p) => p === `${ROOT}/scale/concepts/article-0004/ch-2.md`), `read other concepts: ${reads.slice(0, 5).join(", ")}…`);
  assert.deepEqual(
    writes("scale").filter((p) => p !== "log.md"),
    ["concept-index.md", "concepts/article-0004/ch-2.md", "index.md", "toc/article-0004.md"],
  );
});

test("AE2: a change made behind the service's back is seen by the next read, and that document's TOC is rewritten", async () => {
  genBundle(fs, ROOT, "outside", { docs: 6, chapters: 3 });
  await core.search(ROOT, "outside", "inference");

  // changed, added and deleted directly in the store — not through the service
  fs.write(`${ROOT}/outside/concepts/article-0004/ch-1.md`, chapterDoc("Zebra crossings", ["zebra-term"]));
  fs.write(`${ROOT}/outside/concepts/article-0004/ch-9.md`, chapterDoc("Okapi notes", ["okapi-term"]));
  fs.remove(`${ROOT}/outside/concepts/article-0005/ch-0.md`);

  const terms = (await core.listConcepts(ROOT, "outside")).terms.map((t) => t.term);
  assert.ok(terms.includes("zebra-term"), "the edited chapter's new term is in the vocabulary");
  assert.ok(terms.includes("okapi-term"), "the added chapter's term is in the vocabulary");
  const toc = await core.readToc(ROOT, "outside", "article-0005");
  assert.ok(!toc.chapters.some((c) => c.id === "ch-0"), "the deleted chapter is gone from its document's TOC");
  assert.match(fs.read(`${ROOT}/outside/toc/article-0004.md`), /Okapi notes/, "the stored TOC of the changed document was rewritten");
});

test("AE3: a directory listing that fails is an error — never an empty or partial bundle", async () => {
  genBundle(fs, ROOT, "failing", { docs: 6, chapters: 3 });
  await core.search(ROOT, "failing", "inference");
  fs.write(`${ROOT}/failing/concepts/article-0003/ch-0.md`, chapterDoc("Changed", ["changed-term"]));
  fs.failNext("list", (p) => p === `${ROOT}/failing/concepts/article-0005`);

  await assert.rejects(core.search(ROOT, "failing", "inference"), /injected failure/);

  const after = await core.readToc(ROOT, "failing", "article-0005");
  assert.equal(after.chapters.length, 3, "the next read (no failure) still sees every chapter of that document");
});

test("AE4: concurrent writers lose nothing, and concurrent reads share one freshness check", async () => {
  genBundle(fs, ROOT, "busy", { docs: 6, chapters: 3 });
  await core.search(ROOT, "busy", "inference");

  // two "runs" writing at once: chapters, links and raw sources interleaved
  const targets = Array.from({ length: 8 }, (_, i) => `article-0003/ch-${i % 3}`);
  await Promise.all([
    ...Array.from({ length: 8 }, (_, i) => core.addLink(ROOT, "busy", `article-0001/ch-${i % 3}`, targets[i] === "article-0001/ch-0" ? "article-0002/ch-0" : `article-0004/ch-${i % 3}`, { label: `l${i}` })),
    ...Array.from({ length: 6 }, (_, i) => core.addRawSource(ROOT, "busy", { filename: `note-${i}.md`, content: `# Note ${i}\n\nText ${i}.\n`, originUrl: `https://example.test/note-${i}` })),
    ...Array.from({ length: 6 }, (_, i) => core.upsertConcept(ROOT, "busy", `article-0002/new-${i}`, { frontmatter: { parent: "article-0002", concepts: ["busy-term"], summary: `New ${i}.` }, body: `New ${i}\n` })),
  ]);

  const links = JSON.parse(fs.read(`${ROOT}/busy/links.json`));
  assert.equal(new Set(links.map((l) => `${l.from}>${l.to}`)).size, 3, "every distinct link survived");
  const ledger = JSON.parse(fs.read(`${ROOT}/busy/raw/sources.json`));
  for (let i = 0; i < 6; i++) assert.ok(ledger.sources[`https://example.test/note-${i}`], `ledger entry ${i} survived`);
  const toc = await core.readToc(ROOT, "busy", "article-0002");
  assert.equal(toc.chapters.filter((c) => c.id.startsWith("new-")).length, 6, "every new chapter is in its TOC");

  fs.write(`${ROOT}/busy/concepts/article-0003/ch-0.md`, chapterDoc("Changed again", ["again-term"]));
  fs.resetCounts();
  await Promise.all(Array.from({ length: 5 }, () => core.search(ROOT, "busy", "again")));
  assert.equal(fs.counts().get("list").get(`${ROOT}/busy/concepts`), 1, "five concurrent searches, one listing of concepts/");
});

test("AE5: a chapter whose stale_after passes shows stale without any write", async () => {
  genBundle(fs, ROOT, "ageing", { docs: 3, chapters: 2 });
  const soon = new Date(Date.now() + 250).toISOString();
  fs.write(
    `${ROOT}/ageing/concepts/article-0001/ch-0.md`,
    core.stringifyDocument({ type: "section", parent: "article-0001", title: "Ageing", status: "stable", concepts: ["ageing"], summary: "s", stale_after: soon }, "x\n"),
  );
  assert.equal((await core.bundleHealth(ROOT, "ageing")).stale, 0);
  await new Promise((r) => setTimeout(r, 400));
  assert.equal((await core.bundleHealth(ROOT, "ageing")).stale, 1);
});

test("AE6: backlinks come from the model — no second full read of the bundle", async () => {
  genBundle(fs, ROOT, "linked", { docs: 30, chapters: 4 });
  await core.addLink(ROOT, "linked", "article-0001/ch-0", "article-0002/ch-1");
  await core.search(ROOT, "linked", "inference");
  fs.resetCounts();

  assert.deepEqual(await core.backlinks(ROOT, "linked", "article-0002/ch-1"), ["article-0001/ch-0"]);
  assert.deepEqual(conceptReads("linked"), [], "no concept file was read to answer a backlinks query");
});

test("AE7: an unreadable links.json or ledger stops the write — it is never read as empty and overwritten", async () => {
  genBundle(fs, ROOT, "corrupt", { docs: 3, chapters: 2 });
  fs.write(`${ROOT}/corrupt/links.json`, "[{ not json");
  fs.write(`${ROOT}/corrupt/raw/sources.json`, "{ truncated");

  await assert.rejects(core.addLink(ROOT, "corrupt", "article-0001/ch-0", "article-0002/ch-0"), /links\.json/);
  assert.equal(fs.read(`${ROOT}/corrupt/links.json`), "[{ not json", "the existing links were not overwritten");

  await assert.rejects(core.addRawSource(ROOT, "corrupt", { filename: "n.md", content: "# N\n", originUrl: "https://example.test/n" }), /sources\.json/);
  assert.equal(fs.read(`${ROOT}/corrupt/raw/sources.json`), "{ truncated", "the provenance ledger was not overwritten");
});
