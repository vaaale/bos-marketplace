"use client";

import { useEffect, useRef } from "react";
import type { GameSession } from "../game/engine/GameState";
import { render } from "../game/systems/RenderSystem";
import { WORLD_HEIGHT, WORLD_WIDTH } from "../game/utils/Constants";

interface Props {
  session: GameSession;
}

// Thin wrapper around a fixed-size canvas. The parent updates `session` at
// 60Hz via requestAnimationFrame; this component paints on every commit.
// Using a ref-callback keeps the canvas element identity stable across
// re-renders without re-attaching listeners.
export function GameCanvas({ session }: Props) {
  const canvasRef = useRef<HTMLCanvasElement | null>(null);

  useEffect(() => {
    const canvas = canvasRef.current;
    if (!canvas) return;
    const ctx = canvas.getContext("2d");
    if (!ctx) return;
    render({
      ctx,
      lander: session.lander,
      pad: session.pad,
      terrain: session.terrain,
      showThrustFlame: session.phase === "playing" && session.lander.thrusting,
    });
  }, [session]);

  return (
    <canvas
      ref={canvasRef}
      width={WORLD_WIDTH}
      height={WORLD_HEIGHT}
      className="ll-canvas"
      aria-label="Lunar lander game canvas"
      data-testid="lunar-lander-canvas"
    />
  );
}
