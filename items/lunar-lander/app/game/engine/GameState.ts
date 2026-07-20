import type { Lander } from "../entities/Lander";
import type { LandingPad } from "../entities/LandingPad";
import type { TerrainSegment } from "../entities/Terrain";
import {
  DIFFICULTY_KEY,
  DIFFICULTY_MODIFIERS,
  Difficulty,
  HIGH_SCORE_KEY,
  INITIAL_FUEL,
} from "../utils/Constants";
import { createLander } from "../entities/Lander";
import { createLandingPad } from "../entities/LandingPad";
import { createTerrain } from "../entities/Terrain";

export type GamePhase = "menu" | "playing" | "landed" | "crashed";

export type CrashReason = "speed" | "off-pad" | "angle";

export interface GameSession {
  phase: GamePhase;
  difficulty: Difficulty;
  lander: Lander;
  pad: LandingPad;
  terrain: TerrainSegment[];
  score: number;
  crashReason: CrashReason | null;
  highScore: number;
  lastScore: number | null;
}

// Boot the initial session. We start in MENU so the player can pick a
// difficulty before the first descent. The high score is read from
// localStorage if available (SSR-safe: falls back to 0 during server render).
export function createInitialSession(): GameSession {
  const difficulty = readStoredDifficulty();
  const mod = DIFFICULTY_MODIFIERS[difficulty];
  const pad = createLandingPad(mod.padWidth);
  return {
    phase: "menu",
    difficulty,
    lander: createLander(INITIAL_FUEL * mod.fuel),
    pad,
    terrain: createTerrain(pad),
    score: 0,
    crashReason: null,
    highScore: readHighScore(),
    lastScore: null,
  };
}

// Reset everything except the persisted high score, using the currently
// selected difficulty. Used both to leave the menu and to restart from the
// game-over screen.
export function startNewRound(session: GameSession): GameSession {
  const mod = DIFFICULTY_MODIFIERS[session.difficulty];
  const pad = createLandingPad(mod.padWidth);
  return {
    ...session,
    phase: "playing",
    lander: createLander(INITIAL_FUEL * mod.fuel),
    pad,
    terrain: createTerrain(pad),
    score: 0,
    crashReason: null,
  };
}

export function setDifficulty(session: GameSession, difficulty: Difficulty): GameSession {
  writeStoredDifficulty(difficulty);
  const mod = DIFFICULTY_MODIFIERS[difficulty];
  const pad = createLandingPad(mod.padWidth);
  return {
    ...session,
    difficulty,
    lander: createLander(INITIAL_FUEL * mod.fuel),
    pad,
    terrain: createTerrain(pad),
  };
}

export function recordScore(session: GameSession, score: number): GameSession {
  const newHigh = Math.max(session.highScore, score);
  if (newHigh > session.highScore) writeHighScore(newHigh);
  return { ...session, score, lastScore: score, highScore: newHigh };
}

// LocalStorage helpers guarded for SSR/private-mode.
function readHighScore(): number {
  if (typeof window === "undefined") return 0;
  try {
    const raw = window.localStorage.getItem(HIGH_SCORE_KEY);
    return raw ? Math.max(0, Number(raw) || 0) : 0;
  } catch {
    return 0;
  }
}

function writeHighScore(v: number): void {
  if (typeof window === "undefined") return;
  try {
    window.localStorage.setItem(HIGH_SCORE_KEY, String(Math.floor(v)));
  } catch {
    /* ignore quota / privacy errors */
  }
}

function readStoredDifficulty(): Difficulty {
  if (typeof window === "undefined") return "normal";
  try {
    const raw = window.localStorage.getItem(DIFFICULTY_KEY);
    if (raw === "easy" || raw === "normal" || raw === "hard") return raw;
  } catch {
    /* ignore */
  }
  return "normal";
}

function writeStoredDifficulty(v: Difficulty): void {
  if (typeof window === "undefined") return;
  try {
    window.localStorage.setItem(DIFFICULTY_KEY, v);
  } catch {
    /* ignore */
  }
}
