// Folding a run's events into something renderable (T081).
//
// A run arrives as an ordered event stream and the chat has to draw it while it
// is still arriving. This module is the pure part of that: events in, render
// model out, no store, no DOM, no side effects — so the one genuinely fiddly
// piece of v2's rendering can be reasoned about (and tested) on its own.
//
// The event order the server actually emits, per step, is worth writing down
// because it is the whole reason this is a fold and not a queue:
//
//     text_delta*  →  message(assistant, toolCalls[])  →  tool_call*  →
//     tool_result* / message(tool)*  →  (next step)  →  run_finished
//
// The assistant `message` lands BEFORE its tool calls execute, and it carries
// the AUTHORITATIVE `toolCalls[]` — every tool the model invoked that turn,
// editor and otherwise. So a reply's tool row is drawn from that array, and the
// `tool_call`/`tool_result` events only supply live STATUS for chips already on
// screen. Chips whose call id no chip row claims (a stream that arrives out of
// the usual order) are kept as "loose" so nothing the agent did goes unshown.

import type { TranscriptMessage } from "../types";
import type { RunEvent } from "./client";

export type LiveToolStatus = "running" | "done" | "cancelled";

export interface LiveToolCall {
  callId: string;
  name: string;
  args: string;
  /** "frontend" tools are this app's (or another surface's) to execute. */
  execution: string;
  status: LiveToolStatus;
}

/** Everything one in-flight run contributes to the chat pane. */
export interface RunProjection {
  runId: string;
  conversationId: string;
  /** Reply text streamed since the last settled assistant message. */
  text: string;
  /** Which assistant message the current deltas belong to. */
  boundMessageId: string | null;
  /** Every tool call seen this run, in call order, with live status. */
  tools: LiveToolCall[];
  /** Messages the server settled during this run, in order, deduped by id. */
  finalized: TranscriptMessage[];
  finished: boolean;
  finishReason: string | null;
  error: string | null;
}

export function emptyProjection(runId: string, conversationId: string): RunProjection {
  return {
    runId,
    conversationId,
    text: "",
    boundMessageId: null,
    tools: [],
    finalized: [],
    finished: false,
    finishReason: null,
    error: null,
  };
}

function str(value: unknown): string {
  return typeof value === "string" ? value : "";
}

/**
 * Apply one event. Returns the SAME object when the event changes nothing, so a
 * store can skip the re-render (pings and reasoning deltas are most of the
 * traffic on a thinking model).
 */
export function projectRunEvent(state: RunProjection, event: RunEvent): RunProjection {
  switch (event.type) {
    case "text_delta": {
      const delta = str(event.delta);
      if (!delta) return state;
      const messageId = str(event.messageId) || null;
      // One step can produce several assistant messages before any of them
      // settles; keep them in one bubble, separated by a blank line.
      const separator = state.boundMessageId && messageId && messageId !== state.boundMessageId ? "\n\n" : "";
      return { ...state, text: state.text + separator + delta, boundMessageId: messageId ?? state.boundMessageId };
    }

    case "tool_call": {
      const callId = str(event.callId);
      if (!callId || state.tools.some((t) => t.callId === callId)) return state;
      return {
        ...state,
        tools: [
          ...state.tools,
          {
            callId,
            name: str(event.name),
            args: str(event.args),
            execution: str(event.execution) || "frontend",
            status: "running",
          },
        ],
      };
    }

    case "tool_result":
      return withToolStatus(state, str(event.callId), "done");

    case "tool_cancelled":
      return withToolStatus(state, str(event.callId), "cancelled");

    case "message": {
      const message = event.message as TranscriptMessage | undefined;
      if (!message || typeof message.id !== "string") return state;
      const index = state.finalized.findIndex((m) => m.id === message.id);
      const finalized =
        index >= 0
          ? state.finalized.map((m, i) => (i === index ? message : m))
          : [...state.finalized, message];
      // An assistant message settles whatever was streaming: its own text is
      // now in `finalized`, and its `toolCalls[]` is the authoritative row.
      const settles = message.role === "assistant";
      return {
        ...state,
        finalized,
        text: settles ? "" : state.text,
        boundMessageId: settles ? null : state.boundMessageId,
      };
    }

    case "run_finished": {
      const reason = str(event.reason) || "completed";
      return {
        ...state,
        finished: true,
        finishReason: reason,
        error: reason === "error" ? str(event.error) || "The agent run failed." : null,
        // Anything still marked running never got a result — the run is over.
        tools: state.tools.map((t) => (t.status === "running" ? { ...t, status: "cancelled" } : t)),
      };
    }

    default:
      return state;
  }
}

function withToolStatus(state: RunProjection, callId: string, status: LiveToolStatus): RunProjection {
  if (!callId) return state;
  const index = state.tools.findIndex((t) => t.callId === callId);
  if (index < 0 || state.tools[index].status === status) return state;
  const tools = state.tools.slice();
  tools[index] = { ...tools[index], status };
  return { ...state, tools };
}

/** Call ids still executing — the chips that should render a "running" state. */
export function runningCallIds(state: RunProjection | null): string[] {
  if (!state) return [];
  return state.tools.filter((t) => t.status === "running").map((t) => t.callId);
}

/**
 * Merge a freshly-read transcript with what this run projected.
 *
 * The server saves the transcript before it emits `run_finished`, but the two
 * are not one atomic step, so a re-read straight after the run can miss the last
 * message. Disk wins where the two overlap; anything the run settled that disk
 * has not caught up with is appended rather than dropped.
 */
export function mergeTranscript(fromDisk: TranscriptMessage[], projected: TranscriptMessage[]): TranscriptMessage[] {
  const seen = new Set(fromDisk.map((m) => m.id));
  const extra = projected.filter((m) => !seen.has(m.id));
  return extra.length === 0 ? fromDisk : [...fromDisk, ...extra];
}
