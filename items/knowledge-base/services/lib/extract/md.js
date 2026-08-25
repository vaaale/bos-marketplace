"use strict";

// Strips common Markdown markup down to plain readable text — good enough
// for embedding/entity extraction, which cares about content, not formatting.
function stripMarkdown(md) {
  return md
    .replace(/```[\s\S]*?```/g, (block) => block.replace(/```[a-zA-Z0-9]*\n?/g, "").replace(/```/g, ""))
    .replace(/`([^`]+)`/g, "$1")
    .replace(/!\[([^\]]*)\]\([^)]*\)/g, "$1")
    .replace(/\[([^\]]*)\]\([^)]*\)/g, "$1")
    .replace(/^#{1,6}\s+/gm, "")
    .replace(/^>\s?/gm, "")
    .replace(/(\*\*|__)(.*?)\1/g, "$2")
    .replace(/(\*|_)(.*?)\1/g, "$2")
    .replace(/^\s*[-*+]\s+/gm, "- ")
    .replace(/^\s*\d+\.\s+/gm, "")
    .replace(/^-{3,}\s*$/gm, "")
    .replace(/\|/g, " ")
    .replace(/\n{3,}/g, "\n\n")
    .trim();
}

async function extractMd(buffer) {
  return stripMarkdown(buffer.toString("utf8"));
}

module.exports = { extractMd, stripMarkdown };
