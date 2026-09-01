"use client";

// The chat header's dropdown shell — shared by the agent and conversation
// selectors so the two behave identically (v2).
//
// The trigger is the mockup's `.selector` pill: an icon, a truncating label, a
// chevron. The menu closes on an outside click, on Escape, and on any choice
// made inside it — which is why the children are a render prop rather than
// nodes: an item has to be able to close the menu it lives in.

import { useEffect, useId, useRef, useState } from "react";
import { ChevronDown } from "lucide-react";

export function Dropdown({
  label,
  icon,
  align = "left",
  title,
  testId,
  disabled,
  menuLabel,
  children,
}: {
  label: string;
  icon: React.ReactNode;
  align?: "left" | "right";
  title?: string;
  testId?: string;
  disabled?: boolean;
  menuLabel: string;
  children: (close: () => void) => React.ReactNode;
}) {
  const [open, setOpen] = useState(false);
  const rootRef = useRef<HTMLDivElement | null>(null);
  const menuId = useId();

  useEffect(() => {
    if (!open) return;
    const onPointerDown = (e: PointerEvent): void => {
      if (!rootRef.current?.contains(e.target as Node)) setOpen(false);
    };
    const onKeyDown = (e: KeyboardEvent): void => {
      if (e.key === "Escape") setOpen(false);
    };
    // Capture phase: an item's own click handler runs first and closes the menu
    // itself, so this only ever fires for a click somewhere else.
    document.addEventListener("pointerdown", onPointerDown, true);
    document.addEventListener("keydown", onKeyDown);
    return () => {
      document.removeEventListener("pointerdown", onPointerDown, true);
      document.removeEventListener("keydown", onKeyDown);
    };
  }, [open]);

  return (
    <div className="ate-dropdown" ref={rootRef}>
      <button
        className="ate-selector"
        type="button"
        title={title}
        disabled={disabled}
        aria-haspopup="menu"
        aria-expanded={open}
        aria-controls={open ? menuId : undefined}
        data-testid={testId}
        onClick={() => setOpen((v) => !v)}
      >
        {icon}
        <span className="ate-selector-label">{label}</span>
        <ChevronDown size={13} strokeWidth={2} className="ate-selector-chevron" />
      </button>

      {open && (
        <div className={`ate-dropdown-menu ate-align-${align}`} id={menuId} role="menu" data-testid={testId ? `${testId}-menu` : undefined}>
          <div className="ate-menu-label">{menuLabel}</div>
          {children(() => setOpen(false))}
        </div>
      )}
    </div>
  );
}

/** One row in a dropdown. `active` is both the check mark and the highlight. */
export function DropdownItem({
  icon,
  name,
  sub,
  active,
  onSelect,
  testId,
}: {
  icon: React.ReactNode;
  name: string;
  sub?: string;
  active: boolean;
  onSelect: () => void;
  testId?: string;
}) {
  return (
    <button
      type="button"
      role="menuitemradio"
      aria-checked={active}
      className={`ate-dropdown-item${active ? " ate-active" : ""}`}
      onClick={onSelect}
      data-testid={testId}
      title={sub ? `${name} — ${sub}` : name}
    >
      <span className="ate-di-icon">{icon}</span>
      <span className="ate-di-text">
        <span className="ate-di-name">{name}</span>
        {sub && <span className="ate-di-sub">{sub}</span>}
      </span>
      {active && (
        <span className="ate-di-check" aria-hidden="true">
          <CheckGlyph />
        </span>
      )}
    </button>
  );
}

function CheckGlyph() {
  // Inlined rather than pulled from lucide so the check keeps the menu's exact
  // 14px metric without a wrapper element fighting the flex row.
  return (
    <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.4" strokeLinecap="round" strokeLinejoin="round">
      <path d="M20 6 9 17l-5-5" />
    </svg>
  );
}
