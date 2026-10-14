// gen-bundle.mjs — write a generated bundle straight into the memfs, the way
// the service would have left it, for the scale and freshness tests
// (design.md §12.6). Writing through the service would cost one HTTP round
// trip per file and test the service's write path instead of what the tests
// are about.
//
// The bundle carries the cases the retrieval-at-scale tests need:
//   • a name that appears ONLY in one chapter's body (SC-020)
//   • an author on a document stub (person term, chId "")
//   • a document and a concept term with the same name (SC-024)
//   • ledger entries with ingestedAt, oldest document first
//
// Deterministic: the same arguments always produce the same bundle.

import { createRequire } from "node:module";

const require = createRequire(import.meta.url);
const { stringifyDocument } = require("../../services/lib/okf-core.js");

const TOPICS = ["inference", "quantization", "agents", "retrieval", "evaluation", "fine-tuning", "tokenizers", "attention", "serving", "safety"];
export const BODY_ONLY_NAME = "Ingrid Haavardsholm";
export const SHARED_NAME = "deployment";

/**
 * @param {{write: (p: string, c: string) => void}} fs  the memfs handle
 * @param {string} root  e.g. "/KnowledgeBase"
 * @param {string} bundle
 * @param {{docs?: number, chapters?: number, start?: number}} opts
 * @returns {{docIds: string[], chapterIds: string[], bodyOnlyChapter: string}}
 */
export function genBundle(fs, root, bundle, { docs = 10, chapters = 3, start = Date.UTC(2026, 0, 1) } = {}) {
  const b = `${root}/${bundle}`;
  fs.write(`${b}/index.md`, `# ${bundle}\n`);
  const ledger = { sources: {} };
  const docIds = [];
  const chapterIds = [];
  for (let d = 0; d < docs; d++) {
    const topic = TOPICS[d % TOPICS.length];
    // document 0 is named like a concept term (SC-024)
    const docId = d === 0 ? SHARED_NAME : `article-${String(d).padStart(4, "0")}`;
    docIds.push(docId);
    const added = new Date(start + d * 3600_000).toISOString(); // later documents are newer
    fs.write(
      `${b}/concepts/${docId}.md`,
      stringifyDocument(
        {
          id: docId,
          type: "document",
          title: d === 0 ? "Deployment" : `Article ${d} — notes on ${topic}`,
          status: "stable",
          created_at: added,
          updated_at: added,
          summary: `Notes on ${topic}, what it costs, and what the benchmarks leave out.`,
          ...(d === 1 ? { person_terms: ["Diego Córdoba"] } : {}),
          sources: [{ id: docId, uri: `https://example.test/${docId}` }],
        },
        `# ${d === 0 ? "Deployment" : `Article ${d}`}\n`,
      ),
    );
    for (let c = 0; c < chapters; c++) {
      const chId = `ch-${c}`;
      const id = `${docId}/${chId}`;
      chapterIds.push(id);
      const body =
        `## Section ${c}\n\nThis chapter covers ${topic} in some depth. It explains the trade-offs. ` +
        `It closes with a short summary of the ${topic} findings.\n` +
        (d === 2 && c === 1 ? `\nThe method was first described by ${BODY_ONLY_NAME} in an internal memo.\n` : "");
      fs.write(
        `${b}/concepts/${docId}/${chId}.md`,
        stringifyDocument(
          {
            id,
            type: "section",
            parent: docId,
            title: `${topic} part ${c}`,
            status: "stable",
            concepts: [topic, ...(c === 0 && d === 3 ? [SHARED_NAME] : [])],
            summary: `Part ${c} of the ${topic} notes.`,
            created_at: added,
            updated_at: added,
          },
          body,
        ),
      );
    }
    ledger.sources[`https://example.test/${docId}`] = {
      rawFile: `raw/okf-staged-${docId}.md`,
      docId,
      originUrl: `https://example.test/${docId}`,
      ingestedAt: added,
      sourceKey: `https://example.test/${docId}`,
    };
  }
  fs.write(`${b}/raw/sources.json`, JSON.stringify(ledger, null, 2) + "\n");
  return { docIds, chapterIds, bodyOnlyChapter: `${docIds[2]}/ch-1` };
}
