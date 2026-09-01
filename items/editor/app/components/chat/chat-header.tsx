"use client";

// Chat header (T018). The status dot is the agent's liveness: green when idle,
// pulsing violet while a run is in flight.

import { Square, Trash2 } from "lucide-react";

export function ChatHeader({
  busy,
  hasMessages,
  onStop,
  onClear,
}: {
  busy: boolean;
  hasMessages: boolean;
  onStop: () => void;
  onClear: () => void;
}) {
  return (
    <div className="ate-chat-header">
      <div className="ate-online-dot" data-busy={busy} data-testid="ate-agent-status" />
      <h2>Chat with Agent</h2>
      {busy ? (
        <button className="ate-btn-icon" onClick={onStop} aria-label="Stop the agent" title="Stop">
          <Square size={13} strokeWidth={2} />
        </button>
      ) : (
        <button
          className="ate-btn-icon"
          onClick={onClear}
          disabled={!hasMessages}
          aria-label="Clear the conversation"
          title="Clear conversation"
        >
          <Trash2 size={13} strokeWidth={1.9} />
        </button>
      )}
    </div>
  );
}
