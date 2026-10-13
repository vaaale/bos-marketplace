// Types for mdparse.mjs (plain JS so the item's node tests can run it).
export type Inline =
  | { t: "text"; v: string }
  | { t: "code"; v: string }
  | { t: "strong" | "em" | "del"; children: Inline[] }
  | { t: "link"; href: string; children: Inline[] }
  | { t: "image"; alt: string; src: string };

export type ListItem = { text: string; children: Block[] };

export type Block =
  | { type: "paragraph"; text: string }
  | { type: "heading"; level: number; text: string }
  | { type: "hr" }
  | { type: "code"; lang: string; text: string }
  | { type: "blockquote"; children: Block[] }
  | { type: "list"; ordered: boolean; start?: number; items: ListItem[] }
  | { type: "table"; header: string[]; align: ("left" | "right" | "center" | null)[]; rows: string[][] };

export function parseBlocks(source: string): Block[];
export function parseInline(text: string): Inline[];
