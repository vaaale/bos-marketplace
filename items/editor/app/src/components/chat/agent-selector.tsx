"use client";

// The agent selector (T059, FR-023 / US6).
//
// Which agent drives this chat, picked from the ones BrowserOS has registered:
// the Main Assistant plus every agent the user has defined. Selecting one
// re-binds the ACTIVE conversation, so the label always says what the next
// message will actually run on.
//
// BOS exposes no per-agent icon — the agent record carries id, name,
// description and type, and BOS's own picker uses a single generic glyph. So
// the menu does the same thing the mockup does: sparkles for the Main
// Assistant, a bot for everyone else. Nothing here invents an avatar.

import { Bot, Sparkles } from "lucide-react";
import { Dropdown, DropdownItem } from "./dropdown";
import type { AgentInfo } from "../../types";

const MAIN_ASSISTANT_ID = "assistant";

function AgentGlyph({ agentId, size = 15 }: { agentId: string; size?: number }) {
  return agentId === MAIN_ASSISTANT_ID ? (
    <Sparkles size={size} strokeWidth={1.9} />
  ) : (
    <Bot size={size} strokeWidth={1.9} />
  );
}

export function AgentSelector({
  agents,
  selectedAgentId,
  disabled,
  onSelect,
}: {
  agents: AgentInfo[];
  selectedAgentId: string;
  disabled?: boolean;
  onSelect: (agentId: string) => void;
}) {
  const selected = agents.find((a) => a.id === selectedAgentId);
  const label = selected?.name ?? (selectedAgentId === MAIN_ASSISTANT_ID ? "Main Assistant" : selectedAgentId);

  return (
    <Dropdown
      label={label}
      menuLabel="Agents"
      align="left"
      title="Select agent"
      testId="ate-agent-selector"
      disabled={disabled || agents.length === 0}
      icon={<Sparkles size={14} strokeWidth={1.9} className="ate-selector-icon ate-accent-icon" />}
    >
      {(close) =>
        agents.map((agent) => (
          <DropdownItem
            key={agent.id}
            icon={<AgentGlyph agentId={agent.id} />}
            name={agent.name}
            sub={agent.id === MAIN_ASSISTANT_ID ? "default" : agent.description || undefined}
            active={agent.id === selectedAgentId}
            testId={`ate-agent-option-${agent.id}`}
            onSelect={() => {
              close();
              onSelect(agent.id);
            }}
          />
        ))
      }
    </Dropdown>
  );
}
