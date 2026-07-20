import type { Lander } from "../entities/Lander";
import {
  FUEL_CONSUMPTION_PER_SECOND,
  GRAVITY,
  LATERAL_THRUST,
  ROTATION_SPEED,
  THRUST_POWER,
  WORLD_WIDTH,
} from "../utils/Constants";
import type { InputState } from "../../hooks/useKeyboardInput";

export interface PhysicsConfig {
  gravityMultiplier: number;
}

// Advance the lander by `dt` seconds. Rotation is applied first (so the thrust
// vector this frame uses the fresh angle), then thrust adjusts velocity, then
// gravity pulls, then position updates from the resulting velocity.
export function stepPhysics(
  lander: Lander,
  input: InputState,
  dt: number,
  config: PhysicsConfig,
): Lander {
  let angle = lander.angle;
  if (input.rotateLeft) angle -= ROTATION_SPEED * dt;
  if (input.rotateRight) angle += ROTATION_SPEED * dt;

  let vx = lander.velocity.x;
  let vy = lander.velocity.y;
  let fuel = lander.fuel;
  let thrusting = false;

  if (input.thrust && fuel > 0) {
    // Thrust points opposite the ship's "down" — angle 0 = pure upward.
    const rad = (angle * Math.PI) / 180;
    vx += Math.sin(rad) * THRUST_POWER * dt;
    vy -= Math.cos(rad) * THRUST_POWER * dt;
    fuel = Math.max(0, fuel - FUEL_CONSUMPTION_PER_SECOND * dt);
    thrusting = true;
  }

  // Optional lateral RCS-style translation. Feels responsive without breaking
  // the classic gravity-vs-thrust game — costs no fuel (per common variants).
  if (input.rotateLeft && !input.thrust) vx -= LATERAL_THRUST * dt * 0.4;
  if (input.rotateRight && !input.thrust) vx += LATERAL_THRUST * dt * 0.4;

  vy += GRAVITY * config.gravityMultiplier * dt;

  let x = lander.position.x + vx * dt;
  const y = lander.position.y + vy * dt;

  // Horizontal wrap-around keeps the lander in play (edge-case FR handling).
  if (x < 0) x += WORLD_WIDTH;
  if (x > WORLD_WIDTH) x -= WORLD_WIDTH;

  return {
    position: { x, y },
    velocity: { x: vx, y: vy },
    angle,
    fuel,
    thrusting,
  };
}
