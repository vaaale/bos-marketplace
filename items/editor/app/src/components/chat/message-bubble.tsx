"use client";

// One chat bubble: user (right, violet) or agent (left, light), with the turn's
// tool row beneath it (T080).
//
// v1 showed only the editor tools it had run itself. v2 shows the whole turn —
// the row comes from the message's own `toolCalls[]`, which the server records
// for every tool the model invoked, so a web search the agent did on the way to
// an edit is visible too (FR-025). The timestamp is only drawn when it is
// actually known: persisted messages carry no time, and inventing one would be
// worse than leaving it out.

import { ToolRow } from "./tool-row";
import type { ChatMessage } from "../../types";

function formatTime(ts: number): string {
  try {
    return new Date(ts).toLocaleTimeString([], { hour: "2-digit", minute: "2-digit" });
  } catch {
    return "";
  }
}

export function MessageBubble({ message }: { message: ChatMessage }) {
  const empty = message.content.length === 0;
  const time = typeof message.timestamp === "number" ? formatTime(message.timestamp) : "";
  const showBubble = !empty || !!message.streaming;

  return (
    <div className={`ate-message ate-${message.role}`} data-testid={`ate-message-${message.role}`}>
      {showBubble && (
        <div className={`ate-bubble${message.error ? " ate-error" : ""}`}>
          {empty && message.streaming ? <span className="ate-typing" aria-label="Agent is thinking" /> : message.content}
        </div>
      )}
      <ToolRow toolCalls={message.toolCalls ?? []} runningCallIds={message.runningCallIds} />
      {time && <div className="ate-msg-time">{time}</div>}
    </div>
  );
}
