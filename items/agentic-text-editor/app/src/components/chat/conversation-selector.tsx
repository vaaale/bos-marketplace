"use client";

// The conversation selector (T068, FR-024 / US7).
//
// Lists the conversations THIS app started, most recently used first, each with
// the agent it runs on and when it was last used. The list is the app's own
// index — it is not a listing of the chats directory — so conversations started
// from BOS's own chat are not here, and cannot be.

import { MessageSquare, MessagesSquare } from "lucide-react";
import { Dropdown, DropdownItem } from "./dropdown";
import type { AgentInfo, AppConversation } from "../../types";

const MINUTE = 60_000;
const HOUR = 60 * MINUTE;
const DAY = 24 * HOUR;

/** "just now" · "2:33 PM" · "Yesterday" · "Tuesday" · "12 Mar". */
export function relativeTime(at: number, now = Date.now()): string {
  const delta = now - at;
  if (!Number.isFinite(at) || at <= 0) return "";
  if (delta < MINUTE) return "just now";
  try {
    const then = new Date(at);
    const today = new Date(now);
    const startOfToday = new Date(today.getFullYear(), today.getMonth(), today.getDate()).getTime();
    if (at >= startOfToday) return then.toLocaleTimeString([], { hour: "numeric", minute: "2-digit" });
    if (at >= startOfToday - DAY) return "Yesterday";
    if (at >= startOfToday - 6 * DAY) return then.toLocaleDateString([], { weekday: "long" });
    return then.toLocaleDateString([], { day: "numeric", month: "short" });
  } catch {
    return "";
  }
}

export function ConversationSelector({
  conversations,
  activeId,
  agents,
  disabled,
  onSelect,
}: {
  /** Already ordered most-recent-first by the store. */
  conversations: AppConversation[];
  activeId: string | null;
  agents: AgentInfo[];
  disabled?: boolean;
  onSelect: (conversationId: string) => void;
}) {
  const active = conversations.find((c) => c.id === activeId);
  const agentName = (agentId: string): string =>
    agents.find((a) => a.id === agentId)?.name ?? (agentId === "assistant" ? "Main Assistant" : agentId);

  return (
    <Dropdown
      label={active?.title ?? "New conversation"}
      menuLabel="Conversations"
      align="right"
      title="Select conversation"
      testId="ate-conversation-selector"
      disabled={disabled}
      icon={<MessagesSquare size={14} strokeWidth={1.9} className="ate-selector-icon" />}
    >
      {(close) =>
        conversations.length === 0 ? (
          <div className="ate-menu-empty">No conversations yet.</div>
        ) : (
          conversations.map((conversation) => (
            <DropdownItem
              key={conversation.id}
              icon={<MessageSquare size={15} strokeWidth={1.9} />}
              name={conversation.title}
              sub={`${agentName(conversation.agentId)} · ${relativeTime(conversation.lastActiveAt)}`}
              active={conversation.id === activeId}
              testId={`ate-conversation-option-${conversation.id}`}
              onSelect={() => {
                close();
                onSelect(conversation.id);
              }}
            />
          ))
        )
      }
    </Dropdown>
  );
}
