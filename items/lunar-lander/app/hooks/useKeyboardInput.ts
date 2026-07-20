"use client";

import { useEffect, useMemo, useRef, type RefObject } from "react";

export interface InputState {
  thrust: boolean;
  rotateLeft: boolean;
  rotateRight: boolean;
  restart: boolean;
}

// The input state is a stable mutable object (via useMemo) rather than React
// state on purpose: the game loop reads it every frame and we don't want a
// re-render for each keystroke. The `onRestart` handler fires once per
// Enter/R press (not held).
//
// Attaching to `window` (with an activeElement guard against `scope`) means we
// don't hijack arrow keys when another BrowserOS window has focus. If no scope
// is given, keys are captured globally.
export function useKeyboardInput(
  onRestart?: () => void,
  scope?: RefObject<HTMLElement | null>,
): InputState {
  const state = useMemo<InputState>(
    () => ({
      thrust: false,
      rotateLeft: false,
      rotateRight: false,
      restart: false,
    }),
    [],
  );
  const restartRef = useRef(onRestart);
  useEffect(() => {
    restartRef.current = onRestart;
  });

  useEffect(() => {
    const inScope = (): boolean => {
      const root = scope?.current;
      if (!root) return true;
      const active = document.activeElement;
      // Overlays with autoFocus (e.g. Menu's Start button) grab focus, then
      // unmount — leaving activeElement as <body>. Treat "nothing focused" as
      // in-scope so keys work once the overlay closes. A truly focused other
      // BOS window has its own focusable container as activeElement, so we
      // still defer to it correctly.
      if (!active || active === document.body || active === document.documentElement) {
        return true;
      }
      return root === active || root.contains(active);
    };

    const handleDown = (ev: KeyboardEvent) => {
      if (!inScope()) return;
      switch (ev.key) {
        case "ArrowUp":
        case "w":
        case "W":
          state.thrust = true;
          ev.preventDefault();
          break;
        case "ArrowLeft":
        case "a":
        case "A":
          state.rotateLeft = true;
          ev.preventDefault();
          break;
        case "ArrowRight":
        case "d":
        case "D":
          state.rotateRight = true;
          ev.preventDefault();
          break;
        case "Enter":
        case "r":
        case "R":
          if (!state.restart) restartRef.current?.();
          state.restart = true;
          break;
      }
    };
    const handleUp = (ev: KeyboardEvent) => {
      switch (ev.key) {
        case "ArrowUp":
        case "w":
        case "W":
          state.thrust = false;
          break;
        case "ArrowLeft":
        case "a":
        case "A":
          state.rotateLeft = false;
          break;
        case "ArrowRight":
        case "d":
        case "D":
          state.rotateRight = false;
          break;
        case "Enter":
        case "r":
        case "R":
          state.restart = false;
          break;
      }
    };
    window.addEventListener("keydown", handleDown);
    window.addEventListener("keyup", handleUp);
    return () => {
      window.removeEventListener("keydown", handleDown);
      window.removeEventListener("keyup", handleUp);
    };
  }, [scope, state]);

  return state;
}
