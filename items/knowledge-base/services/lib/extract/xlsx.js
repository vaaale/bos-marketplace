"use strict";

const XLSX = require("xlsx");

// Cell text extraction (SheetJS) — every sheet, rendered as tab-separated
// rows so numeric/text layout is still legible to the entity-extraction LLM,
// prefixed with its sheet name.
async function extractXlsx(buffer) {
  const workbook = XLSX.read(buffer, { type: "buffer" });
  const parts = [];
  for (const sheetName of workbook.SheetNames) {
    const sheet = workbook.Sheets[sheetName];
    const csv = XLSX.utils.sheet_to_csv(sheet, { FS: "\t" });
    if (csv.trim()) parts.push(`## ${sheetName}\n${csv.trim()}`);
  }
  return parts.join("\n\n");
}

module.exports = { extractXlsx };
