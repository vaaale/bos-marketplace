"use client";

// Chat header (T061 / T069).
//
// Layout, left to right: the liveness dot, the agent selector, a spacer, then
// the conversation controls — new, and switch. The two ends answer two
// different questions ("who am I talking to" / "about what"), which is why the
// mockup pushes them apart rather than grouping all four controls together.
//
// The stop button only exists while a run is in flight. v1 kept a permanent
// stop/clear button here; v2 has no "clear", because the transcript is
// server-owned — starting a new conversation is what "clear" was for.

import { Plus, Square } from "lucide-react";
import { AgentSelector } from "./agent-selector";
import { ConversationSelector } from "./conversation-selector";
import type { AgentInfo, AppConversation } from "../../types";

export function ChatHeader({
  busy,
  agents,
  selectedAgentId,
  conversations,
  activeConversationId,
  disabled,
  onSelectAgent,
  onNewConversation,
  onSelectConversation,
  onStop,
}: {
  busy: boolean;
  agents: AgentInfo[];
  selectedAgentId: string;
  /** Most-recent-first. */
  conversations: AppConversation[];
  activeConversationId: string | null;
  /** The assistant is unavailable — the controls stay visible but inert. */
  disabled?: boolean;
  onSelectAgent: (agentId: string) => void;
  onNewConversation: () => void;
  onSelectConversation: (conversationId: string) => void;
  onStop: () => void;
}) {
  return (
    <div className="ate-chat-header">
      <div className="ate-online-dot" data-busy={busy} data-testid="ate-agent-status" />

      <AgentSelector
        agents={agents}
        selectedAgentId={selectedAgentId}
        disabled={disabled}
        onSelect={onSelectAgent}
      />

      <div className="ate-header-spacer" />

      {busy && (
        <button
          className="ate-header-icon-btn"
          type="button"
          onClick={onStop}
          aria-label="Stop the agent"
          title="Stop"
          data-testid="ate-stop-run"
        >
          <Square size={14} strokeWidth={2} />
        </button>
      )}

      <button
        className="ate-header-icon-btn"
        type="button"
        onClick={onNewConversation}
        disabled={disabled}
        aria-label="New conversation"
        title="New conversation"
        data-testid="ate-new-conversation"
      >
        <Plus size={15} strokeWidth={2} />
      </button>

      <ConversationSelector
        conversations={conversations}
        activeId={activeConversationId}
        agents={agents}
        disabled={disabled}
        onSelect={onSelectConversation}
      />
    </div>
  );
}
