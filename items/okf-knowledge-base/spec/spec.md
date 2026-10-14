# Feature Specification: OKF Knowledge Base — General-Purpose Agent Knowledge Base (Redesign)

**Feature Branch**: `bos/okf-auto-ingest`

**Created**: 2026-10-09

**Status**: Draft

**App Target**: **`marketplace-item`** (primary) **+ one small `bos-core` platform mechanism** (this session's scope-add). The item deliverable is unchanged in shape: the service facet (OKF storage + the `okf_*` tool surface + the derived two-level index + auto-triggered ingest) and the standalone companion app (Overview / Jobs / Query). The new **job cancellation** capability (FR-050/FR-052) is the first time this item depends on a small BOS-source change: a **generic** headless-run abort route (`POST /api/subagents/[runId]/abort`, the HTTP face of the existing in-process `abortHeadlessRun`). That route is platform-level (any headless run, by `runId`, serving future consumers), not OKF-specific — the item only consumes it over loopback. All four prior `bos-core` prerequisites (`web_fetch`, `file_to_markdown`, `view_image`, `video_keyframes` + the `ToolExecuteResult` mechanism, `ffmpeg`, agent/skill copy-install) remain **assumed-shipped dependencies** (see Assumptions).

**Input**: User description: Re-design the OKF Knowledge Base into a general-purpose knowledge base that agents use to *organize* knowledge and *retrieve* it efficiently. Stay grounded in Andrej Karpathy's "LLM Wiki" principles (raw sources / LLM-maintained wiki / index; ingest–query–lint) and the Open Knowledge Format (v0.2). No vector database, no SQL database, no embeddings — unless we conclude they give substantial value. Retrieval returns **full documents or full chapters, never snippet chunks**.

**Revision (2026-10-14) — retrieval at scale**: User description: a bundle of several hundred documents yields thousands of concept terms, so reading the vocabulary (`okf_list_concepts`) stops being a way in — and concept-term matching cannot find anything ingest did not happen to make a term or put in a summary (a name, a number, a phrase in a chapter body). Add **full-text search**, and — true to the LLM-Wiki idea that the model navigates an index — a **bundle-level table of contents** the agent can browse: `okf_read_toc(bundle)` returns the documents (id, title, a short summary), and the document TOC becomes its second level. Semantic search (embeddings) is **deferred**: it needs an embeddings endpoint separate from the chat model's server, which does not exist yet. It also makes the Query tab's **graph legible** — today it is cluttered in general and unreadable during a search (User description: "the graph view is very clobbered … spread it out a little more"). This revision amends FR-001, FR-002, FR-004, FR-006, FR-036, FR-042, FR-043, NFR-002, NFR-003 and NFR-011, and adds User Story 14, FR-068–FR-073 and SC-020–SC-024. The tool surface stays at 21 tools.

## Clarifications

### Session 2026-10-14 (retrieval at scale)

- Q: How is "spread out" decided for the graph? → A: As behaviour, not constants: no overlapping nodes, layout seeded by structure (FR-073 a), and the view fitted to the stage — at a bundle's real size that means zoomed out with only document labels until the user zooms in or searches.
- Q: In what order does the bundle TOC list documents? → A: **Newest first**, by when the document was **first added** to the bundle (its earliest provenance record), so a re-ingest — or "Re-ingest all" — does not reshuffle the TOC. Ties broken by document id.
- Q: Default and maximum page sizes? → A: Bundle TOC **50** documents per page (max 200) — about 4k tokens at FR-070's summary length. `okf_search` **10** hits (max 50); with `groupBy: "document"`, 10 documents with at most **5** matching chapters each. `okf_list_concepts` **100** terms per page (max 500). A request over a maximum is clamped to it and the response says so.
- Q: How long is a search hit's excerpt? → A: The sentence containing the match plus at most one sentence on each side — **at most three sentences, capped at 400 characters**. A hit that matched on a term, title or summary only carries no body excerpt.
- Q: Are document summaries already stored shortened to the new length? → A: **No.** They are shown as stored; a re-ingest writes a new summary under FR-070 anyway. "Two sentences" alone does not bound length (production summaries are single sentences of ~430 characters), so FR-070 also caps characters.

## Overview

This is a redesign of the installed OKF Knowledge Base. The prior spec's center of gravity was **ingest** (get bytes in via a multi-format pipeline). This redesign moves the center of gravity to **organization + efficient retrieval**, and re-positions ingest as the mechanism that *builds the structures retrieval depends on*.

### What the two use cases demand

Two representative (deliberately illustrative) use cases fix the shape:

1. **General knowledge base.** An agent ingests articles (e.g. from a daily digest). Topics and concepts are extracted and made searchable. A query like *"Building an MCP App with a dynamic AG/UI"* returns a **ranked table of contents** — one row per relevant document, each row carrying a document id, a description of the content, and the concept that matched. The agent then either (a) fetches a document's own table of contents (its chapters) and then the specific chapters, or (b) fetches the chapters directly from the search results. Either way it retrieves the **full document or full chapter**, not a snippet.
2. **Multiple knowledge bases for document comparison.** The user holds a bundle of *Engineering Rules & Guidelines*. They hand an agent a design document and ask it to be checked against the rules. The agent works through the design document, queries the rules bundle for applicable rules, retrieves the relevant full rule documents, compares, and emits findings. The KB's job is to hand the agent the *right full documents*; the comparison is the agent's reasoning.

### The core mechanism: a two-level, concept-anchored, derived index

The retrieval contract these use cases imply — *concept-anchored, chapter-granular, full-text, efficient* — is served by a **two-level index** that is derived from, and regenerable from, the bundle's OKF content. This is the new mechanism; the prior spec had no computed index at all (retrieval was "the LLM traverses the graph").

- **Level 1 — concept index** (bundle-level, a stored human-readable artifact): a mapping from each **concept term** to the (document, chapter) pairs that cover it, each pair carrying a one-line description. This is the *routing table* and the *searchable vocabulary*. Crucially it is bounded by the number of **distinct concept terms**, not by the number of documents — so a bundle with hundreds of articles but a few hundred real topics keeps a small, cheap-to-route table.
- **Level 2 — document TOC** (per ingested document, a stored human-readable `.md` artifact): the document's chapters, each with a one-line description and the concept terms it covers. This is the level-1 drill-down: fetch a document's TOC, then fetch the chapters you want.

Both are **derived and regenerable**: the canonical source of truth is the OKF content — the chapter `.md` files (each carrying frontmatter: its parent document, the concept terms it covers, and a one-line summary) plus the raw sources. The index and TOCs are views the service maintains and can rebuild from that content, so they can never become a second thing you must keep in sync by hand, and they can never silently rot. They are still *stored, browsable, exportable* artifacts (part of the distributable bundle), satisfying the requirement that the document TOC be a real `.md` file.

Retrieval, end to end, with no embeddings: `natural-language query → okf_search performs deterministic matching over the concept index → returns TOC rows {docId, chapterId?, description, matched-concept} → the agent fetches the whole document, or the document's TOC, or a specific chapter — always full text → the agent reasons and synthesizes`. Efficiency comes from **precomputed summaries** (written at ingest) making routing a cheap deterministic pass over a small vocabulary plus targeted full-chapter reads — not the LLM re-reading everything, and not a vector store over chunks.

### Retrieval at scale (revision 2026-10-14)

The concept index alone does not scale to the bundle sizes the general-knowledge use case produces, for two reasons. Its vocabulary grows with the corpus (hundreds of articles → thousands of terms), so "read the vocabulary and route" becomes the expensive step it was meant to avoid. And it only knows what ingest chose to make a term or write into a summary: a name, a figure or a phrase that lives only in a chapter body is unreachable.

The revision gives the agent **two ways in**, which converge on the same drill-down:

- **Browse** — the **bundle TOC**: one entry per document (id, title, chapter count, a short summary), paged. This is the LLM-Wiki move: the model reads an index of the knowledge base and picks what is relevant. Best for "what do we have on X" and for bundles small enough to scan.
- **Search** — `okf_search` over a **full-text index** of every chapter (title, summary, concept and person terms, body, inline-asset interpretations), concept terms, titles and summaries ranked above body text. Best for a specific fact, name, number or phrase, and for any bundle too large to browse.
- **Then, either way** — the **document TOC** (the document's chapters with their summaries and terms) to choose chapters, then **full chapters** via `okf_read_concept`.

The concept index stays: it is the vocabulary ingest extends and curation merges, now searched rather than read whole. The full-text index is a **derived cache** like the concept index and the TOCs — regenerable from the bundle at any time — but, unlike them, not part of the distributable bundle.

### Inline artifacts (the other new mechanism)

Source documents in a knowledge base frequently embed figures, images, and video that carry real knowledge (a state diagram, an architecture sketch, a demo). This redesign requires ingest to **extract, interpret, and preserve** them inline:

> For every non-HTML asset (image, video, or other non-HTML artifact) within a chapter's scope, ingest (1) downloads a **local immutable copy** into the bundle's `raw/` store, (2) **interprets** it via the ingest agent's vision capability, and (3) writes the chapter markdown with a **link to the stored asset and the interpretation directly beneath it**.

This maps exactly onto Karpathy's three layers: the asset bytes live in **raw** (immutable); the interpretation is LLM-written **wiki** text (a blockquote in the chapter); the markdown link is the **edge** connecting them. Because the interpretation is *stored text* (written once at ingest), retrieving the chapter hands the agent the readable knowledge the asset encodes **without re-running vision at query time**, and the link lets the agent re-view the raw asset if it wants to verify. HTML/link content stays as **remote references** (not downloaded); only non-HTML artifacts are pulled in locally.

### What this is *not* (the "less is more" reduction)

The prior installed surface had **31 tools**, many shaped for the old model (one setter per frontmatter field; graph power-tools; index/log readers; find/list duplicates). The redesigned surface is **21 tools**: **7 added** (concept-anchored `okf_search`, document-TOC `okf_read_toc`, `okf_merge_concepts`, job-listing `okf_list_jobs`, job-cancelling `okf_cancel_job`, job-deleting `okf_delete_job`), **14 kept**, **10 removed**. Field-setters collapse into `okf_upsert_concept` (frontmatter, merge-on-fields); graph power-tools drop out because retrieval is index-based, not path-based; the log becomes internal. The full before/after table is in FR-037.

## User Scenarios & Testing *(mandatory)*

### User Story 1 - I can ask "tell me about X" and get back a table of contents I can drill into, in full (Priority: P1)

An agent issues a natural-language query against a bundle and receives a concept-anchored table of contents — one row per relevant document (and optionally chapter), each with a description and the matching concept. The agent then retrieves the full document or the specific full chapters. No snippet is ever returned in place of the full content.

**Why this priority**: This *is* the headline retrieval contract. Without it the KB is a file store, not a knowledge base.

**Independent Test**: Ingest a set of articles on a topic; query with a natural-language phrase not present verbatim in any title; verify `okf_search` returns concept-anchored TOC rows; verify `okf_read_concept` on a returned chapter returns its *entire* body (not a truncation); verify `okf_read_toc` returns the document's full chapter list.

**Acceptance Scenarios**:

1. **Given** a bundle containing ingested articles covering a concept, **When** an agent calls `okf_search` with a natural-language query that paraphrases the concept, **Then** it receives TOC rows each carrying a document id, an optional chapter id, a one-line content description, and what matched (the concept term, or — since the 2026-10-14 revision — the title, summary or body text, see FR-001).
2. **Given** a TOC row from `okf_search`, **When** the agent calls `okf_read_concept` for the referenced chapter, **Then** it receives the chapter's complete markdown body — full text, not a snippet — including any inline-asset links and interpretations.
3. **Given** a document id, **When** the agent calls `okf_read_toc`, **Then** it receives that document's stored table of contents: its chapters, each with a one-line description and the concepts it covers — enabling drill-down to a specific chapter.
4. **Given** a document id, **When** the agent calls `okf_read_concept` for the document itself, **Then** it receives the whole document's content in full.

---

### User Story 2 - Ingesting a document organizes it: chapters, concepts, summaries, a stored TOC, and an updated index (Priority: P1)

The user (or an agent) ingests a document. The result is *organized*, not just stored: it is decomposed into chapters, each chapter is assigned concept terms and given a one-line summary, the document gains a stored table of contents, and the bundle's concept index is updated so the chapters are discoverable.

**Why this priority**: The index that US1 retrieves against only exists because ingest builds it. Organization and retrieval are one system.

**Independent Test**: Ingest a structured article (with headings); verify each heading-level section becomes a chapter concept with `parent`, `concepts`, and `summary` frontmatter; verify a stored document TOC appears listing those chapters; verify the concept index now routes the new concept terms to the new chapters.

**Acceptance Scenarios**:

1. **Given** a source document with clear section structure, **When** it is ingested, **Then** each section becomes a chapter concept file (OKF `type: section`) carrying frontmatter: its parent document, the concept terms it covers, and a one-line summary.
2. **Given** an ingested document, **When** the agent (or the config-app) inspects the bundle, **Then** a stored, human-readable table-of-contents artifact exists for that document, listing its chapters with one-line descriptions and covered concepts.
3. **Given** an ingested document whose chapters cover a concept not previously in the bundle, **When** ingest completes, **Then** the bundle's concept index is updated so that concept now routes to the new chapters (the vocabulary grows organically).
4. **Given** a source document already in the bundle, **When** the same source is re-ingested, **Then** it is deduplicated (not created as a duplicate document), and the index is reconciled rather than doubled.

---

### User Story 3 - I can scope retrieval to a specific bundle to compare a document against a rule base (Priority: P1)

The user holds a bundle of rules/guidelines and asks an agent to check a design document against it. The agent queries *that bundle specifically*, retrieves the applicable full rule documents, and compares. Knowledge bases are the unit of curation and of retrieval scope.

**Why this priority**: Confirms the multi-bundle, domain-scoped model is real, not just multiple folders in one namespace.

**Independent Test**: Create a "rules" bundle, ingest several rule documents into it. With a design document in hand, run `okf_search` against *only* the rules bundle; verify results come solely from that bundle and that the returned rule documents are retrievable in full.

**Acceptance Scenarios**:

1. **Given** a rules bundle and a separate general bundle both containing overlapping concepts, **When** the agent calls `okf_search` naming the rules bundle, **Then** results are drawn only from the rules bundle.
2. **Given** a matched rule document from a scoped `okf_search`, **When** the agent retrieves it via `okf_read_concept`, **Then** it gets the full rule text so it can be compared against a design document.
3. **Given** a document the agent is evaluating (whether or not it is itself stored in a bundle), **When** the agent works through it, **Then** it can query any target bundle per section to gather the applicable full rules for comparison.

---

### User Story 4 - Ingest interprets figures and preserves them inline, so retrieval carries their knowledge (Priority: P1)

A rules document contains a figure (an image, a diagram, or a video). Ingest extracts it, downloads a local copy, interprets it, and writes the chapter so the stored markdown links to the asset and carries the interpretation directly beneath. Retrieving the chapter therefore hands the agent both the interpretation and a link to the raw asset — without re-running vision.

**Why this priority**: This is what makes a KB usable for rule bases, technical docs, and any corpus where the *diagrams* carry the knowledge — a stated, load-bearing requirement.

**Independent Test**: Ingest a document containing an image and a video; verify each non-HTML asset is downloaded as a local copy in `raw/`; verify each chapter's markdown contains a link to the stored asset and an interpretation beneath it; verify `okf_read_concept` returns both the link and the interpretation; verify a plain hyperlink (HTML link) in the source is *not* downloaded (left as a remote reference).

**Acceptance Scenarios**:

1. **Given** a chapter whose source contains an image, **When** it is ingested, **Then** the image is downloaded as a local immutable copy in the bundle's `raw/` store, interpreted, and the chapter markdown contains a link to the stored copy with the interpretation directly beneath it.
2. **Given** a chapter whose source contains a video, **When** it is ingested, **Then** the video is handled the same way (local copy + interpretation of the sequence + inline link).
3. **Given** an ingested chapter with inline assets, **When** the agent retrieves it via `okf_read_concept`, **Then** the returned content includes the asset links and their interpretations, so the agent has the asset's knowledge without re-running vision.
4. **Given** a source containing ordinary hyperlinks (to HTML pages) alongside a non-HTML image, **When** it is ingested, **Then** the hyperlinks remain remote references and only the non-HTML image is downloaded locally.

---

### User Story 5 - I can manage bundles: create, import, export, delete (Priority: P2)

The user creates a knowledge base, imports an existing OKF bundle, exports a bundle, and deletes one they no longer need — from the config-app or via tools.

**Why this priority**: OKF is a distribution format; bundles are the unit of curation. Secondary to ingest/retrieve.

**Independent Test**: Create a bundle; import an existing OKF directory; export a bundle and confirm the export is spec-conformant OKF (including the concept index and document TOCs); delete a bundle and confirm it is gone.

**Acceptance Scenarios**:

1. **Given** the config-app, **When** the user creates a bundle, **Then** an OKF bundle is created with the conformant layout.
2. **Given** an existing OKF bundle on disk, **When** the user imports it, **Then** its documents, chapters, concept index, and TOCs are present and queryable.
3. **Given** a bundle, **When** the user exports it, **Then** the export is a spec-conformant OKF bundle that includes the concept index and every document TOC, and re-importing it reproduces a queryable bundle.
4. **Given** a bundle, **When** the user deletes it (or an agent calls `okf_delete_bundle`), **Then** the bundle directory is removed and it no longer appears in `okf_list_bundles`.

---

### User Story 6 - I can curate the concept vocabulary (Priority: P2)

As the vocabulary grows organically, near-duplicate terms accumulate. The user (or an agent) merges two terms into one canonical term, and the index, TOCs, and chapter frontmatter are all updated to reference the canonical term.

**Why this priority**: Keeps retrieval routing consistent over time; a fragmentation guard for the organic vocabulary.

**Independent Test**: Ingest sources that produce two near-duplicate terms; merge them; verify the concept index has one canonical entry, and that every document TOC and chapter `concepts` field that referenced either term now references only the canonical term.

**Acceptance Scenarios**:

1. **Given** two concept terms in a bundle, **When** the agent (or user) calls `okf_merge_concepts` to merge one into the other, **Then** the concept index consolidates to the canonical term and all affected document TOCs and chapter `concepts` frontmatter are updated.
2. **Given** a merge, **When** a query that previously matched either term is run, **Then** it routes via the single canonical term to the union of the chapters.

---

### User Story 7 - I manage my knowledge bases from a dedicated app, and browse the index and TOCs (Priority: P2)

The KB is a standalone master-detail app (not buried in settings). In its **Overview** tab the user lists knowledge bases (bundles), opens one, and browses its concept index and document TOCs — the human-facing window onto the structures agents retrieve against — and manages bundles (create/import/export/delete).

**Why this priority**: The index and TOCs are the system's core artifacts; a first-class app that makes them browsable is what makes the KB inspectable and trustworthy, not a black box.

**Independent Test**: Open the app; see the bundle list with per-bundle health; open a bundle; view its concept index; open a document and view its TOC; verify both match what the retrieval tools return.

**Acceptance Scenarios**:

1. **Given** the app's Overview tab on a bundle, **When** the user opens the concept index, **Then** it shows each concept term and the documents/chapters it covers, with the one-line descriptions.
2. **Given** a document in a bundle, **When** the user opens its TOC, **Then** the app renders the stored document TOC (chapters, descriptions, covered concepts).
3. **Given** the app's Overview tab, **When** the user views a bundle's status, **Then** it shows document count, chapter count, concept-term count, and stale/deprecated items.

---

### User Story 8 - I can watch and control my ingest runs (jobs): see status, cancel a running one, delete a finished one (Priority: P2)

An agent triggers ingestion of a document into a bundle. The user opens the app's **Jobs** tab to see the run and its live status — still running, completed (with a summary of what was written), cancelled (when they stopped it), or failed (with the error). The user can **cancel a running run** (stop it, distinct from a failure) and **delete a finished run** (clear the list), from the Jobs tab or via agent tools.

**Why this priority**: Ingest is the way knowledge gets in; without a way to see whether a triggered ingest actually completed, the user can't trust the pipeline or debug it.

**Independent Test**: Trigger an ingest; open the Jobs tab; verify the run appears as running, then transitions to completed with a summary (chapters written, concepts assigned, assets interpreted) or failed with an error.

**Acceptance Scenarios**:

1. **Given** an in-flight ingest, **When** the user opens the Jobs tab, **Then** the run is listed with status running, its bundle, and its source.
2. **Given** a completed ingest, **When** the user opens its run detail, **Then** it shows a summary (chapters written, concepts assigned, assets interpreted, references skipped/failed).
3. **Given** a failed ingest, **When** the user opens its run detail, **Then** it shows the failure and the error.
4. **Given** a running ingest, **When** the user clicks **Cancel** on it (or an agent calls `okf_cancel_job`), **Then** the underlying headless run is aborted and the job transitions to the distinct **cancelled** state (not failed); the job record and any bundle content already written are preserved; cancelling a job that is already terminal is a no-op.
5. **Given** a finished (completed / cancelled / failed) ingest, **When** the user clicks **Delete** on it (or an agent calls `okf_delete_job`), **Then** the job record is removed and the bundle's content is left untouched.
6. **Given** a running ingest, **When** a delete is attempted on it, **Then** the delete is rejected (cancel it first).

---

### User Story 9 - I can explore the KB as a graph and search it, opening full chapters in a pane (Priority: P2)

In the app's **Query** tab the user has a **shared search field** and a **Graph / Table** toggle: a **Knowledge Graph** (nodes and edges of the bundle) or a **Table** of the same nodes, with the search reflecting in whichever view is active (matching rows / highlighted nodes). Selecting a node or a search result opens the corresponding chapter in a resizable side pane, rendered in full, with a link to the original source document at the top.

**Why this priority**: This is the human-facing mirror of the agent's retrieval — it lets the user see and use exactly what the agents see, and trust the results.

**Independent Test**: In the Query tab, switch to Knowledge Graph and navigate the nodes; switch to Search, run a concept-anchored query, click a result; verify the chapter opens in the resizable pane, rendered in full, with a source link at the top that opens the original document.

**Acceptance Scenarios**:

1. **Given** the Query tab's Knowledge Graph sub-tab, **When** the user views it, **Then** it renders the bundle's nodes (documents, chapters, concept terms) and typed edges; clicking a node opens the corresponding chapter/document.
2. **Given** the Query tab's Search sub-tab, **When** the user runs a natural-language query, **Then** it returns the same concept-anchored TOC rows the agent's `okf_search` returns.
3. **Given** a selected search result or graph node, **When** the user opens it, **Then** the chapter renders in full in a mouse-resizable side pane, with a link to the original source document at the top of the pane.
4. *(2026-10-14)* **Given** the Knowledge Graph of a bundle, **When** it opens, **Then** no two nodes overlap, the whole graph fits the stage, documents are labelled where there is room and everything else only when zoomed in, hovered or matched, no label overlaps another, and no edge carries a text label until its node is hovered or selected (FR-073).
5. *(2026-10-14)* **Given** a search in the Query tab with the Graph showing, **When** it returns hits, **Then** the hits (and their documents and matched terms) stay at full strength with their labels, everything else fades almost out with its edges hidden, and the view zooms to the hits; clearing the search returns to the whole graph (FR-073).

---

### User Story 11 - I can ingest a large document without hitting context limits (Priority: P1)

The user (or an agent) ingests a large article or document (1MB+). The service pre-splits it into bounded chunks on its heading structure; the headless agent processes them sequentially (one chunk at a time, each well within the model's context window). The result is a complete document — all chapters, concepts, summaries, the TOC, and the concept index — with no chapter lost and no duplicate.

**Why this priority**: Without chunking, any source above ~150KB blows the model's context window (the 1.4M-token failure), making the KB unable to ingest real-world documents (long articles, whitepapers, book chapters). This is a hard blocker for the KB's core use case.

**Independent Test**: Ingest a 1MB+ structured document (with headings); verify the chunker splits it into chunks ≤ `maxChunkSize`; verify the agent processes each chunk sequentially; verify the resulting document has all its chapters (no loss, no duplicates), a correct TOC, and a populated concept index.

**Acceptance Scenarios**:

1. **Given** a source document larger than `maxChunkSize` with clear heading structure, **When** it is ingested, **Then** the service splits it into heading-delimited chunks (each ≤ `maxChunkSize`), and the agent processes them one at a time — the run completes and the document is fully ingested.
2. **Given** a source document with no headings, **When** it is ingested, **Then** the chunker falls back to paragraph/sentence boundaries and the document is still fully ingested.
3. **Given** a source document that fits within `maxChunkSize`, **When** it is ingested, **Then** it is processed as a single chunk (no splitting overhead) and the result is identical to the non-chunked path.
4. **Given** a `maxChunkSize` setting changed in the service config, **When** the next ingest runs, **Then** the chunker uses the new size (the setting is honored without code changes).

---

### User Story 12 - I can see what the agent did during a run (trajectory) (Priority: P2)

The user clicks on a job in the Jobs tab and sees the agent's complete trajectory: every tool call it made, with its input and the result it received, in chronological order — rendered as collapsible cards (the same pattern as Self-Heal and the Agentic Editor). For a running job, the trajectory grows in real-time as events are captured.

**Why this priority**: Without the trajectory, a failed or surprising run is a black box — the user sees "0 chapters, 0 concepts" or an error message but can't tell *what the agent tried*. The trajectory is the audit log and the debug surface for the ingest pipeline.

**Independent Test**: Complete an ingest run; click the job in the Jobs tab; verify the trajectory shows the agent's tool calls (`okf_add_raw_source`, `okf_upsert_concept`, `web_fetch`, etc.) with their inputs and results in chronological order, each in a collapsible card.

**Acceptance Scenarios**:

1. **Given** a completed ingest run, **When** the user clicks the job in the Jobs tab, **Then** the detail shows a tool-call timeline — each `tool_call` as a collapsible card (tool name + input summary), expandable to show the `tool_result` — in chronological order.
2. **Given** a running ingest run, **When** the user views its trajectory, **Then** the timeline shows the events captured so far (it grows as the run progresses).
3. **Given** a failed run (the agent hit an error), **When** the user views its trajectory, **Then** the timeline shows the calls leading up to the failure, making the error's cause diagnosable.
4. **Given** a run that produced no events (immediate crash), **When** the user views its trajectory, **Then** a "No trajectory captured" message is shown (not an empty scroll).

---

### User Story 10 - I can find content by the person it's about or authored by (Priority: P2)

The user asks for content by or about a person — *"what has Diego Córdoba covered?"* or just searches his name. Because ingest registered the salient person as a person-kind term, the name is in the vocabulary and the existing concept-anchored search returns the person's documents/chapters.

**Why this priority**: Person-level retrieval is a high-frequency KB need (authors, key figures, the "who") and the single most common reason a name-based search misses today (names live in chapter bodies, not in the term vocabulary).

**Independent Test**: Ingest an article with a named author and one or more named key figures; verify the author and the named figures appear as person-kind terms in the index; verify `okf_search` on the person's name returns their documents/chapters; verify `okf_list_concepts` reports their `kind: person`; verify the graph renders them as distinct nodes.

**Acceptance Scenarios**:

1. **Given** an ingested article with a named author, **When** the author is registered as a person-kind term, **Then** `okf_search` on the author's name returns the documents that author wrote (and the chapters where they are the subject).
2. **Given** a person-kind term, **When** the user (or agent) calls `okf_list_concepts`, **Then** the term is reported with `kind: person`, distinguishable from topical terms.
3. **Given** a person-kind term, **When** the user views the Query tab's Knowledge Graph, **Then** the person renders as a distinct node (its own category color/shape) with edges to the documents/chapters it covers.

### User Story 13 - Large documents ingest quickly and don't get reaped mid-run (Priority: P1)

The user ingests one or several large documents, and may ingest several simultaneously. Each completes in a bounded, predictable time, and a long-but-actively-progressing run is not killed by the stale reaper. The ingest's model output is dominated by the metadata the agent authors (concepts, summaries, persons, interpretations), not by re-typing the source text.

**Why this priority**: This is what makes the KB usable for real-world documents (long articles, whitepapers, tech reports) and for batch ingestion. The 1.4M-token context failure and the repeated 30-minute stale reaps are both symptoms of the same root cause: the model re-emits source it could have left on disk, so runs are slow, token-heavy, and stall-prone.

**Independent Test**: Ingest a 1MB+ structured document; verify the stored chapter bodies are verbatim slices of the source (not re-typed) with frontmatter + interpretations added; verify a run still producing trajectory events past 30 minutes is not reaped; verify the reaper bound is changeable in Settings → Plugins.

**Acceptance Scenarios**:

1. **Given** a large source with clear heading structure, **When** it is ingested, **Then** each stored chapter's body (minus the LLM-authored interpretation blocks) is a verbatim slice of the source for that chapter's heading range — the model did not re-emit the source body as output tokens.
2. **Given** a run that has produced a trajectory event within the configured inactivity bound, **When** it has been running longer than the bound in total, **Then** it is NOT reaped — the bound measures inactivity, not total duration.
3. **Given** the reaper bound in Settings → Plugins → OKF Knowledge Base, **When** the user changes it, **Then** the new bound is honored on subsequent runs.
4. **Given** several documents ingested simultaneously, **When** they compete for the model provider, **Then** each is an independent job; an actively-progressing run is not reaped, and a genuinely stalled (silent) run is eventually reaped with an honest error.

### User Story 14 - I can find knowledge in a bundle of hundreds of documents — by browsing its table of contents or by searching its text (Priority: P1)

An agent works against a bundle that holds several hundred documents and thousands of concept terms. It can **browse** the bundle's table of contents — one line per document — to see what the bundle holds, or **search** the full text of every chapter for a name, a number or a phrase. Either way it lands on a document's chapter list and reads only the chapters it needs. At no point does it have to read the whole concept vocabulary to find its way.

**Why this priority**: Without it, retrieval silently degrades as the knowledge base grows — the exact use the general knowledge base exists for — and anything ingest did not turn into a term is invisible. A lookup that answers "not in the knowledge base" when it is there is worse than no knowledge base.

**Independent Test**: Build a bundle in which a person's name appears **only** in one chapter's body (not as a term, not in any title or summary). Verify `okf_search` with the name returns that chapter, with an excerpt showing the match and the match marked as body text. Verify `okf_read_toc({bundle})` returns one row per document (id, title, chapter count, summary) with paging and a total, and no concept vocabulary; verify `okf_read_toc({bundle, docId})` returns that document's chapters. Verify `okf_list_concepts({bundle, query})` returns only matching terms.

**Acceptance Scenarios**:

1. **Given** a name that appears only in a chapter body, **When** an agent calls `okf_search` with it, **Then** that chapter is returned, marked as a body-text match, with a short excerpt around the match.
2. **Given** a query whose words are a concept term or appear in a chapter's title or summary, and also appear in passing in other chapters' bodies, **When** `okf_search` runs, **Then** the chapters where they are a term, title or summary rank above the passing mentions.
3. **Given** a bundle, **When** an agent calls `okf_read_toc({bundle})`, **Then** it receives a page of documents — each with id, title, chapter count and summary — plus the total, newest first, and can page through every document with `offset`/`limit`; the result carries no concept vocabulary.
4. **Given** a document id, **When** an agent calls `okf_read_toc({bundle, docId})`, **Then** it receives that document's chapter list exactly as FR-004 has always specified.
5. **Given** a query, **When** an agent calls `okf_search` with `groupBy: "document"`, **Then** it receives one row per matching document with its matching chapters listed beneath it.
6. **Given** a bundle with thousands of terms, **When** an agent calls `okf_list_concepts({bundle, query})`, **Then** only the terms matching the query are returned, each with its kind and coverage; without a query the result is paged.
7. **Given** a chapter written, updated, deleted, merged, re-ingested or imported — or a bundle edited by hand outside the service — **When** the next `okf_search` runs, **Then** its results reflect the bundle as it now is.

### Edge Cases

- **What happens when a source has no headings (no natural chunk boundaries)?** → The chunker falls back to paragraph boundaries (double-newline splits). If a single paragraph exceeds `maxChunkSize`, it is split at the nearest sentence boundary (period/space). The chunk carries no `headingPath` (it's a flat split).
- **What happens when a heading-delimited section exceeds `maxChunkSize`?** → The section is further split at paragraph boundaries within it, up to `maxChunkSize`. The `headingPath` is carried on each sub-chunk so the agent knows the section it's in.
- **What happens when a job's trajectory is very large (many tool calls)?** → The trajectory is stored in full (it's the run's audit log). The app renders it lazily (virtualized or paginated if > 100 events). The job record size is bounded by the run's actual tool-call count (typically 20–80 for an ingest run).
- **What happens when the agent's run produces no NDJSON events (immediate crash)?** → The trajectory is an empty array; the job's `error` field carries the failure. The app shows "No trajectory captured — the run failed before producing events."
- **What happens when a query matches nothing?** → `okf_search` returns an empty result set and says what it searched (terms, titles, summaries, full text), so the caller can rephrase or browse the bundle TOC instead. No invented rows. An empty result after rephrasing and browsing is a real "not in this bundle".
- **What happens when a concept index entry points at a chapter that has since been deleted?** → `okf_lint` reports the drift; the index is regenerable, so a rebuild (or the write path) removes the dangling entry.
- **What happens when a chapter has no headings (no natural section structure)?** → Ingest treats the whole source as a single chapter.
- **What happens when a non-HTML asset fails to download or is unreadable for interpretation?** → The chapter records the asset link with an interpretation marked as unavailable (or the asset is noted in `okf_lint`); ingest does not fail the whole document.
- **What happens when a source is re-ingested after its content changed?** → The existing document is updated in place (append-only `raw/` for the new version); the index/TOC are reconciled, not doubled.
- **What happens when unknown frontmatter keys are present on a concept?** → Preserved verbatim on every write (merge-on-fields, never dropped).
- **What happens when a write targets a path outside the configured bundle root?** → Rejected (path safety).
- **What happens when the service is stopped or uninstalled?** → Its `okf_*` tools disappear from the registry immediately.
- **What happens when the concept vocabulary grows very large?** → Nothing reads it whole any more: `okf_search` goes through the full-text index (FR-068), and `okf_list_concepts` filters by query and pages (FR-006). This is the escalation NFR-002 anticipated, adopted 2026-10-14.
- **What happens when the full-text index is missing, stale or unreadable?** → It is rebuilt from the bundle before the search answers; a search never answers from an index it knows to be out of date, and never reports "no match" because the index was missing.
- **What happens when a query is made of very common words?** → Results are ranked and capped by `limit`; the caller narrows the query or browses the bundle TOC.
- **What happens when a bundle has hundreds of documents with long summaries?** → The bundle TOC is paged (FR-069); new document summaries are held to two sentences and ~300 characters (FR-070) so a page stays readable.
- **What happens when an ingest run would follow a reference already in the bundle?** → Deduplicated against existing provenance; the hop is skipped and reported, not silently re-fetched.
- **What happens when the last chapter of a document is deleted?** → The document remains (possibly empty); the bundle is not auto-deleted.
- **What happens when a chapter the author wrote does not align to a single heading (a heading-less preamble, or the agent merges two short sections into one chapter)?** → The chapter's body is the source content for the range the agent declares; the service assembles it from that range (possibly across chunk boundaries) plus the LLM-authored frontmatter/interpretations. The verbatim-slice body invariant (FR-060) still holds.
- **What happens when an inline-asset interpretation is authored for a chapter whose body is extracted from source?** → The extracted body and the authored interpretation block are combined (the interpretation is placed beneath the asset link, per FR-021); neither is lost.
- **What happens when a single model turn takes longer than the inactivity bound (no trajectory events during the generation)?** → This is the failure the configurable bound + smaller (non-re-emitting) turns exist to make rare; the bound is inactivity-based and user-raisable (FR-059), and the body-extraction write protocol (FR-060) keeps each turn small enough that a single generation does not exceed a sane default. A run that is genuinely silent past the bound is reaped with an honest error.

## Requirements *(mandatory)*

### Functional Requirements — retrieval (the core)

- **FR-001** *(amended 2026-10-14)*: The service MUST provide search (`okf_search`) that takes a query and a bundle and returns ranked **chapter hits** — each carrying the document id and title, the chapter id and title, the chapter's one-line summary, **what matched** (a concept or person term, the title, the summary, or the body text), a short **excerpt** around a body-text match, and the chapter's status and staleness — sufficient for the calling agent to choose what to read. It MUST accept a `limit` (default 10, max 50), and `groupBy: "document"` returning one row per matching document (default 10) with at most 5 of its matching chapters beneath. The excerpt is the sentence containing the match plus at most one sentence either side, capped at 400 characters. The excerpt explains a match; it is never the retrieval (FR-003).
- **FR-002** *(amended 2026-10-14)*: `okf_search` MUST match over concept and person terms, titles, summaries **and the full text of every chapter** (inline-asset interpretations included) through the derived full-text index (FR-068), ranking term, title and summary matches above body-only matches. It MUST be deterministic — the same bundle and query give the same result — and its cost MUST NOT grow with what the calling model has to read: no step reads the whole vocabulary or every document into the model. The final semantic choice and synthesis remain the calling agent's.
- **FR-003**: Retrieval MUST return full documents or full chapters, never snippet chunks. Reading any concept (document or chapter) returns its entire content. A search hit's excerpt (FR-001) points at a match; it is not a substitute for reading the chapter.
- **FR-004** *(amended 2026-10-14)*: The service MUST provide table-of-contents retrieval (`okf_read_toc`) at two levels: with `{bundle}`, the **bundle TOC** (FR-069); with `{bundle, docId}`, that document's stored table of contents — its chapters, each with a one-line description and the concept terms it covers.
- **FR-005**: The service MUST provide full-content reading of a single concept (`okf_read_concept`) for any concept id (document or chapter), returning its complete markdown body including resolved inline-asset links and their interpretations.
- **FR-006** *(amended 2026-10-14)*: The service MUST support reading the concept vocabulary (`okf_list_concepts`) — the concept terms in a bundle, each with its kind and the chapters that cover it — filtered by an optional `query` matched against term names, and paged (`offset`/`limit` — default 100, max 500 — with the total) so that no caller has to read thousands of terms to find one. Ingest uses it to reuse an existing term before coining a new one.

### Functional Requirements — the two-level derived index

- **FR-007**: The service MUST maintain a bundle-level **concept index** — a stored, human-readable artifact mapping each concept term to the (document, chapter) pairs that cover it, each pair carrying a one-line description.
- **FR-008**: The service MUST maintain, per ingested document, a stored **table-of-contents** artifact — a human-readable `.md` listing the document's chapters, each with a one-line description and the concept terms it covers.
- **FR-009**: Both the concept index and each document TOC MUST be **derived and regenerable**: the service MUST be able to rebuild them from the bundle's underlying chapter content and frontmatter, so neither is the sole source of truth and neither can silently rot.
- **FR-010**: The concept index MUST be included in a bundle's export and re-imported cleanly; document TOCs likewise. They are part of the distributable bundle.
- **FR-011**: The size of the concept index MUST scale with the number of distinct concept terms, not with the number of documents or chapters.

### Functional Requirements — ingest (re-scoped: it builds the index and artifacts)

- **FR-012**: `okf_ingest` MUST decompose a source into chapters from the source's structure/headings, each chapter becoming a concept file (OKF `type: section`) carrying frontmatter: its parent document, the concept terms it covers, and a one-line summary.
- **FR-013**: `okf_ingest` MUST assign one or more concept terms to each chapter; the vocabulary grows organically (new terms are created as encountered), **including person-kind terms** — the author and named key figures are registered as part of this vocabulary (FR-053).
- **FR-014**: `okf_ingest` MUST write a one-line summary for each chapter, which feeds both the concept index and the document TOC.
- **FR-015**: `okf_ingest` MUST create or update the document's TOC artifact and the bundle concept index as part of ingesting.
- **FR-016**: `okf_ingest` MUST perform the semantic decomposition (chapters, concepts, summaries, inline-asset interpretation, TOC + concept-index maintenance) by starting a **headless run of the bundled `okf-ingest` agent** (not performed by the service worker) — and MUST **start it automatically** (FR-046) rather than returning a plan for the caller to execute. At no point is the full source re-emitted by the caller as output tokens (the run pins `output_path` on its acquisition steps, FR-047).
- **FR-017**: `okf_add_raw_source` MUST register source bytes — text or a non-HTML asset — into the bundle's `raw/` store immutably, accepting either inline `content` or a `sourcePath` already staged on disk (so the caller is never forced to pass large content inline).
- **FR-018**: `okf_ingest` MUST deduplicate against the bundle's existing provenance: a source already recorded starts no run and returns the existing document (`already_ingested`) — unless a re-ingest is explicitly requested (FR-064), which updates the existing document under the same id rather than creating a duplicate.
- **FR-019**: `okf_ingest` MAY follow references worth ingesting, bounded by a configurable crawl depth and fan-out, with dedup against already-ingested sources; followed and skipped references MUST be reported in the run summary.

### Functional Requirements — inline artifacts

- **FR-020**: During ingest, the service MUST support registering non-HTML source assets (images, video, and other non-HTML artifacts) as local, immutable copies in the bundle's `raw/` store.
- **FR-021**: For every non-HTML asset within a chapter's scope, ingest MUST interpret it via the ingest agent's vision capability and write the chapter markdown with (a) a link to the stored asset and (b) the interpretation directly beneath that link.
- **FR-022**: HTML/link content in a source MUST be kept as remote references (not downloaded); only non-HTML artifacts are downloaded as local copies.
- **FR-023**: Retrieving a chapter MUST include its inline-asset links and interpretations in the returned content, so the agent gets the asset's knowledge without re-running vision at query time.

### Functional Requirements — concepts

- **FR-024**: The service MUST support concept authorship (`okf_upsert_concept`) — create or update a concept file with frontmatter (merge-on-fields; unknown keys preserved) and body. This is also how a concept's trust, status, provenance, and lifecycle fields are set (no separate field-setter tools).
- **FR-025**: The service MUST support concept deletion (`okf_delete_concept`) — remove a concept file, non-destructive to the rest of the bundle by default.
- **FR-026**: The service MUST support concept curation (`okf_merge_concepts`) — merge one concept term into another canonical term, updating the concept index, all affected document TOCs, and all chapter `concepts` frontmatter that referenced either term.

### Functional Requirements — bundles

- **FR-027**: The service MUST provide bundle listing (`okf_list_bundles`) with per-bundle health: document count, chapter count, concept-term count, and stale/deprecated items.
- **FR-028**: The service MUST support bundle creation (`okf_init_bundle`).
- **FR-029**: The service MUST support bundle import (`okf_import_bundle`) and export (`okf_export_bundle`), both spec-conformant OKF.
- **FR-030**: The service MUST support bundle deletion (`okf_delete_bundle`), removing only that bundle's directory.

### Functional Requirements — organization (minimal graph)

- **FR-031**: The service MUST support adding a relationship between concepts (`okf_add_link`) as an OKF markdown-link edge.
- **FR-032**: The service MUST support backlink lookup (`okf_backlinks`).

### Functional Requirements — health

- **FR-033**: The service MUST provide lint (`okf_lint`) — detect broken inline-asset links, orphan chapters, and concept-index / document-TOC drift from the underlying content.
- **FR-034**: The service MUST provide a staleness report (`okf_stale_report`) for concepts past their lifecycle threshold.

### Functional Requirements — standalone app (UI)

- **FR-035**: The item MUST provide a **standalone companion app** — a master-detail application, dock-openable, with a top-level tab bar: **Overview**, **Jobs**, and **Query** — rather than a settings-embedded config page. The **Overview** tab is the bundle-management surface: bundle list (with per-bundle health) and bundle detail (concept index, documents/TOC, health, create/import/export/delete).
- **FR-036**: The app's data access is via the service's HTTP API, and the app's search performs the **identical matching as the `okf_search` tool** (FR-001/FR-002 — full text included since 2026-10-14) — one capability, two surfaces. Adding app-side views (Overview, Jobs, Query) MUST NOT add to the 21-tool agent surface (FR-037). The Overview tab MUST render a bundle's concept index (term → documents/chapters, with descriptions), any document's stored TOC, and a bundle's status (document / chapter / concept-term counts, stale items) in a human-readable form. *(2026-10-14)* Its **Documents** tab MUST be the bundle TOC (FR-069) — the same entries, order and page size an agent gets — and its **Concept Index** tab MUST filter by term name and page through the vocabulary the way `okf_list_concepts` does (FR-006), so neither loads a whole large bundle.

### Functional Requirements — tool surface

- **FR-037**: The service MUST declare exactly the following 21 `okf_*` tools, under the **Knowledge Base** tool group, via the 039 Service Tool Exposure contract, and no others:

  | Group | Tools |
  |---|---|
  | Retrieval | `okf_search`, `okf_read_toc`, `okf_read_concept`, `okf_list_concepts` |
  | Concepts | `okf_upsert_concept`, `okf_delete_concept`, `okf_merge_concepts` |
  | Bundles | `okf_list_bundles`, `okf_init_bundle`, `okf_import_bundle`, `okf_export_bundle`, `okf_delete_bundle` |
  | Ingest | `okf_ingest`, `okf_add_raw_source` |
  | Jobs | `okf_list_jobs`, `okf_cancel_job`, `okf_delete_job` |
  | Organization | `okf_add_link`, `okf_backlinks` |
  | Health | `okf_lint`, `okf_stale_report` |

  Compared to the prior 31-tool surface: **added** `okf_search`, `okf_read_toc`, `okf_merge_concepts`, `okf_list_jobs`, `okf_cancel_job`, `okf_delete_job`; **removed** `okf_bundle_status`, `okf_find_concepts`, `okf_read_index`, `okf_read_bundle_schema`, `okf_append_log`, `okf_get_as_of`, `okf_set_status`, `okf_set_trust`, `okf_add_source`, `okf_attest`, `okf_provenance`, `okf_remove_link`, `okf_list_links`, `okf_neighbors`, `okf_shortest_path`, `okf_export_graph` (field-setters collapsed into `okf_upsert_concept`; graph power-tools dropped as retrieval is index-based; log made internal).
- **FR-038**: Every declared tool MUST be validated against its JSON schema before dispatch and MUST respect the existing tool-gating/permission model exactly like built-in tools.

### Functional Requirements — bundled agent & skill

- **FR-039**: The item MUST bundle the `okf-ingest` agent (`agents/okf-ingest/AGENT.md`) with a **least-privilege** tool allowlist that includes the acquisition tools needed for inline-artifact interpretation (`view_image`, `video_keyframes`, `web_fetch`, `file_to_markdown`) and the `okf_*` read/write tools it needs, and excludes destructive operations and unrestricted `run_command`.
- **FR-040**: The item MUST bundle the bundle-schema skill (`skills/okf-bundle-schema/SKILL.md`) encoding the ingest/query conventions — chapter decomposition, concept assignment, summary writing, inline-artifact interpretation, and concept-index / document-TOC maintenance — attached to the `okf-ingest` agent.

### Functional Requirements — standalone app: Jobs & Query (extends FR-035/FR-036)

- **FR-041**: The app MUST provide a **Jobs** tab listing ingest runs, each showing its lifecycle status (queued / running / completed / **cancelled** / failed), the bundle, the source, and either a per-run summary (chapters written, concepts assigned, assets interpreted, references skipped/failed) or the run's error. The app MUST reflect a run's status as it changes. The app MUST provide a **Cancel** control on running jobs (FR-050) and a **Delete** control on non-running jobs (FR-051).
- **FR-042**: The app's **Query** tab MUST be a single unified view — a **shared search field** at the top and, beneath it, a **Graph / Table** toggle choosing how to render the bundle's knowledge graph. The **Graph** view MUST render the bundle's nodes (documents, chapters, concept terms) with typed, **directed, labeled** edges (containment document→chapter, concept-coverage chapter→concept term, explicit link) as a **force-directed layout of category-colored circular nodes** (a graph-database style, not a fixed columnar grid). The **Table** view MUST list the same nodes (type, name, description). Selecting a document or chapter — a graph node or a table row — opens it in the reader pane (document → its TOC, chapter → the full chapter); selecting a **concept-term** opens a term view in the pane listing the chapters that term covers.
- **FR-043**: The Query tab's **shared search field** MUST run the same search the agent uses (FR-001/FR-002), showing each hit's match kind and excerpt in the Table view, and MUST reflect its results in the active view — in the **Table** (the matching rows) and in the **Graph** (the hits focused, the rest faded, the view fitted to the hits — FR-073) (FR-042). Selecting a search result (or a graph node) MUST open the corresponding chapter in a **mouse-resizable side pane** that renders the full document (markdown, including inline-asset links and interpretations) and shows a **link to the original source** at the top of the pane. The source link's target is the document's original ingested URL when one exists, otherwise the stored `raw/` path (the document's provenance) — i.e. the honest "where did this come from" target.
- **FR-044**: The service MUST record each `okf_ingest` invocation as an observable run with a lifecycle (queued → running → completed | **cancelled** | failed) and a summary, and MUST expose those runs to the app **and to agents via `okf_list_jobs`** (FR-048). Run-completion/failure detection is a design concern (see design.md); the mechanism MUST NOT require the calling agent to emit the full source, and the run-observation plumbing MUST NOT add tools beyond `okf_list_jobs`/`okf_cancel_job`/`okf_delete_job` to the 21-tool agent surface.
- **FR-045**: The service MUST expose a bundle's knowledge graph — nodes and typed edges (containment via `parent` frontmatter, concept-coverage via the concept index, explicit links via stored edges) — derived from stored content, for the app's graph view.

### Functional Requirements — automatic ingestion & job observation

- **FR-046 (Automatic trigger)**: `okf_ingest` MUST, upon being called with a valid source, **automatically start the headless `okf-ingest` run** that performs the ingestion, and MUST **return immediately** with the minted `jobId` and the job's initial record — it MUST NOT return an instruction block ("run these acquisition steps", "now delegate to the okf-ingest agent") for the caller to act on. The caller (an agent, or the app's Ingest modal) is freed at return. The same automatic trigger applies to the app's Ingest action, which drives the same worker-side path via a `POST /jobs` route.
- **FR-047 (End-to-end headless run)**: The headless `okf-ingest` run MUST be **self-sufficient** — it performs the acquisition steps itself (`web_fetch` for URL sources, `file_to_markdown` for PDF/DOCX, each pinning `output_path` so the source streams to disk and is never re-emitted as the caller's output tokens), registers the raw source via `okf_add_raw_source`, then does the FR-012–FR-015 semantic decomposition, FR-020–FR-023 inline-asset interpretation, and FR-019 bounded reference crawl (nested reference runs as their own jobs). It MUST require no caller-held tool or caller follow-up — the reason the agent carries the complete allowlist of FR-039.
- **FR-048 (Job listing tool)**: The service MUST provide `okf_list_jobs` — a **read-only** (parallel-safe) tool returning the current ingest runs and their lifecycle status (`id`, `status`, `bundle`, `source`, `startedAt`, `duration`/`elapsed`, `summary`, `error`) — the same records the app's Jobs tab shows (FR-041) — so an agent can observe the runs it triggered (FR-046) without opening the app. It is part of the 21-tool agent surface (FR-037).
- **FR-049 (Finalization & stale reaper)**: Each run MUST be finalized to a terminal state (completed | cancelled | failed) by the **launcher observing the headless run's terminal outcome** (its `endedReason`: `completed`, `error`, `max_steps`, or `cancelled`); the service MUST additionally **reaper-mark any run still non-terminal past a configured bound as failed (stale)**, so a crashed or abandoned headless run never leaves a job stuck in running. Only a RUNNING job is a reap candidate: a queued job is waiting for a run slot (FR-063), not a run that died, and is started again after a restart. Both the app's Jobs tab and `okf_list_jobs` reflect the final state (FR-044, US8, SC-011).

### Functional Requirements — job control (cancel & delete)

- **FR-050 (Job cancellation)**: A **running** ingest job MUST be cancellable. The service MUST provide `okf_cancel_job` (takes a `jobId`) and the app's Jobs tab MUST provide a **Cancel** control on running jobs, both driving the same cancel path: the worker tells the platform to **abort the headless `okf-ingest` run** (by the run's `runId`, captured from the run's `run_started` event — see FR-052), and the job transitions to a **distinct `cancelled` terminal state** (not `failed` — cancellation is an intentional stop, not an error). Cancelling a job that is already terminal MUST be a no-op (idempotent). Cancelling MUST NOT delete the job record or the bundle content the run already wrote.
- **FR-051 (Job deletion)**: A **non-running** (terminal: completed / cancelled / failed, or a queued job whose run has not yet started) ingest job MUST be deletable. The service MUST provide `okf_delete_job` (takes a `jobId`) and the app's Jobs tab MUST provide a **Delete** control on non-running jobs. Deletion removes the job record only — it MUST NOT touch the bundle's content (chapters, index, TOC, `raw/`) that the run may have written. Deleting a **running** job MUST be rejected (cancel it first). Deleting a non-existent job MUST return a clean not-found result.
- **FR-052 (Platform abort dependency)**: Because the headless run executes in the main Next.js process while the job is owned by the service worker, cancelling a run MUST go through a **generic, platform-level** mechanism in BOS source: a `POST /api/subagents/[runId]/abort` route that invokes the existing in-process `abortHeadlessRun(runId)` (which already registers every headless run's `AbortController` in a run-registry and cascades the abort to any nested runs it spawned). This route is NOT OKF-specific — it is the HTTP face of the existing run-registry, consumable by any future fire-and-forget headless consumer. The OKF item consumes it over loopback; it MUST NOT special-case OKF. (This is the one `src/` change the scope-add introduces.)

### Functional Requirements — person extraction (kind-tagged terms)

- **FR-053 (Person extraction & registration)**: Ingest MUST extract **salient persons** — the **author** and any **named key figures** (people who are *subjects* of the content, not every name that appears) — and register each as a **person-kind concept term**, attached at **document level** (the author) and at **chapter level** (a person a specific section is about). A person term is a concept term carrying `kind: person` (distinct from the default topical kind); it lives in the **same derived concept index** — it is **not** a new entity type and **not** a separate content file. It is **found by name through the existing `okf_search`** (a query token matching the person's name returns the documents/chapters that term covers); no separate search path is introduced.
- **FR-054 (Person in graph & vocabulary)**: The knowledge graph MUST render person terms as **distinct nodes** (a category color/shape different from topic terms, chapters, and documents), and `okf_list_concepts` MUST report a term's kind so persons are distinguishable from topics.

### Functional Requirements — ingest chunking

- **FR-055 (Source chunking)**: Before the headless `okf-ingest` run processes a source, the service MUST **pre-split the source into bounded chunks** on its heading structure (markdown `##`/`###` boundaries, or paragraph boundaries for headingless sources), each chunk ≤ `maxChunkSize` characters (configurable in the item's service config, default 32000). The chunking is a **mechanical, deterministic** step performed by the service worker (not the agent) — it reads the staged source, splits it, and writes the chunks to a staging directory. The headless agent then processes **one chunk at a time** (sequential, not parallel): reads a chunk, decomposes it into chapters/concepts/summaries, writes them, moves to the next. The total document is reassembled from the per-chapter outputs (the doc stub, TOC, and concept index are built incrementally as chapters are written). A source that fits within `maxChunkSize` is a single chunk (no splitting). The chunking MUST preserve heading hierarchy context: each chunk carries a `headingPath` (the ancestor headings) so the agent knows where in the document it is.
- **FR-056 (Chunk config)**: The `maxChunkSize` setting MUST be in the item's service config (`config/okf-knowledge-base.json`, alongside `maxDepth`/`maxWorkers`), default 32000 characters (~8K tokens). The service MUST expose it via `GET /config` so the app can display it. Changing it takes effect on the next ingest (no restart required for the setting itself, but the service config is read at start — a restart IS required to pick up a new value, same as `maxDepth`/`maxWorkers`).

### Functional Requirements — job trajectory

- **FR-057 (Trajectory capture)**: The launcher MUST **capture the headless run's full NDJSON stream** (every event: `run_started`, `tool_call`, `tool_result`, `done`) and store it on the job record as a `trajectory` field (an array of the raw NDJSON events, in order). Consecutive `reasoning_delta` lines (the model's reasoning, streamed one token per line) MUST be stored as ONE event carrying the joined text, in its place in the sequence — the trajectory records what the agent did, not its token stream, and per-token storage grew one run to 33,186 events and the store past the worker's heap limit (2026-10-13). A store written per-token by an older service MUST be compacted the same way when loaded. This is the agent's complete conversation/trajectory for the run — every tool it called, every result it received, and its final output. The trajectory belongs to the job and is returned with it by the job's detail read; it is persisted in the job store (`.jobs/`) and MUST NOT be lost on service restart. It MUST NOT be stored inside the job records themselves: each run's trajectory is persisted on its own, so that recording an event costs that run's trajectory and nothing else, and the service's memory does not grow with the run history (a store embedding every run's trajectory reached 13 MB at 40 runs and exhausted the service's 256 MB heap during a single ingest, 2026-10-14). A completed run's trajectory MUST NOT be held in memory. A store that cannot be read MUST be reported, never replaced with an empty one.
- **FR-058 (Trajectory exposure)**: The service MUST expose the job's trajectory via the app-facing REST: `GET /jobs/<id>` returns the full job record **including `trajectory`** (the NDJSON event array). The app's Jobs tab MUST render the trajectory in the expandable job detail: a **tool-call timeline** — each `tool_call` event shown as a collapsible card (tool name + input, expandable to show the `tool_result`), matching the rendering pattern used by Self-Heal and the Agentic Editor (the same `tool_call`/`tool_result` NDJSON shape, the same collapsible-card UI pattern). The timeline is read-only (it's a historical record, not a live stream). For a running job, the trajectory shows the events captured so far (it grows as the run progresses); for a terminal job, it's complete.

### Functional Requirements — ingest efficiency & run timeout

- **FR-059 (Configurable, inactivity-based run timeout)**: The bound past which a non-terminal ingest run is reaper-marked **failed (stale)** MUST be **user-configurable in Settings → Plugins → OKF Knowledge Base** (surfaced in the service config form alongside `maxDepth`/`maxWorkers`/`maxChunkSize`), with a sane default. The bound MUST be an **inactivity** bound — measured from the run's last observed progress (its most recent trajectory event), not from when it started — so a legitimately long run that is still producing work is not reaped. Because a single long model turn produces **no** trajectory events while it generates, the default MUST be long enough (and the bound MUST be configurable) to absorb large documents and the provider contention of concurrent ingestion; the exact default, the inactivity signal, and any guardrails are a design concern (design.md, ADR-014).

- **FR-060 (Bounded ingest output — no source re-emission)**: The headless ingest run MUST NOT re-emit source text that already exists on disk (the staged source / chunk files) as the model's **output** tokens. When the agent writes a chapter, it contributes only the content it **authors** — the frontmatter (`concepts`, `summary`, `person_terms`, `title`, `status`) and any inline-asset **interpretation** blocks — and the **service assembles the chapter's body from the source's on-disk content**. The invariant: a stored chapter's body, with the LLM-authored interpretation blocks removed, MUST be a **verbatim slice of the source** for that chapter's heading range (the chapter is a copy of source text plus authored frontmatter/interpretations — not a re-typing of it). Per-chapter write cost is therefore O(metadata + interpretations), not O(body). The exact mechanism — how the agent references a chapter's source range, how it handles chapters the author wrote across non-heading boundaries or that span chunk boundaries, how LLM-authored additions are combined with the extracted body, and whether per-chapter writes are batched per chunk — is a **design concern** (design.md, ADR-014), constrained by: it MUST be deterministic; MUST NOT lose LLM-authored text; MUST handle the no-heading / single-chapter / cross-chunk / merged-section edge cases; and MUST preserve the verbatim-slice body invariant.

- **FR-061 (Nested ingest depth is bounded by the calling run)**: A reference followed from inside an ingest run (an `okf_ingest` call made by one of this service's own runs) MUST become a run with `maxDepth` one less than the run that followed it, recording that run's job as its `parentJobId`; a `maxDepth` argument MAY lower this, MUST NOT raise it, and `maxWorkers` MUST NOT exceed the parent's. A run with no hops left MUST be refused (`status: "over_depth"`, no job created) and report the reference as skipped. The calling run MUST be identified from the caller BOS attaches to the tool call (`caller.runId` matched against the job's `runId`), never from an argument the model supplies — a bound the model can switch off by omitting a field is not a bound. (Reproduction, 2026-10-13: every child restarted at the default depth and one PDF fanned out into seven concurrent runs.)

- **FR-062 (Sections of a heading-less source)**: When a registered source contains no Markdown heading, the service MUST still derive its heading map and chunk boundaries from the source's own section titles — numbered titles accepted only as the valid next entry of an outline (child, sibling, or ancestor's next sibling), including a number and title split across lines, and conventional unnumbered titles (Abstract, References, …) — each standing alone (the previous line blank or ending a sentence or table row). One reader MUST serve both the heading map and the chunker. A source with any Markdown heading MUST be read exactly as before. (Reproduction, 2026-10-13: a converted PDF with zero `#` lines left `sourceRange` able to express only `whole`, and the agent re-typed all 130K characters to insert headings.)
- **FR-063 (Run queue)**: Every ingest run — requested, nested (FR-061) or re-ingest (FR-064) — MUST be queued and started oldest-first, with at most `maxConcurrentRuns` (service config, default 2) running at once; a queued job MUST be started when a slot frees and after a service restart, and a job cancelled while queued MUST never start. `GET /config` MUST report the effective cap.
- **FR-064 (Re-ingest)**: The user MUST be able to re-ingest one document (the app's Documents list; the Ingest dialog when it answers "already ingested"; `okf_ingest` with `reingest: true`) and every document of a bundle (the app's "Re-ingest all"; `POST /bundles/<b>/reingest`). A re-ingest MUST re-acquire the document from its recorded origin when it has one (else its original file if still present, else its newest `raw/` version), MUST clear the document's stub, chapters and chunk cache **when its run starts** (not when queued) and rewrite it under the same id, and MUST keep every `raw/` version. A run started from inside an ingest run MUST NOT re-ingest. A run over a `raw/` source MUST get the same chunks and heading map an acquisition would have produced, before the agent starts. No tool is added: the surface stays as SC-007 pins it.
- **FR-065 (Ingest agent least privilege)**: The bundled `okf-ingest` agent MUST NOT hold any tool that writes or edits a file, nor any tool that deletes, merges, imports or exports bundle content; a skill it declares MUST come with `skill_load`/`skill_read_file`. Its instructions MUST NOT tell it a heading-less source is one chapter, and MUST forbid re-registering or re-typing a registered source.

- **FR-066 (Rendered agent report)**: A completed job's detail MUST render the agent's report (its final message) as markdown — paragraphs, lists, tables, code, emphasis, links — through the app's one markdown renderer, the same one the chapter view uses; raw HTML in it MUST NOT be interpreted.
- **FR-067 (Acquisition through the browser)**: When a URL source is a web page (not a binary download), the ingest task's Step 0 MUST name the route for a page a plain fetch is refused (an HTTP 403 or a bot check): `browser_navigate` to the URL, `browser_save_page` to the SAME staged path `web_fetch` would have written, `browser_close` — so the remaining steps run unchanged and the page never passes through the model. The ingest agent MUST hold exactly those browser tools, and MUST NOT fall back to third-party reader proxies or archives, which return another copy (often a paywall preview) rather than the page.

### Functional Requirements — retrieval at scale (revision 2026-10-14)

- **FR-068 (Full-text index)**: The service MUST maintain a **derived full-text index** over every chapter and document stub of a bundle — title, summary, concept and person terms, and body including inline-asset interpretations. It MUST be regenerable from the bundle at any time (NFR-004), updated by every write that changes what a search would find (ingest, `okf_upsert_concept`, `okf_delete_concept`, `okf_merge_concepts`, re-ingest, import, bundle deletion), and rebuilt when it is missing or out of date — including after the bundle was edited outside the service — before a search answers from it. It is a **cache**: not part of a bundle export (FR-010), never a source of truth.
- **FR-069 (Bundle TOC)**: The service MUST maintain, per bundle, a derived **bundle table of contents** — one entry per document: id, title, chapter count, and the document's summary — and `okf_read_toc({bundle})` MUST return it **paged** (`offset`, `limit` — default 50, max 200 — and the total), **newest first** by when each document was first added to the bundle, ties by id (Clarifications 2026-10-14). It MUST NOT include the concept vocabulary. It is the same document listing the bundle's stored `index.md` overview already carries, now reachable by an agent.
- **FR-070 (Document summary length)**: Ingest MUST write a document's summary as **at most two sentences and about 300 characters** saying what the document is about, so a page of the bundle TOC stays readable at hundreds of documents. Summaries already stored are shown as they are, never truncated silently.
- **FR-071 (Lookup skill)**: The item MUST ship a **lookup skill** (`okf-lookup`) that any agent can load, describing how to use a knowledge base as a source: choose the bundle; **browse** (`okf_read_toc({bundle})`) or **search** (`okf_search`); open the chosen document's TOC; read only the chapters that answer; answer citing chapter ids and the source (`okf_read_concept`'s `source`), flagging stale or deprecated chapters and keeping the knowledge base's content apart from the agent's own knowledge. It MUST say that an empty search is not proof of absence until a rephrased search and the bundle TOC agree, and that a lookup writes nothing, starts no ingest, and does not read `raw/`.
- **FR-073 (Graph legibility)**: The Query tab's Knowledge Graph (FR-042) MUST stay readable: (a) after the layout settles **no two nodes overlap**, and nodes are spread by structure — a chapter starts beside its own document, a term beside the chapters it covers; (b) the graph opens **fitted to the stage**, with **zoom in / zoom out / fit** controls; (c) an edge's text label is shown **only** for the edges of the hovered or selected node — otherwise the edge kind is carried by line style and the legend; (d) **no label is drawn over another**: documents are labelled wherever there is room, chapters and terms only when the view is zoomed in past a threshold or the node is hovered (with its neighbours), selected or a search hit — in that priority (selection, hover, hits, neighbours, documents), and a label with no room waits until zooming in makes some; a label sits below its node at a **constant on-screen size**; *(revised during implementation: "documents always labelled" made a 300-document bundle fit to a solid pile of titles)* (e) during a search the hits — matched chapters, their documents and the matched terms — keep full strength and their labels, everything else **fades almost out with its edges hidden**, and the view **zooms to fit the hits** (the fit control re-fits them); clearing the search returns to the whole graph, fitted; (f) a document and a term with the same name are **two distinct nodes** — node identity is namespaced by kind (today they collapse into one node: the term's coverage edges land on the document).
- **FR-072 (Index isolation)**: The full-text index's storage MUST honor BOS's data isolation: a preview instance's index writes MUST NOT change the production instance's index, nor the reverse. (BOS previews share `data/` files by hardlink and rely on no file being modified in place.) Being a regenerable cache, the index MAY live outside the bundle and be rebuilt per instance.

### Non-Functional Requirements

- **NFR-001 (OKF portability)**: Every bundle MUST be a spec-conformant OKF bundle usable with git/grep/editor; the concept index and document TOCs are plain `.md` files inside the bundle.
- **NFR-002 (No vector store / embeddings; full-text index adopted 2026-10-14)**: Retrieval MUST be over derived, regenerable structures and full-chapter reading — no vector store and no embedding pipeline. The **full-text index** (FR-068) is the escalation this requirement anticipated, adopted on its documented justification: (1) at the target scale — hundreds of documents, thousands of concept terms — a routing pass over the vocabulary is the token-heavy step the design meant to avoid; (2) the concept index cannot find what ingest did not make a term or summary, and a lookup that answers "not there" when it is (a name in a chapter body) is a correctness failure, not a speed one. **Semantic search** (embeddings) remains deferred until BOS has an embeddings endpoint separate from the chat model's server: on a single-model inference server, an embedding request unloads the chat model and kills the runs in flight.
- **NFR-003 (Chapter-granular, full-text)**: Retrieval returns full documents or full chapters; never snippet chunks. Search hits may carry an excerpt to explain a match (FR-001); reading is always whole.
- **NFR-004 (Derived, regenerable index)**: The concept index and document TOCs are derived from chapter content + frontmatter; rebuildable at any time; never the sole source of truth.
- **NFR-005 (OKF invariants)**: Schema-less (only `type` required); unknown frontmatter keys preserved verbatim on every write (merge-on-fields); human-readable plain markdown; forward-compatible round-trips.
- **NFR-006 (Path safety)**: All writes scoped to the configured bundle root; atomic writes; `raw/` immutable (append-only).
- **NFR-007 (Reliability)**: Tool errors/crashes are reported without crashing BOS; the service restarts on crash; tools are removed on stop/uninstall.
- **NFR-008 (Single-user)**: No multi-user access control in v1.
- **NFR-009 (Least-privilege ingest agent)**: The `okf-ingest` agent's allowlist is complete for end-to-end ingest (FR-039) but stays scoped to the KB domain — the full `okf_*` surface plus the named acquisition tools plus VFS reads; it does not gain non-`okf_*` tools, unrestricted `run_command`, `agent_delegate`, or the top-level assistant's full surface.
- **NFR-010 (Karpathy fidelity)**: The design follows the LLM-Wiki pattern — immutable raw sources / LLM-maintained wiki / index, with the three operations ingest–query–lint — where the LLM does the reasoning and the service provides and maintains the structure.
- **NFR-011 (Efficiency)** *(amended 2026-10-14)*: What the calling model has to read to find its way is bounded by a result page — a page of search hits, a page of the bundle TOC, one document TOC — never by the number of documents, chapters or concept terms in the bundle.

### Key Entities

- **KnowledgeBundle**: An OKF bundle at `/KnowledgeBase/<name>/`. Holds documents, chapters, the concept index, and raw sources.
- **Document**: An ingested source (OKF `type: document`). Decomposed into chapters; has a stored table-of-contents artifact.
- **Chapter / Concept**: One `.md` concept file (OKF `type: section`). The atomic full-text retrieval unit. Carries frontmatter: `parent` (document), `concepts` (terms it covers), `summary` (one line). May contain inline-asset links + interpretations.
- **ConceptTerm**: A vocabulary term in the concept index — organic, mergeable, not a separate content-bearing file. Carries a `kind` (default topical; `kind: person` for a salient person).
- **PersonTerm**: A concept term of `kind: person` — a salient person (author or named key figure) registered at ingest (FR-053). It is a term in the **same** derived index (not a separate content file or entity type), found by name via `okf_search` (FR-053), and rendered as a distinct node in the knowledge graph (FR-054).
- **BundleTOC**: Bundle-level derived listing of the documents — id, title, chapter count, summary — served paged by `okf_read_toc({bundle})` (FR-069).
- **FullTextIndex**: Per-bundle derived cache over every chapter's and document stub's title, summary, terms and body (FR-068). Regenerable, rebuilt when stale, not exported, isolated per instance (FR-072).
- **SearchHit**: One `okf_search` result — document and chapter ids and titles, summary, match kind, excerpt, status, staleness (FR-001).
- **ConceptIndex**: Bundle-level stored, derived artifact. Maps each concept term to `(document, chapter, one-line description)` pairs.
- **DocumentTOC**: Per-document stored `.md`, derived artifact. Lists the document's chapters with one-line descriptions and covered concepts.
- **InlineAsset**: A downloaded non-HTML source asset in `raw/` plus its interpretation written into the owning chapter's markdown.
- **IngestRun**: One headlessly-triggered run of the `okf-ingest` agent, started automatically by `okf_ingest` (FR-046). Recorded as an observable run with a lifecycle (queued → running → completed | **cancelled** | failed), a bundle, a source, timestamps, a summary (chapters written, concepts assigned, assets interpreted, references skipped/failed), an error, and a **trajectory** (the full NDJSON event array of the run's tool calls and results, FR-057). Shown in the app's Jobs tab (FR-041) and listable by agents via `okf_list_jobs` (FR-048). Cancellable while running (FR-050); deletable when non-running (FR-051).
- **IngestChunk**: One bounded slice of a source document, produced by the mechanical chunker (FR-055) before the headless run processes it. Carries the chunk's text, its `headingPath` (ancestor headings), and its ordinal (which chunk in the document). The agent processes chunks sequentially.
- **TrajectoryEvent**: One event in a job's trajectory array (FR-057) — a `run_started`, `tool_call`, `tool_result`, or `done` NDJSON event, in order. The trajectory is the agent's complete conversation for the run.
- **GraphView**: The bundle's knowledge graph — nodes (documents, chapters, concept terms) and typed edges (containment, concept-coverage, explicit links) — derived from stored frontmatter / index / links, for the app's graph view (FR-042/FR-045).
- **ServiceTool**: An `okf_*` tool declared per the 039 contract.
- **BundleHealth**: Document / chapter / concept-term counts and stale/deprecated items, for the config-app.

## Success Criteria *(mandatory)*

### Measurable Outcomes

- **SC-001**: A natural-language query returns, via `okf_search`, concept-anchored TOC rows; retrieving any referenced chapter via `okf_read_concept` returns its **full** text (not a snippet).
- **SC-002**: 100% of ingested source documents produce a stored document TOC and update the bundle concept index; a re-ingest of an existing source does not duplicate it.
- **SC-003**: Every non-HTML asset in an ingested chapter's scope is downloaded as a local copy, interpreted, and appears in the chapter markdown as a link + interpretation; retrieving that chapter returns both. Ordinary hyperlinks are left as remote references.
- **SC-004**: The concept index and every document TOC are plain `.md` files present in a bundle export; re-importing the export reproduces a fully queryable bundle.
- **SC-005**: Unknown frontmatter keys survive 100% of write/read round-trips.
- **SC-006**: For a bundle of N documents with V distinct concept terms, the concept index is O(V), not O(N) — verified by a corpus where V ≪ N.
- **SC-007**: The declared `okf_*` tool surface is exactly 21 tools; none of the 16 removed tools remains declared; `okf_list_jobs`, `okf_cancel_job`, and `okf_delete_job` are present.
- **SC-008**: Merging two concept terms updates the concept index, all affected document TOCs, and all chapter `concepts` frontmatter that referenced either term, leaving a single canonical entry.
- **SC-009**: Stopping/uninstalling the service removes all 21 `okf_*` tools immediately.
- **SC-010**: `okf_lint` detects broken inline-asset links and concept-index / document-TOC drift from the underlying content.
- **SC-011**: In the app's Jobs tab, a triggered ingest run is observable through its real lifecycle: it shows as running, then completed (with its summary), cancelled (when the user stops it), or failed (with its error). A running job can be cancelled from the Jobs tab (FR-050) or via `okf_cancel_job`; a non-running job can be deleted (FR-051).
- **SC-012**: In the app's Query tab, selecting a Knowledge-Graph node or a search result opens the full chapter in a resizable side pane with a working link to the original source document.
- **SC-013**: Calling `okf_ingest` returns a `jobId` immediately, **without** the caller running acquisition or agent-delegation steps itself; the run then proceeds headlessly to completed (with its summary), cancelled (when stopped), or failed (with its error), observable in **both** the app's Jobs tab and `okf_list_jobs`; a run whose headless process dies is reaper-marked failed, not left running.
- **SC-014**: Cancelling a running job from the Jobs tab or via `okf_cancel_job` aborts the underlying headless run and transitions the job to the distinct `cancelled` state; the job record and any content already written are preserved; cancelling a terminal job is a no-op.
- **SC-015**: Deleting a non-running job removes its record (via `okf_delete_job` or the Jobs tab) without touching bundle content; deleting a running job is rejected; deleting a non-existent job returns a clean not-found.
- **SC-016**: Searching a person's name (e.g. "Diego Córdoba") via `okf_search` returns the documents/chapters that person authored or is the subject of — because salient persons are registered as person-kind terms at ingest (FR-053); no separate search path is needed.
- **SC-017**: A source document of 1MB+ (~250K tokens) is ingested successfully — the chunker splits it into chunks ≤ `maxChunkSize`, the agent processes them sequentially, and the resulting bundle has a complete document (all chapters, TOC, index) with no chapter lost or duplicated.
- **SC-018**: Clicking a completed or failed job in the Jobs tab shows the agent's trajectory — a scrollable tool-call timeline with each `tool_call` (name + input) and its `tool_result` in collapsible cards — matching the rendering pattern of Self-Heal / Agentic Editor. For a running job, the trajectory grows in real-time as events are captured.
- **SC-019**: Ingesting a large document produces stored chapters whose bodies (minus LLM-authored interpretation blocks) are **byte-correct verbatim slices of the source** — the model's per-chapter output is bounded by the metadata it authors (concepts / summary / persons / interpretations), not by re-emitted source text; a run still producing trajectory events past the configured inactivity bound is **not** reaped, and the bound is changeable in Settings → Plugins → OKF Knowledge Base.
- **SC-020**: In a bundle where a name appears only in one chapter's body, `okf_search` for the name returns that chapter — marked as a body-text match, with an excerpt containing the name. (Person-term registration, SC-016, is no longer the only way a name is found.)
- **SC-021**: In a bundle of 500 documents, an agent can page through the whole bundle TOC with `okf_read_toc({bundle})`, each page carrying id, title, chapter count and summary for its documents and the total, and no concept vocabulary; `okf_list_concepts` with a `query` returns only matching terms.
- **SC-022**: After any write that changes a chapter — and after the bundle is edited outside the service — the next `okf_search` reflects it; deleting the full-text index leaves the next search's results identical to before.
- **SC-023**: Searching in a preview instance — including the index rebuilds that triggers — leaves the production instance's full-text index unchanged.
- **SC-024**: In the Query graph, after the layout settles no two node circles overlap; with no hover, no edge shows a text label; a search fits the view to its hits and fades the rest; and a document and a concept term with the same name render as two nodes, each with its own edges.

## Assumptions

- **The item already exists and is installed** (spec 040/041 consolidated): a service facet (worker thread, `okf-core` storage, `/KnowledgeBase` VFS, 039 tool exposure) and a companion app (currently a settings config-app). This redesign reworks its retrieval model, index, ingest, tool surface, and turns the companion app into a **standalone master-detail app** (Overview / Jobs / Query); it does not re-derive the service-facet shape.
- **The prior 040 `bos-core` prerequisites are present and unchanged**: the fixed `web_fetch` (clean markdown, links preserved, no silent truncation; **binary assets stored verbatim** — the content type decides text-vs-bytes before the body is read, so a PNG is not UTF-8-mangled to U+FFFD), `file_to_markdown` (markitdown), `view_image` (**byte-sniffs its input** and refuses non-images in-band, so a corrupt asset is a recoverable tool error rather than a fatal provider 400), `video_keyframes`, the `ToolExecuteResult` mechanism (tool results can carry image/video content), `ffmpeg` in the Docker images, and marketplace-item agent/skill copy-install with provenance. If any has not actually shipped, it is a prerequisite BOS-source follow-up, not part of this item's deliverable.
- **LLM-based retrieval over the derived index** (no embeddings / vector / SQL in v1), per the "substantial value" constraint (NFR-002).
- **The bundled `okf-ingest` agent runs headlessly** via the existing 034 event bus + the headless sub-agent run surface (`POST /api/subagents/delegate`, which runs the same `runSubAgent` the scheduler, workflows, and self-heal use); triggering a run requires no live conversation and occupies no caller's turn (FR-046). Cancelling a run goes through the platform's `POST /api/subagents/[runId]/abort` route (FR-052). It is a new consumer, not new delegation infrastructure.
- **A chapter is a concept file** (OKF `type: section`); "concepts" in the retrieval sense are the *index vocabulary* (terms routing to chapters), not separate content-bearing files. This preserves OKF's "everything is a `.md`, only `type` required" invariant.
- **Single-user**; no per-agent access assignment in v1.
- **BOS's directory listing tolerates a file that vanishes mid-listing.** `/api/fs`'s `list` can fail when an atomic write renames its temp file between reading the directory and reading the file's details; the full-text index's freshness check lists the bundle on every read, so this `bos-core` fix (an entry gone before it could be read is skipped — nothing else) is a prerequisite of FR-068, shipped separately (design §12.7).
- **Agents that query the knowledge base hold the retrieval tools.** BOS's seeded default assistant currently lists retired `okf_*` tools (`okf_find_concepts`, `okf_read_index`, `okf_get_as_of`, …) and lacks `okf_search`/`okf_read_toc`; fixing that seed is a `bos-core` follow-up outside this item, needed for FR-071's skill to be usable by the default assistant on a fresh install.
- **`raw/` sources are immutable** (append-only); the concept index and document TOCs are derived/regenerable and never the sole source of truth.

## UI Mockup Reference

- **App**: the item's UI is a **standalone master-detail app** (Overview / Jobs / Query), not a settings config page. The visual language derives from the baseline `040-okf-knowledge-base.html` (bundle list/detail, create/import/export, delete).
- **`mockup.html` (this item's spec directory)**: the complete, consolidated mockup — the **binding visual + interaction contract** for the whole app, which the app implements directly. It covers: the **app shell** (titlebar + Overview / Jobs / Query tab bar with a live Jobs badge, Populated/Empty mode toggle); **Overview** — bundle list → bundle detail (health stat cards; Concept Index / Documents / Health / Import·Export tabs) → concept index → document → stored TOC → full chapter, with inline-asset blocks (thumbnail + stored interpretation) and "View source (.md)"; **Jobs** — ingest-run list (queued/running/completed/**cancelled**/failed dots, bundle, source, elapsed/duration) with a **Cancel** control on running jobs and a **Delete** control on non-running jobs → expandable run detail (summary cells, written-chapter chips, error card, live progress bar); and **Query** — a **single unified view**: a **shared search field** at the top and a **Graph / Table** toggle beneath it. The **Graph** is a force-directed layout of category-colored circular nodes (documents / chapters / concept terms) with typed, directed, **labeled** edges (contains / covers / related), in the graph-database / Neo4J style using the BOS dark palette; the **Table** lists the same nodes. The search field's results are reflected in **both** views (Table filters rows; Graph highlights matching nodes and dims the rest). **Retrieval at scale (2026-10-14)**: a **Large bundle** mode (312 documents, 2,437 terms) shows the paged **Documents** tab (the bundle TOC, newest first, with summaries and "added" dates) and the name-filtered, paged **Concept Index**; in the Query tab a query shows, in the **Table** view, the ranked `okf_search` **hits** — document › chapter, summary, a highlighted excerpt for a full-text match, and a match-kind badge (concept / person / title / summary / full text) — with a **Chapters / By document** toggle and a "Nothing matched" state naming everything that was searched; the **Graph** lights up the same hits. The **Graph** itself (FR-073) is laid out by structure with no overlapping nodes, opens fitted to the stage with **+ / − / fit** controls and a status hint, labels only documents until zoomed in, hovered or matched (labels at a constant on-screen size, below the node), shows edge labels only on hover, and during a search fades everything but the hits and zooms to them. Selecting a node opens it in the **mouse-resizable reader pane** (document → its TOC, chapter → full chapter, concept-term → its covering chapters) with an **"Open source"** link at the top (the document's original ingested URL, or its stored `raw/` path when ingested from disk).
