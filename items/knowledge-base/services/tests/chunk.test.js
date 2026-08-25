"use strict";

const { test, describe } = require("node:test");
const assert = require("node:assert/strict");
const { chunkText, MAX_EPISODE_CHARS } = require("../lib/chunk");

describe("chunkText", () => {
  test("short text stays one episode", () => {
    const chunks = chunkText("A short document about architecture.");
    assert.equal(chunks.length, 1);
  });

  test("long headed document splits by heading, keeping heading with its section", () => {
    const section = "x".repeat(MAX_EPISODE_CHARS / 2);
    const text = `# Intro\n${section}\n\n## Details\n${section}\n\n## More\n${section}`;
    const chunks = chunkText(text);
    assert.ok(chunks.length >= 2);
    assert.match(chunks[0], /^# Intro/);
  });

  test("long unheaded document packs paragraphs under the cap", () => {
    const para = "y".repeat(200);
    const text = Array.from({ length: 200 }, () => para).join("\n\n");
    const chunks = chunkText(text);
    assert.ok(chunks.length > 1);
    for (const c of chunks) assert.ok(c.length <= MAX_EPISODE_CHARS);
  });

  test("a single paragraph longer than the cap is kept whole, not truncated", () => {
    const huge = "z".repeat(MAX_EPISODE_CHARS * 2);
    const chunks = chunkText(huge);
    assert.equal(chunks.length, 1);
    assert.equal(chunks[0].length, huge.length);
  });
});
