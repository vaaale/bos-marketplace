"use strict";

const JSZip = require("jszip");

// PPTX is a zip of per-slide DrawingML XML (ppt/slides/slideN.xml). Each text
// run's content lives in an <a:t> element — pulling those out (in slide
// order) is sufficient for entity/fact extraction without a full OOXML
// parser (design.md §5.4: "PPTX (unzip+XML) — slide text extraction").
function slideTextFromXml(xml) {
  const runs = [];
  const re = /<a:t>([^<]*)<\/a:t>/g;
  let match;
  while ((match = re.exec(xml)) !== null) {
    runs.push(decodeXmlEntities(match[1]));
  }
  return runs.join(" ").replace(/\s+/g, " ").trim();
}

function decodeXmlEntities(text) {
  return text
    .replace(/&lt;/g, "<")
    .replace(/&gt;/g, ">")
    .replace(/&quot;/g, '"')
    .replace(/&apos;/g, "'")
    .replace(/&amp;/g, "&");
}

function slideNumber(name) {
  const match = /slide(\d+)\.xml$/.exec(name);
  return match ? Number(match[1]) : Number.MAX_SAFE_INTEGER;
}

async function extractPptx(buffer) {
  const zip = await JSZip.loadAsync(buffer);
  const slideFiles = Object.keys(zip.files)
    .filter((name) => /^ppt\/slides\/slide\d+\.xml$/.test(name))
    .sort((a, b) => slideNumber(a) - slideNumber(b));

  const slides = [];
  for (const name of slideFiles) {
    const xml = await zip.files[name].async("string");
    const text = slideTextFromXml(xml);
    if (text) slides.push(`Slide ${slideNumber(name)}: ${text}`);
  }
  return slides.join("\n\n");
}

module.exports = { extractPptx };
