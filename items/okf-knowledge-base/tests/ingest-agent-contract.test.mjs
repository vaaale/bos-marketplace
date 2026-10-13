// ingest-agent-contract.test.mjs — what the bundled okf-ingest agent may hold.
//
// Two defects, both visible in production transcripts (2026-10-13):
//
//  • The agent declared `skills: [okf-bundle-schema]` but held no skill_load,
//    so the Skills section of its prompt told it to load a skill it could not.
//    Its first call, run after run, was `skill_patch` with dummy arguments —
//    the only skill tool it could see — as a way to "load" it.
//  • Faced with a converted PDF that had no Markdown headings, it reached for
//    file_write to insert them, and without it re-typed the whole 130K-char
//    document into okf_add_raw_source({content}). Nothing in an ingest writes a
//    file directly: acquisition streams to disk via output_path, raw/ is
//    registered from a path, chapters go through okf_upsert_concept. A
//    file-writing tool only makes the most expensive mistake possible.
//
// An ingest also has no business deleting, merging, importing or exporting a
// knowledge base: those are curation, and they belong to the user.
//
// And acquisition of a page a plain fetch is refused (prod, job run-1022): the
// agent's web_fetch got Cloudflare's 403 on a Medium article, browser_navigate
// loaded it — and the agent had no way to put the page in a file, so it tried
// reader proxies that returned the paywall preview. The task now names the
// browser path (navigate, then browser_save_page to the SAME staged path) and
// the agent holds those tools.
//
//   node --test tests/ingest-agent-contract.test.mjs

import test from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { createRequire } from "node:module";

const core = createRequire(import.meta.url)("../services/lib/okf-core.js");

const SRC = readFileSync(new URL("../agents/okf-ingest/AGENT.md", import.meta.url), "utf8");
const FRONT = SRC.split(/^---$/m)[1];
const list = (key) => {
  const m = FRONT.match(new RegExp(`^${key}:\\s*\\[([^\\]]*)\\]`, "m"));
  return m ? m[1].split(",").map((s) => s.trim()).filter(Boolean) : [];
};
const tools = list("tools");
const BODY = SRC.slice(SRC.indexOf("---", 4) + 3);
const CALL = /`(okf_[a-z_]+|file_[a-z_]+|web_[a-z_]+|skill_[a-z_]+|browser_[a-z_]+|view_image|video_keyframes)\(/g;

test("the ingest agent holds no tool that writes or edits a file", () => {
  for (const t of ["file_write", "file_edit", "file_patch", "file_mkdir", "file_delete", "run_command"]) {
    assert.ok(!tools.includes(t), `${t} would let the agent re-type a source instead of slicing it`);
  }
});

test("the ingest agent cannot delete, merge, import or export a knowledge base", () => {
  for (const t of ["okf_delete_bundle", "okf_delete_concept", "okf_merge_concepts", "okf_import_bundle", "okf_export_bundle", "okf_init_bundle"]) {
    assert.ok(!tools.includes(t), `${t} is curation, not ingestion`);
  }
});

test("a declared skill comes with the means to load it", () => {
  assert.ok(list("skills").length > 0);
  assert.ok(tools.includes("skill_load"), "skills declared but no skill_load — the agent reaches for skill_patch instead");
  assert.ok(tools.includes("skill_read_file"));
});

test("the prompt never tells it to make a heading-less source one chapter, and says it cannot write files", () => {
  assert.doesNotMatch(BODY, /no headings is one chapter/i);
  assert.match(BODY, /no tool that writes or edits a file/i);
  assert.match(BODY, /never re-register|do not re-register/i);
});

test("every tool the prompt tells the agent to CALL is one it holds", () => {
  const called = [...BODY.matchAll(CALL)].map((m) => m[1]);
  const missing = [...new Set(called)].filter((t) => !tools.includes(t));
  assert.deepEqual(missing, [], "the prompt instructs calls to tools the agent does not hold");
});

const task = (source) =>
  core.buildIngestTask({ jobId: "run-1", bundle: "b", source, maxDepth: 1, maxWorkers: 2 });

test("every tool a generated task tells the agent to call is one it holds", () => {
  for (const source of ["https://medium.com/@a/post-1", "https://x.test/report.pdf", "/Documents/a.pdf", "/Documents/a.md"]) {
    const called = [...task(source).matchAll(CALL)].map((m) => m[1]);
    const missing = [...new Set(called)].filter((t) => !tools.includes(t));
    assert.deepEqual(missing, [], `the task for ${source} instructs calls to tools the agent does not hold`);
  }
});

test("a web page's task names the browser path when web_fetch is refused — saved to the SAME staged path", () => {
  const t = task("https://medium.com/@a/post-1");
  const staged = JSON.parse(t.match(/`web_fetch\((\{.*?\})\)`/)[1]).output_path;
  assert.match(t, /`browser_navigate\(\{"url":"https:\/\/medium\.com\/@a\/post-1"\}\)`/);
  assert.ok(t.includes(`\`browser_save_page(${JSON.stringify({ output_path: staged })})\``), "saved where okf_add_raw_source reads it");
  assert.match(t, /`browser_close\(\{\}\)`/);
  assert.match(t, /403|bot check/i);
});

test("a binary download (a PDF URL) gets no browser path — a browser does not save a PDF as a page", () => {
  assert.doesNotMatch(task("https://x.test/report.pdf"), /browser_/);
});
