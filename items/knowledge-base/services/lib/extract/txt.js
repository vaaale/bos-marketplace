"use strict";

async function extractTxt(buffer) {
  return buffer.toString("utf8");
}

module.exports = { extractTxt };
