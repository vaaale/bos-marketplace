"use client";

import { useEffect, useRef } from "react";

// requestAnimationFrame-driven loop. The callback receives the delta since the
// last frame in seconds — the physics/render modules work in per-second units
// so a slower browser still gets consistent motion, and a fast browser draws
// more often without accelerating gameplay.
export function useGameLoop(callback: (deltaSeconds: number) => void, running: boolean) {
  const cbRef = useRef(callback);
  // Keep the ref in sync with the latest callback without stale closures. The
  // ref is intentionally written inside an effect to satisfy React 19's
  // "no ref writes during render" rule.
  useEffect(() => {
    cbRef.current = callback;
  });

  useEffect(() => {
    if (!running) return;
    let raf = 0;
    let last = performance.now();
    const tick = (now: number) => {
      // Cap delta at 100ms — protects the sim after tab defocus so the lander
      // doesn't "warp" through the ground when the loop resumes.
      const delta = Math.min((now - last) / 1000, 0.1);
      last = now;
      cbRef.current(delta);
      raf = requestAnimationFrame(tick);
    };
    raf = requestAnimationFrame(tick);
    return () => cancelAnimationFrame(raf);
  }, [running]);
}
