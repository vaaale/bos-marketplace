"use client";

import type { Difficulty } from "../game/utils/Constants";

interface Props {
  difficulty: Difficulty;
  highScore: number;
  onStart: () => void;
  onSelectDifficulty: (d: Difficulty) => void;
}

const LABELS: Record<Difficulty, string> = {
  easy: "Easy",
  normal: "Normal",
  hard: "Hard",
};

const HINTS: Record<Difficulty, string> = {
  easy: "Weaker gravity, wider pad, more fuel.",
  normal: "The classic descent.",
  hard: "Heavier gravity, narrow pad, less fuel.",
};

export function Menu({ difficulty, highScore, onStart, onSelectDifficulty }: Props) {
  return (
    <div className="ll-overlay" role="dialog" aria-modal="true">
      <div className="ll-panel">
        <h1 className="ll-title">Lunar Lander</h1>
        <p className="ll-subline">Descend gently. Land on the pad. Don&apos;t die.</p>

        <div className="ll-difficulty">
          {(["easy", "normal", "hard"] as const).map((d) => (
            <button
              key={d}
              className={`ll-diff-btn ${d === difficulty ? "ll-diff-active" : ""}`}
              onClick={() => onSelectDifficulty(d)}
              aria-pressed={d === difficulty}
            >
              {LABELS[d]}
            </button>
          ))}
        </div>
        <p className="ll-hint">{HINTS[difficulty]}</p>

        <div className="ll-controls-help">
          <div><kbd>↑</kbd> / <kbd>W</kbd> — thrust</div>
          <div><kbd>←</kbd> <kbd>→</kbd> / <kbd>A</kbd> <kbd>D</kbd> — rotate</div>
          <div><kbd>Enter</kbd> / <kbd>R</kbd> — restart after game over</div>
        </div>

        <p className="ll-hint">Best score: {highScore}</p>
        <div className="ll-buttons">
          <button className="ll-btn ll-btn-primary" onClick={onStart} autoFocus>
            Start Descent
          </button>
        </div>
      </div>
    </div>
  );
}
