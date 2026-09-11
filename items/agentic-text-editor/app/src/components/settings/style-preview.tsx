"use client";

// The live-preview column beside the style editor (v3): the fenced-div source,
// a box styled with the CURRENT draft CSS (restyled on every keystroke), and —
// under a divider — the permanent neutral-fallback box (the "content is never
// dropped" guarantee made visible).
//
// The box uses the same `boxCss` value the markdown renderer embeds in a
// fenced-div's style attribute, so what the user tunes here is exactly what a
// document preview renders.

import { useLayoutEffect, useRef, type ReactNode } from "react";
import { CircleDot, Code2 } from "lucide-react";
import { boxCss, NEUTRAL_STYLE } from "../../config/custom-styles";

const SAMPLE_TEXT =
  "This is how text inside the style renders in a document — a short paragraph to show the container, border, padding and color.";

/**
 * A div whose inline style IS a CSS declaration-block string. React's `style`
 * prop wants an object, but the registry deals in raw declaration blocks (they
 * go verbatim — escaped — into the renderer's style attribute), so this sets
 * `style.cssText` directly. Class styles still apply underneath; the cssText
 * carries only the style's own declarations. Shared by the live-preview box,
 * the list swatches and the neutral-fallback box.
 */
export function CssBox({
  css,
  className,
  children,
  testId,
}: {
  css: string;
  className?: string;
  children?: ReactNode;
  testId?: string;
}) {
  const ref = useRef<HTMLDivElement | null>(null);
  useLayoutEffect(() => {
    if (ref.current) ref.current.style.cssText = css;
  }, [css]);
  return (
    <div ref={ref} className={className} data-testid={testId}>
      {children}
    </div>
  );
}

export function StylePreview({ name, css }: { name: string; css: string }) {
  return (
    <div className="ate-cs-preview" data-testid="ate-cs-preview">
      <div className="ate-cs-preview-head">
        <Code2 size={14} strokeWidth={1.9} />
        Live preview
        <span className="ate-pill ate-pill-green">updates as you type</span>
      </div>

      <div className="ate-cs-src">
        <span className="ate-cs-src-delim">:::</span> {'{custom-style="'}
        <span className="ate-cs-src-name">{name}</span>
        {'"}'}
        {"\n"}A block of styled content…{"\n"}
        <span className="ate-cs-src-delim">:::</span>
      </div>

      <CssBox css={boxCss(css)} className="ate-cs-box" testId="ate-cs-live-box">
        <span className="ate-cs-sample">{SAMPLE_TEXT}</span>
      </CssBox>

      <div className="ate-cs-divider" />

      <div className="ate-cs-fallback-head">
        <CircleDot size={13} strokeWidth={1.9} />
        Fallback · unknown style
        <span className="ate-cs-fallback-sub">content is never dropped</span>
      </div>
      <CssBox css={boxCss(NEUTRAL_STYLE.css)} className="ate-cs-box" testId="ate-cs-neutral-box">
        <span className="ate-cs-sample">
          A fenced div whose name isn’t in the registry still renders — just neutral. No crash, no lost content.
        </span>
      </CssBox>
    </div>
  );
}
