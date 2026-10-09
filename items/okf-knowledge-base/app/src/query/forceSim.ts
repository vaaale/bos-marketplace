// forceSim.ts — the mockup's dependency-free force simulation, ported
// verbatim in behaviour (ADR-009: no d3-force, no vis.js, no new runtime
// package). Coulomb repulsion + spring attraction along edges + a weak pull
// toward the stage centre, velocity-damped and speed-capped.
//
// Keeping the mockup's exact constants matters: they are what make the
// approved layout look the way it does at the node counts this app renders.

import type { GraphEdge, GraphNode } from "../lib/types";

export const L = {
  k: 5200, // Coulomb constant (node-node repulsion)
  rest: 120, // spring rest length along an edge
  center: 0.02, // centering pull
  damp: 0.8, // velocity damping
  maxV: 9, // per-tick speed cap
  ticks: 150, // settle iterations before the first paint
};

/** O(N²) per tick. Fine for the hundreds-of-nodes case the spec's use cases
 *  imply; above NODE_CAP the view samples instead (design.md Risk #6). */
export const NODE_CAP = 400;

export interface SimNode extends GraphNode {
  x: number;
  y: number;
  vx: number;
  vy: number;
  r: number;
  fixed: boolean;
  fx: number | null;
  fy: number | null;
  _fx?: number;
  _fy?: number;
  el?: SVGGElement | null;
}

export interface SimEdge extends GraphEdge {
  el?: SVGPathElement | null;
  wrap?: SVGGElement | null;
}

export interface Sim {
  nodes: SimNode[];
  byId: Record<string, SimNode>;
  edges: SimEdge[];
  nbr: Map<string, Set<string>>;
  center: { x: number; y: number };
  view: { x: number; y: number; k: number };
}

export function nodeRadius(n: GraphNode): number {
  if (n.type === "doc") return 22;
  if (n.type === "concept") return 14 + Math.min(9, (n.count || 1) * 2.2);
  return 15;
}

/** CSS class for an edge kind — the mockup's contain/cover/link vocabulary. */
export function edgeClass(kind: GraphEdge["kind"]): string {
  return kind === "containment" ? "contain" : kind === "coverage" ? "cover" : "link";
}

/**
 * Seed the layout: each category on its own ring (documents innermost,
 * chapters mid, concept terms outermost), lightly jittered so coincident
 * nodes don't divide by zero on the first tick.
 */
export function buildSim(nodes: GraphNode[], edges: GraphEdge[], width: number, height: number): Sim {
  const center = { x: width / 2, y: height / 2 };
  const baseR = Math.max(120, Math.min(width, height) / 2 - 74);
  const totals = {
    doc: nodes.filter((n) => n.type === "doc").length || 1,
    chap: nodes.filter((n) => n.type === "chap").length || 1,
    concept: nodes.filter((n) => n.type === "concept").length || 1,
  };
  const seen = { doc: 0, chap: 0, concept: 0 };

  const simNodes: SimNode[] = nodes.map((n) => {
    const i = seen[n.type]++;
    const a = (i / totals[n.type]) * Math.PI * 2 + (n.type === "doc" ? 0 : n.type === "chap" ? 1.2 : 2.3);
    const rr = baseR * (n.type === "doc" ? 0.28 : n.type === "chap" ? 0.58 : 0.9);
    return {
      ...n,
      r: nodeRadius(n),
      fixed: false,
      fx: null,
      fy: null,
      vx: 0,
      vy: 0,
      x: center.x + Math.cos(a) * rr + (Math.random() - 0.5) * 10,
      y: center.y + Math.sin(a) * rr * 0.82 + (Math.random() - 0.5) * 10,
    };
  });

  const byId: Record<string, SimNode> = {};
  for (const n of simNodes) byId[n.id] = n;

  const simEdges: SimEdge[] = edges.filter((e) => byId[e.from] && byId[e.to]).map((e) => ({ ...e }));

  const nbr = new Map<string, Set<string>>();
  for (const n of simNodes) nbr.set(n.id, new Set([n.id]));
  for (const e of simEdges) {
    nbr.get(e.from)!.add(e.to);
    nbr.get(e.to)!.add(e.from);
  }

  return { nodes: simNodes, byId, edges: simEdges, nbr, center, view: { x: 0, y: 0, k: 1 } };
}

export function stepGraph(sim: Sim): void {
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
        dx = Math.random() - 0.5;
        dy = Math.random() - 0.5;
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
    const f = (d - L.rest) * 0.02;
    const ux = dx / d;
    const uy = dy / d;
    a._fx! += f * ux;
    a._fy! += f * uy;
    b._fx! -= f * ux;
    b._fy! -= f * uy;
  }

  for (const n of ns) {
    n._fx! -= (n.x - sim.center.x) * L.center;
    n._fy! -= (n.y - sim.center.y) * L.center;
    if (n.fixed) {
      n.x = n.fx!;
      n.y = n.fy!;
      n.vx = 0;
      n.vy = 0;
      continue;
    }
    n.vx = (n.vx + n._fx!) * L.damp;
    n.vy = (n.vy + n._fy!) * L.damp;
    const sp = Math.hypot(n.vx, n.vy);
    if (sp > L.maxV) {
      n.vx *= L.maxV / sp;
      n.vy *= L.maxV / sp;
    }
    n.x += n.vx;
    n.y += n.vy;
  }
}

export function settle(sim: Sim, ticks = L.ticks): void {
  for (let i = 0; i < ticks; i++) stepGraph(sim);
}

/**
 * Cap a very large bundle's graph so the O(N²) sim stays interactive
 * (design.md Risk #6). Documents are always kept (they are the spine);
 * chapters and concept terms are sampled, highest-degree first, so the parts
 * of the graph that carry the most structure survive the cut.
 */
export function capGraph(
  nodes: GraphNode[],
  edges: GraphEdge[],
  cap = NODE_CAP,
): { nodes: GraphNode[]; edges: GraphEdge[]; truncated: number } {
  if (nodes.length <= cap) return { nodes, edges, truncated: 0 };
  const degree = new Map<string, number>();
  for (const e of edges) {
    degree.set(e.from, (degree.get(e.from) || 0) + 1);
    degree.set(e.to, (degree.get(e.to) || 0) + 1);
  }
  const docs = nodes.filter((n) => n.type === "doc");
  const rest = nodes
    .filter((n) => n.type !== "doc")
    .sort((a, b) => (degree.get(b.id) || 0) - (degree.get(a.id) || 0) || a.id.localeCompare(b.id));
  const kept = [...docs, ...rest.slice(0, Math.max(0, cap - docs.length))];
  const keptIds = new Set(kept.map((n) => n.id));
  return {
    nodes: kept,
    edges: edges.filter((e) => keptIds.has(e.from) && keptIds.has(e.to)),
    truncated: nodes.length - kept.length,
  };
}
