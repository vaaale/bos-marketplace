"use client";

// Draggable divider between the editor and chat panes (T012).
//
// Pointer capture rather than window listeners: the drag keeps tracking even
// when the cursor leaves the iframe, and there is exactly one teardown path.

import { useCallback, useRef, useState } from "react";
import { clampSplit } from "../state/document-store";

export function Resizer({
  containerRef,
  onResize,
}: {
  containerRef: React.RefObject<HTMLDivElement | null>;
  onResize: (percent: number) => void;
}) {
  const [dragging, setDragging] = useState(false);
  const frame = useRef<number | null>(null);

  const apply = useCallback(
    (clientX: number) => {
      const rect = containerRef.current?.getBoundingClientRect();
      if (!rect || rect.width === 0) return;
      if (frame.current !== null) cancelAnimationFrame(frame.current);
      frame.current = requestAnimationFrame(() => {
        onResize(clampSplit(((clientX - rect.left) / rect.width) * 100));
      });
    },
    [containerRef, onResize],
  );

  return (
    <div
      className="ate-resizer"
      data-dragging={dragging}
      data-testid="ate-resizer"
      role="separator"
      aria-orientation="vertical"
      aria-label="Resize editor and chat panes"
      onPointerDown={(e) => {
        e.preventDefault();
        e.currentTarget.setPointerCapture(e.pointerId);
        document.body.classList.add("ate-resizing");
        setDragging(true);
      }}
      onPointerMove={(e) => {
        if (!dragging) return;
        apply(e.clientX);
      }}
      onPointerUp={(e) => {
        if (!dragging) return;
        e.currentTarget.releasePointerCapture(e.pointerId);
        document.body.classList.remove("ate-resizing");
        setDragging(false);
      }}
      onLostPointerCapture={() => {
        document.body.classList.remove("ate-resizing");
        setDragging(false);
      }}
    />
  );
}
