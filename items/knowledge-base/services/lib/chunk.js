"use strict";

// Episode chunking (design.md §5.3). Graphiti's native unit of input is the
// *episode*, not a chunk — the worker decides how a document maps to one or
// more episodes. Default: one document = one episode. Large documents are
// split so each episode stays within the structured-output LLM's context and
// keeps provenance granular (a passage citation should point at a reasonably
// small piece of the source, not an entire book).

// A soft cap in characters, not tokens — good enough for "stay well within
// context" without pulling in a tokenizer dependency; ~4 chars/token puts
// this around 3-4k tokens, comfortably inside any modern chat-completion
// context even after the entity/fact-extraction prompt overhead.
const MAX_EPISODE_CHARS = 12000;

/** Splits `text` on Markdown-style ATX headings (`# `..`###### `), keeping
 *  each heading with the section that follows it. Returns `null` if no
 *  headings are found (caller falls back to paragraph packing). */
function splitByHeadings(text) {
  const lines = text.split("\n");
  const headingIdx = [];
  lines.forEach((line, i) => {
    if (/^#{1,6}\s+\S/.test(line)) headingIdx.push(i);
  });
  if (headingIdx.length < 2) return null;

  const sections = [];
  for (let i = 0; i < headingIdx.length; i++) {
    const start = headingIdx[i];
    const end = i + 1 < headingIdx.length ? headingIdx[i + 1] : lines.length;
    const section = lines.slice(start, end).join("\n").trim();
    if (section) sections.push(section);
  }
  const preamble = lines.slice(0, headingIdx[0]).join("\n").trim();
  if (preamble) sections.unshift(preamble);
  return sections;
}

/** Greedily packs paragraphs into chunks no larger than MAX_EPISODE_CHARS. A
 *  single paragraph longer than the cap is kept whole (never mid-sentence
 *  truncated) rather than split further. */
function packParagraphs(text) {
  const paragraphs = text.split(/\n{2,}/).map((p) => p.trim()).filter(Boolean);
  const chunks = [];
  let current = "";
  for (const para of paragraphs) {
    const candidate = current ? `${current}\n\n${para}` : para;
    if (candidate.length > MAX_EPISODE_CHARS && current) {
      chunks.push(current);
      current = para;
    } else {
      current = candidate;
    }
  }
  if (current) chunks.push(current);
  return chunks.length > 0 ? chunks : [text];
}

/** Splits `sections` (already-heading-bounded) further if any individual
 *  section still exceeds the cap. */
function packSections(sections) {
  const chunks = [];
  for (const section of sections) {
    if (section.length <= MAX_EPISODE_CHARS) {
      chunks.push(section);
    } else {
      chunks.push(...packParagraphs(section));
    }
  }
  return chunks;
}

/** Returns an array of episode body strings for one document's extracted
 *  text. A single-element array means "one document = one episode" (the
 *  common case). */
function chunkText(text) {
  const trimmed = text.trim();
  if (trimmed.length <= MAX_EPISODE_CHARS) return [trimmed];
  const byHeadings = splitByHeadings(trimmed);
  return byHeadings ? packSections(byHeadings) : packParagraphs(trimmed);
}

module.exports = { chunkText, MAX_EPISODE_CHARS };
