# Feature Specification: OKF Knowledge Base & Ingestion Pipeline

**Feature Branch**: `bos/040-okf-knowledge-base`

**Created**: 2026-08-16

**Status**: Draft

**App Target**: **mixed — `bos-core` + `marketplace-item`.** This feature has two deliverables that must ship together:

1. **`bos-core`** — four small, targeted changes to `src/`: (a) fix `web_fetch`/`web_search` to return clean, complete, link-preserving markdown instead of the current regex-stripped, silently-truncated text; (b) add a general-purpose `file_to_markdown` server tool (PDF/DOCX/PPTX/XLSX → markdown via the sandbox's existing `markitdown` install) and a `video_keyframes` tool (ffmpeg-based); (c) extend the marketplace item install pipeline (`src/system/marketplace/install/symlinkManager.ts`) so an item can bundle agents/skills that get copied (not symlinked) into `data/agents/`/`data/skills/` with update-conflict detection; (d) add `ffmpeg` to both `Dockerfile` and `docker/run-command/Dockerfile`, and add provider-native-video-understanding capability detection alongside the existing `isNativeWebSearchAvailable()` pattern.
2. **`marketplace-item`** (service facet + config-app UI facet) — the OKF Knowledge Base item itself, at `data/user-apps/items/okf-knowledge-base/`, redesigned around an agentic ingest pipeline, plus the delete capability.

Do NOT read this as two features awkwardly stapled together: the `bos-core` changes exist *only* to serve the KB's ingestion pipeline (clean fetch output, document conversion, and a bundled ingest agent are all prerequisites for FR-018+ below) and are not independently useful BOS features in their own right.

**Input**: User description: consolidates and supersedes the prior `040-okf-knowledge-base` and `041-okf-delete-capability` specs. Both are folded into this single spec; neither prior spec is retained separately.

## Overview

This feature delivers a **Knowledge Base for BrowserOS whose storage format is the Open Knowledge Format (OKF)** — a directory of Markdown files with YAML frontmatter (canonical source: `GoogleCloudPlatform/knowledge-catalog`, `okf/SPEC.md`, v0.2) — running as a marketplace-item background service, **plus** an ingestion pipeline capable of turning a URL, a local document (PDF/DOCX/PPTX/XLSX), an image, or a video into OKF concepts without ever routing the source content through the calling agent's own context.

### What stays the same (baseline, carried from the original 040/041)

1. Bundles live under the user's VFS at `/KnowledgeBase/<bundle>/`: concepts (`.md` files), edges (Markdown links), reserved files (`index.md`, `log.md`), and semantic frontmatter families (provenance, trust, lifecycle, sources).
2. Every operation is exposed to agents as native tools (`okf_*`), declared by the service via the 039 Service Tool Exposure contract.
3. **Retrieval is LLM-based over OKF structure** — the LLM traverses the concept graph (links/backlinks, provenance, trust, lifecycle) to answer, following Andrej Karpathy's "LLM Wiki" pattern (canonical gist `https://gist.github.com/karpathy/442a6bf555914893e9891c11519de94f`). No RAG, no embeddings, no vector store, no model hosting in the service.
4. Deletion — of a whole bundle (`okf_delete_bundle`) or a single concept (`okf_delete_concept`) — is supported on both the tool surface and the config-app, confirmation-gated in the UI, non-destructive to the graph by default.

### What's new — the ingestion redesign

The original 040 shipped `okf_ingest` as a flat tool requiring the caller to pass the **entire source content as a string argument** (`{bundle, filename, content, conceptId, title}`). This has two costs: the calling LLM must reproduce/output the full source verbatim (token cost, truncation risk, hallucination risk on long sources), and the source content bloats the calling conversation's context for no benefit. Compounding this, `web_fetch`/`web_search` (the tools most likely to feed `okf_ingest`) themselves regex-strip HTML (dropping every link) and silently truncate at 200KB.

The redesign splits **mechanical acquisition** (deterministic, no LLM involved) from **semantic decomposition** (inherently a reasoning task — deciding concept boundaries, resolving citations, linking the graph):

- **Mechanical acquisition** — a fixed `web_fetch`, plus new `file_to_markdown` (PDF/DOCX/PPTX/XLSX via `markitdown`) and `video_keyframes` (ffmpeg) tools — gets bytes into `raw/` via the renamed-and-narrowed `okf_add_raw_source` tool. None of this requires an LLM turn to relay content.
- **Semantic decomposition** — reading the raw source, deciding concept granularity, writing frontmatter, linking into the graph, resolving loose citations ("Foo et al. 2024", `arxiv:NNNN.NNNNN`) that aren't plain URLs, and recursing into references worth ingesting — happens inside a **bounded sub-agent run**, dispatched via BOS's existing `agent_delegate` mechanism (`src/lib/assistant/tools/server/delegate-local.ts` → `runInnerLoop`), not a flat tool call. The sub-agent is a bundled agent (`okf-ingest`) shipped *with* the marketplace item, restricted to exactly the tools it needs (least privilege), so the top-level assistant's own tool surface never grows to accommodate ingestion's internal steps.
- Images are ingested by giving the sub-agent the image directly as a multimodal content block (BOS's assistant harness already supports this — `src/lib/assistant/messages.ts`, `model-turn.ts`) rather than OCR — real understanding, not text extraction.
- Video is ingested via ffmpeg keyframe sampling by default, with a provider-native-video-understanding path preferred when the active model/provider supports it (capability-detected, mirroring `isNativeWebSearchAvailable()` in `src/lib/agent/web-search.ts`).
- Reference/citation discovery is **mechanical where possible** (regex over the fetched markdown for URLs, `arxiv:` IDs, DOIs) and only falls back to the sub-agent's own `web_search` reasoning for bare author-year citations that have no explicit link — cost proportional to actual ambiguity, not a blanket LLM pass over every reference.
- Crawl depth (how many hops of references to follow) and fan-out worker count (how many references to ingest concurrently) are **configurable**, with a bundle-level default (in the service's `configSchema`, alongside the existing `bundleRoot`/`port`) and a per-call override on `okf_ingest`.

### What's new — marketplace items can bundle agents/skills

The `okf-ingest` sub-agent above has to come from *somewhere* installable. BOS's marketplace items currently support bundling an app facet and/or a service facet (035-install-by-symlink: one symlink per item, nothing copied). This feature extends that model, for agents/skills only, to **copy-on-install** (matching the existing `seed/agents/` → `data/agents/`, `seed/skills/` → `data/skills/` pattern already used for BOS's built-in agents/skills) with **provenance tracking** so a later item update can tell whether the user (or the running agent itself, e.g. via the skill reflective-optimizer) has diverged from what was installed, and prompt to keep-or-replace only when it actually has.

## User Scenarios & Testing *(mandatory)*

### User Story 1 - I can create an OKF knowledge base and add concepts to it (Priority: P1)

The user creates a new knowledge base (an OKF bundle) and the LLM adds concepts (Markdown files with frontmatter) into it via the `okf_*` tools. Concepts become graph nodes, links become edges, and the content is queryable.

**Why this priority**: Foundation — without a bundle and concepts, nothing else can be demonstrated.

**Independent Test**: Create a bundle named "Engineering Docs" from the service config page, add three concept files via `okf_upsert_concept`, verify each appears in the bundle, then confirm a link between two concepts is retrievable via the query tools.

**Acceptance Scenarios**:

1. **Given** the OKF service configuration page, **When** the user creates a new knowledge base with a name, **Then** an OKF bundle directory is created under `/KnowledgeBase/<name>/` with `index.md` and `log.md`.
2. **Given** an existing bundle, **When** the agent calls `okf_upsert_concept` with an id, type, frontmatter, and body, **Then** a concept `.md` file is written and appears in `okf_list_concepts`.
3. **Given** a concept with a Markdown link to another concept, **When** the agent reads it via `okf_read_concept` or queries it, **Then** the edge is extracted and navigable (`okf_neighbors`, `okf_backlinks`).

---

### User Story 2 - I can ask the agent to ingest a URL into a bundle, and it never has to retype the source (Priority: P1)

The user says "ingest this article into bundle X." The agent calls `okf_add_raw_source` with the URL (fetched via the fixed `web_fetch`, clean markdown, no truncation), which lands the content in `raw/`, then delegates to the bundled `okf-ingest` agent to decompose it into concepts. At no point does the orchestrating conversation's context carry the full article text.

**Why this priority**: This is the headline problem this feature exists to solve — the prior design forced the calling LLM to output the entire source as a tool argument.

**Independent Test**: Ask the assistant to ingest a known article URL into a bundle; inspect the conversation transcript and confirm the raw article text never appears as model-generated output; verify concepts appear in the bundle afterward.

**Acceptance Scenarios**:

1. **Given** a URL, **When** the agent calls `okf_add_raw_source` (backed by a fixed `web_fetch`), **Then** the full page content — clean markdown, links preserved, not truncated — lands in `raw/` without the calling LLM having generated that content as output tokens.
2. **Given** a raw source has been added, **When** the agent (or the dispatching layer) delegates to the `okf-ingest` agent via `agent_delegate`, **Then** the sub-agent reads the raw source directly (not re-supplied as an argument), writes one or more concepts with provenance/trust/lifecycle frontmatter, links them into the graph, and updates `index.md`/`log.md`.
3. **Given** an article containing both explicit URLs and bare citations ("Foo et al. 2024", `arxiv:2401.00001`), **When** the sub-agent resolves references, **Then** explicit URLs and arXiv/DOI-pattern citations are resolved mechanically (no `web_search` call), and only bare author-year citations trigger a `web_search`-backed resolution.
4. **Given** a bundle-level `maxDepth`/`maxWorkers` configuration (or a per-call override), **When** the sub-agent discovers references worth ingesting, **Then** it follows at most `maxDepth` hops and ingests at most `maxWorkers` references concurrently, and skips references whose source already exists in the bundle (dedup against prior ingests).

---

### User Story 3 - I can ingest documents, images, and video, not just URLs (Priority: P1)

The user points the agent at a local PDF, DOCX, PPTX, or XLSX file, an image, or a video, and asks it to be ingested into a bundle.

**Why this priority**: The original ingestion design was scoped to text/Markdown only; multi-format ingestion was always intended and the sandbox already ships the tooling to do it.

**Independent Test**: Ingest a PDF containing multiple sections; verify each becomes a distinct, correctly-linked concept. Ingest a photo; verify the resulting concept reflects real visual understanding, not just literal OCR text. (Video: verify once `ffmpeg` lands per FR-024.)

**Acceptance Scenarios**:

1. **Given** a PDF/DOCX/PPTX/XLSX file, **When** the agent calls `file_to_markdown`, **Then** the file is converted to markdown via the sandbox's `markitdown` (staged through `workspace/`, never requiring the OKF service's `KnowledgeBase/` path to be visible inside the `run_command` sandbox) and the result is registered via `okf_add_raw_source`.
2. **Given** an image, **When** the `okf-ingest` sub-agent processes it, **Then** the image is passed as a multimodal content block (not OCR-only) and the resulting concept cites the original image file (kept immutable in `raw/`) as its source.
3. **Given** a video and `ffmpeg` present in both Docker images (FR-024), **When** the agent calls `video_keyframes`, **Then** keyframes are sampled and passed to the sub-agent for understanding; if the active provider/model supports native video input (capability-detected per FR-023), that path is preferred over frame-sampling.

---

### User Story 4 - An agent can query and traverse the knowledge graph with native tools (Priority: P1)

The agent uses the `okf_*` tools — which appear in its tool registry as native, callable tools — to search, read, traverse, and synthesize over the knowledge base.

**Why this priority**: Proves the tool-exposure model works and that retrieval is genuinely LLM-driven.

**Independent Test**: With the item installed, ask the assistant to research a topic in the bundle, then verify it reads the index, traverses relevant concepts via links, and synthesizes an answer.

**Acceptance Scenarios**:

1. **Given** the OKF KB item is installed and its service running, **When** the assistant invokes an `okf_*` tool by name, **Then** the tool executes in the service and returns a result (no external tool-server configured).
2. **Given** a schema-validating `okf_*` tool, **When** the assistant calls it with a missing required field, **Then** BOS rejects the call with a JSON-schema validation error and does not invoke the service (039 FR-004).
3. **Given** a restrictive tool-gate config, **When** the assistant tries to call an `okf_*` tool matching that scope, **Then** it is not auto-executed — it is gated exactly like a built-in tool (039 FR-005).
4. **Given** a query, **When** the assistant performs retrieval, **Then** it reads `index.md` first, traverses relevant concepts via links/backlinks, weighs provenance/trust/lifecycle, and synthesizes an answer with citations.

---

### User Story 5 - I can delete a bundle or a concept, from either surface (Priority: P1)

The user removes a knowledge base they no longer need, or a single wrong/superseded concept, from the config UI or via an agent tool call.

**Why this priority**: Without delete, an unwanted or miscreated bundle/concept cannot be cleaned up at all — this was entirely missing from the original 040 (carried over from 041, now the baseline rather than an add-on).

**Independent Test**: Create a bundle, delete it via `okf_delete_bundle`; verify it disappears from `okf_list_bundles` and disk. Add a concept, delete it via `okf_delete_concept`; verify the bundle is otherwise intact.

**Acceptance Scenarios**:

1. **Given** an existing bundle, **When** the user selects Delete Bundle in the config UI and confirms (or an agent calls `okf_delete_bundle`), **Then** the bundle directory under `/KnowledgeBase/<name>/` is removed and it no longer appears in `okf_list_bundles`.
2. **Given** an existing concept, **When** the user selects Delete Concept and confirms (or an agent calls `okf_delete_concept`), **Then** the concept file is removed; the bundle remains otherwise intact.
3. **Given** a concept other concepts link to, **When** it is deleted with default settings, **Then** backlinks are left intact (broken-link candidates for `okf_lint`); with `rewrite_backlinks: true`, each backlinker is rewritten, `index.md` updated, `log.md` appended.
4. **Given** a Delete Bundle/Concept confirmation dialog, **When** the user cancels, **Then** nothing is deleted.

---

### User Story 6 - I can manage and distribute OKF bundles (Priority: P2)

The user imports/exports bundles, views bundle health, and manages the lifecycle from the service configuration page.

**Why this priority**: OKF is a distribution format; import/export is core to "portable, human-readable" but secondary to ingest/query/delete.

**Independent Test**: Import an existing OKF bundle (a directory or tarball), verify its concepts are queryable, then export it and confirm the export is spec-conformant.

**Acceptance Scenarios**:

1. **Given** an existing OKF bundle on disk, **When** the user imports it, **Then** its concepts appear and are queryable.
2. **Given** a bundle, **When** the user exports it, **Then** the export is a spec-conformant OKF bundle.
3. **Given** the config page, **When** the user views a bundle, **Then** its status shows concept count, stale/deprecated concepts, and per-concept trust levels.

---

### User Story 7 - A marketplace item's bundled agent/skill updates without silently clobbering my edits (Priority: P2)

The OKF Knowledge Base item ships the `okf-ingest` agent and its schema-as-skill. When the item is updated (new marketplace version) or reinstalled, a user who customized the agent's prompt, or whose agent self-tuned the skill (reflective optimizer), doesn't lose that work silently, but also isn't nagged on every routine update.

**Why this priority**: Prerequisite for shipping any bundled agent/skill safely; without it, item updates are either always-destructive (bad) or always-additive-and-stale (also bad).

**Independent Test**: Install the item; edit the installed `okf-ingest` agent's prompt; update the item to a new version; verify a keep-vs-replace prompt appears (rather than a silent overwrite). Reinstall the same version unchanged; verify no prompt appears.

**Acceptance Scenarios**:

1. **Given** a marketplace item bundling agents/skills, **When** it is installed, **Then** each bundled agent/skill is *copied* into `data/agents/<id>/`/`data/skills/<id>/` (never symlinked), with provenance (`itemId`, `version`, content hash) recorded.
2. **Given** an installed bundled agent/skill unmodified since install, **When** the item is updated, **Then** the new version replaces it silently.
3. **Given** an installed bundled agent/skill that has since diverged (user edit, or agent self-modification) from its recorded provenance hash, **When** the item is updated, **Then** the user is prompted to keep the local version or take the incoming update, before anything is overwritten.

---

### User Story 8 - Provenance, trust, and lifecycle are first-class operations (Priority: P3)

The agent manages provenance (sources/actors), the trust ladder, and lifecycle (status/stale_after) via tools.

**Why this priority**: OKF's differentiators vs. a plain file store; lower priority than ingest/query/delete.

**Independent Test**: Mark a concept `human-reviewed`, attach a source, set `status: deprecated` with a `stale_after`, verify `okf_stale_report` surfaces it.

**Acceptance Scenarios**:

1. **Given** a concept, **When** the agent calls `okf_set_trust`, **Then** `trust`/`verified` update and unknown keys are preserved.
2. **Given** a concept, **When** the agent attaches a source or sets `status`/`stale_after`, **Then** the frontmatter persists and lifecycle tools reflect it.
3. **Given** a concept whose `stale_after` has passed, **When** `okf_stale_report` runs, **Then** it is returned.

### Edge Cases

- What happens when a concept file has unknown frontmatter keys? → preserved verbatim on every write, never dropped.
- What happens when a tool call fails inside the service? → reported as a tool error; BOS does not crash; the service restarts on crash.
- What happens when a concept link points to a non-existent target? → non-fatal warning (broken-link detection).
- What happens when the service is stopped/uninstalled? → its `okf_*` tools disappear from the registry immediately.
- What happens if a write targets a path outside the configured bundle root? → rejected.
- What happens if the user edits a concept file by hand while the service runs? → re-read from disk on each read; backlink index rebuilt lazily/on-change.
- What happens when an ingest run's reference crawl would exceed `maxDepth`/would re-fetch an already-ingested source? → the hop is skipped, not silently fetched anyway; skipped references are reported in the sub-agent's summary, not silently dropped.
- What happens if a reference resolves to a URL already present in the bundle's provenance? → skipped (dedup), not re-ingested as a duplicate concept.
- What happens if `file_to_markdown`/`video_keyframes` need the bundle's `raw/` path but the sandbox only has `workspace/` enabled? → the tool stages the input/output through `workspace/`; the OKF service's own (non-sandboxed) write path moves the result into `raw/` — the `run_command` sandbox never needs `KnowledgeBase/` in its visible-paths configuration.
- What happens when the active AI provider has no native video/vision or native web-search capability? → the capability-detection check (mirroring `isNativeWebSearchAvailable()`) reports unavailable and the tool/pipeline falls back to the deterministic path (ffmpeg frames; plain fetch) rather than failing.
- What happens on deleting the last concept in a bundle? → the bundle remains valid (empty concept list); not auto-deleted.
- What happens on deleting a non-existent bundle/concept? → graceful "not found" error; nothing else deleted.
- What happens when a marketplace item's bundled agent/skill has no recorded provenance (e.g., pre-existing install from before this feature)? → treated as diverged/unknown on first update after upgrade — prompt keep-vs-replace once, then record provenance going forward.

## Requirements *(mandatory)*

### Functional Requirements — baseline KB (carried from original 040)

- **FR-001**: The OKF KB MUST be a marketplace item with a service facet managing OKF bundles under `/KnowledgeBase/`.
- **FR-002**: The service facet MUST opt into tool exposure via `deploymentMode: "tools"` (039 ADR-002) and declare `okf_*` tools natively via the Service Tool Exposure contract.
- **FR-003**: Each declared tool MUST be validated against its JSON schema before dispatch.
- **FR-004**: Service-declared tools MUST respect the existing tool-gating/permission model exactly like built-ins.
- **FR-005**: When the service is stopped/uninstalled, its tools MUST be removed from the registry.
- **FR-006**: A tool-execution error inside the service MUST be reported as a tool error without crashing BOS; invocations use loopback-scoped auth as the trust boundary.
- **FR-007**: The service MUST create bundles with the spec-conformant layout: `index.md`, `log.md`, `concepts/`, `raw/`, a schema file.
- **FR-008**: The service MUST support concept CRUD as tools: `okf_upsert_concept`, `okf_read_concept`, `okf_delete_concept`, `okf_list_concepts`, `okf_find_concepts`.
- **FR-009**: The service MUST preserve unknown frontmatter keys verbatim on every write (merge-on-fields, never wholesale rewrite).
- **FR-010**: The service MUST extract Markdown links as graph edges and provide graph tools (`okf_add_link`, `okf_remove_link`, `okf_list_links`, `okf_backlinks`, `okf_neighbors`, `okf_shortest_path`, `okf_export_graph`).
- **FR-011**: The service MUST support provenance/trust/lifecycle tools (`okf_set_trust`, `okf_add_source`, `okf_set_status`, `okf_attest`, `okf_provenance`, `okf_stale_report`).
- **FR-012**: The service MUST support point-in-time reads via `okf_get_as_of`.
- **FR-013**: The service MUST support bundle import/export (`okf_import_bundle`, `okf_export_bundle`).
- **FR-014**: The service MUST provide a management config-app page for bundle create/import/export/health.
- **FR-015**: The management UI MUST conform to `040-okf-knowledge-base.html` for all baseline screens; delete controls (FR-016 below) and any new ingest-run/agent-bundling UI extend it (see UI Mockup Reference).
- **FR-016**: The service MUST write atomically and guard against path traversal outside the configured bundle root.
- **FR-017**: `okf_delete_concept` MUST be non-destructive by default: no backlink/index/log rewrite unless `rewrite_backlinks: true`.

### Functional Requirements — delete capability (carried from 041, now baseline)

- **FR-018**: The service MUST provide `okf_delete_bundle`, deleting an entire bundle directory and returning a result to the agent.
- **FR-019**: The config UI MUST provide Delete Bundle and Delete Concept actions, each gated by a confirmation dialog naming the target; cancel MUST abort without deleting.
- **FR-020**: Deleting a concept MUST NOT delete the bundle or other concepts; deleting a bundle MUST remove only that bundle's directory.
- **FR-021**: Deleting a non-existent bundle/concept MUST return a clear "not found" error without deleting anything else.
- **FR-022**: Delete tools MUST respect the same 039 tool contract as every other `okf_*` tool.

### Functional Requirements — ingestion redesign (new)

- **FR-023**: `web_fetch` MUST return complete, link-preserving content, and MUST keep working on **every** provider. Where the provider offers a native web-fetch server tool (Anthropic), route through it — the provider does the extraction upstream and returns cleaner output than any local converter. Where it does not (self-hosted / OpenAI-compatible endpoints), fall back to fetching locally and converting HTML to markdown in BOS, preserving `<a href>` targets (absolutized against the page URL) and never truncating silently. The tool MUST NOT be reduced to an error on non-Anthropic providers: it worked everywhere before native support existed, and removing that is a straight downgrade for those users.
- **FR-024**: The service MUST expose `okf_add_raw_source` (`{bundle, filename, content?, sourcePath?, conceptId?, title?}`) as the mechanical primitive that registers bytes into `raw/`, accepting either inline `content` (small/pasted text) or a `sourcePath` already staged on disk (e.g. by `web_fetch`/`file_to_markdown`) — the caller MUST NOT be required to pass large content as an inline argument when a `sourcePath` is available.
- **FR-025**: `okf_ingest` MUST dispatch semantic decomposition to a bounded sub-agent run (via `agent_delegate`/`runInnerLoop`) rather than performing concept-writing itself; the sub-agent MUST be restricted to a least-privilege tool set (raw-source read, `okf_upsert_concept`/`okf_add_link`/`okf_set_*`/`okf_add_source`/`okf_append_log`, `okf_find_concepts`/`okf_read_concept`/`okf_read_index` for dedup, `web_search`/`web_fetch` for reference resolution).
- **FR-025a**: `okf_ingest` MUST be the single entry point for an ingest, accepting a URL, a VFS path, or a `raw/` path. It MUST NOT perform acquisition itself (the service worker has no `web_fetch`/`file_to_markdown`), and MUST instead return the exact acquisition steps to run — **with `output_path` pinned on every fetch/convert step**. Requiring the caller to remember `output_path` is insufficient: omitting it forces the model to regenerate the whole document as output tokens to store it, silently defeating SC-007.
- **FR-025b**: Acquisition tools (`web_fetch`, `file_to_markdown`) MUST support an `output_path` that writes content to the VFS and returns only a receipt (path + size), never the content. Without this there is no way to move a document into `raw/` except by the model re-emitting it verbatim.
- **FR-026**: Reference/citation discovery MUST resolve explicit URLs, `arxiv:`-pattern IDs, and DOIs mechanically (regex, no LLM call); only citations with no explicit machine-resolvable identifier (e.g., bare "Author et al. Year") MAY invoke `web_search`-backed resolution.
- **FR-027**: Reference crawl depth and concurrent ingest worker count MUST be configurable, with a bundle-level default (service `configSchema`) and a per-`okf_ingest`-call override. `maxWorkers` MUST mean real concurrency — satisfied by FR-038's parallel tool execution, since `agent_delegate` is parallel-safe.
- **FR-038**: The agent loop MUST support running tool calls concurrently within a turn, as an **opt-in per-tool** property (`parallelSafe`) so existing tools are unaffected. It MUST: batch only *adjacent* parallel-safe calls (never reordering a write around a read), bound concurrency by a configurable cap, append results in call order rather than completion order, and preserve the existing guarantees — every `tool_use` id answered, cancellation, per-call hooks, and in-band error isolation (one failing call must not strand its siblings).
- **FR-028**: The sub-agent MUST check for and skip references whose source is already present in the bundle's provenance (dedup against prior ingests), rather than re-ingesting duplicates.
- **FR-029**: A general-purpose `file_to_markdown` tool MUST convert PDF/DOCX/PPTX/XLSX to markdown via the sandbox's `markitdown` install, staged through `workspace/` so the `run_command` sandbox never requires the bundle's `KnowledgeBase/` path to be visible.
- **FR-030**: Images MUST be ingested via a real vision content block to the sub-agent (via the new `view_image` tool and the `ToolExecuteResult` mechanism — see design.md), not OCR-only extraction.
- **FR-031**: A `video_keyframes` tool MUST sample frames from a video via `ffmpeg`/`ffprobe` for ingestion, returned as image attachments via the same `ToolExecuteResult` mechanism; when the active provider/model supports native video understanding (capability-detected per FR-032), that path MUST be preferred over frame-sampling.
- **FR-032**: BOS MUST add a provider capability-detection check for native video understanding (`isNativeVideoUnderstandingAvailable()`, `src/lib/agent/web-search.ts`), following the existing `isNativeWebSearchAvailable()` pattern. Confirmed against current provider docs that neither Anthropic nor OpenAI support native video input today — the check exists and always returns `false` for now; frame-sampling via `video_keyframes` is the only working path until a provider adds it.
- **FR-033**: `ffmpeg` MUST be added to both `Dockerfile` and `docker/run-command/Dockerfile` (kept in lockstep, per the existing comment documenting that invariant).

### Functional Requirements — marketplace item agent/skill bundling (new)

- **FR-034**: A marketplace item MUST be able to declare bundled agents (`agents/<id>/AGENT.md`) and skills (`skills/<id>/SKILL.md`) in its own directory.
- **FR-035**: On install (`installItemLink` in `src/system/marketplace/install/symlinkManager.ts`), bundled agents/skills MUST be **copied** into `data/agents/<id>/`/`data/skills/<id>/` — never symlinked — mirroring the existing `seed/agents/` → `data/agents/`, `seed/skills/` → `data/skills/` copy-once pattern.
- **FR-036**: Each copied agent/skill MUST record provenance — source `itemId`, item `version`, and a content hash covering the asset's **entire directory** (entry file plus any `scripts/`/`references/`), so an edit to a bundled helper file counts as divergence just as an edit to the entry file does.
- **FR-037**: On item update/reinstall, if the installed agent/skill's current on-disk content matches its recorded provenance hash (untouched), the update MUST replace it silently; if it has diverged — or carries no recorded provenance at all — BOS MUST NOT overwrite it, and MUST instead record a conflict the user can resolve (keep local vs. take the update) from Settings. Conflicts MUST persist across the install that produced them, so a headless install (agent-driven `app_build`, marketplace sync) still surfaces the decision later rather than dropping it.

### Non-Functional Requirements

- **NFR-001 (Portability)**: Every bundle MUST be a spec-conformant OKF bundle usable with git/grep/editor.
- **NFR-002 (Durability)**: Atomic writes; `raw/` immutable (append-only).
- **NFR-003 (Forward compatibility)**: Unknown frontmatter keys preserved verbatim.
- **NFR-004 (Path safety)**: All writes scoped to the configured bundle root.
- **NFR-005 (Reliability)**: Tool errors/crashes reported without crashing BOS; service restarts on crash.
- **NFR-006 (Tool lifecycle)**: Tools removed on stop/uninstall.
- **NFR-007 (Tool gating parity)**: Same gating model as built-ins.
- **NFR-008 (Single-user)**: No multi-user access control required.
- **NFR-009 (External-edit resilience)**: Re-read from disk on each read; backlink index rebuilt lazily.
- **NFR-010 (No embeddings)**: No vector store/embedding pipeline; retrieval is file-graph + in-memory backlink index only.
- **NFR-011 (Least privilege for the ingest sub-agent)**: The `okf-ingest` agent's tool allowlist MUST stay narrow — it must not gain the top-level assistant's full tool surface merely by being delegated to.
- **NFR-012 (Bounded recursion)**: Reference crawling MUST respect `maxDepth` and dedup; an ingest run MUST NOT be able to unboundedly fan out across the web.
- **NFR-013 (Sandbox containment)**: `file_to_markdown`/`video_keyframes` MUST NOT require expanding the `run_command` sandbox's visible-paths configuration to include `KnowledgeBase/`.

### Key Entities

- **KnowledgeBundle**: An OKF bundle at `/KnowledgeBase/<name>/`. Attributes: name, path, `index.md`, `log.md`, concept count, `maxDepth`/`maxWorkers` ingest defaults.
- **Concept**: One `.md` file with frontmatter; id = path minus `.md`.
- **Edge / Link**: A Markdown link, concept A → concept B.
- **RawSource**: An immutable source in `raw/` — text, converted-document markdown, or a binary asset (image/video) the sub-agent reads directly.
- **BundleSchema**: The bundle's ingest/query/lint conventions — modeled as a BOS skill (see FR-034) rather than a bespoke convention file.
- **IngestRun**: One `agent_delegate` invocation of the `okf-ingest` agent — bundle, seed source, resolved/skipped references, concepts written, depth reached.
- **ReferenceCandidate**: A citation discovered in a source — either mechanically resolved (URL/arXiv/DOI) or requiring `web_search`; carries a resolved-URL-or-none and an ingest/skip decision.
- **ServiceTool**: An `okf_*` tool declared per the 039 contract.
- **BundleHealth**: Concept count, stale/deprecated concepts, per-concept trust — for the config page.
- **InstalledAgentAsset / InstalledSkillAsset**: A copied agent/skill under `data/agents/`/`data/skills/`, carrying `installedFrom: {itemId, version, contentHash}`.
- **DeleteConfirmation**: UI gate requiring explicit intent before a destructive action.

## Success Criteria *(mandatory)*

### Measurable Outcomes

- **SC-001**: An `okf_*` tool is visible and callable immediately on service start, no external tool-server configured.
- **SC-002**: 100% of valid tool invocations to a healthy service return a result without error; a crashing tool does not crash BOS.
- **SC-003**: A user can create a bundle, add concepts, and have 100% of concepts queryable.
- **SC-004**: Unknown frontmatter keys survive 100% of write/read round-trips.
- **SC-005**: A bundle exported by the service re-imports cleanly with all concepts/links/frontmatter intact.
- **SC-006**: Stopping/uninstalling the service removes its tools immediately.
- **SC-007**: Ingesting a URL results in zero article-length content appearing as model-generated output tokens in the orchestrating conversation (verifiable from the run transcript) — only the sub-agent's own bounded reasoning/tool-call turns.
- **SC-008**: A source containing explicit URLs and arXiv IDs resolves 100% of them without a `web_search` call; only bare author-year citations trigger one.
- **SC-009**: An ingest run never exceeds its configured `maxDepth`/`maxWorkers`, and never re-ingests a source already present in the bundle's provenance.
- **SC-010**: A PDF/DOCX/PPTX/XLSX file ingests into one or more concepts without the `run_command` sandbox needing `KnowledgeBase/` added to its visible paths.
- **SC-011**: Deleting a bundle/concept from the config UI takes at most 3 steps (select → confirm → deleted); 100% of destructive UI actions require confirmation.
- **SC-012**: An item update that finds its bundled agent/skill unmodified replaces it silently in 100% of cases; a diverged one prompts keep-vs-replace in 100% of cases, never a silent overwrite.

## Assumptions

- **039 is the tool-exposure mechanism** for all `okf_*` tools (tool declaration, JSON-schema validation, gating, loopback auth, removal on stop/uninstall).
- **LLM-based retrieval over OKF structure**: no embeddings, no vector DB, no RAG in the service.
- **Single-user**: BOS is a personal OS; no per-agent access assignment in v1.
- **`agent_delegate`/`runInnerLoop` already supports long-running sub-agent turns** (used by Build Studio → Developer today) — the ingest redesign is a new *consumer* of this mechanism, not new delegation infrastructure. Whether BOS's tool-calling loop dispatches multiple `agent_delegate` calls concurrently (for `maxWorkers` fan-out) is confirmed during implementation, not assumed here.
- **The sandbox already ships `markitdown[all]`, `poppler-utils`, `libreoffice`, `python-docx`, `python-pptx`** (verified in `Dockerfile`) — `file_to_markdown` is a wiring task, not a new capability.
- **`ffmpeg` is not yet present** in either Docker image — FR-033 is a real gap, not already covered.
- **Provider video/vision support varies and shifts over time** — capability detection (FR-032), not a hardcoded assumption of what any given provider supports.
- **No trash/soft-delete for v1** — bundle/concept deletion is permanent; a future feature could add it.
- **`raw/` sources remain immutable** and are never deletable independent of their concept/bundle.
- **Index state persists under `data/`**, not `src/`.

## UI Mockup Reference

- **Baseline**: `040-okf-knowledge-base.html` (this spec directory) — bundle list, bundle detail (concepts/health/import-export), New Bundle/Import/Export dialogs. Still the visual contract for these screens.
- **Delete controls**: the prior `041-okf-delete-capability.html` mockup (Delete Bundle / Delete Concept actions + confirmation dialogs) is the reference for these controls' visual design; fold its delete affordances into the single consolidated config-app UI during implementation — there is no longer a separate 041 mockup file to consult, so capture its intent (per-row delete + toolbar danger action + named confirmation dialog) directly in the implementation.
- **Not yet mocked**: an ingest-run status/progress surface (bundle-level `maxDepth`/`maxWorkers` settings, and visibility into an in-flight or completed ingest — concepts written, references skipped/ingested) has no mockup yet; design it consistent with the existing visual language during implementation.
