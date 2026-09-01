"use client";

// Scrollable transcript (T019). Sticks to the bottom while the user is already
// there; if they have scrolled up to read something, a streaming reply must not
// yank them back down.

import { useEffect, useRef } from "react";
import { MessageSquare } from "lucide-react";
import { MessageBubble } from "./message-bubble";
import type { ChatMessage } from "../../types";

const STICK_THRESHOLD_PX = 80;

export function ChatMessages({ messages }: { messages: ChatMessage[] }) {
  const scrollRef = useRef<HTMLDivElement | null>(null);
  const stick = useRef(true);

  const lastLength = messages.length;
  const lastContent = messages[messages.length - 1]?.content.length ?? 0;

  useEffect(() => {
    const el = scrollRef.current;
    if (!el || !stick.current) return;
    el.scrollTop = el.scrollHeight;
  }, [lastLength, lastContent]);

  return (
    <div
      className="ate-chat-messages"
      ref={scrollRef}
      data-testid="ate-chat-messages"
      onScroll={(e) => {
        const el = e.currentTarget;
        stick.current = el.scrollHeight - el.scrollTop - el.clientHeight < STICK_THRESHOLD_PX;
      }}
    >
      {messages.length === 0 ? (
        <div className="ate-chat-empty">
          <MessageSquare size={26} strokeWidth={1.5} />
          <h3>No messages yet</h3>
          <p>
            Ask the agent to draft, rewrite or clean up the open document — &ldquo;add a summary section&rdquo;,
            &ldquo;delete the first paragraph&rdquo;, &ldquo;open /Documents/notes.md&rdquo;. Edits land in the
            editor immediately and reach disk only when you save.
          </p>
        </div>
      ) : (
        messages.map((m) => <MessageBubble key={m.id} message={m} />)
      )}
    </div>
  );
}
