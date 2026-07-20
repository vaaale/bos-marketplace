"use client";

import type { CrashReason, GamePhase } from "../game/engine/GameState";

interface Props {
  phase: GamePhase;
  crashReason: CrashReason | null;
  lastScore: number | null;
  highScore: number;
  onRestart: () => void;
  onMenu: () => void;
}

const CRASH_MESSAGE: Record<CrashReason, string> = {
  speed: "CRASHED — descent velocity exceeded the safety limit.",
  "off-pad": "CRASHED — missed the landing pad.",
  angle: "CRASHED — hit at too steep an angle.",
};

// Shown after a landing or a crash. Reads its message from `phase` +
// `crashReason` so the parent stays a pure state machine.
export function GameOver({ phase, crashReason, lastScore, highScore, onRestart, onMenu }: Props) {
  const success = phase === "landed";
  const heading = success ? "TOUCHDOWN" : "MISSION FAILED";
  const subline = success
    ? "The Eagle has landed."
    : crashReason
      ? CRASH_MESSAGE[crashReason]
      : "The lander is lost.";

  return (
    <div className="ll-overlay" role="dialog" aria-modal="true">
      <div className="ll-panel">
        <h2 className={`ll-heading ${success ? "ll-heading-good" : "ll-heading-bad"}`}>{heading}</h2>
        <p className="ll-subline">{subline}</p>
        {success && lastScore !== null && (
          <div className="ll-score-block">
            <div className="ll-score-value">{lastScore}</div>
            <div className="ll-score-label">
              {lastScore > highScore - 1 && lastScore === highScore ? "NEW BEST" : "SCORE"}
            </div>
          </div>
        )}
        <p className="ll-hint">Best: {highScore}</p>
        <div className="ll-buttons">
          <button className="ll-btn ll-btn-primary" onClick={onRestart} autoFocus>
            Restart (Enter)
          </button>
          <button className="ll-btn" onClick={onMenu}>
            Menu
          </button>
        </div>
      </div>
    </div>
  );
}
