export interface LayoutNode {
  id: string;
  type: "doc" | "chap" | "concept" | "person";
  label: string;
  count?: number;
  docId?: string;
  chId?: string;
  term?: string;
  [key: string]: unknown;
}
export interface LayoutEdge {
  from: string;
  to: string;
  kind: "containment" | "coverage" | "link";
  [key: string]: unknown;
}
export interface SimNode extends LayoutNode {
  x: number;
  y: number;
  vx: number;
  vy: number;
  r: number;
  fixed: boolean;
  fx: number | null;
  fy: number | null;
}
export interface Sim {
  nodes: SimNode[];
  byId: Record<string, SimNode>;
  edges: LayoutEdge[];
  nbr: Map<string, Set<string>>;
  center: { x: number; y: number };
  tick: number;
}
export interface Box {
  x0: number;
  y0: number;
  x1: number;
  y1: number;
}
export interface SearchRowLike {
  docId: string;
  chId: string;
  matchKind?: string;
  matchedConcept?: string | null;
}
export declare const L: {
  k: number;
  rest: Record<"containment" | "coverage" | "link", number>;
  spring: number;
  center: number;
  damp: number;
  maxV: number;
  ticks: number;
  pad: number;
  labelGap: number;
  labelZoom: number;
  fitMargin: number;
  kMin: number;
  kMax: number;
};
export declare function nodeRadius(n: LayoutNode): number;
export declare function buildLayout(nodes: LayoutNode[], edges: LayoutEdge[], stage?: { width?: number; height?: number }): Sim;
export declare function step(sim: Sim, alpha?: number): void;
export declare function alphaAt(i: number, ticks?: number): number;
export declare function settle(sim: Sim, ticks?: number): void;
export declare function finish(sim: Sim): void;
export declare function fitBox(sim: Sim, ids: Set<string> | null): Box | null;
export declare function fitView(box: Box | null, width: number, height: number, opts?: { focus?: boolean }): { x: number; y: number; k: number };
export declare function matchSet(rows: SearchRowLike[], nodes: LayoutNode[], query: string): Set<string>;
