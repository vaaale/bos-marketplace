# Feature Specification: Knowledge Base

**Feature Branch**: `bos/038-knowledge-base`

**Created**: 2026-08-05

**Status**: Draft (Revision 3 — service-config delivery; per-agent access assignment removed)

**App Target**: marketplace-item (**service facet only**). The Knowledge Base management UI is **not** a separate window app — it is delivered as the service's **configuration page** via `settingsRegistration.configApp` (a self-contained HTML file served at `/api/services/<id>/config-app` and rendered in the **Settings → Plugins → Services → Knowledgebase → config** panel). See `references/target-marketplace-item.md`.

**Input**: User description: "I'm thinking about adding support for a knowledge base in BOS. Basically what I want is an app where I can create new knowledge bases, upload documents to the knowledge base, or provide a location to a Google Drive folder, or a Website etc. The solution must provide tools that an agent can use to query the knowledge. It must also be possible to select which knowledge bases an agent has access to."

> **Revision note (2026-08-06)**: The per-agent access-assignment requirement has been **removed** from this spec. The KB management UI is now delivered through the service's configuration mechanism (Settings → Plugins → Knowledgebase Service → config) rather than as a standalone app, and the separate `kb-settings.html` mockup is **deferred/archived** (not implemented at this stage). The full functional scope (create/manage KBs, upload/Drive/website sources, ingestion, query tools) is retained.

## Overview

This feature adds a **Knowledge Base** capability to BrowserOS. A knowledge base is a named, queryable collection of documents. Users create and manage knowledge bases from the **Knowledge Base service's configuration page** (reached at Settings → Plugins → Services → Knowledgebase → config), add content from multiple **source types** (uploaded documents, a Google Drive folder, a website/URL), and query the knowledge through agent tools.

The service runs as a worker-thread daemon that acquires source content, extracts text, and pushes episodes into a knowledge graph (Graphiti). Agents query the knowledge through a set of **query tools** (search/retrieve). The knowledge base is therefore the source of truth for "what does this agent know about".

### Goals

- Create, configure, and delete knowledge bases from the service's configuration page (Settings → Plugins → Services → Knowledgebase → config).
- Add content to a knowledge base from multiple source types (upload, Google Drive folder, website/URL), with ingestion that makes the content queryable.
- Provide agents with query tools to retrieve relevant content from knowledge bases.
- Show ingestion/indexing status so the user knows when content is queryable.
- Deliver the entire management surface through the service configuration mechanism — no separate window app.

### Non-Goals

- **Generative Q&A / chat over the KB** is out of scope for v1 — agents get retrieval tools (search + retrieve), not a conversational "ask the KB" tool. (Open for a future story; noted under assumptions.)
- **Document editing inside the KB** — documents are ingested as-is; the KB is not an editor.
- **Per-agent access assignment** (Settings → Agents → [agent] → Knowledge bases) — removed from this revision. The KB service has no per-agent query-grant surface. (The archived `kb-settings.html` mockup for that concept is deferred, not implemented.)
- **Multi-user sharing / team workspaces** — v1 is single-user (BOS is a personal OS).
- **Full-text search across every file type** — ingestion targets text-extractable documents (PDF, text, markdown, docx, etc.). Binary-only formats are out of scope for v1.
- **Embedding/model hosting** — the feature relies on the user's configured AI provider (see Constitution II); it does not ship its own model.

## User Scenarios & Testing

### User Story 1 - I can create a knowledge base and add documents to it (Priority: P1)

The user opens the Knowledge Base service's configuration page, creates a new knowledge base, and uploads documents into it. Ingested documents become queryable by the agent tools.

**Why this priority**: This is the core value — without a way to create a KB and put content into it, nothing else (querying) can be demonstrated. It is the foundation of the feature.

**Independent Test**: Create a knowledge base named "Engineering Docs" from the service config page, upload three markdown documents, observe ingestion complete, then confirm the content is retrievable via the query tool.

**Acceptance Scenarios**:

1. **Given** the Knowledge Base configuration page, **When** the user creates a new knowledge base with a name, **Then** it appears in the knowledge base list with an empty source set and status "Empty".
2. **Given** an existing knowledge base, **When** the user uploads one or more documents, **Then** each document is accepted, ingestion starts, and the document appears in the source list with a "Indexing" status.
3. **Given** documents that have finished ingestion, **When** ingestion completes, **Then** each document's status changes to "Indexed" and the content becomes queryable via the agent query tool.
4. **Given** the query tool, **When** the user/agent searches for a term contained in an uploaded document, **Then** the tool returns the relevant passage from that document.

---

### User Story 2 - I can add a Google Drive folder as a knowledge source (Priority: P2)

The user connects a Google Drive folder as a source for a knowledge base. Files in the folder are indexed and become queryable.

**Why this priority**: Remote sources are a stated requirement ("provide a location to a Google Drive folder") and materially extend where knowledge can come from. It builds directly on Story 1's ingestion pipeline.

**Independent Test**: Connect a Google Drive folder, verify files are indexed and queryable, then add a new file to the folder and verify it is picked up by a refresh.

**Acceptance Scenarios**:

1. **Given** a knowledge base, **When** the user adds a Google Drive folder source (via OAuth link + folder selection), **Then** the source appears as "Connecting" and, once authorized, files are listed and ingestion begins.
2. **Given** an authorized Google Drive folder source, **When** files finish ingestion, **Then** they become queryable via the agent query tool.
3. **Given** a connected Google Drive folder source, **When** the user triggers a refresh, **Then** newly added or changed files are indexed (and removed files are de-indexed) so the KB reflects the folder.

---

### User Story 3 - I can add a website as a knowledge source (Priority: P2)

The user provides a website URL as a source for a knowledge base. The site's pages are crawled and indexed, and become queryable.

**Why this priority**: "or a Website etc." is an explicit source type; web sources let users bring external knowledge into the KB. It reuses the ingestion pipeline with a crawler source.

**Independent Test**: Add a website URL, verify pages are crawled/indexed and queryable, then re-crawl after the site updates and confirm the KB reflects the change.

**Acceptance Scenarios**:

1. **Given** a knowledge base, **When** the user adds a website URL source, **Then** the source appears with a "Crawling" status and pages are progressively indexed.
2. **Given** a website source that finished crawling, **When** the user/agent queries the KB, **Then** content from the site's pages is returned.
3. **Given** an existing website source, **When** the user triggers a re-crawl, **Then** changed/removed pages are updated in the index.

---

### User Story 4 - I can manage and delete knowledge bases (Priority: P3)

The user renames, reconfigures, or deletes knowledge bases, and views ingestion health.

**Why this priority**: Basic lifecycle management rounds out the feature; lower priority because the core create/query flows (Stories 1–3) deliver the main value first.

**Independent Test**: Rename a KB, delete a KB (with confirmation), and confirm the deletion removes its sources and index.

**Acceptance Scenarios**:

1. **Given** an existing knowledge base, **When** the user renames it, **Then** the new name persists and the KB remains queryable.
2. **Given** an existing knowledge base, **When** the user deletes it (after confirmation), **Then** it is removed from the list and its sources/index are cleaned up.
3. **Given** a knowledge base with sources, **When** ingestion fails for a source, **Then** the config page surfaces a per-source error status with an actionable message.

### Edge Cases

- What happens when a document fails to extract text (corrupt file, unsupported type)? → per-source error status, KB remains usable, error is actionable.
- How does the system handle a Google Drive folder with thousands of files or a huge website? → ingestion is incremental/chunked, never blocks the app; large sources index progressively.
- What happens if the AI provider (embedding step) is unavailable or rate-limited? → ingestion retries/backlogs; status shows "Pending/Retrying", queryable content remains available.
- How does the system handle duplicate documents (same content, re-added)? → de-duplication by content hash; re-adding a known document is idempotent.
- What happens if the Google Drive OAuth token expires or is revoked? → source shows "Needs re-auth" with a clear reconnect action.
- How does the system handle a website that is unreachable, blocked, or robots-disallowed? → source shows a crawl error; partial index of already-crawled pages is retained.
- What happens if an agent queries a knowledge base that has no indexed content? → tool returns empty/graceful "no content indexed yet".
- How does the system handle deletion of a document while it is being indexed? → deletion wins; indexing is cancelled/ignored.

## Requirements

### Functional Requirements

- **FR-001**: The system MUST provide a management UI — the service's configuration page (Settings → Plugins → Services → Knowledgebase → config) — where the user can list, create, configure, rename, and delete knowledge bases.
- **FR-002**: A knowledge base MUST have a unique name and a stable identity (id) used by query tools.
- **FR-003**: The system MUST support adding **uploaded documents** as a source type, accepting text-extractable files (PDF, TXT, MD, DOCX, and similar).
- **FR-004**: The system MUST support adding a **Google Drive folder** as a source type, requiring the user to authorize the connection (OAuth) and select a folder.
- **FR-005**: The system MUST support adding a **website/URL** as a source type, crawling and indexing the site's pages.
- **FR-006**: Each source MUST expose an ingest status (`Pending` → `Indexing` → `Indexed`, or an error state), surfaced in the configuration page.
- **FR-007**: The system MUST index ingested content so it can be searched semantically (retrieval over entities and facts in a knowledge graph, with passages reconstructed from source).
- **FR-008**: The system MUST de-duplicate documents by content hash so re-adding the same content is idempotent.
- **FR-009**: The system MUST expose **agent query tools** (search + retrieve) that return relevant passages from a knowledge base, with each result citing its source passage.
- **FR-010**: The system MUST support refreshing a remote source (Google Drive, website) to pick up changes, and de-index removed content.
- **FR-011**: The system MUST surface per-source and per-KB ingestion health and actionable errors in the configuration page.
- **FR-012**: Deleting a knowledge base MUST clean up its sources and index.
- **FR-013**: The management UI MUST conform to the UI mockup at `038-knowledge-base.html` (in this spec directory) — the mockup is the UI contract for the service's configuration page. The UI MUST be delivered as the service's `configApp` (self-contained HTML rendered in Settings → Plugins → Services → Knowledgebase → config).
- **FR-014**: The service's configuration page MUST allow the user to **set the Graphiti MCP endpoint** (the URL of the user's Dokploy-deployed Graphiti MCP server). The configured endpoint MUST persist and be used by the worker for all Graphiti calls. A default endpoint MAY be provided, but the user MUST be able to change it in the config UI and the change MUST take effect without reinstalling the item.

### Key Entities

- **KnowledgeBase**: A named, queryable collection of sources + an index. Attributes: id, name, created/updated timestamps.
- **Source**: A content origin attached to a knowledge base. Types: Upload, GoogleDriveFolder, Website. Attributes: id, type, reference (file path / folder id+auth / URL), ingestion status, last-synced timestamp.
- **Episode**: The ingested content unit pushed to the knowledge graph (one document, a large-document section, or one crawled page). Episodes are the source of passages.
- **Entity/Fact**: Graph nodes and edges extracted from episodes; the indexed, retrievable units with embeddings.
- **Group**: A Graphiti group maps one-to-one to a knowledge base; each group is a separate graph database (hard partition).
- **IngestionJob**: A background unit of work that extracts → chunks → embeds → indexes content from a source. Attributes: source ref, status, retry state.

## Success Criteria

### Measurable Outcomes

- **SC-001**: A user can create a knowledge base and upload documents, and all successfully-extracted documents reach `Indexed` status and are queryable — quality over speed, with no silent ingestion failures.
- **SC-002**: An agent retrieves relevant, correctly-ranked passages for a query — retrieval quality (relevance) is prioritized over raw latency. Query latency is measured and reported, but not optimized until quality targets are met.
- **SC-003**: 100% of documents that successfully extract text are indexed and queryable (no silent ingestion failures).
- **SC-004**: A remote source (Google Drive / website) can be refreshed and reflect added/removed content without user re-creation.

## Assumptions

- **Single-user**: BOS is a personal OS; knowledge bases are owned by the single local user. Multi-user/team sharing is out of scope for v1.
- **Retrieval model**: v1 uses semantic retrieval over entities and facts in a knowledge graph (Graphiti), with passages reconstructed from episodes. The embedding/model provider is the user's configured AI provider (Constitution II); the feature does not host or train models.
- **No generative answers in v1 (Q=A)**: query tools are search + retrieve (return passages), not conversational Q&A. Generative "ask the KB" is a possible future story.
- **Text-extractable files only**: ingestion targets PDF, TXT, MD, DOCX, and similar; binary-only formats are out of scope for v1.
- **Google Drive access**: requires the user to authorize the folder via OAuth; token refresh/expiry is handled by the integration.
- **Website crawling scope**: v1 crawls the given URL and same-domain subtree with a depth/limit cap (configurable). Full-site mirroring is out of scope.
- **Delivery via service configuration page**: the KB management UI is delivered as the service's configuration page via `settingsRegistration.configApp` (a self-contained HTML file served at `/api/services/<id>/config-app` and rendered in the Settings → Plugins → Services → Knowledgebase panel). There is **no separate window app** for the KB. The `038-knowledge-base.html` mockup in this directory is the UI contract for that configuration page (FR-013).
- **Per-agent access assignment removed**: there is no per-KB, per-agent query-grant surface in this revision. The `kb-settings.html` mockup (Settings → Agents → [agent] → Knowledge bases) is **deferred/archived** — not part of the implemented scope at this stage.
- **Dependency on service-daemon infra**: the ingestion/indexing/query service facet runs as a worker-thread service daemon per the Service Daemons model (user-specs/002-service-daemons), outside the Next.js request pipeline, so heavy ingestion never blocks the UI.
- **Index storage**: index state persists under `data/` (BOS-owned runtime state), not in `src/`.
- **Graphiti stack deployed externally by the user**: the Graphiti engine, FalkorDB, and the Graphiti MCP server are **deployed and managed by the user in Dokploy** (a separate deployment platform), NOT bundled with BOS and NOT added to the BOS `docker-compose.yml`. There is **no BOS core source change** for the Graphiti stack, and the marketplace item ships **no docker-compose file**. The worker daemon reaches the user's Dokploy-deployed Graphiti MCP endpoint over loopback HTTP. **The endpoint is user-configurable in the service's configuration page (FR-014)** — the user sets it to their Dokploy-deployed MCP URL; a default (`http://127.0.0.1:8020/mcp/`) is provided but is editable in the config UI.
- **Quality-first performance (Q3)**: performance targets (ingestion time, query latency) are not fixed up-front. v1 focuses on retrieval and ingestion *quality* (correctness, coverage, relevance); latency is measured/reported but optimization is deferred until quality targets are met.

## UI Mockup Reference

- **Primary mockup**: `/Specs/user-specs/038-knowledge-base/038-knowledge-base.html` — the UI contract for the service's configuration page (FR-013). It shows the empty KB list, the populated master-detail KB list, the KB detail (Sources / Health tabs — the Access tab has been removed), and the dialogs (New KB, Add Source, Upload, Drive connect, Website). **The Developer MUST use this mockup as the visual contract for the config page during implementation**; the delivered UI MUST conform to it.
- **Deferred mockup**: `/Specs/user-specs/038-knowledge-base/kb-settings.html` — the per-agent access-assignment page (Settings → Agents → [agent] → Knowledge bases). **Archived / not implemented at this stage** (per-agent access was removed from this revision).

## Clarifications Needed

The following are genuinely scope-defining and lack a single obvious default:

## Question 1: What should the agent query tools return?

**Context**: FR-009 — "tools that an agent can use to query the knowledge."

**Resolution (user: A)**: The agent query tools are **search + retrieve** — they return ranked relevant passages from a knowledge base (as entities/facts with passage provenance), and the agent consumes them. No generative/answer synthesis in v1.

## Question 2: Performance targets for ingestion and query

**Context**: SC-001/SC-002 — measurable ingestion and query latency targets.

**Resolution (user: quality-first)**: No fixed performance targets are set up-front. v1 prioritizes **quality** (retrieval correctness, coverage, relevance; no silent ingestion failures) before optimizing for speed. Ingestion and query latency are measured and reported, but optimization is deferred until quality targets are met.
