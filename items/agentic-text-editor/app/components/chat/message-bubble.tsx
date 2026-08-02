"use client";

// One chat bubble: user (right, violet) or agent (left, light), with the tool
// calls the turn made shown as chips beneath it so an edit the agent applied is
// visible in the transcript, not just in the document.

import { Wrench } from "lucide-react";
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
  return (
    <div className={`ate-message ate-${message.role}`} data-testid={`ate-message-${message.role}`}>
      <div className={`ate-bubble${message.error ? " ate-error" : ""}`}>
        {empty && message.streaming ? <span className="ate-typing" aria-label="Agent is thinking" /> : message.content}
      </div>
      {message.toolCalls && message.toolCalls.length > 0 && (
        <div className="ate-tool-chips">
          {message.toolCalls.map((call, i) => (
            <span className="ate-tool-chip" key={`${call.name}-${i}`}>
              <Wrench size={9} strokeWidth={2.2} />
              {call.summary}
            </span>
          ))}
        </div>
      )}
      <div className="ate-msg-time">{formatTime(message.timestamp)}</div>
    </div>
  );
}
