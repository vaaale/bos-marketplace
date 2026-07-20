import type { Lander } from "../entities/Lander";
import type { LandingPad } from "../entities/LandingPad";
import { isWithinPad } from "../entities/LandingPad";
import {
  GROUND_Y,
  LANDER_HEIGHT,
  MAX_LANDING_ANGLE,
  MAX_LANDING_VELOCITY,
} from "../utils/Constants";
import type { CrashReason } from "../engine/GameState";

export type CollisionResult =
  | { kind: "none" }
  | { kind: "landed" }
  | { kind: "crashed"; reason: CrashReason };

// The lander's feet rest at position.y + LANDER_HEIGHT/2. Collision fires the
// moment those touch or dip below the ground line. The spec (edge case) makes
// the 20 unit velocity boundary inclusive, so we test with `> MAX`, not `>=`.
export function checkCollision(lander: Lander, pad: LandingPad): CollisionResult {
  const feetY = lander.position.y + LANDER_HEIGHT / 2;
  if (feetY < GROUND_Y) return { kind: "none" };

  const speed = Math.abs(lander.velocity.y);
  const onPad = isWithinPad(lander.position.x, pad) && feetY >= pad.y - 1;
  const angleOk = Math.abs(lander.angle) <= MAX_LANDING_ANGLE;

  if (!onPad) return { kind: "crashed", reason: "off-pad" };
  if (speed > MAX_LANDING_VELOCITY) return { kind: "crashed", reason: "speed" };
  if (!angleOk) return { kind: "crashed", reason: "angle" };
  return { kind: "landed" };
}
