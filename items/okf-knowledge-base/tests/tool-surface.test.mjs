// tool-surface.test.mjs — what the agent is TOLD about retrieval, and what the
// app's routes return, match what the service now does (phase AI; spec
// FR-001/FR-004/FR-006 as amended, FR-036; design.md §12.4).
//
// The declarations still said "concept-anchored, NOT full text … read the
// vocabulary with okf_list_concepts" — instructions that would send an agent
// to page through thousands of terms for a name the search now finds. And the
// app's routes must return exactly the tool's object: one core function, two
// surfaces.
//
//   node --test tests/tool-surface.test.mjs
import test, { before, after } from "node:test";
import assert from "node:assert/strict";
import http from "node:http";
import { createRequire } from "node:module";
import { startMemFs } from "./memfs-server.mjs";
import { genBundle, BODY_ONLY_NAME } from "./fixtures/gen-bundle.mjs";

const require = createRequire(import.meta.url);
const core = require("../services/lib/okf-core.js");
const { DECLARATIONS, makeHandlers } = require("../services/lib/tools.js");
const { createRequestHandler } = require("../services/lib/http-bridge.js");

const ROOT = "/KnowledgeBase";
const B = "surface";
let fs;
let bridge;
let base;
let previousPort;

before(async () => {
  fs = await startMemFs();
  previousPort = process.env.PORT;
  process.env.PORT = String(fs.port);
  genBundle(fs, ROOT, B, { docs: 12, chapters: 3 });
  bridge = http.createServer(createRequestHandler({ core, bundleRoot: ROOT, declarations: DECLARATIONS, getRuntime: () => ({}) }));
  await new Promise((r) => bridge.listen(0, "127.0.0.1", r));
  base = `http://127.0.0.1:${bridge.address().port}`;
});
after(async () => {
  if (previousPort === undefined) delete process.env.PORT;
  else process.env.PORT = previousPort;
  await new Promise((r) => bridge.close(() => r()));
  await fs.close();
});

const decl = (name) => DECLARATIONS.find((d) => d.name === name);
const get = async (p) => (await fetch(`${base}${p}`)).json();

test("AI1: still exactly 21 tools; the retrieval declarations describe what the service does now", () => {
  assert.equal(DECLARATIONS.length, 21);

  const search = decl("okf_search");
  assert.doesNotMatch(search.description, /NOT full text/);
  assert.match(search.description, /full text/i);
  assert.ok(search.inputSchema.properties.groupBy, "okf_search declares groupBy");
  assert.match(search.inputSchema.properties.limit.description, /default 10/);

  const toc = decl("okf_read_toc");
  assert.ok(!toc.inputSchema.required.includes("docId"), "docId is optional — without it, the bundle TOC");
  assert.ok(toc.inputSchema.properties.offset && toc.inputSchema.properties.limit);

  const vocab = decl("okf_list_concepts");
  for (const p of ["query", "offset", "limit"]) assert.ok(vocab.inputSchema.properties[p], `okf_list_concepts declares ${p}`);
  assert.doesNotMatch(vocab.description, /plus the document and chapter listings/);
});

test("AI1: an empty search tells the agent what was searched and what to do next — not to read the vocabulary", async () => {
  const handlers = makeHandlers(core);
  const res = await handlers.okf_search({ bundle: B, query: "quantum chromodynamics" }, { core, bundleRoot: ROOT });
  assert.equal(res.count, 0);
  assert.match(res.note, /full text/);
  assert.match(res.note, /okf_read_toc/);
  assert.doesNotMatch(res.note, /okf_list_concepts to read the vocabulary/);
});

test("AI2: the app's routes return exactly the tool's object", async () => {
  const handlers = makeHandlers(core);
  const ctx = { core, bundleRoot: ROOT };

  const tocTool = await handlers.okf_read_toc({ bundle: B, offset: 2, limit: 3 }, ctx);
  assert.deepEqual(await get(`/bundles/${B}/toc?offset=2&limit=3`), tocTool);

  const vocabTool = await handlers.okf_list_concepts({ bundle: B, query: "infer", limit: 5 }, ctx);
  assert.deepEqual(await get(`/bundles/${B}/concepts?query=infer&limit=5`), vocabTool);

  const searchTool = await handlers.okf_search({ bundle: B, query: BODY_ONLY_NAME, groupBy: "document" }, ctx);
  const searchRoute = await get(`/bundles/${B}/search?query=${encodeURIComponent(BODY_ONLY_NAME)}&groupBy=document`);
  assert.deepEqual(searchRoute.groups, searchTool.groups);
  assert.equal(searchRoute.total, searchTool.total);

  assert.deepEqual(Object.keys(await get(`/bundles/${B}`)).sort(), ["health", "indexGeneratedAt"]);
});
