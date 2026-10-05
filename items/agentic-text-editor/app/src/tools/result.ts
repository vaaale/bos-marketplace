// The shape every tool result shares, and the guard every handler runs behind.
//
// Extracted when the style tools (v4) arrived: two tool modules that each
// invent their own `{ok: false}` would drift, and a result the model can't
// pattern-match on is a result it reasons about badly. One `ok`, one `fail`,
// one `guarded`.

import type { ToolHandler } from "../types";

/** A trimmed non-empty string argument, or undefined. */
export function str(args: Record<string, unknown>, key: string): string | undefined {
  const v = args[key];
  return typeof v === "string" && v.trim() ? v : undefined;
}

export function ok(payload: Record<string, unknown>): string {
  return JSON.stringify({ ok: true, ...payload });
}

/**
 * A refusal. `extra` carries the way forward — the tool to call instead, the
 * names that do exist — because a bare "no" is what makes an agent retry the
 * same call with the same arguments.
 */
export function fail(message: string, extra?: Record<string, unknown>): string {
  return JSON.stringify({ ok: false, error: message, ...extra });
}

/** Run a handler, turning any throw into a structured error result. */
export function guarded(handler: ToolHandler): ToolHandler {
  return async (args) => {
    try {
      return await handler(args);
    } catch (err) {
      return fail((err as Error).message);
    }
  };
}

export function truncate(s: string, max: number): string {
  return s.length <= max ? s : `${s.slice(0, max)}…`;
}
