"use client";

import type { Lander } from "../game/entities/Lander";
import { GROUND_Y, LANDER_HEIGHT, MAX_LANDING_VELOCITY } from "../game/utils/Constants";

interface Props {
  lander: Lander;
  highScore: number;
  score: number;
}

// Small telemetry panel. Only shows during flight — kept absolutely positioned
// over the canvas via `game.css`.
export function HUD({ lander, highScore, score }: Props) {
  const altitude = Math.max(0, GROUND_Y - (lander.position.y + LANDER_HEIGHT / 2));
  const vy = lander.velocity.y;
  const vx = lander.velocity.x;
  // Red-tint the vertical velocity readout as soon as we're above the safe
  // touchdown threshold — instant "you're coming in too hot" feedback.
  const vyDanger = Math.abs(vy) > MAX_LANDING_VELOCITY;

  return (
    <div className="ll-hud" data-testid="lunar-lander-hud">
      <Row label="ALT" value={altitude.toFixed(0)} />
      <Row label="VY" value={vy.toFixed(1)} danger={vyDanger} />
      <Row label="VX" value={vx.toFixed(1)} />
      <Row label="FUEL" value={`${Math.round(lander.fuel)}%`} danger={lander.fuel <= 0} />
      <Row label="SCORE" value={score.toString()} />
      <Row label="HI" value={highScore.toString()} muted />
    </div>
  );
}

function Row({
  label,
  value,
  danger,
  muted,
}: {
  label: string;
  value: string;
  danger?: boolean;
  muted?: boolean;
}) {
  return (
    <div className="ll-hud-row">
      <span className="ll-hud-label">{label}</span>
      <span
        className={`ll-hud-value ${danger ? "ll-hud-danger" : ""} ${muted ? "ll-hud-muted" : ""}`}
      >
        {value}
      </span>
    </div>
  );
}
