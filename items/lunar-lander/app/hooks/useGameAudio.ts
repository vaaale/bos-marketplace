import { useEffect, useRef, useCallback } from "react";
import type { GamePhase } from "../game/engine/GameState";

// Procedural sound effects via Web Audio API — no audio files required.
// All sounds are synthesized from oscillators and noise.

function getCtx(ref: React.MutableRefObject<AudioContext | null>): AudioContext | null {
  if (typeof window === "undefined") return null;
  if (!ref.current || ref.current.state === "closed") {
    ref.current = new AudioContext();
  }
  return ref.current;
}

export function useGameAudio(phase: GamePhase, thrusting: boolean) {
  const ctxRef = useRef<AudioContext | null>(null);
  const thrustNodeRef = useRef<{
    source: AudioBufferSourceNode;
    gain: GainNode;
  } | null>(null);
  const prevPhaseRef = useRef<GamePhase>(phase);

  // ── Thrust loop ──────────────────────────────────────────────────────────
  const startThrust = useCallback(() => {
    const ctx = getCtx(ctxRef);
    if (!ctx || thrustNodeRef.current) return;

    // White-noise buffer (0.5 s, looped)
    const bufLen = Math.floor(ctx.sampleRate * 0.5);
    const buf = ctx.createBuffer(1, bufLen, ctx.sampleRate);
    const data = buf.getChannelData(0);
    for (let i = 0; i < bufLen; i++) data[i] = Math.random() * 2 - 1;

    const source = ctx.createBufferSource();
    source.buffer = buf;
    source.loop = true;

    // Shape: band-pass to give it a rumble character, then gain down
    const bp = ctx.createBiquadFilter();
    bp.type = "bandpass";
    bp.frequency.value = 180;
    bp.Q.value = 0.8;

    const gain = ctx.createGain();
    gain.gain.value = 0;
    gain.gain.linearRampToValueAtTime(0.18, ctx.currentTime + 0.08);

    source.connect(bp);
    bp.connect(gain);
    gain.connect(ctx.destination);
    source.start();
    thrustNodeRef.current = { source, gain };
  }, []);

  const stopThrust = useCallback(() => {
    const node = thrustNodeRef.current;
    const ctx = ctxRef.current;
    if (!node || !ctx) return;
    node.gain.gain.cancelScheduledValues(ctx.currentTime);
    node.gain.gain.linearRampToValueAtTime(0, ctx.currentTime + 0.12);
    const src = node.source;
    setTimeout(() => { try { src.stop(); } catch { /* already stopped */ } }, 200);
    thrustNodeRef.current = null;
  }, []);

  useEffect(() => {
    if (phase !== "playing") { stopThrust(); return; }
    if (thrusting) startThrust(); else stopThrust();
  }, [thrusting, phase, startThrust, stopThrust]);

  // ── Phase transition sounds ──────────────────────────────────────────────
  useEffect(() => {
    const prev = prevPhaseRef.current;
    prevPhaseRef.current = phase;

    if (phase === prev) return;

    const ctx = getCtx(ctxRef);
    if (!ctx) return;

    if (phase === "landed") {
      playLanded(ctx);
    } else if (phase === "crashed") {
      playCrash(ctx);
    }
  }, [phase]);

  // Cleanup on unmount
  useEffect(() => {
    return () => {
      stopThrust();
      ctxRef.current?.close().catch(() => {});
    };
  }, [stopThrust]);
}

// ── Sound definitions ────────────────────────────────────────────────────────

function playLanded(ctx: AudioContext) {
  // Ascending two-tone chime
  const notes = [523.25, 659.25, 783.99]; // C5, E5, G5
  notes.forEach((freq, i) => {
    const osc = ctx.createOscillator();
    const gain = ctx.createGain();
    osc.type = "sine";
    osc.frequency.value = freq;
    const t = ctx.currentTime + i * 0.12;
    gain.gain.setValueAtTime(0, t);
    gain.gain.linearRampToValueAtTime(0.22, t + 0.02);
    gain.gain.exponentialRampToValueAtTime(0.001, t + 0.5);
    osc.connect(gain);
    gain.connect(ctx.destination);
    osc.start(t);
    osc.stop(t + 0.55);
  });
}

function playCrash(ctx: AudioContext) {
  // Burst of noise + descending pitch sweep
  const bufLen = Math.floor(ctx.sampleRate * 0.6);
  const buf = ctx.createBuffer(1, bufLen, ctx.sampleRate);
  const data = buf.getChannelData(0);
  for (let i = 0; i < bufLen; i++) data[i] = Math.random() * 2 - 1;

  const source = ctx.createBufferSource();
  source.buffer = buf;

  const gain = ctx.createGain();
  gain.gain.setValueAtTime(0.35, ctx.currentTime);
  gain.gain.exponentialRampToValueAtTime(0.001, ctx.currentTime + 0.6);

  const lp = ctx.createBiquadFilter();
  lp.type = "lowpass";
  lp.frequency.setValueAtTime(2000, ctx.currentTime);
  lp.frequency.exponentialRampToValueAtTime(80, ctx.currentTime + 0.6);

  source.connect(lp);
  lp.connect(gain);
  gain.connect(ctx.destination);
  source.start();
  source.stop(ctx.currentTime + 0.65);

  // Low thud underneath
  const osc = ctx.createOscillator();
  const oscGain = ctx.createGain();
  osc.type = "sine";
  osc.frequency.setValueAtTime(80, ctx.currentTime);
  osc.frequency.exponentialRampToValueAtTime(20, ctx.currentTime + 0.4);
  oscGain.gain.setValueAtTime(0.4, ctx.currentTime);
  oscGain.gain.exponentialRampToValueAtTime(0.001, ctx.currentTime + 0.4);
  osc.connect(oscGain);
  oscGain.connect(ctx.destination);
  osc.start();
  osc.stop(ctx.currentTime + 0.45);
}
