"use client";

// Tab bar (T014 / T039). Tabs are derived from the store, never held locally,
// so an agent that opens a file gets a tab with no extra wiring. The active tab
// scrolls itself into view, which is what keeps a long tab strip usable.

import { useEffect, useRef } from "react";
import { Plus, X } from "lucide-react";
import type { Tab } from "../../types";

export function TabBar({
  tabs,
  onSelect,
  onClose,
  onNew,
}: {
  tabs: Tab[];
  onSelect: (documentId: string) => void;
  onClose: (documentId: string) => void;
  onNew: () => void;
}) {
  const activeRef = useRef<HTMLButtonElement | null>(null);
  const activeId = tabs.find((t) => t.isActive)?.documentId;

  useEffect(() => {
    activeRef.current?.scrollIntoView({ block: "nearest", inline: "nearest" });
  }, [activeId, tabs.length]);

  return (
    <div className="ate-tab-bar" role="tablist" aria-label="Open documents" data-testid="ate-tab-bar">
      {tabs.map((tab) => (
        <button
          key={tab.documentId}
          ref={tab.isActive ? activeRef : undefined}
          role="tab"
          aria-selected={tab.isActive}
          title={tab.visibleName}
          className={`ate-tab${tab.isActive ? " ate-active" : ""}`}
          onClick={() => onSelect(tab.documentId)}
          onAuxClick={(e) => {
            if (e.button === 1) onClose(tab.documentId); // middle-click closes
          }}
          data-testid={`ate-tab-${tab.visibleName}`}
        >
          {tab.isDirty && <span className="ate-tab-dot" aria-label="Unsaved changes" />}
          <span>{tab.visibleName}</span>
          <span
            className="ate-tab-close"
            role="button"
            tabIndex={-1}
            aria-label={`Close ${tab.visibleName}`}
            onClick={(e) => {
              e.stopPropagation();
              onClose(tab.documentId);
            }}
          >
            <X size={11} strokeWidth={2.4} />
          </span>
        </button>
      ))}
      <button className="ate-tab-add" onClick={onNew} aria-label="New document" title="New document">
        <Plus size={13} strokeWidth={2} />
      </button>
    </div>
  );
}
