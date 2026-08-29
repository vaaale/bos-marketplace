import React, { useMemo } from "react";
import type { StepLiveStatus, WorkflowStep } from "../lib/types";
import { describeStep } from "../lib/trajectory";

interface GraphProps {
  steps: WorkflowStep[];
  /** stepId -> status. Missing entries render as "pending" (neutral gray). */
  statuses?: Record<string, StepLiveStatus | undefined>;
  /** stepId currently executing — gets the pulsing glow (FR-013). */
  activeStepId?: string | null;
  /** Editing surface (001 mockup Detail/Edit view): clicking a node selects it for the step form. */
  selectedId?: string | null;
  onSelectNode?: (id: string) => void;
}

const NODE_W = 140;
const NODE_H = 52;
const GAP_X = 60;
const GAP_Y = 20;

function layerOf(steps: WorkflowStep[]): Map<string, number> {
  const byId = new Map(steps.map((s) => [s.id, s]));
  const layer = new Map<string, number>();
  const visiting = new Set<string>();

  function depth(id: string): number {
    if (layer.has(id)) return layer.get(id) as number;
    if (visiting.has(id)) return 0; // cycle guard — validate.js is the real acyclicity check
    visiting.add(id);
    const step = byId.get(id);
    const deps = step?.dependencies || [];
    const d = deps.length === 0 ? 0 : 1 + Math.max(...deps.map((dep) => (byId.has(dep) ? depth(dep) : 0)));
    layer.set(id, d);
    visiting.delete(id);
    return d;
  }

  for (const s of steps) depth(s.id);
  return layer;
}

// bg values are opaque (pre-blended over the app's #0f1117 canvas) rather than
// translucent rgba — a translucent node fill let the SVG edge layer show
// through the node itself, which is the bug this component was fixed for.
function statusStyle(status: StepLiveStatus | undefined, isActive: boolean) {
  switch (status) {
    case "running":
      return { border: "#38bdf8", bg: "#152b39", text: "#bae6fd", edge: "#38bdf8", glow: isActive };
    case "completed":
      return { border: "#34d399", bg: "#132424", text: "#a7f3d0", edge: "#34d399", glow: false };
    case "failed":
      return { border: "#f87171", bg: "#261b20", text: "#fecaca", edge: "#f87171", glow: false };
    case "cancelled":
      return { border: "rgba(255,255,255,0.2)", bg: "#191b20", text: "rgba(255,255,255,0.4)", edge: "#ffffff40", glow: false };
    case "skipped":
      // A leaf its routing node did not select (FR-031) — deliberately styled
      // like "neutral": nothing ran, and that is not an error.
      return { border: "rgba(251,191,36,0.25)", bg: "#1c1a17", text: "rgba(253,230,138,0.6)", edge: "#ffffff20", glow: false };
    case "neutral":
      return { border: "rgba(255,255,255,0.15)", bg: "#14161c", text: "rgba(255,255,255,0.35)", edge: "#ffffff20", glow: false };
    default:
      return { border: "rgba(255,255,255,0.15)", bg: "#1b1d23", text: "rgba(255,255,255,0.6)", edge: "#ffffff26", glow: false };
  }
}

export function Graph({ steps, statuses = {}, activeStepId = null, selectedId = null, onSelectNode }: GraphProps) {
  const { positions, width, height, edges } = useMemo(() => {
    const layer = layerOf(steps);
    const byLayer = new Map<number, string[]>();
    for (const s of steps) {
      const l = layer.get(s.id) ?? 0;
      if (!byLayer.has(l)) byLayer.set(l, []);
      byLayer.get(l)!.push(s.id);
    }
    const pos = new Map<string, { x: number; y: number }>();
    let maxLayer = 0;
    let maxCount = 1;
    for (const [l, ids] of byLayer) {
      maxLayer = Math.max(maxLayer, l);
      maxCount = Math.max(maxCount, ids.length);
      ids.forEach((id, i) => pos.set(id, { x: l * (NODE_W + GAP_X), y: i * (NODE_H + GAP_Y) }));
    }
    const edgeList: Array<{ from: string; to: string }> = [];
    for (const s of steps) for (const dep of s.dependencies || []) edgeList.push({ from: dep, to: s.id });
    return {
      positions: pos,
      width: (maxLayer + 1) * (NODE_W + GAP_X),
      height: maxCount * (NODE_H + GAP_Y),
      edges: edgeList,
    };
  }, [steps]);

  return (
    <div style={{ overflowX: "auto", borderRadius: 8, border: "1px solid rgba(255,255,255,0.1)", background: "rgba(255,255,255,0.02)", padding: 8 }}>
      <div style={{ position: "relative", height: Math.max(height, NODE_H), width: Math.max(width, NODE_W), minWidth: Math.max(width, NODE_W) }}>
        <svg width={Math.max(width, NODE_W)} height={Math.max(height, NODE_H)} style={{ position: "absolute", left: 0, top: 0, zIndex: 0 }}>
          {edges.map((e, i) => {
            const a = positions.get(e.from);
            const b = positions.get(e.to);
            if (!a || !b) return null;
            const style = statusStyle(statuses[e.from], e.from === activeStepId);
            return (
              <line
                key={i}
                x1={a.x + NODE_W}
                y1={a.y + NODE_H / 2}
                x2={b.x}
                y2={b.y + NODE_H / 2}
                stroke={style.edge}
                strokeWidth={1.5}
                opacity={0.8}
              />
            );
          })}
        </svg>
        {steps.map((s) => {
          const p = positions.get(s.id) || { x: 0, y: 0 };
          const isActive = s.id === activeStepId;
          const isSelected = s.id === selectedId;
          const style = statusStyle(statuses[s.id], isActive);
          return (
            <div
              key={s.id}
              title={`${s.id}: ${s.outputType} · ${describeStep(s)}`}
              onClick={onSelectNode ? () => onSelectNode(s.id) : undefined}
              style={{
                position: "absolute",
                left: p.x,
                top: p.y,
                zIndex: 1,
                width: NODE_W,
                borderRadius: 8,
                border: `1px solid ${isSelected ? "#c4b5fd" : style.border}`,
                background: style.bg,
                padding: "6px 10px",
                boxShadow: isSelected
                  ? "0 0 0 2px rgba(139,92,246,0.55)"
                  : style.glow
                    ? "0 0 14px 3px rgba(56,189,248,0.45)"
                    : undefined,
                cursor: onSelectNode ? "pointer" : undefined,
                fontSize: 11,
              }}
            >
              <div style={{ display: "flex", alignItems: "center", gap: 6 }}>
                {isActive ? <span className="wf-pulse-dot" style={{ background: style.edge }} /> : null}
                <span style={{ color: style.text, fontWeight: 600, overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap" }}>{s.id}</span>
              </div>
              <div style={{ marginTop: 2, fontFamily: "ui-monospace, monospace", fontSize: 9, color: style.text, opacity: 0.7, overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap" }}>
                {s.outputType} · {describeStep(s)}
              </div>
            </div>
          );
        })}
      </div>
    </div>
  );
}

export function GraphLegend({ historical = false }: { historical?: boolean }) {
  const items: Array<[string, StepLiveStatus]> = historical
    ? [
        ["completed", "completed"],
        ["failed", "failed"],
        ["cancelled", "cancelled"],
        ["skipped · branch not selected", "skipped"],
        ["neutral · never ran", "neutral"],
      ]
    : [
        ["pending", "pending" as StepLiveStatus],
        ["running", "running"],
        ["completed", "completed"],
        ["failed", "failed"],
        ["cancelled", "cancelled"],
      ];
  return (
    <div style={{ marginTop: 8, display: "flex", flexWrap: "wrap", gap: 12, fontFamily: "ui-monospace, monospace", fontSize: 10, color: "rgba(255,255,255,0.5)" }}>
      {items.map(([label, status]) => {
        const style = statusStyle(status, false);
        return (
          <span key={label} style={{ display: "flex", alignItems: "center", gap: 4 }}>
            <span style={{ display: "inline-block", height: 8, width: 8, borderRadius: 999, background: style.border }} />
            {label}
          </span>
        );
      })}
    </div>
  );
}
