"use strict";

const { test, describe } = require("node:test");
const assert = require("node:assert/strict");
const path = require("path");
const fs = require("fs");
const extract = require("../lib/extract");
const { stripMarkdown } = require("../lib/extract/md");

describe("extractText", () => {
  test("txt — decodes UTF-8", async () => {
    const text = await extract.extractText("a.txt", Buffer.from("hello world"));
    assert.equal(text, "hello world");
  });

  test("md — strips markup to plain text", () => {
    const out = stripMarkdown("# Title\n\nSome **bold** and `code` and a [link](http://x).");
    assert.match(out, /^Title/);
    assert.doesNotMatch(out, /[*`[\]]/);
  });

  test("html — strips scripts/styles, keeps body text", async () => {
    const html = "<html><head><title>T</title><script>bad()</script></head><body><nav>nav</nav><p>Hi there</p></body></html>";
    const text = await extract.extractText("a.html", Buffer.from(html));
    assert.match(text, /Hi there/);
    assert.doesNotMatch(text, /bad\(\)/);
    assert.doesNotMatch(text, /\bnav\b/);
  });

  test("xlsx — extracts cell text per sheet", async () => {
    const XLSX = require("xlsx");
    const wb = XLSX.utils.book_new();
    const ws = XLSX.utils.aoa_to_sheet([["a", "b"], [1, 2]]);
    XLSX.utils.book_append_sheet(wb, ws, "Sheet1");
    const buf = XLSX.write(wb, { type: "buffer", bookType: "xlsx" });
    const text = await extract.extractText("a.xlsx", buf);
    assert.match(text, /Sheet1/);
    assert.match(text, /a\tb/);
  });

  test("pptx — pulls <a:t> runs in slide order", async () => {
    const JSZip = require("jszip");
    const zip = new JSZip();
    zip.file("ppt/slides/slide1.xml", '<p:sld xmlns:a="http://x"><a:t>Hello</a:t><a:t> One</a:t></p:sld>');
    zip.file("ppt/slides/slide2.xml", '<p:sld xmlns:a="http://x"><a:t>Two &amp; done</a:t></p:sld>');
    const buf = await zip.generateAsync({ type: "nodebuffer" });
    const text = await extract.extractText("deck.pptx", buf);
    assert.match(text, /Slide 1: Hello One/);
    assert.match(text, /Slide 2: Two & done/);
  });

  test("docx — extracts raw paragraph text", async () => {
    const fixture = path.join(__dirname, "..", "node_modules", "mammoth", "test", "test-data", "single-paragraph.docx");
    const buf = fs.readFileSync(fixture);
    const text = await extract.extractText("a.docx", buf);
    assert.match(text, /Walking on imported air/);
  });

  test("unsupported extension throws a descriptive error", async () => {
    await assert.rejects(() => extract.extractText("a.exe", Buffer.from("x")), /Unsupported file type/);
  });

  test("empty text throws a descriptive error", async () => {
    await assert.rejects(() => extract.extractText("a.txt", Buffer.from("   \n  ")), /No extractable text/);
  });
});
