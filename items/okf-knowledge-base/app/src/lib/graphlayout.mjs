// graphlayout.mjs — the Query graph's layout: the ONE layout the app runs and
// the tests prove (spec FR-073, SC-024; design.md ADR-022).
//
// Plain JS with no DOM and no React, like mdparse.mjs, so tests/graph-layout
// .test.mjs runs it under `node --test`. The app imports it through esbuild
// and drives `step` across animation frames; types: graphlayout.d.mts.
//
// What makes it legible (the mockup's graph is the binding behaviour):
//   • seeded by STRUCTURE — documents on a wide ring, each chapter on a small
//     ring around its own document, each term at the centroid of the chapters
//     it covers — so the simulation refines a sensible layout rather than
//     untangling three category rings;
//   • a spring rest length per edge KIND (a chapter close to its document, a
//     term further out), weak centering, cooling over the ticks;
//   • a COLLISION pass every tick, and to finish, so no two circles overlap.
//
// Node ids are the namespaced keys core.graph() emits (`doc:…`, `chap:…`,
// `concept:…`, `person:…`): a document and a term with the same name are two
// nodes (FR-073(f)).

export const L = {
  k: 12000, // node-node repulsion
  rest: { containment: 70, coverage: 150, link: 130 },
  spring: 0.03,
  center: 0.004,
  damp: 0.82,
  maxV: 14,
  ticks: 420,
  pad: 22, // minimum gap between two circles
  labelGap: 22, // room for a label under a node
  labelZoom: 1.25, // non-document labels show from this zoom up
  fitMargin: 48,
  kMin: 0.2,
  kMax: 3,
};

export function nodeRadius(n) {
  if (n.type === "doc") return 22;
  if (n.type === "concept" || n.type === "person") return 14 + Math.min(9, (n.count || 1) * 2.2);
  return 15;
}

/** A small seeded PRNG, so the same graph always lays out the same way. */
function prng(seed) {
  let a = seed >>> 0;
  return () => {
    a = (a + 0x6d2b79f5) >>> 0;
    let t = a;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

/**
 * Seed a simulation for `nodes`/`edges` on a stage of `width` x `height`.
 * Edges whose ends are not both nodes are dropped.
 */
export function buildLayout(nodes, edges, { width = 800, height = 600 } = {}) {
  const rand = prng(nodes.length * 7919 + edges.length);
  const center = { x: width / 2, y: height / 2 };
  const ids = new Set(nodes.map((n) => n.id));
  const kept = edges.filter((e) => ids.has(e.from) && ids.has(e.to));
  const R = Math.max(160, Math.sqrt(nodes.length) * 46);
  const pos = new Map();

  const docs = nodes.filter((n) => n.type === "doc");
  docs.forEach((d, i) => {
    const a = (i / Math.max(1, docs.length)) * Math.PI * 2;
    pos.set(d.id, { x: center.x + Math.cos(a) * R, y: center.y + Math.sin(a) * R });
  });
  const chaptersOf = new Map();
  for (const e of kept) {
    if (e.kind !== "containment") continue;
    if (!chaptersOf.has(e.from)) chaptersOf.set(e.from, []);
    chaptersOf.get(e.from).push(e.to);
  }
  for (const [docId, chapters] of chaptersOf) {
    const p0 = pos.get(docId) || center;
    chapters.forEach((id, i) => {
      const a = (i / chapters.length) * Math.PI * 2;
      pos.set(id, { x: p0.x + Math.cos(a) * 80, y: p0.y + Math.sin(a) * 80 });
    });
  }
  const coveredBy = new Map();
  for (const e of kept) {
    if (e.kind !== "coverage") continue;
    if (!coveredBy.has(e.to)) coveredBy.set(e.to, []);
    coveredBy.get(e.to).push(e.from);
  }
  for (const n of nodes) {
    if (pos.has(n.id)) continue;
    const ps = (coveredBy.get(n.id) || []).map((id) => pos.get(id)).filter(Boolean);
    const x = ps.length ? ps.reduce((s, p) => s + p.x, 0) / ps.length : center.x;
    const y = ps.length ? ps.reduce((s, p) => s + p.y, 0) / ps.length : center.y;
    pos.set(n.id, { x: x + (center.x - x) * 0.15, y: y + (center.y - y) * 0.15 });
  }

  const simNodes = nodes.map((n) => {
    const p = pos.get(n.id) || center;
    return { ...n, r: nodeRadius(n), x: p.x + (rand() - 0.5) * 8, y: p.y + (rand() - 0.5) * 8, vx: 0, vy: 0, fixed: false, fx: null, fy: null };
  });
  const byId = {};
  for (const n of simNodes) byId[n.id] = n;
  const nbr = new Map(simNodes.map((n) => [n.id, new Set([n.id])]));
  for (const e of kept) {
    nbr.get(e.from).add(e.to);
    nbr.get(e.to).add(e.from);
  }
  return { nodes: simNodes, byId, edges: kept, nbr, center, rand, tick: 0 };
}

/** Push apart every pair of circles closer than r_a + r_b + pad. Returns
 *  whether anything moved. */
function collide(sim) {
  const ns = sim.nodes;
  let moved = false;
  for (let i = 0; i < ns.length; i++) {
    for (let j = i + 1; j < ns.length; j++) {
      const a = ns[i];
      const b = ns[j];
      let dx = b.x - a.x;
      let dy = b.y - a.y;
      let d = Math.hypot(dx, dy);
      if (d < 0.01) {
        dx = sim.rand() - 0.5;
        dy = sim.rand() - 0.5;
        d = Math.hypot(dx, dy) || 0.01;
      }
      const min = a.r + b.r + L.pad;
      if (d >= min) continue;
      const push = (min - d) / (a.fixed || b.fixed ? 1 : 2);
      const ux = dx / d;
      const uy = dy / d;
      if (!a.fixed) {
        a.x -= ux * push;
        a.y -= uy * push;
      }
      if (!b.fixed) {
        b.x += ux * push;
        b.y += uy * push;
      }
      moved = true;
    }
  }
  return moved;
}

/** One tick at strength `alpha` (1 hot … ~0 cool). O(N²). */
export function step(sim, alpha = 0.3) {
  const ns = sim.nodes;
  if (!ns.length) return;
  for (let i = 0; i < ns.length; i++) {
    const a = ns[i];
    let fx = 0;
    let fy = 0;
    for (let j = 0; j < ns.length; j++) {
      if (i === j) continue;
      const b = ns[j];
      let dx = a.x - b.x;
      let dy = a.y - b.y;
      let d2 = dx * dx + dy * dy;
      if (d2 < 0.01) {
        dx = sim.rand() - 0.5;
        dy = sim.rand() - 0.5;
        d2 = dx * dx + dy * dy + 0.01;
      }
      const f = L.k / d2;
      const d = Math.sqrt(d2);
      fx += (f * dx) / d;
      fy += (f * dy) / d;
    }
    a._fx = fx;
    a._fy = fy;
  }
  for (const e of sim.edges) {
    const a = sim.byId[e.from];
    const b = sim.byId[e.to];
    const dx = b.x - a.x;
    const dy = b.y - a.y;
    const d = Math.max(1, Math.hypot(dx, dy));
    const f = (d - (L.rest[e.kind] || 120)) * L.spring;
    const ux = dx / d;
    const uy = dy / d;
    a._fx += f * ux;
    a._fy += f * uy;
    b._fx -= f * ux;
    b._fy -= f * uy;
  }
  for (const n of ns) {
    n._fx -= (n.x - sim.center.x) * L.center;
    n._fy -= (n.y - sim.center.y) * L.center;
    if (n.fixed) {
      n.x = n.fx;
      n.y = n.fy;
      n.vx = 0;
      n.vy = 0;
      continue;
    }
    n.vx = (n.vx + n._fx * alpha) * L.damp;
    n.vy = (n.vy + n._fy * alpha) * L.damp;
    const sp = Math.hypot(n.vx, n.vy);
    if (sp > L.maxV) {
      n.vx *= L.maxV / sp;
      n.vy *= L.maxV / sp;
    }
    n.x += n.vx;
    n.y += n.vy;
  }
  collide(sim);
  sim.tick++;
}

/** The cooling schedule's alpha at tick `i` of `ticks`. */
export function alphaAt(i, ticks = L.ticks) {
  return 1 - (i / ticks) * 0.95;
}

/** Run the whole schedule, then resolve any remaining overlap. */
export function settle(sim, ticks = L.ticks) {
  for (let i = 0; i < ticks; i++) step(sim, alphaAt(i, ticks));
  finish(sim);
}

/** Collision-only passes until nothing overlaps (bounded). */
export function finish(sim) {
  for (let i = 0; i < 60 && collide(sim); i++);
}

/** The bounding box of the given node ids (all nodes when null), with room
 *  for each node's label below it and to its sides. */
export function fitBox(sim, ids) {
  const ns = ids ? sim.nodes.filter((n) => ids.has(n.id)) : sim.nodes;
  if (!ns.length) return null;
  let x0 = Infinity;
  let y0 = Infinity;
  let x1 = -Infinity;
  let y1 = -Infinity;
  for (const n of ns) {
    x0 = Math.min(x0, n.x - n.r - 40);
    x1 = Math.max(x1, n.x + n.r + 40);
    y0 = Math.min(y0, n.y - n.r);
    y1 = Math.max(y1, n.y + n.r + L.labelGap);
  }
  return { x0, y0, x1, y1 };
}

/** The view {x, y, k} that fits `box` into a `width` x `height` stage. A fit
 *  to a focus (search hits) may zoom in further than a fit to everything. */
export function fitView(box, width, height, { focus = false } = {}) {
  if (!box) return { x: 0, y: 0, k: 1 };
  const k = Math.max(
    L.kMin,
    Math.min(focus ? 1.6 : 1.2, Math.min((width - 2 * L.fitMargin) / (box.x1 - box.x0), (height - 2 * L.fitMargin) / (box.y1 - box.y0))),
  );
  return { k, x: width / 2 - ((box.x0 + box.x1) / 2) * k, y: height / 2 - ((box.y0 + box.y1) / 2) * k };
}

const fold = (s) => String(s || "").normalize("NFKD").replace(/\p{M}+/gu, "").toLowerCase();

/**
 * The nodes a search lights up (FR-073(e)): every hit's chapter (or, for a
 * document-level hit, its document), each hit's document, the term that
 * matched when a term matched (an anchored term is not a match), and
 * documents whose title contains the query. Only ids that are nodes.
 */
export function matchSet(rows, nodes, query) {
  const present = new Set(nodes.map((n) => n.id));
  const ids = new Set();
  for (const r of rows || []) {
    ids.add(`doc:${r.docId}`);
    if (r.chId) ids.add(`chap:${r.docId}/${r.chId}`);
    if (r.matchKind === "term" && r.matchedConcept) ids.add(`concept:${r.matchedConcept}`);
    if (r.matchKind === "person" && r.matchedConcept) ids.add(`person:${String(r.matchedConcept).toLowerCase()}`);
  }
  const q = fold(query).trim();
  if (q) for (const n of nodes) if (n.type === "doc" && fold(n.label).includes(q)) ids.add(n.id);
  return new Set([...ids].filter((id) => present.has(id)));
}
