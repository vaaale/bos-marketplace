import { BASE_PAD_WIDTH, GROUND_Y, WORLD_WIDTH } from "../utils/Constants";

export interface LandingPad {
  x: number; // left edge
  width: number;
  y: number; // top of the pad (also its landing surface)
}

// Randomises the horizontal position so replays feel different, but keeps the
// pad fully on-screen with padding on both sides.
export function createLandingPad(widthMultiplier: number = 1): LandingPad {
  const width = Math.max(40, BASE_PAD_WIDTH * widthMultiplier);
  const padding = 40;
  const range = WORLD_WIDTH - width - padding * 2;
  const x = padding + (range > 0 ? Math.random() * range : 0);
  return { x, y: GROUND_Y, width };
}

export function padCenter(pad: LandingPad): number {
  return pad.x + pad.width / 2;
}

export function isWithinPad(lander_x: number, pad: LandingPad): boolean {
  return lander_x >= pad.x && lander_x <= pad.x + pad.width;
}
