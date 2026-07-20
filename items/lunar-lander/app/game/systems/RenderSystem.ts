import type { Lander } from "../entities/Lander";
import type { LandingPad } from "../entities/LandingPad";
import type { TerrainSegment } from "../entities/Terrain";
import { LANDER_HEIGHT, LANDER_WIDTH, WORLD_HEIGHT, WORLD_WIDTH } from "../utils/Constants";

// Rendering is fully derived from the current session — no side effects on
// game state, no allocation of persistent buffers. Called every frame by the
// game loop after physics updates.

export interface RenderInputs {
  ctx: CanvasRenderingContext2D;
  lander: Lander;
  pad: LandingPad;
  terrain: TerrainSegment[];
  showThrustFlame: boolean;
}

export function render({ ctx, lander, pad, terrain, showThrustFlame }: RenderInputs): void {
  drawSky(ctx);
  drawStars(ctx);
  drawTerrain(ctx, terrain);
  drawPad(ctx, pad);
  drawLander(ctx, lander, showThrustFlame);
}

function drawSky(ctx: CanvasRenderingContext2D): void {
  const gradient = ctx.createLinearGradient(0, 0, 0, WORLD_HEIGHT);
  gradient.addColorStop(0, "#050914");
  gradient.addColorStop(1, "#101830");
  ctx.fillStyle = gradient;
  ctx.fillRect(0, 0, WORLD_WIDTH, WORLD_HEIGHT);
}

// Deterministic star field — same seed every frame gives a stable background.
const STAR_POSITIONS: Array<{ x: number; y: number; r: number }> = Array.from({ length: 90 }, (_, i) => {
  const x = ((i * 97) % WORLD_WIDTH) + ((i * 31) % 13);
  const y = ((i * 53) % (WORLD_HEIGHT - 120)) + 4;
  const r = (i % 5) === 0 ? 1.4 : 0.8;
  return { x, y, r };
});

function drawStars(ctx: CanvasRenderingContext2D): void {
  ctx.fillStyle = "#c7d2ff";
  for (const s of STAR_POSITIONS) {
    ctx.globalAlpha = s.r > 1 ? 0.9 : 0.55;
    ctx.beginPath();
    ctx.arc(s.x, s.y, s.r, 0, Math.PI * 2);
    ctx.fill();
  }
  ctx.globalAlpha = 1;
}

function drawTerrain(ctx: CanvasRenderingContext2D, terrain: TerrainSegment[]): void {
  if (terrain.length === 0) return;
  ctx.fillStyle = "#1a2140";
  ctx.strokeStyle = "#8896c8";
  ctx.lineWidth = 1.5;
  ctx.beginPath();
  ctx.moveTo(terrain[0].x1, WORLD_HEIGHT);
  ctx.lineTo(terrain[0].x1, terrain[0].y1);
  for (const seg of terrain) ctx.lineTo(seg.x2, seg.y2);
  ctx.lineTo(terrain[terrain.length - 1].x2, WORLD_HEIGHT);
  ctx.closePath();
  ctx.fill();
  ctx.beginPath();
  ctx.moveTo(terrain[0].x1, terrain[0].y1);
  for (const seg of terrain) ctx.lineTo(seg.x2, seg.y2);
  ctx.stroke();
}

function drawPad(ctx: CanvasRenderingContext2D, pad: LandingPad): void {
  ctx.fillStyle = "#4ade80";
  ctx.fillRect(pad.x, pad.y - 4, pad.width, 4);
  // little goalposts on either side so it's easy to spot
  ctx.fillStyle = "#22c55e";
  ctx.fillRect(pad.x - 2, pad.y - 14, 4, 14);
  ctx.fillRect(pad.x + pad.width - 2, pad.y - 14, 4, 14);
}

function drawLander(ctx: CanvasRenderingContext2D, lander: Lander, showFlame: boolean): void {
  ctx.save();
  ctx.translate(lander.position.x, lander.position.y);
  ctx.rotate((lander.angle * Math.PI) / 180);

  const hw = LANDER_WIDTH / 2;
  const hh = LANDER_HEIGHT / 2;

  // Thrust flame first so it sits behind the body.
  if (showFlame) {
    ctx.fillStyle = "#facc15";
    ctx.beginPath();
    ctx.moveTo(-6, hh);
    ctx.lineTo(6, hh);
    ctx.lineTo(0, hh + 12 + Math.random() * 6);
    ctx.closePath();
    ctx.fill();
    ctx.fillStyle = "#fb923c";
    ctx.beginPath();
    ctx.moveTo(-3, hh);
    ctx.lineTo(3, hh);
    ctx.lineTo(0, hh + 7 + Math.random() * 3);
    ctx.closePath();
    ctx.fill();
  }

  // Body
  ctx.fillStyle = "#e5e7eb";
  ctx.strokeStyle = "#94a3b8";
  ctx.lineWidth = 1.2;
  ctx.beginPath();
  ctx.moveTo(0, -hh);
  ctx.lineTo(hw - 2, -hh / 2);
  ctx.lineTo(hw - 2, hh / 2);
  ctx.lineTo(-(hw - 2), hh / 2);
  ctx.lineTo(-(hw - 2), -hh / 2);
  ctx.closePath();
  ctx.fill();
  ctx.stroke();

  // Cockpit
  ctx.fillStyle = "#38bdf8";
  ctx.beginPath();
  ctx.arc(0, -hh / 2 + 2, 3.5, 0, Math.PI * 2);
  ctx.fill();

  // Legs
  ctx.strokeStyle = "#cbd5e1";
  ctx.lineWidth = 1.5;
  ctx.beginPath();
  ctx.moveTo(-hw + 2, hh / 2);
  ctx.lineTo(-hw - 3, hh);
  ctx.moveTo(hw - 2, hh / 2);
  ctx.lineTo(hw + 3, hh);
  ctx.stroke();
  ctx.fillStyle = "#cbd5e1";
  ctx.fillRect(-hw - 5, hh - 1, 5, 2);
  ctx.fillRect(hw, hh - 1, 5, 2);

  ctx.restore();
}
