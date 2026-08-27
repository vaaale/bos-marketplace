"use client";

// Scrollable transcript (T070). Sticks to the bottom while the user is already
// there; if they have scrolled up to read something, a streaming reply must not
// yank them back down.
//
// What it draws is the ACTIVE conversation, whichever document tab happens to
// be frontmost — the chat is global across tabs, and switching conversations is
// the only thing that changes what is shown here.

import { useEffect, useRef } from "react";
import { AlertTriangle, Loader2, MessageSquare, PlugZap } from "lucide-react";
import { MessageBubble } from "./message-bubble";
import type { ChatMessage } from "../../types";

const STICK_THRESHOLD_PX = 80;

export function ChatMessages({
  messages,
  conversationId,
  loading,
  /** The assistant itself is unusable — a revoked capability, or no agents. */
  unavailable,
  /** A conversation's transcript could not be read; shown as a banner, because
   *  by the time it renders the app has already moved on to the next one. */
  transcriptError,
}: {
  messages: ChatMessage[];
  conversationId: string | null;
  loading?: boolean;
  unavailable?: string | null;
  transcriptError?: string | null;
}) {
  const scrollRef = useRef<HTMLDivElement | null>(null);
  const stick = useRef(true);

  const lastLength = messages.length;
  const lastContent = messages[messages.length - 1]?.content.length ?? 0;
  const lastId = messages[messages.length - 1]?.id ?? "";

  useEffect(() => {
    const el = scrollRef.current;
    if (!el || !stick.current) return;
    el.scrollTop = el.scrollHeight;
  }, [lastLength, lastContent, lastId]);

  // Switching conversations starts at the bottom of the new one, the same place
  // the user left every other one.
  useEffect(() => {
    stick.current = true;
    const el = scrollRef.current;
    if (el) el.scrollTop = el.scrollHeight;
  }, [conversationId]);

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
      {!unavailable && transcriptError && (
        <div className="ate-chat-banner" data-testid="ate-transcript-error">
          <AlertTriangle size={13} strokeWidth={2} />
          <span>
            <strong>{transcriptError}</strong> — that conversation is no longer on disk, so it has been removed
            from the list.
          </span>
        </div>
      )}

      {unavailable ? (
        <div className="ate-chat-empty" data-testid="ate-assistant-unavailable">
          <div className="ate-empty-icon">
            <PlugZap size={22} strokeWidth={1.6} />
          </div>
          <h3>Assistant unavailable</h3>
          <p>
            {unavailable} The editor still works — open, edit and save documents as usual. Grant this app the
            Assistant capability in Settings → Apps to bring the chat back.
          </p>
        </div>
      ) : loading && messages.length === 0 ? (
        <div className="ate-chat-empty" data-testid="ate-transcript-loading">
          <Loader2 size={20} strokeWidth={1.7} className="ate-typing" />
          <h3>Loading conversation…</h3>
        </div>
      ) : messages.length === 0 ? (
        <div className="ate-chat-empty" data-testid="ate-chat-empty">
          <div className="ate-empty-icon">
            <MessageSquare size={22} strokeWidth={1.6} />
          </div>
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
