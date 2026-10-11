// icons.tsx — the mockup's inline SVG icon set, ported 1:1 (same paths, same
// stroke geometry) so the app renders the approved visual contract without
// pulling in an icon dependency.

import React from "react";

const PATHS: Record<string, React.ReactNode> = {
  caret: <path d="M9 6l6 6-6 6" />,
  plus: <path d="M12 5v14M5 12h14" />,
  import: <path d="M12 3v12M7 10l5 5 5-5M5 21h14" />,
  export: <path d="M12 21V9M7 14l5-5 5 5M5 3h14" />,
  trash: <path d="M4 7h16M9 7V4h6v3M6 7l1 14h10l1-14" />,
  search: (
    <>
      <circle cx="11" cy="11" r="7" />
      <path d="M21 21l-4-4" />
    </>
  ),
  eye: (
    <>
      <path d="M2 12s4-7 10-7 10 7 10 7-4 7-10 7S2 12 2 12z" />
      <circle cx="12" cy="12" r="3" />
    </>
  ),
  image: (
    <>
      <rect x="3" y="4" width="18" height="16" rx="2" />
      <circle cx="9" cy="10" r="2" />
      <path d="M21 16l-5-5-8 8" />
    </>
  ),
  play: (
    <>
      <circle cx="12" cy="12" r="9" />
      <path d="M10 8l6 4-6 4z" />
    </>
  ),
  doc: (
    <>
      <path d="M6 3h8l5 5v13H6z" />
      <path d="M14 3v5h5" />
    </>
  ),
  layers: (
    <>
      <path d="M12 3l9 5-9 5-9-5 9-5z" />
      <path d="M3 13l9 5 9-5" />
    </>
  ),
  list: <path d="M8 6h13M8 12h13M8 18h13M3 6h.01M3 12h.01M3 18h.01" />,
  back: <path d="M19 12H5M12 19l-7-7 7-7" />,
  book: (
    <>
      <path d="M4 5a2 2 0 012-2h13v18H6a2 2 0 00-2 2z" />
      <path d="M19 3v18" />
    </>
  ),
  info: (
    <>
      <circle cx="12" cy="12" r="9" />
      <path d="M12 11v5M12 8h.01" />
    </>
  ),
  code: <path d="M9 8l-4 4 4 4M15 8l4 4-4 4" />,
  alert: (
    <>
      <path d="M12 9v4M12 17h.01" />
      <path d="M10.3 3.9L2 18a2 2 0 001.7 3h16.6a2 2 0 001.7-3L13.7 3.9a2 2 0 00-3.4 0z" />
    </>
  ),
  check: <path d="M20 6L9 17l-5-5" />,
  x: <path d="M6 6l12 12M18 6L6 18" />,
  clock: (
    <>
      <circle cx="12" cy="12" r="9" />
      <path d="M12 7v5l3 2" />
    </>
  ),
  zap: <path d="M13 2L4 14h6l-1 8 9-12h-6z" />,
  graph: (
    <>
      <circle cx="6" cy="6" r="2.5" />
      <circle cx="18" cy="8" r="2.5" />
      <circle cx="10" cy="18" r="2.5" />
      <path d="M8 6.5l7.5 1M7 8l1.5 8M16.5 10l-5 5.5" />
    </>
  ),
  refresh: <path d="M21 12a9 9 0 11-3-6.7M21 4v5h-5" />,
};

export type IconName = keyof typeof PATHS;

export function Icon({ name, size = 16, className }: { name: string; size?: number; className?: string }) {
  return (
    <svg
      viewBox="0 0 24 24"
      width={size}
      height={size}
      fill="none"
      stroke="currentColor"
      strokeWidth={1.75}
      strokeLinecap="round"
      strokeLinejoin="round"
      className={className}
      aria-hidden="true"
    >
      {PATHS[name] || null}
    </svg>
  );
}
