"use strict";

const mammoth = require("mammoth");

async function extractDocx(buffer) {
  const result = await mammoth.extractRawText({ buffer });
  return result.value;
}

module.exports = { extractDocx };
