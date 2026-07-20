import type { Lander } from "../entities/Lander";
import type { LandingPad } from "../entities/LandingPad";
import { padCenter } from "../entities/LandingPad";
import {
  MAX_LANDING_VELOCITY,
  SCORE_BASE_LANDING,
  SCORE_FUEL_MULT,
  SCORE_PRECISION_MAX,
  SCORE_SOFT_MAX,
} from "../utils/Constants";

export interface ScoreResult {
  success: boolean;
  baseScore: number;
  fuelBonus: number;
  precisionBonus: number;
  softBonus: number;
  totalScore: number;
}

// Rewards a landing across three axes: base flat bonus for touching down safely,
// remaining fuel, precision (how centered), and softness (how far below the
// crash velocity we were). Crashes still return a score (0) so the UI can
// display a consistent shape.
export function calculateScore(lander: Lander, pad: LandingPad, success: boolean): ScoreResult {
  if (!success) {
    return {
      success: false,
      baseScore: 0,
      fuelBonus: 0,
      precisionBonus: 0,
      softBonus: 0,
      totalScore: 0,
    };
  }

  const baseScore = SCORE_BASE_LANDING;
  const fuelBonus = Math.round(Math.max(0, lander.fuel) * SCORE_FUEL_MULT);

  const halfWidth = pad.width / 2;
  const offset = Math.abs(lander.position.x - padCenter(pad));
  const precisionFrac = halfWidth > 0 ? Math.max(0, 1 - offset / halfWidth) : 0;
  const precisionBonus = Math.round(precisionFrac * SCORE_PRECISION_MAX);

  const softFrac = Math.max(0, 1 - Math.abs(lander.velocity.y) / MAX_LANDING_VELOCITY);
  const softBonus = Math.round(softFrac * SCORE_SOFT_MAX);

  const totalScore = baseScore + fuelBonus + precisionBonus + softBonus;
  return { success: true, baseScore, fuelBonus, precisionBonus, softBonus, totalScore };
}
