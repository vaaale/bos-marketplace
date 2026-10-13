// chapter-from-source-range.test.mjs — the body-extraction write protocol
// (FR-060 / SC-019, ADR-014 Part A, tasks W4 + X2 + AA7).
//
// THE INVARIANT UNDER TEST: a chapter body the service assembled, with the
// inserted interpretation lines removed, is BYTE-FOR-BYTE a contiguous slice
// of `raw/<source>.md`. Everything else here exists to pin the three things
// that could break it — which slice gets taken (the end rules), what gets
// inserted into it (the three interpretation placements), and what happens
// when the heading map no longer describes the bytes (it must throw, not
// mis-slice silently).
//
// Offline: the pure functions directly, and the I/O half against the
// in-memory /api/fs stand-in (tests/memfs-server.mjs). No service, no BOS.
//
//   node --test tests/chapter-from-source-range.test.mjs

import test from "node:test";
import assert from "node:assert/strict";
import { createRequire } from "node:module";
import { startMemFs } from "./memfs-server.mjs";

const require = createRequire(import.meta.url);
const core = require("../services/lib/okf-core.js");

const ASSET_LINE = "![Canary console](https://cdn.example.com/media/canary%20run.mp4)";
const STORED_ASSET = "canary-20run.mp4"; // assetFileName() sanitizes `%` the same way addRawAsset does

/** A source with a preamble, nested levels, an inline asset and a tail. */
const SOURCE =
  "Preamble before any heading at all.\n" +
  "\n" +
  "# Handbook\n" +
  "\n" +
  "Introduction under the title.\n" +
  "\n" +
  "## Alpha\n" +
  "\n" +
  "Alpha content.\n" +
  "\n" +
  "### Alpha detail\n" +
  "\n" +
  "A nested subsection that belongs to Alpha.\n" +
  "\n" +
  "## Beta\n" +
  "\n" +
  "Beta opens with an asset:\n" +
  "\n" +
  `${ASSET_LINE}\n` +
  "\n" +
  "and keeps going afterwards.\n" +
  "\n" +
  "## Gamma\n" +
  "\n" +
  "Gamma is the last section.\n";

// index: 0 "# Handbook"(1) 1 "## Alpha"(2) 2 "### Alpha detail"(3)
//        3 "## Beta"(2)    4 "## Gamma"(2)

async function withMemFs(t) {
  const fs = await startMemFs();
  const previousPort = process.env.PORT;
  process.env.PORT = String(fs.port);
  t.after(async () => {
    if (previousPort === undefined) delete process.env.PORT;
    else process.env.PORT = previousPort;
    await fs.close();
  });
  return fs;
}

/** Register SOURCE as `raw/guide.md` in a fresh bundle → docId "guide". */
async function seedBundle(t, { content = SOURCE, maxChunkSize } = {}) {
  const fs = await withMemFs(t);
  const root = "/KB";
  await core.initBundle(root, "kb");
  const res = await core.addRawSource(root, "kb", { filename: "guide.md", content, maxChunkSize });
  return { fs, root, bundle: "kb", docId: res.docId, bDir: "/KB/kb", content, res };
}

// ── buildHeadingMap: the offsets everything else is built on ─────────────

test("buildHeadingMap records index/level/text/start/end for every heading", () => {
  const { headings, sourceLength } = core.buildHeadingMap(SOURCE);
  assert.equal(sourceLength, SOURCE.length);
  assert.deepEqual(
    headings.map((h) => [h.index, h.level, h.text]),
    [
      [0, 1, "Handbook"],
      [1, 2, "Alpha"],
      [2, 3, "Alpha detail"],
      [3, 2, "Beta"],
      [4, 2, "Gamma"],
    ],
  );
  // every `start` is the offset of that heading's own "#"
  for (const h of headings) {
    assert.equal(SOURCE.slice(h.start, h.start + h.level + 1), `${"#".repeat(h.level)} `);
  }
  // `end` chains: the next heading's start, sourceLength for the last
  for (let i = 0; i < headings.length - 1; i++) assert.equal(headings[i].end, headings[i + 1].start);
  assert.equal(headings[headings.length - 1].end, SOURCE.length);
});

test("a source with no headings has an empty map and its full length", () => {
  const plain = "Just prose.\n\nNo headings anywhere.\n";
  const map = core.buildHeadingMap(plain);
  assert.deepEqual(map.headings, []);
  assert.equal(map.sourceLength, plain.length);
});

// ── chunkSource: the global indices the agent gets to reference ──────────

test("each chunk carries its in-chunk heading indices PLUS the boundary heading", () => {
  const chunks = core.chunkSource(SOURCE, 80);
  assert.ok(chunks.length > 1, "the fixture must actually split");
  // Every referenced index is a real heading, and every chunk that has a
  // following heading can name it (so a toHeading merge is always possible).
  const { headings } = core.buildHeadingMap(SOURCE);
  for (const c of chunks) {
    assert.ok(Array.isArray(c.headings));
    for (const i of c.headings) assert.ok(i >= 0 && i < headings.length, `index ${i} is a real heading`);
  }
  // The chunk holding "## Alpha" names Alpha (1) and its boundary (2).
  const alpha = chunks.find((c) => c.content.startsWith("## Alpha"));
  assert.deepEqual(alpha.headings, [1, 2]);
  // The last section's chunk has no boundary heading to offer.
  const gamma = chunks.find((c) => c.content.startsWith("## Gamma"));
  assert.deepEqual(gamma.headings, [4]);
  // The headingless preamble names only the boundary.
  assert.deepEqual(chunks[0].headings, [0]);
});

test("okf_add_raw_source writes headings.json beside the chunks, pointing at raw/", async (t) => {
  const { fs, bDir, docId } = await seedBundle(t, { maxChunkSize: 90 });
  const map = JSON.parse(fs.read(`${bDir}/.chunks/${docId}/headings.json`));
  assert.equal(map.sourceFile, "raw/guide.md");
  assert.equal(map.sourceLength, SOURCE.length);
  assert.equal(map.headings.length, 5);
  assert.deepEqual(map.headings[3], core.buildHeadingMap(SOURCE).headings[3]);
  // and the per-chunk frontmatter carries the global indices
  const first = core.parseFrontmatter(fs.read(`${bDir}/.chunks/${docId}/001.md`));
  assert.ok(Array.isArray(first.frontmatter.headings));
});

test("re-registering a changed source replaces the heading map in the same window", async (t) => {
  const { fs, root, bDir } = await seedBundle(t, { maxChunkSize: 90 });
  // a second registration of the SAME doc id (shorter source, fewer headings)
  await core.writeChunks(bDir, "guide", core.chunkSource("# Only\n\nShort.\n", 32000), {
    sourceFile: "raw/guide.md",
    ...core.buildHeadingMap("# Only\n\nShort.\n"),
  });
  const map = JSON.parse(fs.read(`${bDir}/.chunks/guide/headings.json`));
  assert.equal(map.headings.length, 1, "the old 5-heading map is gone, not merged");
  assert.equal(root, "/KB");
});

// ── the end rules: WHICH slice (W4 c/d/e/f) ──────────────────────────────

test("nextSameOrHigher (the default) runs to the next same-or-higher heading, swallowing deeper ones", async (t) => {
  const { bDir, docId } = await seedBundle(t);
  const { headings } = core.buildHeadingMap(SOURCE);
  const got = await core.chapterFromSourceRange(bDir, docId, { startHeading: 1 }, [], undefined);

  const expected = SOURCE.slice(headings[1].start, headings[3].start);
  assert.equal(got.body, expected, "byte-identical to the raw/ slice");
  assert.ok(got.body.startsWith("## Alpha"), "the chapter's own heading line is part of the slice");
  assert.ok(got.body.includes("### Alpha detail"), "a DEEPER heading stays inside the chapter");
  assert.ok(!got.body.includes("## Beta"), "the next same-level heading ends it");
  assert.equal(got.sourceFile, "raw/guide.md");
});

test("the last heading runs to the end of the source", async (t) => {
  const { bDir, docId } = await seedBundle(t);
  const { headings } = core.buildHeadingMap(SOURCE);
  const got = await core.chapterFromSourceRange(bDir, docId, { startHeading: 4 }, [], undefined);
  assert.equal(got.body, SOURCE.slice(headings[4].start));
  assert.equal(got.end, SOURCE.length);
});

test("toHeading merges two sections into one chapter — the slice spans both", async (t) => {
  const { bDir, docId } = await seedBundle(t);
  const { headings } = core.buildHeadingMap(SOURCE);
  const got = await core.chapterFromSourceRange(bDir, docId, { startHeading: 1, toHeading: 4 }, [], undefined);

  assert.equal(got.body, SOURCE.slice(headings[1].start, headings[4].start));
  assert.ok(got.body.includes("## Alpha") && got.body.includes("## Beta"), "both sections are in the one chapter");
  assert.ok(!got.body.includes("## Gamma"), "toHeading is exclusive");
});

test("ADR-014's nested endRule spelling means the same thing as the flat one", async (t) => {
  const { bDir, docId } = await seedBundle(t);
  const flat = await core.chapterFromSourceRange(bDir, docId, { startHeading: 1, toHeading: 4 }, [], undefined);
  const nested = await core.chapterFromSourceRange(bDir, docId, { startHeading: 1, endRule: { toHeading: 4 } }, [], undefined);
  assert.equal(nested.body, flat.body);
});

test("whole:true takes the entire source (the no-heading / single-chapter case)", async (t) => {
  const { bDir, docId } = await seedBundle(t);
  const got = await core.chapterFromSourceRange(bDir, docId, { whole: true }, [], undefined);
  assert.equal(got.body, SOURCE);

  // and for a source that genuinely has no headings at all
  const plain = "No headings here.\n\nJust two paragraphs.\n";
  const second = await seedBundle(t, { content: plain });
  const whole = await core.chapterFromSourceRange(second.bDir, second.docId, { whole: true }, [], undefined);
  assert.equal(whole.body, plain);
});

test("startHeading:-1 is the headingless preamble before the first heading", async (t) => {
  const { bDir, docId } = await seedBundle(t);
  const { headings } = core.buildHeadingMap(SOURCE);
  const got = await core.chapterFromSourceRange(bDir, docId, { startHeading: -1 }, [], undefined);
  assert.equal(got.body, SOURCE.slice(0, headings[0].start));
  assert.equal(got.body, "Preamble before any heading at all.\n\n");
});

test("a section split across chunk boundaries is still ONE contiguous slice of raw/", async (t) => {
  // maxChunkSize small enough that "## Beta" spans several chunk files.
  const { bDir, docId, fs } = await seedBundle(t, { maxChunkSize: 60 });
  const { headings } = core.buildHeadingMap(SOURCE);
  const betaChunks = ["001", "002", "003", "004", "005", "006", "007", "008"]
    .map((n) => fs.read(`${bDir}/.chunks/${docId}/${n}.md`))
    .filter(Boolean)
    .filter((raw) => (core.parseFrontmatter(raw).frontmatter.headingPath || []).includes("Beta"));
  assert.ok(betaChunks.length > 1, "the fixture must split Beta across chunks");

  const got = await core.chapterFromSourceRange(bDir, docId, { startHeading: 3 }, [], undefined);
  assert.equal(got.body, SOURCE.slice(headings[3].start, headings[4].start));
});

// ── resolveSourceSlice: the pure arithmetic, including its refusals ──────

test("resolveSourceSlice refuses a range it cannot honour rather than guessing", () => {
  const { headings, sourceLength } = core.buildHeadingMap(SOURCE);
  assert.throws(() => core.resolveSourceSlice({}, headings, sourceLength), /startHeading/);
  assert.throws(() => core.resolveSourceSlice({ startHeading: 99 }, headings, sourceLength), /out of range/);
  assert.throws(() => core.resolveSourceSlice({ startHeading: 3, toHeading: 2 }, headings, sourceLength), /must be a later heading/);
  // toHeading === headings.length is the legal "to the end" spelling
  assert.deepEqual(core.resolveSourceSlice({ startHeading: 4, toHeading: 5 }, headings, sourceLength), {
    start: headings[4].start,
    end: sourceLength,
  });
});

// ── the interpretations: three placements, one invariant (W4 g) ──────────

test("an interpretation is inserted beneath its asset line — and the body strips back to the verbatim slice", async (t) => {
  const { bDir, docId } = await seedBundle(t);
  const { headings } = core.buildHeadingMap(SOURCE);
  const slice = SOURCE.slice(headings[3].start, headings[4].start);

  const got = await core.chapterFromSourceRange(
    bDir,
    docId,
    { startHeading: 3 },
    [{ assetLine: ASSET_LINE, interpretation: "A console showing a canary rollout at 5% traffic." }],
    undefined,
  );

  assert.deepEqual(got.placements, [{ assetLine: ASSET_LINE, placement: "exact", line: got.placements[0].line }]);
  const lines = got.body.split("\n");
  const at = lines.findIndex((l) => l === ASSET_LINE);
  assert.ok(at >= 0, "the SOURCE asset line is still there, byte-exact");
  // the stored local copy is linked, then the interpretation blockquote
  assert.equal(lines[at + 1], `![Canary console](raw/assets/${docId}/${STORED_ASSET}) ${core.INTERPRETATION_ASSET_MARK}`);
  assert.equal(lines[at + 2], `${core.INTERPRETATION_PREFIX} A console showing a canary rollout at 5% traffic.`);

  // SC-019 — the whole point
  assert.equal(core.stripInterpretations(got.body), slice);
});

test("a stored local asset line gets the blockquote only — no duplicate link", async (t) => {
  const localSource = `# Doc\n\n![Shot](raw/assets/doc/shot.png)\n\nText.\n`;
  const { bDir, docId } = await seedBundle(t, { content: localSource });
  const got = await core.chapterFromSourceRange(
    bDir,
    docId,
    { whole: true },
    [{ assetLine: "![Shot](raw/assets/doc/shot.png)", interpretation: "A screenshot." }],
    undefined,
  );
  assert.equal(got.body.split("raw/assets/doc/shot.png").length - 1, 1, "the link is not duplicated");
  assert.equal(core.stripInterpretations(got.body), localSource);
});

test("fallback 1 — a drifted assetLine still lands by FILENAME, and the slice survives", async (t) => {
  const { bDir, docId } = await seedBundle(t);
  const { headings } = core.buildHeadingMap(SOURCE);
  const slice = SOURCE.slice(headings[3].start, headings[4].start);

  const got = await core.chapterFromSourceRange(
    bDir,
    docId,
    { startHeading: 3 },
    // caption drift: the agent re-typed the caption, the URL filename holds
    [{ assetLine: "![Canary rollout console](https://cdn.example.com/media/canary%20run.mp4 )", interpretation: "Rollout at 5%." }],
    undefined,
  );
  assert.equal(got.placements[0].placement, "filename");
  assert.ok(got.body.includes(`${core.INTERPRETATION_PREFIX} Rollout at 5%.`));
  assert.equal(core.stripInterpretations(got.body), slice);
});

test("fallback 2 — an unmatchable assetLine is appended behind a marker, and the slice STILL survives", async (t) => {
  const { bDir, docId } = await seedBundle(t);
  const { headings } = core.buildHeadingMap(SOURCE);
  const slice = SOURCE.slice(headings[1].start, headings[3].start);

  const got = await core.chapterFromSourceRange(
    bDir,
    docId,
    { startHeading: 1 }, // Alpha — has no asset at all
    [{ assetLine: "![Nowhere](https://cdn.example.com/missing.png)", interpretation: "Not in this chapter." }],
    undefined,
  );
  assert.equal(got.placements[0].placement, "appended");
  assert.ok(/<!-- interpretation: .*missing\.png.* -->/.test(got.body), "the marker okf_lint can flag is there");
  assert.ok(got.body.includes(`${core.INTERPRETATION_PREFIX} Not in this chapter.`));
  assert.equal(core.stripInterpretations(got.body), slice, "appending authored text is still removable");
});

test("several interpretations in one chapter all land, and the slice survives all of them", async (t) => {
  const multi =
    "# Doc\n\n![One](https://x.test/one.png)\n\nmiddle\n\n![Two](https://x.test/two.png)\n\nend\n";
  const { bDir, docId } = await seedBundle(t, { content: multi });
  const got = await core.chapterFromSourceRange(
    bDir,
    docId,
    { whole: true },
    [
      { assetLine: "![One](https://x.test/one.png)", interpretation: "The first." },
      { assetLine: "![Two](https://x.test/two.png)", interpretation: "The second." },
    ],
    undefined,
  );
  assert.equal(got.placements.map((p) => p.placement).join(","), "exact,exact");
  assert.equal(core.stripInterpretations(got.body), multi);
});

// ── fail loud, never mis-slice (W4 h) ───────────────────────────────────

test("a missing heading map throws — it does not fall back to a guess", async (t) => {
  const { bDir } = await seedBundle(t);
  await assert.rejects(
    () => core.chapterFromSourceRange(bDir, "no-such-doc", { whole: true }, [], undefined),
    /no heading map at \.chunks\/no-such-doc\/headings\.json/,
  );
});

test("a heading map that disagrees with raw/'s LENGTH throws", async (t) => {
  const { fs, bDir, docId } = await seedBundle(t);
  fs.write(`${bDir}/raw/guide.md`, `${SOURCE}appended after the map was built\n`);
  await assert.rejects(
    () => core.chapterFromSourceRange(bDir, docId, { startHeading: 1 }, [], undefined),
    /heading map drift: .*was built for a \d+-char raw\/guide\.md, which is now \d+ chars/,
  );
});

test("a heading map that disagrees with raw/'s HEADING COUNT throws, even at the same length", async (t) => {
  const { fs, bDir, docId } = await seedBundle(t);
  // "## Gamma" -> "Gamma ##": same byte length, one heading fewer.
  const tampered = SOURCE.replace("## Gamma", "Gamma ##");
  assert.equal(tampered.length, SOURCE.length, "the fixture must keep the length identical");
  fs.write(`${bDir}/raw/guide.md`, tampered);
  await assert.rejects(
    () => core.chapterFromSourceRange(bDir, docId, { startHeading: 1 }, [], undefined),
    /heading map drift: .*records 5 heading\(s\), raw\/guide\.md has 4/,
  );
});

test("okf_lint reports heading-map drift instead of leaving it for the next write", async (t) => {
  const { fs, root, bundle, bDir } = await seedBundle(t);
  fs.write(`${bDir}/raw/guide.md`, `${SOURCE}drifted\n`);
  const lint = await core.lintBundle(root, bundle);
  assert.equal(lint.checks.headingMapDrift, 1);
  assert.ok(lint.warnings.some((w) => w.check === "heading-map" && /drift/.test(w.issue)));
});

test("a document with chunks but no heading map is NOT reported as drift (the pre-ADR-014 state)", async (t) => {
  const { fs, root, bundle, bDir, docId } = await seedBundle(t);
  fs.remove(`${bDir}/.chunks/${docId}/headings.json`);
  const lint = await core.lintBundle(root, bundle);
  assert.equal(lint.checks.headingMapDrift, 0);
});

// ── X2: the tool-level precedence, end to end ───────────────────────────

test("upsertConcept with sourceRange writes the EXTRACTED body; with body, the body as given", async (t) => {
  const { fs, root, bundle, bDir, docId } = await seedBundle(t);
  const { headings } = core.buildHeadingMap(SOURCE);

  await core.upsertConcept(root, bundle, docId, { title: "Handbook", frontmatter: { type: "document" } });
  const written = await core.upsertConcept(root, bundle, `${docId}/alpha`, {
    sourceRange: { startHeading: 1 },
    interpretations: [],
    frontmatter: { type: "section", parent: docId, concepts: ["alpha"], summary: "The alpha section.", person_terms: ["Ada Lovelace"] },
  });

  const stored = core.parseFrontmatter(fs.read(`${bDir}/concepts/${docId}/alpha.md`));
  assert.equal(stored.body, SOURCE.slice(headings[1].start, headings[3].start));
  assert.equal(stored.frontmatter.summary, "The alpha section.");
  assert.deepEqual(stored.frontmatter.person_terms, ["Ada Lovelace"], "the person-kind frontmatter rides through untouched");
  assert.equal(written.extraction.sourceFile, "raw/guide.md");
  assert.equal(written.extraction.chars, headings[3].start - headings[1].start);

  // the original path is untouched: no sourceRange -> body exactly as given
  await core.upsertConcept(root, bundle, `${docId}/authored`, {
    body: "# Authored\n\nTyped by hand.\n",
    frontmatter: { type: "section", parent: docId, concepts: ["x"], summary: "s" },
  });
  const authored = core.parseFrontmatter(fs.read(`${bDir}/concepts/${docId}/authored.md`));
  assert.equal(authored.body, "# Authored\n\nTyped by hand.\n");
});

test("sourceRange WINS over a body passed alongside it", async (t) => {
  const { fs, root, bundle, bDir, docId } = await seedBundle(t);
  const { headings } = core.buildHeadingMap(SOURCE);
  await core.upsertConcept(root, bundle, `${docId}/beta`, {
    body: "## Beta\n\nA re-typed, drifted copy of the source.\n",
    sourceRange: { startHeading: 3 },
    frontmatter: { type: "section", parent: docId, concepts: ["beta"], summary: "s" },
  });
  const stored = core.parseFrontmatter(fs.read(`${bDir}/concepts/${docId}/beta.md`));
  assert.equal(stored.body, SOURCE.slice(headings[3].start, headings[4].start));
  assert.ok(!stored.body.includes("re-typed"), "the extracted body replaced the passed one");
});

test("an unresolvable sourceRange fails the write rather than silently falling back to `body`", async (t) => {
  const { root, bundle, docId } = await seedBundle(t);
  await assert.rejects(
    () =>
      core.upsertConcept(root, bundle, `${docId}/bad`, {
        body: "a body that must NOT be written",
        sourceRange: { startHeading: 42 },
        frontmatter: { type: "section", parent: docId },
      }),
    /out of range/,
  );
});
