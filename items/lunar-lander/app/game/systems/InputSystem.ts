// The InputSystem is intentionally thin: the actual keyboard listener lives in
// `hooks/useKeyboardInput.ts` (needs React lifecycle for cleanup). This file
// exports the shared type used by physics and the game loop so callers don't
// have to reach into the hook module. Keeping the type here mirrors the plan's
// file layout and gives us a natural home if we ever add gamepad/touch input.

export type { InputState } from "../../hooks/useKeyboardInput";
