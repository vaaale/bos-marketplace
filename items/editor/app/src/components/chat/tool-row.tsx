"use client";

// The reply's tool row (T079, FR-025 / US8).
//
// Every tool the agent invoked that turn, in one row, in two colours: violet
// for the tools that touched the user's documents (`agentic_editor_*`), neutral
// grey for everything else it did to answer — a web search, a file read, a
// memory lookup. The colour is the whole point: the user can see the full shape
// of the turn and still tell at a glance what changed their document.

import {
  Brain,
  Eraser,
  FilePlus2,
  FileText,
  Globe,
  List,
  Pencil,
  Save,
  Search,
  Terminal,
  TextCursorInput,
  Wrench,
} from "lucide-react";
import { getToolChip } from "../../assistant/tool-chip";
import type { ToolCallRef, ToolChipIcon } from "../../types";

const GLYPHS: Record<ToolChipIcon, React.ComponentType<{ size?: number; strokeWidth?: number }>> = {
  pencil: Pencil,
  "text-cursor": TextCursorInput,
  eraser: Eraser,
  "file-text": FileText,
  "file-plus": FilePlus2,
  save: Save,
  search: Search,
  list: List,
  globe: Globe,
  brain: Brain,
  terminal: Terminal,
  wrench: Wrench,
};

export function ToolRow({
  toolCalls,
  runningCallIds,
}: {
  toolCalls: ToolCallRef[];
  /** Calls still executing — the chip dims until its result lands. */
  runningCallIds?: string[];
}) {
  if (!toolCalls || toolCalls.length === 0) return null;
  const running = new Set(runningCallIds ?? []);

  return (
    <div className="ate-tool-row" data-testid="ate-tool-row">
      {toolCalls.map((call, i) => {
        const name = call?.function?.name ?? "";
        const chip = getToolChip(name);
        const Glyph = GLYPHS[chip.icon] ?? Wrench;
        return (
          <span
            key={call?.id || `${name}-${i}`}
            className={`ate-tool-chip ate-${chip.variant}`}
            data-variant={chip.variant}
            data-status={running.has(call?.id) ? "running" : "done"}
            data-tool={name}
            title={name}
          >
            <Glyph size={11} strokeWidth={2.1} />
            {chip.label}
          </span>
        );
      })}
    </div>
  );
}
