// GraphView.tsx — the force-directed knowledge graph (FR-042 / US9 AS1).
//
// Category-coloured circular nodes (document slate / chapter accent-blue /
// concept-term violet / PERSON teal) with typed, DIRECTED, LABELLED edges
// (contains / covers / related), in the BOS dark palette — the mockup's
// graph-database look, rendered from the service's derived
// `GET /bundles/<b>/graph`.
//
// The 4th category (ADR-011) is a colour, not a mechanism: a person node is
// sized, highlighted, dimmed, dragged and opened exactly like a concept-term
// node, and its coverage edge is the same dashed `covers` edge. Only the
// palette and the reader-pane label say "person".
//
// Two implementation notes that are requirements, not choices:
//
//  1. The SVG's viewBox is set from the REAL measured container dimensions
//     and the stage is flex:1 inside .q-content.graph-mode, so the graph
//     FILLS its pane rather than sitting in a fixed box. A ResizeObserver
//     re-lays-out whenever the pane changes size — which is exactly what
//     dragging the reader-pane divider does.
//  2. Node/edge positions are written straight to the DOM, not through React
//     state. Hundreds of settle ticks plus drag-time ticks would otherwise be
//     as many re-renders of every node; React owns the container, the legend
//     and the controls, the simulation owns the <g> transforms.
//
// Legibility (FR-073, ADR-022) — the layout itself is lib/graphlayout.mjs:
//   • the settle runs in animation-frame chunks, then the view FITS the stage;
//   • + / − / fit controls and a status hint;
//   • edge labels only on the hovered node's edges; node labels sit BELOW the
//     node at a constant on-screen size — documents always, everything else
//     when zoomed in, hovered (with its neighbours), selected or matched;
//   • a search fades everything but the hits (their edges too) and zooms to
//     them; clearing it fits the whole graph again.

import React from "react";
import { Icon } from "../lib/icons";
import type { BundleGraph, GraphNode } from "../lib/types";
import { nodeRef } from "./nodeRef";
import { L, alphaAt, buildLayout, capGraph, edgeClass, finish, fitBox, fitView, step, type Sim, type SimNode } from "../lib/graphlayout.mjs";

interface Props {
  graph: BundleGraph;
  /** Node ids (namespaced keys) the shared search matched. null = no query. */
  matches: Set<string> | null;
  selectedId: string | null;
  onSelect: (node: GraphNode) => void;
  /** Bumped by the parent when the reader-pane divider is dragged. */
  resizeToken: number;
}

interface View {
  x: number;
  y: number;
  k: number;
}

interface Painted {
  nodes: Map<string, SVGGElement>;
  edges: { el: SVGPathElement; wrap: SVGGElement }[];
}

/** Settle ticks per animation frame — keeps a 400-node first paint responsive. */
const TICKS_PER_FRAME = 30;

export default function GraphView({ graph, matches, selectedId, onSelect, resizeToken }: Props) {
  const stageRef = React.useRef<HTMLDivElement | null>(null);
  const svgRef = React.useRef<SVGSVGElement | null>(null);
  const simRef = React.useRef<Sim | null>(null);
  const viewRef = React.useRef<View>({ x: 0, y: 0, k: 1 });
  const paintedRef = React.useRef<Painted | null>(null);
  const matchesRef = React.useRef(matches);
  matchesRef.current = matches;
  const onSelectRef = React.useRef(onSelect);
  onSelectRef.current = onSelect;
  const [settled, setSettled] = React.useState(0);

  const capped = React.useMemo(() => capGraph(graph.nodes, graph.edges), [graph]);

  /** Fit the view to the search hits (or to everything) and repaint. */
  const fit = React.useCallback(() => {
    const stage = stageRef.current;
    const svg = svgRef.current;
    const sim = simRef.current;
    if (!stage || !svg || !sim) return;
    const m = matchesRef.current;
    const focus = m && m.size ? m : null;
    viewRef.current = fitView(fitBox(sim, focus), stage.clientWidth, stage.clientHeight, { focus: !!focus });
    applyTransform(svg, viewRef.current);
    if (paintedRef.current) cullLabels(svg, sim, paintedRef.current, viewRef.current);
  }, []);

  const zoomBy = React.useCallback((f: number) => {
    const stage = stageRef.current;
    const svg = svgRef.current;
    if (!stage || !svg) return;
    const v = viewRef.current;
    const cx = stage.clientWidth / 2;
    const cy = stage.clientHeight / 2;
    const k = Math.max(L.kMin, Math.min(L.kMax, v.k * f));
    viewRef.current = { k, x: cx - (cx - v.x) * (k / v.k), y: cy - (cy - v.y) * (k / v.k) };
    applyTransform(svg, viewRef.current);
    if (simRef.current && paintedRef.current) cullLabels(svg, simRef.current, paintedRef.current, viewRef.current);
  }, []);

  // ── layout + paint, settled in animation-frame chunks ──────────────────
  const layout = React.useCallback(() => {
    const stage = stageRef.current;
    const svg = svgRef.current;
    if (!stage || !svg) return () => undefined;
    const W = stage.clientWidth;
    const H = stage.clientHeight;
    if (!W || !H) return () => undefined; // still display:none / mid-mount — the observer retries

    svg.setAttribute("viewBox", `0 0 ${W} ${H}`);
    svg.setAttribute("width", "100%");
    svg.setAttribute("height", "100%");

    const sim = buildLayout(capped.nodes, capped.edges, { width: W, height: H });
    simRef.current = sim;
    paintedRef.current = paintStructure(svg, sim);
    let tick = 0;
    let frame = 0;
    const run = () => {
      for (let i = 0; i < TICKS_PER_FRAME && tick < L.ticks; i++, tick++) step(sim, alphaAt(tick));
      if (tick >= L.ticks) finish(sim);
      draw(sim, paintedRef.current!);
      fit();
      if (tick < L.ticks) frame = requestAnimationFrame(run);
      else setSettled((n) => n + 1);
    };
    frame = requestAnimationFrame(run);
    return () => cancelAnimationFrame(frame);
  }, [capped, fit]);

  React.useEffect(() => {
    let cancel = layout();
    const stage = stageRef.current;
    if (!stage) return cancel;
    let lastW = stage.clientWidth;
    let lastH = stage.clientHeight;
    const obs = new ResizeObserver(() => {
      const w = stage.clientWidth;
      const h = stage.clientHeight;
      if (w === lastW && h === lastH) return;
      lastW = w;
      lastH = h;
      cancel();
      cancel = layout();
    });
    obs.observe(stage);
    return () => {
      obs.disconnect();
      cancel();
    };
  }, [layout]);

  // An explicit re-layout when the divider moves: a drag can settle on the
  // same integer size the observer already saw, and the graph must still
  // re-fill its (new) pane.
  React.useEffect(() => {
    if (resizeToken > 0) return layout();
    return undefined;
  }, [resizeToken, layout]);

  // ── search focus (FR-073 e) ────────────────────────────────────────────
  React.useEffect(() => {
    const sim = simRef.current;
    const painted = paintedRef.current;
    const svg = svgRef.current;
    if (!sim || !painted || !svg) return;
    svg.classList.toggle("searching", !!matches);
    for (const n of sim.nodes) {
      const el = painted.nodes.get(n.id);
      if (!el) continue;
      const hit = !!matches && matches.has(n.id);
      el.classList.toggle("match", hit);
      el.classList.toggle("faded", !!matches && !hit);
    }
    sim.edges.forEach((e, i) => {
      const both = !!matches && matches.has(e.from) && matches.has(e.to);
      painted.edges[i]?.el.classList.toggle("faded", !!matches && !both);
    });
    fit();
  }, [matches, settled, fit]);

  // ── selection ring ─────────────────────────────────────────────────────
  React.useEffect(() => {
    const painted = paintedRef.current;
    if (!painted) return;
    for (const [id, el] of painted.nodes) el.classList.toggle("sel", id === selectedId);
  }, [selectedId, settled]);

  // ── pointer interactions: drag a node, pan, zoom, hover-to-trace ───────
  React.useEffect(() => {
    const svg = svgRef.current;
    if (!svg) return;
    let drag: { id: string; ox: number; oy: number } | null = null;
    let pan: { sx: number; sy: number; vx: number; vy: number } | null = null;
    let downAt: { x: number; y: number } | null = null;
    let moved = false;
    let hover: string | null = null;
    let tickCount = 0;

    const toWorld = (sx: number, sy: number) => {
      const v = viewRef.current;
      const r = svg.getBoundingClientRect();
      return { x: (sx - r.left - v.x) / v.k, y: (sy - r.top - v.y) / v.k };
    };

    const setHover = (id: string | null) => {
      const sim = simRef.current;
      const painted = paintedRef.current;
      if (!sim || !painted || id === hover) return;
      hover = id;
      const near = id ? sim.nbr.get(id) || new Set<string>() : null;
      for (const [nid, el] of painted.nodes) {
        el.classList.toggle("hot", nid === id);
        el.classList.toggle("near", !!near && near.has(nid) && nid !== id);
        el.classList.toggle("dim", !!near && !near.has(nid));
      }
      sim.edges.forEach((e, i) => {
        const inc = !!id && (e.from === id || e.to === id);
        painted.edges[i]?.el.classList.toggle("hot", inc);
        painted.edges[i]?.wrap.classList.toggle("hot", inc);
      });
      cullLabels(svg, sim, painted, viewRef.current);
    };

    const onDown = (ev: MouseEvent) => {
      const sim = simRef.current;
      if (!sim) return;
      downAt = { x: ev.clientX, y: ev.clientY };
      moved = false;
      const gEl = (ev.target as Element).closest(".g-node");
      if (gEl) {
        const n = sim.byId[gEl.getAttribute("data-id")!];
        const p = toWorld(ev.clientX, ev.clientY);
        drag = { id: n.id, ox: p.x - n.x, oy: p.y - n.y };
        n.fixed = true;
        n.fx = n.x;
        n.fy = n.y;
      } else {
        const v = viewRef.current;
        pan = { sx: ev.clientX, sy: ev.clientY, vx: v.x, vy: v.y };
        svg.classList.add("panning");
      }
      ev.preventDefault();
    };

    const onMove = (ev: MouseEvent) => {
      const sim = simRef.current;
      if (!sim) return;
      if (downAt && !moved && Math.hypot(ev.clientX - downAt.x, ev.clientY - downAt.y) > 3) moved = true;
      if (drag) {
        if (!moved) return;
        const p = toWorld(ev.clientX, ev.clientY);
        const n = sim.byId[drag.id];
        n.fx = p.x - drag.ox;
        n.fy = p.y - drag.oy;
        n.x = n.fx;
        n.y = n.fy;
        if (++tickCount % 2 === 0) {
          for (let i = 0; i < 3; i++) step(sim, 0.3);
          draw(sim, paintedRef.current!);
          cullLabels(svg, sim, paintedRef.current!, viewRef.current);
        }
      } else if (pan) {
        if (!moved) return;
        viewRef.current = { ...viewRef.current, x: pan.vx + (ev.clientX - pan.sx), y: pan.vy + (ev.clientY - pan.sy) };
        applyTransform(svg, viewRef.current);
        cullLabels(svg, sim, paintedRef.current!, viewRef.current);
      }
    };

    const onUp = () => {
      const sim = simRef.current;
      if (sim && drag) {
        const n = sim.byId[drag.id];
        if (n) {
          n.fixed = false;
          n.fx = null;
          n.fy = null;
        }
      }
      drag = null;
      if (pan) svg.classList.remove("panning");
      pan = null;
      downAt = null;
    };

    const onWheel = (ev: WheelEvent) => {
      ev.preventDefault();
      const v = viewRef.current;
      const k = Math.max(L.kMin, Math.min(L.kMax, v.k * Math.exp(-ev.deltaY * 0.0016)));
      const r = svg.getBoundingClientRect();
      const px = ev.clientX - r.left;
      const py = ev.clientY - r.top;
      viewRef.current = { k, x: px - (px - v.x) * (k / v.k), y: py - (py - v.y) * (k / v.k) };
      applyTransform(svg, viewRef.current);
      if (simRef.current && paintedRef.current) cullLabels(svg, simRef.current, paintedRef.current, viewRef.current);
    };

    const onClick = (ev: MouseEvent) => {
      if (moved) return;
      const sim = simRef.current;
      if (!sim) return;
      const gEl = (ev.target as Element).closest(".g-node");
      if (!gEl) return;
      const n = sim.byId[gEl.getAttribute("data-id")!];
      if (n) onSelectRef.current(n as unknown as GraphNode);
    };

    const onOver = (ev: MouseEvent) => {
      const gEl = (ev.target as Element).closest(".g-node");
      setHover(gEl ? gEl.getAttribute("data-id") : null);
    };

    svg.addEventListener("mousedown", onDown);
    svg.addEventListener("wheel", onWheel, { passive: false });
    svg.addEventListener("click", onClick);
    svg.addEventListener("mouseover", onOver);
    window.addEventListener("mousemove", onMove);
    window.addEventListener("mouseup", onUp);
    return () => {
      svg.removeEventListener("mousedown", onDown);
      svg.removeEventListener("wheel", onWheel);
      svg.removeEventListener("click", onClick);
      svg.removeEventListener("mouseover", onOver);
      window.removeEventListener("mousemove", onMove);
      window.removeEventListener("mouseup", onUp);
    };
  }, []);

  const hint = matches
    ? matches.size
      ? `${matches.size} of ${capped.nodes.length} nodes match — zoomed to the results`
      : "No node matches — showing the whole graph"
    : `${capped.nodes.length} nodes · zoom in (scroll or +) to label every node`;

  return (
    <>
      <div className="g-legend" data-testid="graph-legend">
        <span className="lg-item">
          <span className="lg-sw doc" />
          Document
        </span>
        <span className="lg-item">
          <span className="lg-sw chap" />
          Chapter
        </span>
        <span className="lg-item">
          <span className="lg-sw concept" />
          Concept term
        </span>
        <span className="lg-item" data-testid="legend-person">
          <span className="lg-sw person" />
          Person
        </span>
        <span className="lg-sep" />
        <span className="lg-item">
          <span className="lg-line contain" />
          contains
        </span>
        <span className="lg-item">
          <span className="lg-line cover" />
          covers
        </span>
        <span className="lg-item">
          <span className="lg-line link" />
          related
        </span>
      </div>

      <div id="graphStage" className="graph-stage" ref={stageRef} data-testid="graph-stage">
        <div className="g-ctl" data-testid="graph-controls">
          <button title="Zoom in" onClick={() => zoomBy(1.3)} data-testid="graph-zoom-in">
            +
          </button>
          <button title="Zoom out" onClick={() => zoomBy(1 / 1.3)} data-testid="graph-zoom-out">
            −
          </button>
          <button title="Fit (the search results, when searching)" onClick={fit} data-testid="graph-fit">
            ⤢
          </button>
        </div>
        <span className="g-hint" data-testid="graph-hint">
          {hint}
        </span>
        <svg className="g-svg" ref={svgRef} data-testid="graph-svg" />
      </div>

      <div className="note">
        <Icon name="info" size={14} />
        <span>
          <b>Knowledge graph</b> — derived from stored content: <b>contains</b> (document → its chapters), <b>covers</b> (chapter → the
          concept term it covers, and document/chapter → the <span style={{ color: "var(--teal)" }}>person</span> it is by or about), and{" "}
          <b>related</b> (explicit <code>okf_add_link</code> edges). <b>Drag</b> a node, <b>scroll</b> or <b>+ / −</b> to zoom, <b>drag empty
          space</b> to pan, <b>hover</b> to trace a node's neighbours and edges. Labels: documents always; everything else when you zoom in,
          hover or search. Searching above lights up the hits, fades the rest and zooms to them (⤢ re-fits).
          {capped.truncated ? (
            <>
              {" "}
              <b>Showing the {capped.nodes.length} most-connected nodes</b> of {graph.nodes.length} — search to find the rest.
            </>
          ) : null}
        </span>
      </div>
    </>
  );
}

// ── label placement ──────────────────────────────────────────────────────

/** Approximate on-screen width of a label: they are drawn at a constant
 *  on-screen size, so this does not depend on the zoom. */
function labelWidth(text: string, doc: boolean): number {
  return text.length * (doc ? 6.9 : 6.0) + 6;
}

/**
 * Show a label only where it does not collide with one already shown (FR-073
 * d): candidates are the labels the rules allow (documents; everything when
 * zoomed in; the hovered node and its neighbours; the selection; search
 * hits), placed greedily in priority order — selection, hover, hits,
 * neighbours, documents, then the rest, larger nodes first. A label that
 * would overlap is hidden until zooming in makes room. Without this, a
 * bundle of hundreds of documents fits to a solid pile of document titles.
 */
function cullLabels(svg: SVGSVGElement, sim: Sim, painted: Painted, view: View): void {
  const zoomed = view.k >= L.labelZoom;
  const searching = svg.classList.contains("searching");
  const candidates: { el: SVGGElement; box: [number, number, number, number]; rank: number }[] = [];
  for (const n of sim.nodes) {
    const el = painted.nodes.get(n.id);
    if (!el) continue;
    const c = el.classList;
    const rank = c.contains("sel") ? 0 : c.contains("hot") ? 1 : c.contains("match") ? 2 : c.contains("near") ? 3 : n.type === "doc" ? 4 : 5;
    const allowed = rank < 4 || (rank === 4 && !(searching && c.contains("faded"))) || (zoomed && !(searching && c.contains("faded")));
    if (!allowed) {
      c.remove("lbl-off");
      continue;
    }
    const text = el.querySelector(".g-tx")?.textContent || "";
    const w = labelWidth(text, n.type === "doc");
    const cx = n.x * view.k + view.x;
    const top = (n.y + n.r + 3) * view.k + view.y;
    candidates.push({ el, box: [cx - w / 2, top, cx + w / 2, top + 14], rank: rank * 1000 - n.r });
  }
  candidates.sort((a, b) => a.rank - b.rank);
  const placed: [number, number, number, number][] = [];
  for (const cand of candidates) {
    const [x0, y0, x1, y1] = cand.box;
    const clash = placed.some(([a0, b0, a1, b1]) => x0 < a1 && x1 > a0 && y0 < b1 && y1 > b0);
    cand.el.classList.toggle("lbl-off", clash);
    if (!clash) placed.push(cand.box);
  }
}

// ── imperative SVG painting ──────────────────────────────────────────────

const EDGE_COLOR: Record<string, string> = {
  contain: "#aeb8c4",
  cover: "var(--violet)",
  link: "var(--amber)",
};

function paintStructure(svg: SVGSVGElement, sim: Sim): Painted {
  const painted: Painted = { nodes: new Map(), edges: [] };
  const NS = "http://www.w3.org/2000/svg";
  svg.replaceChildren();

  const defs = document.createElementNS(NS, "defs");
  for (const kind of ["contain", "cover", "link"]) {
    const marker = document.createElementNS(NS, "marker");
    marker.setAttribute("id", `g-arrow-${kind}`);
    marker.setAttribute("refX", "6");
    marker.setAttribute("refY", "4");
    marker.setAttribute("markerWidth", "7");
    marker.setAttribute("markerHeight", "8");
    marker.setAttribute("orient", "auto");
    marker.setAttribute("markerUnits", "userSpaceOnUse");
    const p = document.createElementNS(NS, "path");
    p.setAttribute("d", "M0 0 L7 4 L0 8 z");
    p.setAttribute("fill", EDGE_COLOR[kind]);
    marker.appendChild(p);
    defs.appendChild(marker);
  }
  svg.appendChild(defs);

  const root = document.createElementNS(NS, "g");
  root.setAttribute("class", "g-sel");
  const edgeLayer = document.createElementNS(NS, "g");
  edgeLayer.setAttribute("class", "g-edges");
  const labelLayer = document.createElementNS(NS, "g");
  labelLayer.setAttribute("class", "g-elabels");
  const nodeLayer = document.createElementNS(NS, "g");
  nodeLayer.setAttribute("class", "g-nodes");

  for (const e of sim.edges) {
    const cls = edgeClass(e.kind);
    const path = document.createElementNS(NS, "path");
    path.setAttribute("class", `g-edge ${cls}`);
    path.setAttribute("marker-end", `url(#g-arrow-${cls})`);
    edgeLayer.appendChild(path);

    const wrap = document.createElementNS(NS, "g");
    wrap.setAttribute("class", "g-elab");
    const labelText = String(e.label || e.kind);
    const w = labelText.length * 5.6 + 9;
    const rect = document.createElementNS(NS, "rect");
    rect.setAttribute("class", "g-elbg");
    rect.setAttribute("x", String(-w / 2));
    rect.setAttribute("y", "-7");
    rect.setAttribute("width", String(w));
    rect.setAttribute("height", "14");
    rect.setAttribute("rx", "7");
    rect.setAttribute("fill", "rgba(8,10,14,.72)");
    rect.setAttribute("stroke", "rgba(255,255,255,.07)");
    const text = document.createElementNS(NS, "text");
    text.setAttribute("class", "g-elbl");
    text.setAttribute("text-anchor", "middle");
    text.setAttribute("dominant-baseline", "central");
    text.textContent = labelText;
    wrap.append(rect, text);
    labelLayer.appendChild(wrap);
    painted.edges.push({ el: path, wrap });
  }

  for (const n of sim.nodes) {
    const g = document.createElementNS(NS, "g");
    g.setAttribute("class", `g-node ${n.type}`);
    g.setAttribute("data-id", n.id);
    g.setAttribute("data-testid", `graph-node-${nodeRef(n as unknown as GraphNode)}`);

    const title = document.createElementNS(NS, "title");
    title.textContent = n.label;
    const ring = document.createElementNS(NS, "circle");
    ring.setAttribute("class", "g-ring");
    ring.setAttribute("r", String(n.r + 5));
    ring.setAttribute(
      "stroke",
      n.type === "doc"
        ? "#5a6a82"
        : n.type === "concept"
          ? "var(--violet)"
          : n.type === "person"
            ? "var(--teal)"
            : "var(--accent)",
    );
    const circ = document.createElementNS(NS, "circle");
    circ.setAttribute("class", "g-circ");
    circ.setAttribute("r", String(n.r));
    const hit = document.createElementNS(NS, "circle");
    hit.setAttribute("class", "g-hit");
    hit.setAttribute("r", String(n.r + 8));
    const label = document.createElementNS(NS, "text");
    label.setAttribute("class", "g-tx");
    label.setAttribute("text-anchor", "middle");
    // below the node, so it never sits on the circle or its neighbour's label
    label.setAttribute("y", String(n.r + 11));
    label.textContent = n.label.length > 28 ? `${n.label.slice(0, 27)}…` : n.label;

    g.append(title, ring, circ, hit, label);
    nodeLayer.appendChild(g);
    painted.nodes.set(n.id, g);
  }

  root.append(edgeLayer, labelLayer, nodeLayer);
  svg.appendChild(root);
  draw(sim, painted);
  return painted;
}

function applyTransform(svg: SVGSVGElement, view: View): void {
  const root = svg.querySelector(".g-sel");
  root?.setAttribute("transform", `translate(${view.x},${view.y}) scale(${view.k})`);
  // labels keep a constant on-screen size; non-document labels appear zoomed in
  svg.style.setProperty("--gk", String(view.k));
  svg.classList.toggle("zoomed", view.k >= L.labelZoom);
}

/** Position every edge path, edge label and node from the current sim state. */
function draw(sim: Sim, painted: Painted): void {
  sim.edges.forEach((e, i) => {
    const p = painted.edges[i];
    const a = sim.byId[e.from];
    const b = sim.byId[e.to];
    if (!a || !b || !p) return;
    const dx = b.x - a.x;
    const dy = b.y - a.y;
    const d = Math.hypot(dx, dy) || 1;
    const ux = dx / d;
    const uy = dy / d;
    const ax = a.x + ux * (a.r + 3);
    const ay = a.y + uy * (a.r + 3);
    const bx = b.x - ux * (b.r + 3);
    const by = b.y - uy * (b.r + 3);
    p.el.setAttribute("d", `M${ax.toFixed(1)} ${ay.toFixed(1)} L${bx.toFixed(1)} ${by.toFixed(1)}`);
    let ang = Math.atan2(dy, dx) * 57.2958;
    if (ang > 90) ang -= 180;
    if (ang < -90) ang += 180;
    p.wrap.setAttribute("transform", `translate(${((ax + bx) / 2).toFixed(1)} ${((ay + by) / 2).toFixed(1)}) rotate(${ang.toFixed(1)})`);
  });
  for (const n of sim.nodes as SimNode[]) {
    painted.nodes.get(n.id)?.setAttribute("transform", `translate(${n.x.toFixed(1)} ${n.y.toFixed(1)})`);
  }
}
