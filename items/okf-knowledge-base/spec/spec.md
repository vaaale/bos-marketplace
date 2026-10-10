# Feature Specification: OKF Knowledge Base — General-Purpose Agent Knowledge Base (Redesign)

**Feature Branch**: `bos/okf-auto-ingest`

**Created**: 2026-10-09

**Status**: Draft

**App Target**: **`marketplace-item`.** This is a redesign of the already-installed `okf-knowledge-base` item: its **service facet** (OKF storage + the `okf_*` tool surface + a new derived two-level index + re-scoped ingest) and a **standalone companion app facet** — a master-detail app (Overview / Jobs / Query), dock-openable, not a settings config page — plus the item's bundled `okf-ingest` agent and bundle-schema skill. The prior `040` spec split the work as *mixed* (item + four `bos-core` prerequisites). Those prerequisites — the fixed `web_fetch`, `file_to_markdown`, `view_image`, `video_keyframes`, the `ToolExecuteResult` attachment mechanism, `ffmpeg` in the Docker images, and marketplace-item agent/skill copy-install — remain **dependencies** (see Assumptions) and are *not re-scoped here*: this spec's deliverable is the item. If any prerequisite has not actually shipped, it is a separate BOS-source follow-up.

**Input**: User description: Re-design the OKF Knowledge Base into a general-purpose knowledge base that agents use to *organize* knowledge and *retrieve* it efficiently. Stay grounded in Andrej Karpathy's "LLM Wiki" principles (raw sources / LLM-maintained wiki / index; ingest–query–lint) and the Open Knowledge Format (v0.2). No vector database, no SQL database, no embeddings — unless we conclude they give substantial value. Retrieval returns **full documents or full chapters, never snippet chunks**.

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

Retrieval, end to end, with no embeddings and no database: `natural-language query → okf_search performs deterministic matching over the concept index → returns TOC rows {docId, chapterId?, description, matched-concept} → the agent fetches the whole document, or the document's TOC, or a specific chapter — always full text → the agent reasons and synthesizes`. Efficiency comes from **precomputed summaries** (written at ingest) making routing a cheap deterministic pass over a small vocabulary plus targeted full-chapter reads — not the LLM re-reading everything, and not a vector store over chunks.

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

1. **Given** a bundle containing ingested articles covering a concept, **When** an agent calls `okf_search` with a natural-language query that paraphrases the concept, **Then** it receives TOC rows each carrying a document id, an optional chapter id, a one-line content description, and the concept term that matched.
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

### User Story 8 - I can watch ingest runs (jobs) and see if they finished or failed (Priority: P2)

An agent triggers ingestion of a document into a bundle. The user opens the app's **Jobs** tab to see the run and its live status — still running, completed (with a summary of what was written), or failed (with the error).

**Why this priority**: Ingest is the way knowledge gets in; without a way to see whether a triggered ingest actually completed, the user can't trust the pipeline or debug it.

**Independent Test**: Trigger an ingest; open the Jobs tab; verify the run appears as running, then transitions to completed with a summary (chapters written, concepts assigned, assets interpreted) or failed with an error.

**Acceptance Scenarios**:

1. **Given** an in-flight ingest, **When** the user opens the Jobs tab, **Then** the run is listed with status running, its bundle, and its source.
2. **Given** a completed ingest, **When** the user opens its run detail, **Then** it shows a summary (chapters written, concepts assigned, assets interpreted, references skipped/failed).
3. **Given** a failed ingest, **When** the user opens its run detail, **Then** it shows the failure and the error.

---

### User Story 9 - I can explore the KB as a graph and search it, opening full chapters in a pane (Priority: P2)

In the app's **Query** tab the user has a **shared search field** and a **Graph / Table** toggle: a **Knowledge Graph** (nodes and edges of the bundle) or a **Table** of the same nodes, with the search reflecting in whichever view is active (matching rows / highlighted nodes). Selecting a node or a search result opens the corresponding chapter in a resizable side pane, rendered in full, with a link to the original source document at the top.

**Why this priority**: This is the human-facing mirror of the agent's retrieval — it lets the user see and use exactly what the agents see, and trust the results.

**Independent Test**: In the Query tab, switch to Knowledge Graph and navigate the nodes; switch to Search, run a concept-anchored query, click a result; verify the chapter opens in the resizable pane, rendered in full, with a source link at the top that opens the original document.

**Acceptance Scenarios**:

1. **Given** the Query tab's Knowledge Graph sub-tab, **When** the user views it, **Then** it renders the bundle's nodes (documents, chapters, concept terms) and typed edges; clicking a node opens the corresponding chapter/document.
2. **Given** the Query tab's Search sub-tab, **When** the user runs a natural-language query, **Then** it returns the same concept-anchored TOC rows the agent's `okf_search` returns.
3. **Given** a selected search result or graph node, **When** the user opens it, **Then** the chapter renders in full in a mouse-resizable side pane, with a link to the original source document at the top of the pane.

### Edge Cases

- **What happens when a query matches no concept term?** → `okf_search` returns an empty (or near-empty) result set; the agent can widen the query or read the vocabulary via `okf_list_concepts` and route semantically. No invented rows.
- **What happens when a concept index entry points at a chapter that has since been deleted?** → `okf_lint` reports the drift; the index is regenerable, so a rebuild (or the write path) removes the dangling entry.
- **What happens when a chapter has no headings (no natural section structure)?** → Ingest treats the whole source as a single chapter.
- **What happens when a non-HTML asset fails to download or is unreadable for interpretation?** → The chapter records the asset link with an interpretation marked as unavailable (or the asset is noted in `okf_lint`); ingest does not fail the whole document.
- **What happens when a source is re-ingested after its content changed?** → The existing document is updated in place (append-only `raw/` for the new version); the index/TOC are reconciled, not doubled.
- **What happens when unknown frontmatter keys are present on a concept?** → Preserved verbatim on every write (merge-on-fields, never dropped).
- **What happens when a write targets a path outside the configured bundle root?** → Rejected (path safety).
- **What happens when the service is stopped or uninstalled?** → Its `okf_*` tools disappear from the registry immediately.
- **What happens when the concept vocabulary grows very large?** → `okf_search`'s deterministic pass still works; if the vocabulary becomes too large for one cheap pass, a keyword pre-filter (still no vector/SQL) is the documented escalation — see NFR-002.
- **What happens when an ingest run would follow a reference already in the bundle?** → Deduplicated against existing provenance; the hop is skipped and reported, not silently re-fetched.
- **What happens when the last chapter of a document is deleted?** → The document remains (possibly empty); the bundle is not auto-deleted.

## Requirements *(mandatory)*

### Functional Requirements — retrieval (the core)

- **FR-001**: The service MUST provide concept-anchored search (`okf_search`) that takes a natural-language query and a bundle and returns a result set of TOC rows — each row carrying a document id, an optional chapter id, a one-line content description, and the concept term that matched — sufficient for the calling agent to retrieve the relevant knowledge.
- **FR-002**: `okf_search` MUST produce its candidate rows via deterministic matching over the bundle's concept index (the routing table) so that routing cost is bounded by the number of distinct concept terms, not the number of documents; the final semantic routing and synthesis remain the calling agent's responsibility.
- **FR-003**: Retrieval MUST return full documents or full chapters, never snippet chunks. Reading any concept (document or chapter) returns its entire content.
- **FR-004**: The service MUST provide document-TOC retrieval (`okf_read_toc`) returning a document's stored table of contents — its chapters, each with a one-line description and the concept terms it covers.
- **FR-005**: The service MUST provide full-content reading of a single concept (`okf_read_concept`) for any concept id (document or chapter), returning its complete markdown body including resolved inline-asset links and their interpretations.
- **FR-006**: The service MUST support reading the concept vocabulary (`okf_list_concepts`) — the set of concept terms in a bundle, each with a count of the chapters that cover it.

### Functional Requirements — the two-level derived index

- **FR-007**: The service MUST maintain a bundle-level **concept index** — a stored, human-readable artifact mapping each concept term to the (document, chapter) pairs that cover it, each pair carrying a one-line description.
- **FR-008**: The service MUST maintain, per ingested document, a stored **table-of-contents** artifact — a human-readable `.md` listing the document's chapters, each with a one-line description and the concept terms it covers.
- **FR-009**: Both the concept index and each document TOC MUST be **derived and regenerable**: the service MUST be able to rebuild them from the bundle's underlying chapter content and frontmatter, so neither is the sole source of truth and neither can silently rot.
- **FR-010**: The concept index MUST be included in a bundle's export and re-imported cleanly; document TOCs likewise. They are part of the distributable bundle.
- **FR-011**: The size of the concept index MUST scale with the number of distinct concept terms, not with the number of documents or chapters.

### Functional Requirements — ingest (re-scoped: it builds the index and artifacts)

- **FR-012**: `okf_ingest` MUST decompose a source into chapters from the source's structure/headings, each chapter becoming a concept file (OKF `type: section`) carrying frontmatter: its parent document, the concept terms it covers, and a one-line summary.
- **FR-013**: `okf_ingest` MUST assign one or more concept terms to each chapter; the vocabulary grows organically (new terms are created as encountered).
- **FR-014**: `okf_ingest` MUST write a one-line summary for each chapter, which feeds both the concept index and the document TOC.
- **FR-015**: `okf_ingest` MUST create or update the document's TOC artifact and the bundle concept index as part of ingesting.
- **FR-016**: `okf_ingest` MUST route semantic decomposition through the bundled least-privilege ingest agent (not performed by the service worker), which reads the raw source directly and writes chapters via the `okf_*` tools; at no point is the full source re-emitted by the orchestrating agent as output tokens.
- **FR-017**: `okf_add_raw_source` MUST register source bytes — text or a non-HTML asset — into the bundle's `raw/` store immutably, accepting either inline `content` or a `sourcePath` already staged on disk (so the caller is never forced to pass large content inline).
- **FR-018**: `okf_ingest` MUST deduplicate against the bundle's existing provenance — a re-ingested source updates the existing document rather than creating a duplicate.
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
- **FR-036**: The app's data access is via the service's HTTP API, and the app's search performs the **identical concept-anchored matching as the `okf_search` tool** (FR-001/FR-002) — one capability, two surfaces. Adding app-side views (Overview, Jobs, Query) MUST NOT add to the 21-tool agent surface (FR-037). The Overview tab MUST render a bundle's concept index (term → documents/chapters, with descriptions), any document's stored TOC, and a bundle's status (document / chapter / concept-term counts, stale items) in a human-readable form.

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
- **FR-043**: The Query tab's **shared search field** MUST run the same concept-anchored search the agent uses (FR-001/FR-002), and MUST reflect its results in the active view — in the **Table** (the matching rows) and in the **Graph** (the matching nodes highlighted, the rest dimmed) (FR-042). Selecting a search result (or a graph node) MUST open the corresponding chapter in a **mouse-resizable side pane** that renders the full document (markdown, including inline-asset links and interpretations) and shows a **link to the original source** at the top of the pane. The source link's target is the document's original ingested URL when one exists, otherwise the stored `raw/` path (the document's provenance) — i.e. the honest "where did this come from" target.
- **FR-044**: The service MUST record each `okf_ingest` invocation as an observable run with a lifecycle (queued → running → completed | **cancelled** | failed) and a summary, and MUST expose those runs to the app **and to agents via `okf_list_jobs`** (FR-048). Run-completion/failure detection is a design concern (see design.md); the mechanism MUST NOT require the calling agent to emit the full source, and the run-observation plumbing MUST NOT add tools beyond `okf_list_jobs`/`okf_cancel_job`/`okf_delete_job` to the 21-tool agent surface.
- **FR-045**: The service MUST expose a bundle's knowledge graph — nodes and typed edges (containment via `parent` frontmatter, concept-coverage via the concept index, explicit links via stored edges) — derived from stored content, for the app's graph view.

### Non-Functional Requirements

- **NFR-001 (OKF portability)**: Every bundle MUST be a spec-conformant OKF bundle usable with git/grep/editor; the concept index and document TOCs are plain `.md` files inside the bundle.
- **NFR-002 (No vector / SQL / embeddings in v1)**: Retrieval MUST be over the file-based derived index (concept index + document TOCs) and full-chapter reading — no vector store, no SQL database, no embedding pipeline. A real index (a keyword/BM25 pre-filter or embeddings) MAY be introduced **only** when the concept vocabulary is large enough that one deterministic/LLM routing pass over it is measurably too slow or too token-heavy; that threshold and its justification MUST be documented before it is adopted. It is an escalation, not a v1 component.
- **NFR-003 (Chapter-granular, full-text)**: Retrieval returns full documents or full chapters; never snippet chunks.
- **NFR-004 (Derived, regenerable index)**: The concept index and document TOCs are derived from chapter content + frontmatter; rebuildable at any time; never the sole source of truth.
- **NFR-005 (OKF invariants)**: Schema-less (only `type` required); unknown frontmatter keys preserved verbatim on every write (merge-on-fields); human-readable plain markdown; forward-compatible round-trips.
- **NFR-006 (Path safety)**: All writes scoped to the configured bundle root; atomic writes; `raw/` immutable (append-only).
- **NFR-007 (Reliability)**: Tool errors/crashes are reported without crashing BOS; the service restarts on crash; tools are removed on stop/uninstall.
- **NFR-008 (Single-user)**: No multi-user access control in v1.
- **NFR-009 (Least-privilege ingest agent)**: The `okf-ingest` agent's tool allowlist stays narrow; it does not gain the top-level assistant's full tool surface.
- **NFR-010 (Karpathy fidelity)**: The design follows the LLM-Wiki pattern — immutable raw sources / LLM-maintained wiki / index, with the three operations ingest–query–lint — where the LLM does the reasoning and the service provides and maintains the structure.
- **NFR-011 (Efficiency)**: Routing cost is bounded by the number of distinct concept terms, not by document or chapter count.

### Key Entities

- **KnowledgeBundle**: An OKF bundle at `/KnowledgeBase/<name>/`. Holds documents, chapters, the concept index, and raw sources.
- **Document**: An ingested source (OKF `type: document`). Decomposed into chapters; has a stored table-of-contents artifact.
- **Chapter / Concept**: One `.md` concept file (OKF `type: section`). The atomic full-text retrieval unit. Carries frontmatter: `parent` (document), `concepts` (terms it covers), `summary` (one line). May contain inline-asset links + interpretations.
- **ConceptTerm**: A vocabulary term in the concept index — organic, mergeable, not a separate content-bearing file.
- **ConceptIndex**: Bundle-level stored, derived artifact. Maps each concept term to `(document, chapter, one-line description)` pairs.
- **DocumentTOC**: Per-document stored `.md`, derived artifact. Lists the document's chapters with one-line descriptions and covered concepts.
- **InlineAsset**: A downloaded non-HTML source asset in `raw/` plus its interpretation written into the owning chapter's markdown.
- **IngestRun**: One headlessly-triggered run of the `okf-ingest` agent, started automatically by `okf_ingest` (FR-046). Recorded as an observable run with a lifecycle (queued → running → completed | **cancelled** | failed), a bundle, a source, timestamps, a summary (chapters written, concepts assigned, assets interpreted, references skipped/failed), and an error. Shown in the app's Jobs tab (FR-041) and listable by agents via `okf_list_jobs` (FR-048). Cancellable while running (FR-050); deletable when non-running (FR-051).
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

## Assumptions

- **The item already exists and is installed** (spec 040/041 consolidated): a service facet (worker thread, `okf-core` storage, `/KnowledgeBase` VFS, 039 tool exposure) and a companion app (currently a settings config-app). This redesign reworks its retrieval model, index, ingest, tool surface, and turns the companion app into a **standalone master-detail app** (Overview / Jobs / Query); it does not re-derive the service-facet shape.
- **The prior 040 `bos-core` prerequisites are present and unchanged**: the fixed `web_fetch` (clean markdown, links preserved, no silent truncation), `file_to_markdown` (markitdown), `view_image`, `video_keyframes`, the `ToolExecuteResult` mechanism (tool results can carry image/video content), `ffmpeg` in the Docker images, and marketplace-item agent/skill copy-install with provenance. If any has not actually shipped, it is a prerequisite BOS-source follow-up, not part of this item's deliverable.
- **LLM-based retrieval over the derived index** (no embeddings / vector / SQL in v1), per the "substantial value" constraint (NFR-002).
- **The bundled `okf-ingest` agent runs in-process** via the existing `agent_delegate` mechanism (the same one Build Studio → Developer uses); it is a new consumer, not new delegation infrastructure.
- **A chapter is a concept file** (OKF `type: section`); "concepts" in the retrieval sense are the *index vocabulary* (terms routing to chapters), not separate content-bearing files. This preserves OKF's "everything is a `.md`, only `type` required" invariant.
- **Single-user**; no per-agent access assignment in v1.
- **`raw/` sources are immutable** (append-only); the concept index and document TOCs are derived/regenerable and never the sole source of truth.

## UI Mockup Reference

- **App**: the item's UI is a **standalone master-detail app** (Overview / Jobs / Query), not a settings config page. The visual language derives from the baseline `040-okf-knowledge-base.html` (bundle list/detail, create/import/export, delete).
- **`mockup.html` (this item's spec directory)**: the complete, consolidated mockup — the **binding visual + interaction contract** for the whole app, which the app implements directly. It covers: the **app shell** (titlebar + Overview / Jobs / Query tab bar with a live Jobs badge, Populated/Empty mode toggle); **Overview** — bundle list → bundle detail (health stat cards; Concept Index / Documents / Health / Import·Export tabs) → concept index → document → stored TOC → full chapter, with inline-asset blocks (thumbnail + stored interpretation) and "View source (.md)"; **Jobs** — ingest-run list (queued/running/completed/failed dots, bundle, source, elapsed/duration) → expandable run detail (summary cells, written-chapter chips, error card, live progress bar); and **Query** — a **single unified view**: a **shared search field** at the top and a **Graph / Table** toggle beneath it. The **Graph** is a force-directed layout of category-colored circular nodes (documents / chapters / concept terms) with typed, directed, **labeled** edges (contains / covers / related), in the graph-database / Neo4J style using the BOS dark palette; the **Table** lists the same nodes. The search field's results are reflected in **both** views (Table filters rows; Graph highlights matching nodes and dims the rest). Selecting a node opens it in the **mouse-resizable reader pane** (document → its TOC, chapter → full chapter, concept-term → its covering chapters) with an **"Open source"** link at the top (the document's original ingested URL, or its stored `raw/` path when ingested from disk).
