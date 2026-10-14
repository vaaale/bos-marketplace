// full-text-search.test.mjs — okf_search over terms, titles, summaries AND the
// full text of every chapter and document stub (spec FR-001/FR-002 as amended
// 2026-10-14, SC-020/SC-023; design.md ADR-015, ADR-018, §12.3).
//
// Before: search matched only concept-term names and one-line descriptions, so
// anything ingest did not happen to make a term — a name, a figure, a phrase in
// a chapter body — was unreachable, and a lookup answered "not in the
// knowledge base" when it was. The contract that must NOT change with it: a
// natural-language paraphrase still routes (US1 AS1 — any word may match), and
// a description-only match is still anchored to its chapter's term.
//
//   node --test tests/full-text-search.test.mjs
import test, { before, after } from "node:test";
import assert from "node:assert/strict";
import { createRequire } from "node:module";
import { startMemFs } from "./memfs-server.mjs";
import { genBundle, BODY_ONLY_NAME } from "./fixtures/gen-bundle.mjs";

const require = createRequire(import.meta.url);
const core = require("../services/lib/okf-core.js");

const ROOT = "/KnowledgeBase";
const B = "ft";
let fs;
let previousPort;

const write = (id, fm, body) => fs.write(`${ROOT}/${B}/concepts/${id}.md`, core.stringifyDocument(fm, body));

before(async () => {
  fs = await startMemFs();
  previousPort = process.env.PORT;
  process.env.PORT = String(fs.port);
  genBundle(fs, ROOT, B, { docs: 6, chapters: 3 });
  // the e2e fixture's shape: a deployment checklist with a canary/rollback chapter
  write("checklist", { type: "document", title: "Deployment Checklist", summary: "How we ship.", created_at: "2026-02-01T00:00:00.000Z" }, "# Deployment Checklist\n");
  write("checklist/canary", { type: "section", parent: "checklist", title: "Canary and Rollback", status: "stable", concepts: ["rollback", "deployment"], summary: "5% canary for 30m; auto-rollback on p99 regressions." }, "## Canary\n\nShip to five percent first. Roll back automatically when p99 regresses.\n");
  write("checklist/pre-deploy", { type: "section", parent: "checklist", title: "Pre-Deploy Gate", status: "stable", concepts: ["deployment"], summary: "CI green, migrations reviewed, and a documented rollback plan." }, "## Gate\n\nNothing ships unless CI is green.\n");
  write("checklist/apis", { type: "section", parent: "checklist", title: "Rapid prototyping", status: "stable", concepts: ["prototyping"], summary: "Build quickly." }, "## Rapid\n\nWe move rapidly.\n");
  write("checklist/long", { type: "section", parent: "checklist", title: "A long one", status: "stable", concepts: ["misc"], summary: "Long." },
    "## Long\n\n" + "Filler sentence one goes here. ".repeat(3) + "The ﬁnal ligature word is Zyzzogeton, " + "and then it keeps going with words ".repeat(30) + "until the end.\n");
  write("checklist/hangul", { type: "section", parent: "checklist", title: "Hangul", status: "stable", concepts: ["misc"], summary: "Korean." }, "## 한국어\n\n각 문장은 다릅니다. 그리고 Qwertyuiop 단어가 여기에 있습니다. 끝.\n");
});
after(async () => {
  if (previousPort === undefined) delete process.env.PORT;
  else process.env.PORT = previousPort;
  await fs.close();
});

const search = (q, opts) => core.search(ROOT, B, q, opts);

test("AG1 (SC-020): a name only in a chapter body is found by full text, with the name in the excerpt", async () => {
  const res = await search(BODY_ONLY_NAME);
  assert.equal(res.rows[0].docId + "/" + res.rows[0].chId, "article-0002/ch-1");
  assert.equal(res.rows[0].matchKind, "text");
  assert.ok(res.rows[0].excerpt.includes(BODY_ONLY_NAME), res.rows[0].excerpt);
});

test("AG1: diacritics fold both ways, and a word matches only at the start of a word", async () => {
  const plain = await search("Cordoba");
  assert.ok(plain.rows.some((r) => r.docId === "article-0001"), "'Cordoba' finds the stub whose author is 'Diego Córdoba'");
  const accented = await search("ingrid haavardsholm");
  assert.ok(accented.rows.length > 0);
  const api = await search("api");
  assert.ok(!api.rows.some((r) => r.chId === "apis"), "'api' does not match 'Rapid'");
});

test("AG2: a document stub's author is found by name, as a document-level row", async () => {
  const res = await search("Diego Córdoba");
  const row = res.rows.find((r) => r.docId === "article-0001");
  assert.ok(row, "the author's document is a hit");
  assert.equal(row.chId, "");
  assert.equal(row.matchKind, "person");
  assert.equal(row.kind, "person");
  assert.equal(row.matchedConcept, "Diego Córdoba");
});

test("AG3: a natural-language paraphrase still routes, and a description match stays anchored to its term (kept contracts)", async () => {
  const nl = await search("what is our rollback policy");
  assert.equal(nl.rows[0].docId, "checklist");
  assert.equal(nl.rows[0].chId, "canary");
  assert.equal(nl.rows[0].matchedConcept, "rollback");

  const desc = await search("migrations reviewed");
  assert.equal(desc.rows[0].chId, "pre-deploy");
  assert.equal(desc.rows[0].matchedConcept, "deployment", "anchored to its chapter's term, as today");
  assert.equal(desc.rows[0].matchKind, "summary");

  const stop = await search("what is");
  assert.ok(Array.isArray(stop.rows), "a query of only stop words still searches (it is not emptied)");
});

test("AG4: every-word matches rank above partial ones; then tier; output is deterministic", async () => {
  const res = await search("canary rollback automatically");
  assert.equal(res.rows[0].chId, "canary", "the chapter matching every word ranks first");
  assert.ok(res.rows[0].matchedWords.length >= res.rows[1].matchedWords.length);
  const again = await search("canary rollback automatically");
  assert.equal(JSON.stringify(again), JSON.stringify(res));
});

test("AG5: an excerpt is at most three sentences and 400 characters, cut from the original text", async () => {
  const long = (await search("Zyzzogeton")).rows[0];
  assert.ok(long.excerpt.length <= 400, `excerpt is ${long.excerpt.length} chars`);
  assert.ok(long.excerpt.includes("Zyzzogeton"));
  assert.ok(long.excerpt.includes("ﬁnal"), "the ligature is the original text, not its folded form");
  const hangul = (await search("Qwertyuiop")).rows[0];
  assert.ok(hangul.excerpt.includes("Qwertyuiop 단어가"), hangul.excerpt);
  for (const r of (await search("inference")).rows) {
    if (!r.excerpt) continue;
    assert.ok(r.excerpt.split(/(?<=[.!?])\s+/).length <= 3, r.excerpt);
  }
});

test("AG6: paging, totals, what was searched, and grouping by document", async () => {
  const all = await search("chapter"); // in every generated chapter's body
  assert.equal(all.rows.length, 10, "default limit 10");
  assert.ok(all.total > 10);
  assert.deepEqual(all.searched, ["terms", "titles", "summaries", "full text"]);
  const big = await search("chapter", { limit: 500 });
  assert.equal(big.rows.length, Math.min(50, big.total));
  assert.equal(big.clamped, true);
  assert.equal(big.maxLimit, 50);

  const grouped = await search("notes", { groupBy: "document" });
  assert.ok(grouped.groups.length <= 10);
  for (const g of grouped.groups) {
    assert.ok(g.hits.length <= 5);
    assert.ok(g.total >= g.hits.length);
    assert.ok(g.hits.every((h) => h.docId === g.docId));
  }
  const none = await search("quantum chromodynamics");
  assert.deepEqual(none.rows, []);
  assert.equal(none.total, 0);
});

test("AG7 (SC-023): a search writes nothing", async () => {
  const before = fs.paths().join("\n");
  fs.resetCounts();
  await search("inference rollback Córdoba");
  assert.equal(fs.total("write"), 0);
  assert.equal(fs.paths().join("\n"), before);
});
