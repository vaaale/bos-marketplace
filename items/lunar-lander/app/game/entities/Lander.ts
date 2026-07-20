import type { Vector2 } from "../utils/Vector2";
import { INITIAL_FUEL, SPAWN_X, SPAWN_Y } from "../utils/Constants";

export interface Lander {
  position: Vector2;
  velocity: Vector2;
  angle: number; // degrees, 0 = upright, positive = tilted right
  fuel: number; // 0..100 (or higher if easy difficulty)
  thrusting: boolean;
}

// Fresh lander at the spawn point with a full tank and no movement. The
// starting fuel is passed in so difficulty modifiers can override the default.
export function createLander(startingFuel: number = INITIAL_FUEL): Lander {
  return {
    position: { x: SPAWN_X, y: SPAWN_Y },
    velocity: { x: 0, y: 0 },
    angle: 0,
    fuel: startingFuel,
    thrusting: false,
  };
}
