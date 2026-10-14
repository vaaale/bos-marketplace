// graph-identity.test.mjs — a document and a concept term with the same name
// are TWO graph nodes (spec FR-073(f), SC-024; design.md ADR-022).
//
// Reproduction: core.graph() gave every node its bare name as `id` — a
// document "deployment" and the concept term "deployment" both had id
// "deployment". Edges and the app key on `id`, so the two collapsed into one
// node and the term's "covers" edges landed on the document (found in the
// mockup while making the graph legible, 2026-10-14). The service already
// emitted a unique `key`; nothing used it.
//
//   node --test tests/graph-identity.test.mjs
import test, { before, after } from "node:test";
import assert from "node:assert/strict";
import { createRequire } from "node:module";
import { startMemFs } from "./memfs-server.mjs";
import { genBundle, SHARED_NAME } from "./fixtures/gen-bundle.mjs";

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

test("AJ1: a document and a term named alike are two nodes, each with its own edges, and every edge names real nodes", async () => {
  genBundle(fs, ROOT, "same", { docs: 5, chapters: 2 }); // document "deployment" + term "deployment"
  await core.addLink(ROOT, "same", "article-0001/ch-0", "article-0002/ch-1");
  const g = await core.graph(ROOT, "same");

  const ids = g.nodes.map((n) => n.id);
  assert.equal(new Set(ids).size, ids.length, "node ids are unique");
  const doc = g.nodes.find((n) => n.id === `doc:${SHARED_NAME}`);
  const term = g.nodes.find((n) => n.id === `concept:${SHARED_NAME}`);
  assert.ok(doc && term, "both the document and the term are nodes");
  assert.equal(doc.docId, SHARED_NAME);
  assert.equal(term.term, SHARED_NAME);

  const into = (id, kind) => g.edges.filter((e) => e.to === id && e.kind === kind);
  assert.ok(into(term.id, "coverage").length > 0, "the term's coverage edges reach the TERM");
  assert.ok(g.edges.filter((e) => e.from === doc.id && e.kind === "containment").length > 0, "the document contains its chapters");
  assert.ok(into(doc.id, "coverage").length === 0, "no coverage edge lands on the document");

  const present = new Set(ids);
  assert.ok(g.edges.every((e) => present.has(e.from) && present.has(e.to)));
  assert.ok(g.edges.some((e) => e.kind === "link" && e.from === "chap:article-0001/ch-0" && e.to === "chap:article-0002/ch-1"), "explicit links use keys too");
  const author = g.nodes.find((n) => n.type === "person");
  assert.ok(author && author.id.startsWith("person:") && g.edges.some((e) => e.from === "doc:article-0001" && e.to === author.id));
});
