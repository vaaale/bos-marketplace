// Default plaintext handler (T008). No markup — preview shows the raw text in a
// pre-wrapped block, which is the honest rendering of a .txt file.

import type { FormatHandler } from "../../types";

function escapeHtml(s: string): string {
  return s
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;");
}

export const plaintextHandler: FormatHandler = {
  id: "plaintext",
  name: "Plain Text",
  extensions: [".txt", ".text", ".log", ".env", ""],
  supportsPreview: false,
  render(content: string): string {
    return `<pre class="ate-plaintext">${escapeHtml(content)}</pre>`;
  },
  editorHints: { tabSize: 4, spellcheck: true },
};
