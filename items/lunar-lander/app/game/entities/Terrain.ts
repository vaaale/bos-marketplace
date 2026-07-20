import { GROUND_Y, WORLD_WIDTH } from "../utils/Constants";
import type { LandingPad } from "./LandingPad";

// Terrain is a jagged silhouette. Segments are generated once per game so the
// horizon is stable during a descent. The pad's segment is flat and drawn as a
// separate marker on top.

export interface TerrainSegment {
  x1: number;
  y1: number;
  x2: number;
  y2: number;
}

export function createTerrain(pad: LandingPad, segmentCount: number = 24): TerrainSegment[] {
  const step = WORLD_WIDTH / segmentCount;
  const points: Array<{ x: number; y: number }> = [];
  for (let i = 0; i <= segmentCount; i++) {
    const x = i * step;
    // Small pseudo-random undulation around GROUND_Y. Points that fall inside
    // the pad's footprint snap flat.
    let y: number;
    if (x >= pad.x - step && x <= pad.x + pad.width + step) {
      y = pad.y;
    } else {
      const noise = Math.sin(i * 12.9898) * 30 + Math.cos(i * 78.233) * 15;
      y = GROUND_Y + noise;
    }
    points.push({ x, y });
  }
  const segments: TerrainSegment[] = [];
  for (let i = 0; i < points.length - 1; i++) {
    segments.push({ x1: points[i].x, y1: points[i].y, x2: points[i + 1].x, y2: points[i + 1].y });
  }
  return segments;
}
