# OKF Knowledge Base

A durable, human-readable knowledge base your assistant can actually use. You point it at documents; it stores them as plain Markdown files with YAML frontmatter — readable in the Files app, greppable in an editor, portable out of BOS entirely — and builds a routing index over them so retrieval is fast, explainable, and honest about what it doesn't know.

Open it from the dock. It has three tabs: **Overview**, **Jobs**, **Query**.

## What it stores

Knowledge lives in **bundles** — one per subject area (`engineering-rules`, `product-research`, `onboarding`). A bundle is a directory under `/KnowledgeBase/`:

- **Documents** — one per source you ingested.
- **Chapters** — each document split at its own heading structure. A chapter is the unit you read: when something is retrieved, you get the **whole chapter**, never a fragment of one.
- **Concept terms** — the vocabulary. Not files; keys in the bundle's index, each routing to the chapters that cover it.
- **Raw sources** — an immutable copy of everything ingested, plus local copies of images and video.

The bundle is the unit of curation *and* of retrieval scope. Checking a design against your engineering rules means querying the rules bundle, not everything you own.

## The retrieval model, in plain terms

Search here is **concept-anchored**, not full-text. A query is matched against the bundle's concept vocabulary and the one-line description stored for each chapter. What comes back is a **table of contents**: one row per relevant chapter, each naming the document, the chapter, its one-line description, and **the concept term that matched** — so you can see *why* a row is there.

You then open a row to read the chapter in full.

Two consequences worth knowing up front:

- **There is no fuzzy semantic magic.** No embeddings, no vector store. The match is deterministic: the same query returns the same rows, every time.
- **A query that paraphrases body text but misses both the vocabulary and the stored descriptions returns nothing** — and an empty result is a real answer, not a bug. See [Troubleshooting](troubleshooting.md), which explains what to do about it.

### People are searchable too

Ingest also records the **salient persons** a document is by or about: its **author**, and the **named key figures** a chapter is actually about (not every name that gets mentioned). They become terms in the same vocabulary, tagged as *person* rather than *topic*, so you can search a bundle by someone's name — full name, first name or surname — and get the documents and chapters they wrote or are the subject of.

In the app they are **teal** wherever terms appear: a teal node in the graph, a *person* pill in the concept index, a *Person* row in the table, a teal "matched person" tag on a search hit.

The assistant uses exactly the same search through `okf_search`. One implementation, two surfaces: what you see in the app and what the assistant sees can't drift apart.

## Overview — browse and manage

The bundle list shows each knowledge base with its health: documents, chapters, distinct concept terms, and how many chapters are stale or deprecated.

Open one and you get four views:

- **Concept Index** — the vocabulary, searchable and expandable. Each term opens to the (document, chapter) rows it covers, with their descriptions. This is also where you **merge** two terms that turned out to mean the same thing.
- **Documents** — every ingested document, its chapter count, and its stored table of contents. Drill into a chapter to read it in full, with its frontmatter, its inline assets, and a "View source (.md)" toggle.
- **Health** — lint results (broken asset links, orphan chapters, index drift) and the stale report.
- **Import · Export** — export a bundle as a spec-conformant OKF manifest (concept index and every document TOC included), or import a directory back.

Buttons here also create a new bundle, delete one, and **start an ingest**.

## Jobs — watch ingest runs

Every ingest is a **run** with a record: queued → running → completed, cancelled or failed. The Jobs tab lists them with a live elapsed clock, and each row expands into its detail: the summary cells (chapters, concepts, assets, references skipped, references failed), the agent's own report, or the error that stopped it. A live run has a **Cancel** button; a finished one has a **Delete** button that clears the record (never the knowledge the run wrote).

See [Ingesting documents](ingest.md).

## Query — graph and search

The Query tab is a bundle selector, one **shared search box**, a **Graph / Table** toggle, and a resizable reader pane.

- The **Knowledge Graph** is a force-directed view of the bundle: documents (gray), chapters (blue), concept terms (violet) and **persons (teal)**, with labeled directed edges — *contains*, *covers*, *related*. Hover a node to trace its neighbours; drag, pan and zoom. Concept and person nodes are sized by how many chapters they cover, so your bundle's real centres of gravity are visible at a glance. Clicking a person opens the same coverage view a concept term opens, labeled *Person*.
- The **Table** is the search result as rows.
- The search box drives **both**: matching rows filter the table *and* highlight in the graph while everything else dims. One query, one answer, two renderings.
- Click a node or a row and the **reader pane** opens it in full — a chapter, a document's TOC, or a concept term's coverage — with an **"Open source"** link at the top that goes to the document's original URL, or to the stored `raw/` copy when it was ingested from a file.

Drag the divider to resize the reader pane.

## Setting it up

The app talks to its own background service over a loopback port. For that it needs the **`services:read`** capability — the item declares it, and you grant it once in **Settings → Apps**. Without it the app shows "Service unreachable".

If the service itself isn't running, start it in **Settings → Plugins**. The assistant's 21 `okf_*` tools disappear when the service stops and come back when it starts; that is expected.

Defaults you can change in the service's settings: the storage root (`/KnowledgeBase`), the ingest reference-crawl depth and concurrency, how many ingest runs may run at once (the rest wait queued), and how long a run may hang before it is declared lost.
