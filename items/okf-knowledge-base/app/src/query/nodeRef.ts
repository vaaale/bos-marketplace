// nodeRef.ts — a graph node's CONTENT reference, as the bare id the e2e suite
// and the reader pane have always used: a document's id, a chapter's
// `<docId>/<chId>`, a term's name (a person's lowercased). The node's own `id`
// is the namespaced key (`doc:…`), unique across kinds (FR-073(f)); this is
// for test ids and display only, never for identity.
import type { GraphNode } from "../lib/types";

export function nodeRef(n: GraphNode): string {
  if (n.type === "doc") return n.docId || n.id.replace(/^doc:/, "");
  if (n.type === "chap") return n.docId && n.chId ? `${n.docId}/${n.chId}` : n.id.replace(/^chap:/, "");
  const name = n.term || n.label;
  return n.type === "person" ? name.toLowerCase() : name;
}
