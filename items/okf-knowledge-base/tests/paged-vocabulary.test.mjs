// paged-vocabulary.test.mjs — every retrieval response is bounded by a page,
// never by the bundle (spec FR-006/FR-036/FR-070, NFR-011 as amended
// 2026-10-14; design.md ADR-019, ADR-020, ADR-021).
//
// Before: okf_list_concepts returned the whole vocabulary plus every document
// and every chapter, each term with every chapter it covers, and the app's
// bundle detail carried every document and the whole concept index — at
// hundreds of documents, the largest responses the item could produce.
//
//   node --test tests/paged-vocabulary.test.mjs
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

/** A bundle with many distinct terms: every chapter gets its own term too. */
function manyTerms(bundle, docs) {
  genBundle(fs, ROOT, bundle, { docs, chapters: 4 });
  for (let d = 1; d < docs; d++) {
    const docId = `article-${String(d).padStart(4, "0")}`;
    for (let c = 0; c < 4; c++) {
      fs.write(
        `${ROOT}/${bundle}/concepts/${docId}/ch-${c}.md`,
        core.stringifyDocument({ type: "section", parent: docId, title: `t ${d}.${c}`, status: "stable", concepts: ["shared-topic", `term-${d}-${c}`], summary: "s" }, "b\n"),
      );
    }
  }
}

test("AH1: okf_list_concepts filters by name and pages; each term's coverage is bounded", async () => {
  manyTerms("vocab", 80); // 316 own terms + shared-topic + the generated topics
  const first = await core.listConcepts(ROOT, "vocab", {});
  assert.equal(first.terms.length, 100, "default page 100");
  assert.ok(first.total > 300);
  assert.equal(first.offset, 0);
  assert.ok(!("documents" in first) && !("chapters" in first), "no document or chapter lists");

  const shared = first.terms.find((t) => t.term === "shared-topic") || (await core.listConcepts(ROOT, "vocab", { query: "shared" })).terms[0];
  assert.equal(shared.covers.length, 5, "at most 5 covers per term");
  assert.equal(shared.coversTotal, 316);

  const filtered = await core.listConcepts(ROOT, "vocab", { query: "TERM-7" });
  assert.ok(filtered.terms.length > 0);
  assert.ok(filtered.terms.every((t) => t.term.includes("term-7")), "case- and accent-insensitive substring of the name");

  const clamped = await core.listConcepts(ROOT, "vocab", { limit: 5000 });
  assert.equal(clamped.limit, 500);
  assert.equal(clamped.clamped, true);

  const pointer = await core.listConcepts(ROOT, "vocab", { type: "document" });
  assert.deepEqual(pointer.terms, []);
  assert.match(pointer.note, /okf_read_toc/);
});

test("AH2: the bundle detail carries counts, not the bundle", async () => {
  manyTerms("detail", 20);
  const detail = await core.bundleDetail(ROOT, "detail");
  assert.deepEqual(Object.keys(detail).sort(), ["health", "indexGeneratedAt"]);
  assert.equal(detail.health.docs, 20);
});

test("AH3: a document summary over two sentences or 320 characters is refused; chapters and stored summaries are not", async () => {
  genBundle(fs, ROOT, "capped", { docs: 2, chapters: 1 });
  await assert.rejects(
    core.upsertConcept(ROOT, "capped", "new-doc", { frontmatter: { type: "document", summary: "One. Two. Three." } }),
    /at most two sentences/,
  );
  await assert.rejects(
    core.upsertConcept(ROOT, "capped", "new-doc", { frontmatter: { type: "document", summary: "x".repeat(321) } }),
    /320 characters/,
  );
  await core.upsertConcept(ROOT, "capped", "new-doc", { frontmatter: { type: "document", summary: "What it is about. Why it matters." } });
  await core.upsertConcept(ROOT, "capped", "new-doc/ch-0", { frontmatter: { parent: "new-doc", summary: "A chapter. With. Many. Sentences." } });
  // a stored long summary is untouched by a write that does not set one
  fs.write(`${ROOT}/capped/concepts/old.md`, core.stringifyDocument({ type: "document", title: "Old", summary: "y".repeat(500) }, "# Old\n"));
  await core.upsertConcept(ROOT, "capped", "old", { frontmatter: { status: "stable" } });
  assert.match(fs.read(`${ROOT}/capped/concepts/old.md`), /y{500}/);
});
