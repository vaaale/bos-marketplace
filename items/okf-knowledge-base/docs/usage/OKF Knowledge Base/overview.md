# OKF Knowledge Base

A knowledge base your agents build and read. You ingest documents; the OKF Knowledge Base organizes them into **chapters**, tags each chapter with the **concepts** it covers, and keeps a small routing table so an agent can find the right chapters and read them **in full** — no snippets, no vector database, no black box.

Everything it stores is plain Markdown with YAML frontmatter, in a folder you can open in the Files app, grep, or commit to git.

## The idea in one paragraph

Ingest turns each document into **chapters**, each with a one-line summary and the **concept terms** it covers. To find something you either **browse** — the bundle's table of contents lists every document, newest first, with a short summary of what it is about — or **search**: a query matches the concept terms, chapter titles, summaries and the full text of every chapter, and comes back as ranked hits that say what matched. Either way you then open the chapters that answer and read them in full. Retrieval is always a full document or a full chapter.

The vocabulary (`concept-index.md`), each document's table of contents (`toc/<doc>.md`) and the bundle's overview (`index.md`) are **derived**: the service rebuilds them from the chapters themselves whenever anything changes — including changes made outside the app. They are real files you can read.

## The three tabs

### Overview — your knowledge bases

Lists every knowledge base with its health: documents, chapters, distinct concept terms, and anything stale or deprecated. Open one and you get:

- **Concept Index** — the vocabulary. Type to filter terms by name; it shows 100 at a time (Previous / Next), because a big knowledge base has thousands. Expand a term to see the chapters it covers (the first five — the rest are one search away). When the vocabulary has grown two terms meaning the same thing, the layers button on a term **merges** it into a canonical one — type the canonical term's name — and every chapter that used it is rewritten.
- **Documents** — the knowledge base's **table of contents**: every document, newest first, with its summary, chapter count and the date it was added, 50 at a time. Re-ingesting a document doesn't move it. Open one for its **stored table of contents**, then open a chapter to read it in full: frontmatter, body, and any inline images or video with the interpretation written when it was ingested. "View source (.md)" shows the exact text an agent receives.
- **Health** — stale and deprecated chapters, plus the lint report (index drift, broken asset links, orphan chapters).
- **Import / Export** — export is spec-conformant OKF including the index and every TOC; re-importing reproduces a working bundle.

### Jobs — did the ingest finish?

Every ingest is a tracked run: **queued → running → completed, cancelled or failed**. A completed run shows what it actually wrote (chapters, concept terms, assets interpreted, references skipped or failed), lists the chapter titles, and shows the agent's own report, rendered as formatted text (lists, tables, code). A failed run shows the error. A cancelled run shows that you stopped it — that is not a failure, and it carries no error. A running one shows live progress when the ingest agent reports it. **Cancel** stops a live run; **Delete** clears a finished one from the list.

### Query — explore it

One search field and a **Graph / Table** toggle.

- The search is the *same* search an agent runs: concept terms, titles, summaries and full text.
- **Table**, while you search, lists the **hits**, best first. Each says what matched — *concept*, *person*, *title*, *summary* or *full text* — and a full-text hit shows the sentence it was found in, with your words highlighted. **By document** groups them: which documents cover this, with their best chapters. With no search, the table lists every node.
- **Graph** draws the knowledge base as a graph — documents (grey), chapters (blue), concept terms (violet), people (teal) — with arrows for *contains* (solid), *covers* (dashed) and *related* (amber). It opens fitted to the panel; **+ / −** or scrolling zooms, **⤢** fits again, dragging empty space pans, dragging a node moves it. Documents are labelled where there is room; zoom in to label everything. Hover a node to see its neighbours and the names of its arrows.
- While you search, the graph **lights up the hits** — their chapters, documents and matched terms — fades everything else, and zooms to them.
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
