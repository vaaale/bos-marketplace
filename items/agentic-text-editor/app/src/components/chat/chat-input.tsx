"use client";

// Chat input (T071). Enter sends, Shift+Enter adds a newline, and the field
// grows with the message up to the max-height the stylesheet sets.
//
// A send goes to the ACTIVE conversation on the SELECTED agent — the store owns
// both, so this component stays a text box with a button.

import { useEffect, useRef, useState } from "react";
import { ArrowUp } from "lucide-react";

export function ChatInput({
  busy,
  disabled,
  onSend,
}: {
  busy: boolean;
  /** The assistant is unusable; the box explains rather than pretending. */
  disabled?: boolean;
  onSend: (text: string) => void;
}) {
  const [value, setValue] = useState("");
  const ref = useRef<HTMLTextAreaElement | null>(null);

  useEffect(() => {
    const el = ref.current;
    if (!el) return;
    el.style.height = "auto";
    el.style.height = `${Math.min(140, el.scrollHeight)}px`;
  }, [value]);

  const send = (): void => {
    const text = value.trim();
    if (!text || busy || disabled) return;
    setValue("");
    onSend(text);
  };

  return (
    <div className="ate-chat-input-area">
      <div className="ate-chat-input-wrap" data-disabled={disabled || undefined}>
        <textarea
          ref={ref}
          className="ate-chat-input"
          data-testid="ate-chat-input"
          rows={1}
          disabled={disabled}
          placeholder={disabled ? "The assistant is unavailable." : "Type your message..."}
          aria-label="Message the agent"
          value={value}
          onChange={(e) => setValue(e.target.value)}
          onKeyDown={(e) => {
            if (e.key === "Enter" && !e.shiftKey) {
              e.preventDefault();
              send();
            }
          }}
        />
        <button
          className="ate-send-btn"
          onClick={send}
          disabled={busy || disabled || value.trim().length === 0}
          aria-label="Send message"
          data-testid="ate-chat-send"
        >
          <ArrowUp size={16} strokeWidth={2.2} />
        </button>
      </div>
    </div>
  );
}
