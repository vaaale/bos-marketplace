// graph-layout.test.mjs — the Query graph's layout is legible (spec FR-073,
// SC-024; design.md ADR-022). The layout lives in a plain module,
// app/src/lib/graphlayout.mjs, so this runs without a browser.
//
// Before: the layout seeded nodes on three category rings, pulled them hard
// to the centre and had nothing keeping circles apart — so they piled up, and
// every label and edge pill sat on top of the next one.
//
//   node --test tests/graph-layout.test.mjs
import test from "node:test";
import assert from "node:assert/strict";
import { buildLayout, settle, fitBox, matchSet, L } from "../app/src/lib/graphlayout.mjs";

/** A generated graph shaped like a real bundle: documents, their chapters,
 *  terms covering chapters across documents. */
function bundleGraph(docs, chapters, terms) {
  const nodes = [];
  const edges = [];
  for (let d = 0; d < docs; d++) {
    nodes.push({ id: `doc:d${d}`, type: "doc", label: `Document ${d}`, docId: `d${d}` });
    for (let c = 0; c < chapters; c++) {
      const id = `chap:d${d}/c${c}`;
      nodes.push({ id, type: "chap", label: `Chapter ${d}.${c}`, docId: `d${d}`, chId: `c${c}` });
      edges.push({ from: `doc:d${d}`, to: id, kind: "containment" });
      edges.push({ from: id, to: `concept:t${(d * chapters + c) % terms}`, kind: "coverage" });
    }
  }
  for (let t = 0; t < terms; t++) nodes.push({ id: `concept:t${t}`, type: "concept", label: `term ${t}`, term: `t${t}`, count: 3 });
  return { nodes, edges };
}

test("AJ2: after settling no two circles overlap, and a chapter sits by its own document", () => {
  const { nodes, edges } = bundleGraph(40, 7, 80); // 400 nodes, the app's NODE_CAP
  const sim = buildLayout(nodes, edges, { width: 900, height: 600 });
  settle(sim);

  let worst = Infinity;
  for (let i = 0; i < sim.nodes.length; i++) {
    for (let j = i + 1; j < sim.nodes.length; j++) {
      const a = sim.nodes[i];
      const b = sim.nodes[j];
      worst = Math.min(worst, Math.hypot(a.x - b.x, a.y - b.y) - (a.r + b.r));
    }
  }
  assert.ok(worst >= -0.5, `circles overlap by ${(-worst).toFixed(1)}px`);

  const dist = (a, b) => Math.hypot(a.x - b.x, a.y - b.y);
  const chapters = sim.nodes.filter((n) => n.type === "chap");
  const median = (xs) => xs.sort((p, q) => p - q)[Math.floor(xs.length / 2)];
  const toOwn = median(chapters.map((c) => dist(c, sim.byId[`doc:${c.docId}`])));
  const toAny = median(chapters.map((c, i) => dist(c, sim.nodes[(i * 37) % sim.nodes.length])));
  assert.ok(toOwn < toAny / 2, `a chapter's own document is close (${toOwn.toFixed(0)}) vs a random node (${toAny.toFixed(0)})`);
});

test("AJ2: fitBox covers exactly the requested nodes, labels included", () => {
  const { nodes, edges } = bundleGraph(5, 3, 6);
  const sim = buildLayout(nodes, edges, { width: 800, height: 500 });
  settle(sim);
  const some = new Set(["doc:d1", "chap:d1/c0", "concept:t2"]);
  const box = fitBox(sim, some);
  for (const id of some) {
    const n = sim.byId[id];
    assert.ok(n.x - n.r >= box.x0 && n.x + n.r <= box.x1 && n.y - n.r >= box.y0 && n.y + n.r + L.labelGap <= box.y1, id);
  }
  const all = fitBox(sim, null);
  assert.ok(all.x1 - all.x0 > box.x1 - box.x0, "the whole graph's box is larger");
});

test("AJ3: the search match set is the hit chapters, their documents, the matched terms, and documents titled like the query", () => {
  const { nodes } = bundleGraph(4, 2, 4);
  nodes.push({ id: "person:diego córdoba", type: "person", label: "Diego Córdoba", term: "Diego Córdoba" });
  const rows = [
    { docId: "d1", chId: "c0", matchKind: "text", matchedConcept: "t0", kind: "topic" }, // anchored: t0 is NOT a match
    { docId: "d2", chId: "c1", matchKind: "term", matchedConcept: "t3", kind: "topic" },
    { docId: "d3", chId: "", matchKind: "person", matchedConcept: "Diego Córdoba", kind: "person" },
  ];
  const ids = matchSet(rows, nodes, "document 0");
  assert.deepEqual([...ids].sort(), ["chap:d1/c0", "chap:d2/c1", "concept:t3", "doc:d0", "doc:d1", "doc:d2", "doc:d3", "person:diego córdoba"].sort());
});
