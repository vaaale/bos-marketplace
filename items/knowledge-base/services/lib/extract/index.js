"use strict";

const path = require("path");
const { extractTxt } = require("./txt");
const { extractMd } = require("./md");
const { extractHtml } = require("./html");
const { extractDocx } = require("./docx");
const { extractXlsx } = require("./xlsx");
const { extractPdf } = require("./pdf");
const { extractPptx } = require("./pptx");

const BY_EXTENSION = {
  ".txt": extractTxt,
  ".md": extractMd,
  ".markdown": extractMd,
  ".html": extractHtml,
  ".htm": extractHtml,
  ".docx": extractDocx,
  ".xlsx": extractXlsx,
  ".xls": extractXlsx,
  ".pdf": extractPdf,
  ".pptx": extractPptx,
};

const SUPPORTED_EXTENSIONS = Object.keys(BY_EXTENSION);

/** Extracts plain text from `buffer` based on `name`'s extension. Throws a
 *  descriptive error for an unsupported/corrupt file — callers (pipeline.js)
 *  catch this and mark the source "failed" with the message surfaced
 *  verbatim in the Health tab (FR-011). */
async function extractText(name, buffer) {
  const ext = path.extname(name).toLowerCase();
  const extractor = BY_EXTENSION[ext];
  if (!extractor) {
    throw new Error(`Unsupported file type "${ext || "(none)"}" — supported: ${SUPPORTED_EXTENSIONS.join(", ")}`);
  }
  try {
    const text = await extractor(buffer);
    if (!text || !text.trim()) {
      throw new Error("No extractable text found (the file may be empty, scanned, or image-only)");
    }
    return text;
  } catch (err) {
    if (err && /No extractable text/.test(err.message)) throw err;
    throw new Error(`Failed to extract text from ${name}: ${(err && err.message) || err}`);
  }
}

function isSupported(name) {
  return Object.prototype.hasOwnProperty.call(BY_EXTENSION, path.extname(name).toLowerCase());
}

module.exports = { extractText, isSupported, SUPPORTED_EXTENSIONS };
