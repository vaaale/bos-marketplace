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
//     state. 150 settle ticks plus drag-time ticks would otherwise be 150
//     re-renders of every node; React owns the container and the legend,
//     the simulation owns the <g> transforms.

import React from "react";
import { Icon } from "../lib/icons";
import type { BundleGraph, GraphNode } from "../lib/types";
import { buildSim, capGraph, edgeClass, settle, stepGraph, type Sim, type SimNode } from "./forceSim";

export interface GraphSelection {
  // a person node opens the SAME term view as a concept term
  kind: "doc" | "chap" | "concept";
  docId: string | null;
  chId: string | null;
  term: string | null;
}

interface Props {
  graph: BundleGraph;
  /** Node ids the shared search matched. null = no active query. */
  matches: Set<string> | null;
  selectedId: string | null;
  onSelect: (node: GraphNode) => void;
  /** Bumped by the parent when the reader-pane divider is dragged. */
  resizeToken: number;
}

export default function GraphView({ graph, matches, selectedId, onSelect, resizeToken }: Props) {
  const stageRef = React.useRef<HTMLDivElement | null>(null);
  const svgRef = React.useRef<SVGSVGElement | null>(null);
  const simRef = React.useRef<Sim | null>(null);
  const onSelectRef = React.useRef(onSelect);
  onSelectRef.current = onSelect;

  const capped = React.useMemo(() => capGraph(graph.nodes, graph.edges), [graph]);

  // ── layout + paint ─────────────────────────────────────────────────────
  const layout = React.useCallback(() => {
    const stage = stageRef.current;
    const svg = svgRef.current;
    if (!stage || !svg) return;
    const W = stage.clientWidth;
    const H = stage.clientHeight;
    if (!W || !H) return; // still display:none / mid-mount — the observer retries

    svg.setAttribute("viewBox", `0 0 ${W} ${H}`);
    svg.setAttribute("width", "100%");
    svg.setAttribute("height", "100%");

    const sim = buildSim(capped.nodes, capped.edges, W, H);
    simRef.current = sim;
    paintStructure(svg, sim);
    settle(sim);
    applyTransform(svg, sim);
    draw(sim);
  }, [capped]);

  React.useEffect(() => {
    layout();
    const stage = stageRef.current;
    if (!stage) return;
    let lastW = stage.clientWidth;
    let lastH = stage.clientHeight;
    const obs = new ResizeObserver(() => {
      const w = stage.clientWidth;
      const h = stage.clientHeight;
      if (w === lastW && h === lastH) return;
      lastW = w;
      lastH = h;
      layout();
    });
    obs.observe(stage);
    return () => obs.disconnect();
  }, [layout]);

  // An explicit re-layout when the divider moves: a drag can settle on the
  // same integer size the observer already saw, and the graph must still
  // re-fill its (new) pane.
  React.useEffect(() => {
    if (resizeToken > 0) layout();
  }, [resizeToken, layout]);

  // ── search highlight / dim (FR-043) ────────────────────────────────────
  React.useEffect(() => {
    const sim = simRef.current;
    if (!sim) return;
    for (const n of sim.nodes) {
      if (!n.el) continue;
      const hit = !matches || matches.has(n.id);
      n.el.classList.toggle("match", !!matches && hit);
      n.el.classList.toggle("dimmed", !!matches && !hit); // .dimmed = opacity .3
    }
    for (const e of sim.edges) {
      if (!e.el) continue;
      const hit = !matches || matches.has(e.from) || matches.has(e.to);
      e.el.classList.toggle("dim", !!matches && !hit);
      e.wrap?.classList.toggle("dim", !!matches && !hit);
    }
  }, [matches, capped]);

  // ── selection ring ─────────────────────────────────────────────────────
  React.useEffect(() => {
    const sim = simRef.current;
    if (!sim) return;
    for (const n of sim.nodes) n.el?.classList.toggle("sel", n.id === selectedId);
  }, [selectedId, capped]);

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
      const sim = simRef.current!;
      const r = svg.getBoundingClientRect();
      return { x: (sx - r.left - sim.view.x) / sim.view.k, y: (sy - r.top - sim.view.y) / sim.view.k };
    };

    const setHover = (id: string | null) => {
      const sim = simRef.current;
      if (!sim || id === hover) return;
      hover = id;
      if (!id) {
        for (const n of sim.nodes) n.el?.classList.remove("dim", "hot");
        for (const e of sim.edges) {
          e.el?.classList.remove("hot");
          e.wrap?.classList.remove("hot");
        }
        return;
      }
      const near = sim.nbr.get(id) || new Set<string>();
      for (const n of sim.nodes) {
        n.el?.classList.toggle("hot", n.id === id);
        n.el?.classList.toggle("dim", !near.has(n.id));
      }
      for (const e of sim.edges) {
        const inc = e.from === id || e.to === id;
        e.el?.classList.toggle("hot", inc);
        e.wrap?.classList.toggle("hot", inc);
      }
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
        pan = { sx: ev.clientX, sy: ev.clientY, vx: sim.view.x, vy: sim.view.y };
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
          for (let i = 0; i < 3; i++) stepGraph(sim);
          draw(sim);
        }
      } else if (pan) {
        if (!moved) return;
        sim.view.x = pan.vx + (ev.clientX - pan.sx);
        sim.view.y = pan.vy + (ev.clientY - pan.sy);
        applyTransform(svg, sim);
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
      const sim = simRef.current;
      if (!sim) return;
      ev.preventDefault();
      const nk = Math.max(0.4, Math.min(2.6, sim.view.k * Math.exp(-ev.deltaY * 0.0016)));
      const r = svg.getBoundingClientRect();
      const px = ev.clientX - r.left;
      const py = ev.clientY - r.top;
      sim.view.x = px - (px - sim.view.x) * (nk / sim.view.k);
      sim.view.y = py - (py - sim.view.y) * (nk / sim.view.k);
      sim.view.k = nk;
      applyTransform(svg, sim);
    };

    const onClick = (ev: MouseEvent) => {
      if (moved) return;
      const sim = simRef.current;
      if (!sim) return;
      const gEl = (ev.target as Element).closest(".g-node");
      if (!gEl) return;
      const n = sim.byId[gEl.getAttribute("data-id")!];
      if (n) onSelectRef.current(n);
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
        <svg className="g-svg" ref={svgRef} data-testid="graph-svg" />
      </div>

      <div className="note">
        <Icon name="info" size={14} />
        <span>
          <b>Knowledge graph</b> — derived from stored content: <b>contains</b> (document → its chapters, via{" "}
          <code>parent</code>), <b>covers</b> (chapter → the concept term it covers, and document/chapter → the{" "}
          <span style={{ color: "var(--teal)" }}>person</span> it is by or about, via the concept index), and{" "}
          <b>related</b> (explicit <code>okf_add_link</code> edges). Force-directed — <b>drag</b> a node, <b>scroll</b>{" "}
          to zoom, <b>drag empty space</b> to pan, <b>hover</b> to trace its neighbours. Click any node to open it in the
          reader pane. Searching above highlights matching nodes and dims the rest.
          {capped.truncated ? (
            <>
              {" "}
              <b>Showing the {capped.nodes.length} most-connected nodes</b> of {graph.nodes.length} — narrow with the
              search box to see the rest.
            </>
          ) : null}
        </span>
      </div>
    </>
  );
}

// ── imperative SVG painting ──────────────────────────────────────────────

const EDGE_COLOR: Record<string, string> = {
  contain: "#aeb8c4",
  cover: "var(--violet)",
  link: "var(--amber)",
};

function paintStructure(svg: SVGSVGElement, sim: Sim): void {
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
    e.el = path;

    const wrap = document.createElementNS(NS, "g");
    wrap.setAttribute("class", "g-elab");
    const w = e.label.length * 5.6 + 9;
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
    text.textContent = e.label;
    wrap.append(rect, text);
    labelLayer.appendChild(wrap);
    e.wrap = wrap;
  }

  for (const n of sim.nodes) {
    const g = document.createElementNS(NS, "g");
    g.setAttribute("class", `g-node ${n.type}`);
    g.setAttribute("data-id", n.id);
    g.setAttribute("data-testid", `graph-node-${n.id}`);

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
    label.setAttribute("dominant-baseline", "central");
    label.textContent = n.label.length > 22 ? `${n.label.slice(0, 21)}…` : n.label;

    g.append(title, ring, circ, hit, label);
    nodeLayer.appendChild(g);
    n.el = g;
  }

  root.append(edgeLayer, labelLayer, nodeLayer);
  svg.appendChild(root);
  draw(sim);
}

function applyTransform(svg: SVGSVGElement, sim: Sim): void {
  const root = svg.querySelector(".g-sel");
  root?.setAttribute("transform", `translate(${sim.view.x},${sim.view.y}) scale(${sim.view.k})`);
}

/** Position every edge path, edge label and node from the current sim state. */
function draw(sim: Sim): void {
  for (const e of sim.edges) {
    const a = sim.byId[e.from];
    const b = sim.byId[e.to];
    if (!a || !b) continue;
    const dx = b.x - a.x;
    const dy = b.y - a.y;
    const d = Math.hypot(dx, dy) || 1;
    const ux = dx / d;
    const uy = dy / d;
    const ax = a.x + ux * (a.r + 3);
    const ay = a.y + uy * (a.r + 3);
    const bx = b.x - ux * (b.r + 3);
    const by = b.y - uy * (b.r + 3);
    e.el?.setAttribute("d", `M${ax.toFixed(1)} ${ay.toFixed(1)} L${bx.toFixed(1)} ${by.toFixed(1)}`);
    let ang = Math.atan2(dy, dx) * 57.2958;
    if (ang > 90) ang -= 180;
    if (ang < -90) ang += 180;
    e.wrap?.setAttribute(
      "transform",
      `translate(${((ax + bx) / 2).toFixed(1)} ${((ay + by) / 2).toFixed(1)}) rotate(${ang.toFixed(1)})`,
    );
  }
  for (const n of sim.nodes as SimNode[]) {
    n.el?.setAttribute("transform", `translate(${n.x.toFixed(1)} ${n.y.toFixed(1)})`);
  }
}
