// Game balance parameters. The values are tuned so a fresh player can complete
// a Normal descent inside 60s (SC-001). Physics use per-second units and are
// integrated against a variable delta each frame — see engine/Physics.ts.

export type Difficulty = "easy" | "normal" | "hard";

// World size — matches the fixed canvas the RenderSystem draws into. Kept in
// module scope so entities and rendering agree on coordinates.
export const WORLD_WIDTH = 800;
export const WORLD_HEIGHT = 600;

// Ground is a flat line near the bottom; the pad sits on it.
export const GROUND_Y = 560;

// Descent physics — feel is inspired by the classic arcade lander.
export const GRAVITY = 40; // px/s² downward
export const THRUST_POWER = 90; // px/s² upward while thrusting
export const LATERAL_THRUST = 35; // px/s² horizontal for A/D or ←/→
export const ROTATION_SPEED = 90; // degrees/s when rotating

// Landing tolerances (FR-004). Boundary is inclusive per the spec edge case.
export const MAX_LANDING_VELOCITY = 20; // px/s
export const MAX_LANDING_ANGLE = 15; // degrees

// Fuel is a percentage 0..100. Consumption is per-second so it scales with
// frame rate — long presses burn more, short taps burn less.
export const INITIAL_FUEL = 100;
export const FUEL_CONSUMPTION_PER_SECOND = 15;

// Where the lander spawns each round.
export const SPAWN_X = WORLD_WIDTH / 2;
export const SPAWN_Y = 60;

// Lander dimensions (used by collision + rendering).
export const LANDER_WIDTH = 24;
export const LANDER_HEIGHT = 28;

// Pad width scales with difficulty via DIFFICULTY_MODIFIERS below.
export const BASE_PAD_WIDTH = 120;

// Difficulty modifiers alter gravity and pad size. Numbers reflect the spec:
// easy = larger pad + weaker gravity, hard = smaller pad + stronger gravity.
export interface DifficultyModifier {
  gravity: number; // multiplier applied to GRAVITY
  padWidth: number; // multiplier applied to BASE_PAD_WIDTH
  fuel: number; // multiplier applied to INITIAL_FUEL
}

export const DIFFICULTY_MODIFIERS: Record<Difficulty, DifficultyModifier> = {
  easy: { gravity: 0.75, padWidth: 1.6, fuel: 1.2 },
  normal: { gravity: 1.0, padWidth: 1.0, fuel: 1.0 },
  hard: { gravity: 1.35, padWidth: 0.6, fuel: 0.85 },
};

// Scoring constants — see systems/ScoreSystem.ts. Weighting favors a soft,
// centered touchdown with fuel to spare.
export const SCORE_BASE_LANDING = 500;
export const SCORE_FUEL_MULT = 5; // per fuel percentage remaining
export const SCORE_PRECISION_MAX = 300; // capped bonus for pad-center accuracy
export const SCORE_SOFT_MAX = 200; // capped bonus for how gently we touched down

// LocalStorage key for the high-score record (SC survives page reload).
export const HIGH_SCORE_KEY = "browseros:lunar-lander:high-score";
export const DIFFICULTY_KEY = "browseros:lunar-lander:difficulty";
