// chunk-source.test.mjs — the ingest chunker (FR-055/FR-056, ADR-012).
//
// `chunkSource` is pure, so most of this needs nothing but the module.
// `writeChunks` and the `okf_add_raw_source` integration DO touch the VFS, so
// they run against the in-memory /api/fs stand-in (tests/memfs-server.mjs) —
// the real okf-core write path, the real frontmatter serializer, no BOS.
//
//   node --test tests/

import test from "node:test";
import assert from "node:assert/strict";
import { createRequire } from "node:module";
import { startMemFs } from "./memfs-server.mjs";

const require = createRequire(import.meta.url);
const core = require("../services/lib/okf-core.js");

const SENTENCE = (n) => `Sentence number ${n} says a thing about the subject at hand. `;
const paragraph = (n, reps = 12) => SENTENCE(n).repeat(reps).trim();

test("a source within maxChunkSize is ONE chunk, untouched, with no headingPath", () => {
  const src = "# Title\n\nShort enough to need nothing.\n";
  const chunks = core.chunkSource(src, 32000);
  assert.equal(chunks.length, 1);
  // `headings` is the ADR-014 addition: the GLOBAL heading indices this
  // chunk can reference. A one-chunk source holds every heading in it.
  assert.deepEqual(chunks[0], { chunk: 1, total: 1, headingPath: [], headings: [0], content: src });
});

test("an empty source is still one chunk", () => {
  const chunks = core.chunkSource("", 32000);
  assert.equal(chunks.length, 1);
  assert.equal(chunks[0].total, 1);
});

test("three heading sections, each under the bound, split into three chunks with their headingPath", () => {
  const src = `## Alpha\n\n${paragraph(1, 5)}\n\n## Beta\n\n${paragraph(2, 5)}\n\n## Gamma\n\n${paragraph(3, 5)}\n`;
  const max = 340;
  assert.ok(src.length > max, "the fixture must exceed the bound or rule 1 short-circuits");
  const chunks = core.chunkSource(src, max);
  assert.equal(chunks.length, 3);
  assert.deepEqual(chunks.map((c) => c.headingPath), [["Alpha"], ["Beta"], ["Gamma"]]);
  assert.deepEqual(chunks.map((c) => c.chunk), [1, 2, 3]);
  assert.ok(chunks.every((c) => c.total === 3));
  assert.ok(chunks.every((c) => c.content.length <= max));
});

test("headingPath is the stack of open headings, deepest last", () => {
  const src =
    `# Part II: Numerical Methods\n\n${paragraph(0, 4)}\n\n` +
    `## Section 4: Spectral Methods\n\n${paragraph(1, 4)}\n\n` +
    `### Chebyshev\n\n${paragraph(2, 4)}\n\n` +
    `## Section 5: Finite Elements\n\n${paragraph(3, 4)}\n`;
  const chunks = core.chunkSource(src, 300);
  assert.deepEqual(chunks[0].headingPath, ["Part II: Numerical Methods"]);
  const deepest = chunks.find((c) => c.headingPath.includes("Chebyshev"));
  assert.deepEqual(deepest.headingPath, ["Part II: Numerical Methods", "Section 4: Spectral Methods", "Chebyshev"]);
  // a sibling at the same level POPS the deeper one back off the stack
  const sibling = chunks.find((c) => c.headingPath.includes("Section 5: Finite Elements"));
  assert.deepEqual(sibling.headingPath, ["Part II: Numerical Methods", "Section 5: Finite Elements"]);
});

test("a section over the bound splits further, at paragraphs then sentences, and every chunk stays bounded", () => {
  const max = 400;
  const src = `# Big\n\n${Array.from({ length: 8 }, (_, i) => paragraph(i)).join("\n\n")}`;
  const chunks = core.chunkSource(src, max);
  assert.ok(chunks.length > 1);
  assert.ok(chunks.every((c) => c.content.length <= max), "no chunk may exceed maxChunkSize");
  assert.ok(chunks.every((c) => c.headingPath.length === 1 && c.headingPath[0] === "Big"));
  // nothing was dropped: every sentence survives somewhere, in order
  const rejoined = chunks.map((c) => c.content).join("\n\n");
  for (let i = 0; i < 8; i++) assert.ok(rejoined.includes(`Sentence number ${i} says`), `paragraph ${i} survived`);
});

test("a headingless source splits at paragraph/sentence boundaries with an empty headingPath", () => {
  const max = 350;
  const src = Array.from({ length: 6 }, (_, i) => paragraph(i)).join("\n\n");
  const chunks = core.chunkSource(src, max);
  assert.ok(chunks.length > 1);
  assert.ok(chunks.every((c) => c.headingPath.length === 0));
  assert.ok(chunks.every((c) => c.content.length <= max));
});

test("a single sentence longer than the bound is hard-cut rather than returned over-size", () => {
  const chunks = core.chunkSource("x".repeat(1000), 300);
  assert.equal(chunks.length, 4);
  assert.ok(chunks.every((c) => c.content.length <= 300));
});

test("a bad or missing maxChunkSize falls back to the 32000 default", () => {
  assert.equal(core.DEFAULT_MAX_CHUNK_SIZE, 32000);
  const src = "y".repeat(40000);
  for (const bad of [undefined, null, 0, -5, Number.NaN, "big"]) {
    const chunks = core.chunkSource(src, bad);
    assert.ok(chunks.every((c) => c.content.length <= 32000), `fallback for ${String(bad)}`);
  }
});

test("seven hashes is not a heading", () => {
  const src = `####### not a heading\n\n${paragraph(1, 6)}\n\n####### still not\n\n${paragraph(2, 6)}`;
  const chunks = core.chunkSource(src, 250);
  assert.ok(chunks.every((c) => c.headingPath.length === 0));
});

// ── the I/O half ─────────────────────────────────────────────────────────

test("writeChunks writes .chunks/<docId>/NNN.md with chunk/total/headingPath frontmatter, and clears before rewriting", async (t) => {
  const fs = await startMemFs();
  const previousPort = process.env.PORT;
  process.env.PORT = String(fs.port);
  t.after(async () => {
    if (previousPort === undefined) delete process.env.PORT;
    else process.env.PORT = previousPort;
    await fs.close();
  });

  const bDir = "/KB/demo";
  const chunks = core.chunkSource(
    `## Alpha\n\n${paragraph(1, 5)}\n\n## Beta\n\n${paragraph(2, 5)}\n\n## Gamma\n\n${paragraph(3, 5)}\n`,
    340,
  );
  const written = await core.writeChunks(bDir, "demo-doc", chunks);

  assert.deepEqual(
    written.map((w) => w.path),
    [".chunks/demo-doc/001.md", ".chunks/demo-doc/002.md", ".chunks/demo-doc/003.md"],
  );
  assert.deepEqual(written.map((w) => w.ordinal), [1, 2, 3]);
  assert.ok(written.every((w) => w.total === 3));

  const second = core.parseFrontmatter(fs.read("/KB/demo/.chunks/demo-doc/002.md"));
  assert.equal(second.frontmatter.chunk, 2);
  assert.equal(second.frontmatter.total, 3);
  assert.deepEqual(second.frontmatter.headingPath, ["Beta"]);
  assert.ok(second.body.includes("Sentence number 2"));

  // clear-then-rewrite: .chunks/ is a derived cache, not append-only raw/
  await core.writeChunks(bDir, "demo-doc", core.chunkSource("# Only one now\n\nShort.\n", 32000));
  assert.ok(fs.read("/KB/demo/.chunks/demo-doc/001.md"), "the new split is there");
  assert.equal(fs.read("/KB/demo/.chunks/demo-doc/002.md"), undefined, "the stale tail of the old split is gone");
  assert.equal(fs.read("/KB/demo/.chunks/demo-doc/003.md"), undefined);
});

test("okf_add_raw_source registers into raw/ AND returns the chunk paths; .chunks/ stays out of the export", async (t) => {
  const fs = await startMemFs();
  const previousPort = process.env.PORT;
  process.env.PORT = String(fs.port);
  t.after(async () => {
    if (previousPort === undefined) delete process.env.PORT;
    else process.env.PORT = previousPort;
    await fs.close();
  });

  const root = "/KB";
  await core.initBundle(root, "chunky");

  const big =
    `# Handbook\n\n${paragraph(0, 10)}\n\n` +
    `## Rules\n\n${paragraph(1, 10)}\n\n` +
    `## Exceptions\n\n${paragraph(2, 10)}\n`;
  const res = await core.addRawSource(root, "chunky", { filename: "handbook.md", content: big, maxChunkSize: 400 });

  assert.equal(res.rawFile, "raw/handbook.md");
  assert.equal(res.docId, "handbook");
  assert.equal(res.maxChunkSize, 400);
  assert.ok(res.chunks.length > 1, "a source over the bound is split");
  assert.ok(res.chunks.every((c) => c.total === res.chunks.length));
  assert.deepEqual(res.chunks.map((c) => c.ordinal), res.chunks.map((_, i) => i + 1));
  for (const c of res.chunks) {
    const parsed = core.parseFrontmatter(fs.read(`/KB/chunky/${c.path}`));
    assert.ok(parsed, `${c.path} exists on disk`);
    assert.equal(parsed.frontmatter.chunk, c.ordinal);
    assert.ok(parsed.body.length <= 400, `${c.path} is within the bound`);
  }
  // raw/ still holds the source byte-exact — the chunks are derived staging
  assert.equal(fs.read("/KB/chunky/raw/handbook.md"), big);

  const exported = await core.exportBundle(root, "chunky");
  assert.equal(
    exported.files.filter((f) => f.path.startsWith(".chunks/")).length,
    0,
    ".chunks/ is operational and must not be exported",
  );
  assert.ok(exported.files.some((f) => f.path === "raw/handbook.md"), "raw/ IS exported");
});

test("a source within maxChunkSize comes back as exactly one chunk — the unchanged path", async (t) => {
  const fs = await startMemFs();
  const previousPort = process.env.PORT;
  process.env.PORT = String(fs.port);
  t.after(async () => {
    if (previousPort === undefined) delete process.env.PORT;
    else process.env.PORT = previousPort;
    await fs.close();
  });

  await core.initBundle("/KB", "small");
  const res = await core.addRawSource("/KB", "small", { filename: "note.md", content: "# Note\n\nTiny.\n" });
  assert.equal(res.chunks.length, 1);
  assert.equal(res.chunks[0].total, 1);
  assert.equal(res.chunks[0].ordinal, 1);
  assert.equal(res.chunks[0].path, ".chunks/note/001.md");
  assert.equal(res.maxChunkSize, 32000);
  // and the pre-chunking contract is untouched
  assert.equal(res.stored, true);
  assert.equal(res.rawFile, "raw/note.md");
  assert.equal(res.concept, null);
});
