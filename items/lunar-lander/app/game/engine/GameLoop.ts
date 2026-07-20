import type { InputState } from "../../hooks/useKeyboardInput";
import { DIFFICULTY_MODIFIERS } from "../utils/Constants";
import { stepPhysics } from "./Physics";
import { checkCollision } from "../systems/CollisionSystem";
import { calculateScore } from "../systems/ScoreSystem";
import type { CrashReason, GameSession } from "./GameState";
import { recordScore } from "./GameState";

// One tick of the sim. Pure function of (session, input, dt) → next session.
// The React shell just calls this every animation frame while `phase` is
// "playing" — no persistent globals, no side effects beyond localStorage
// writes for high scores (via recordScore).
export function tickGame(session: GameSession, input: InputState, dt: number): GameSession {
  if (session.phase !== "playing") return session;

  const gravityMultiplier = DIFFICULTY_MODIFIERS[session.difficulty].gravity;
  const nextLander = stepPhysics(session.lander, input, dt, { gravityMultiplier });
  const collision = checkCollision(nextLander, session.pad);

  if (collision.kind === "none") {
    return { ...session, lander: nextLander };
  }

  if (collision.kind === "landed") {
    const scoreResult = calculateScore(nextLander, session.pad, true);
    const withScore = recordScore(session, scoreResult.totalScore);
    return {
      ...withScore,
      phase: "landed",
      lander: { ...nextLander, velocity: { x: 0, y: 0 } },
      crashReason: null,
    };
  }

  // Crashed
  const reason: CrashReason = collision.reason;
  return {
    ...session,
    phase: "crashed",
    lander: { ...nextLander, velocity: { x: 0, y: 0 } },
    crashReason: reason,
    lastScore: 0,
  };
}
