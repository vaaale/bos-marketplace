# OKF Knowledge Base

A knowledge base your agents build and read. You ingest documents; the OKF Knowledge Base organizes them into **chapters**, tags each chapter with the **concepts** it covers, and keeps a small routing table so an agent can find the right chapters and read them **in full** — no snippets, no vector database, no black box.

Everything it stores is plain Markdown with YAML frontmatter, in a folder you can open in the Files app, grep, or commit to git.

## The idea in one paragraph

A query doesn't search the full text of everything. It matches a **concept vocabulary** — a few hundred topic terms the bundle has accumulated — and each term points at the chapters that cover it, with a one-line description. So "tell me about rollback policy" costs one cheap pass over that vocabulary, not a scan of every document, and what comes back is a **table of contents**: document, chapter, description, and the concept term that matched. The agent then fetches the whole chapter. Retrieval is always a full document or a full chapter.

That routing table (`concept-index.md`) and each document's table of contents (`toc/<doc>.md`) are **derived**: the service rebuilds them from the chapters themselves whenever anything changes. They are real files you can read, and they can never quietly drift out of date.

## The three tabs

### Overview — your knowledge bases

Lists every knowledge base with its health: documents, chapters, distinct concept terms, and anything stale or deprecated. Open one and you get:

- **Concept Index** — the routing table, as a human reads it. Expand a term to see every (document, chapter) it covers with its one-line description. This is literally what an agent's search runs against. When the vocabulary has grown two terms meaning the same thing, the layers button on a term **merges** it into a canonical one: every chapter that used it is rewritten and the index and TOCs follow.
- **Documents** — the ingested sources. Open one for its **stored table of contents**, then open a chapter to read it in full: frontmatter, body, and any inline images or video with the interpretation written when it was ingested. "View source (.md)" shows the exact text an agent receives.
- **Health** — stale and deprecated chapters, plus the lint report (index drift, broken asset links, orphan chapters).
- **Import / Export** — export is spec-conformant OKF including the index and every TOC; re-importing reproduces a working bundle.

### Jobs — did the ingest finish?

Every ingest is a tracked run: **queued → running → completed, cancelled or failed**. A completed run shows what it actually wrote (chapters, concept terms, assets interpreted, references skipped or failed) and lists the chapter titles. A failed run shows the error. A cancelled run shows that you stopped it — that is not a failure, and it carries no error. A running one shows live progress when the ingest agent reports it. **Cancel** stops a live run; **Delete** clears a finished one from the list.

### Query — explore it

One search field and a **Graph / Table** toggle.

- The search runs the *same* concept-anchored search an agent runs. It matches the vocabulary and the stored descriptions, **not full text** — so a phrase that appears in a chapter body but in no term or summary returns nothing. That's the design, not a bug: widen the query, or browse the Concept Index.
- **Graph** draws the bundle as a knowledge graph — documents (grey), chapters (blue), concept terms (violet) — with labelled arrows for *contains*, *covers* and *related*. Drag a node, scroll to zoom, drag empty space to pan, hover to trace a node's neighbours.
- **Table** lists the same nodes as rows.
- Searching reflects in **both**: the table filters to matching rows, the graph highlights matching nodes and dims the rest.
- Clicking anything opens it in the **reader pane** on the right — a document shows its TOC, a chapter renders in full, a concept term lists the chapters it routes to. The pane is **resizable**: drag the divider. At the top is **Open source**: the document's original URL if it was ingested from the web, otherwise its stored `raw/` path.

## Getting knowledge in

Open a knowledge base and press **Ingest**. Enter the source — a URL, a file path, or a `raw/` path already in the bundle — and press **Queue run**. The run appears in the **Jobs** tab straight away as *queued*, and the modal shows you the call to hand the assistant:

> Ingest https://engineering.example.com/handbook/api-design into the `engineering` knowledge base.

The decomposition itself runs in a bundled, least-privilege agent, so the assistant is what actually starts it — the app queues and plans, it doesn't pretend to have launched an agent. The assistant's `okf_ingest` call pins the download to disk, so the document never passes through the conversation. Watch the run go *running* → *completed* in **Jobs**.

Re-ingesting something already in the bundle is detected and skipped rather than duplicated.

**Figures and video are kept.** Any non-HTML image or video in a document is downloaded into the bundle, interpreted once at ingest, and written into the chapter as a link plus an interpretation. When an agent later reads that chapter it gets the diagram's meaning as text, with no vision call. Ordinary links to web pages stay as links — they're not downloaded.

## Asking questions of it

Just ask. For example:

> Using the `engineering` knowledge base, what do our rules say about canary deploys and rollback?

> Check this design doc against the `engineering-rules` knowledge base and list anything that conflicts.

The second one is what multiple bundles are for: a bundle is the unit of curation *and* of retrieval scope, so an agent can check a document against one specific rule base.

## Where your data lives

`/KnowledgeBase/<bundle>/` in the Files app. One directory per knowledge base:

- `concepts/` — the documents and chapters (this is the real content)
- `raw/` — the original sources and downloaded assets, immutable and never edited
- `concept-index.md`, `toc/` — the derived routing table and tables of contents
- `index.md`, `log.md`, `links.json`

Delete a bundle and only that directory goes.

## First-time setup

The app reads its data from the Knowledge Base service over a local connection. If the app shows "Service unreachable", see [Troubleshooting](troubleshooting.md).
