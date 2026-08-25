# Implementation Plan: Knowledge Base

**Branch**: `bos/038-knowledge-base` | **Date**: 2026-08-06 | **Spec**: [spec.md](spec.md) | **Design**: [design.md](design.md)

**Input**: Feature specification from `spec.md` (Revision 3: service-config delivery, per-agent access assignment removed, full functional scope retained).

## Summary

Add a **Knowledge Base** capability to BrowserOS. A knowledge base (KB) is a named, queryable collection of content from multiple source types (uploaded docs, a Google Drive folder, a website URL). Users create/manage KBs from the **Knowledge Base service's configuration page** — reached at Settings → Plugins → Services → Knowledgebase → config and delivered via the service's `settingsRegistration.configApp`. A BOS worker service daemon acquires source content, extracts text, and pushes episodes into **Graphiti** (a temporal knowledge graph) via its MCP server. Agents query KBs through search/retrieve tools.

**Architecture (from design.md, Revision 3):**
- **Dokploy side (external, user-managed)**: Graphiti MCP server (Python/FastAPI) + **FalkorDB** (graph DB; one DB per Graphiti group = hard per-KB partition), deployed and managed by the user in Dokploy — external to BOS, no BOS core change. **The Graphiti MCP endpoint is user-configurable in the service's config page (FR-014).**
- **BOS worker service daemon (Node)**: orchestrator + extractor + query tools. Fetches source bytes (uploads via `/api/fs`, Drive via invoke route, websites via crawler), extracts text (pdf/docx/pptx/xlsx/txt/md/html), chunks into episodes, pushes to Graphiti over loopback HTTP.
- **Configuration UI (service's `configApp`)**: the KB management UI delivered via `settingsRegistration.configApp`, served at `/api/services/knowledge-base/config-app` and rendered by `ServiceConfigPanel.tsx` at **Settings → Plugins → Services → Knowledgebase → config**. The `038-knowledge-base.html` mockup is the UI contract (FR-013). **No separate window app / app facet.**
- **Per-agent access assignment REMOVED (Revision 3)**: no per-KB, per-agent query grant; no `kb-settings.html` implementation. Query tools query any KB the requesting agent addresses.
- **Retrieval model**: Graphiti `search_nodes` / `search_memory_facts` per KB group, with passages reconstructed via `get_episodes` provenance (Q=A preserved: agent gets passages + citations).

## Technical Context

**Language/Version**: Node (BOS worker service daemon, TypeScript); Python 3.11+ (Graphiti MCP server, deployed by the user in Dokploy); self-contained HTML/JS for the config page.

**Primary Dependencies**:
- **Worker (service facet)**: `pdfjs-dist` (PDF), `mammoth` (DOCX), PPTX parser (unzip+XML), SheetJS `xlsx` (XLSX), `cheerio` (HTML). Graphiti MCP client over loopback HTTP. No native-compile dependencies (pure-JS extraction).
- **Config page**: self-contained HTML/JS (single bundle) per the `038-knowledge-base.html` mockup. Served via `/api/services/<id>/config-app`.
- **Dokploy (user-deployed)**: `getzep/graphiti` (graphiti + its MCP server), FalkorDB image. Graphiti needs an OpenAI-compatible endpoint for structured-output LLM + embeddings → routes through BOS `/api/llm/*` proxy. **No BOS compose file** — the user runs this stack in Dokploy.

**Storage**: Graphiti groups → FalkorDB (one DB per group/KB). KB metadata + ingestion journal → `data/kbs.json` and `data/` worker state (gitignored). No local vector DB — Graphiti abstracts embeddings internally.

**Testing**: Playwright e2e for the config page (`e2e/038-knowledge-base.spec.ts`); worker extraction/ingestion unit tests (pure-JS parsers); MCP/query integration tests against the user's Dokploy-deployed Graphiti stack.

**Target Platform**: BrowserOS (service daemon + config page) + Dokploy external services (user-managed).

**Project Type**: marketplace-item (**service facet only**) + user-deployed Dokploy Graphiti stack (no BOS docker-compose change).

**Performance Goals**: Quality-first (Q3) — no fixed latency targets up-front. Retrieval relevance and ingestion correctness prioritized; latency measured/reported, optimization deferred.

**Constraints**: Worker reaches BOS resources only via loopback HTTP (no `src/lib` imports); local-first (Graphiti telemetry must be disabled: `GRAPHITI_TELEMETRY_ENABLED=false`); worker-thread Node daemon must not block on heavy ingestion.

**Scale/Scope**: Single-user personal OS; KBs = Graphiti groups; sources = upload/Drive/website. v1 retrieval = entities/facts + provenance (no generative answers).

## Constitution Check

*GATE: Must pass before Phase 0 research. Re-check after Phase 1 design.*

| Principle | Verdict | Notes |
|-----------|---------|-------|
| **I. Spec-Driven** | ✅ PASS | Spec `spec.md` exists and is agreed (Revision 3); plan/design are derivative. Implement only after user confirms. |
| **II. Server Authority & SSR Boundary** | ✅ PASS | Worker reaches BOS via loopback HTTP routes (`/api/fs`, `/api/llm/*`, services config); secrets never returned to client; embeddings/LLM go through `/api/llm/*` proxy. |
| **III. Always Delegate; Claude Codes** | ✅ PASS | All coding delegated to the Developer (Claude) sub-agent at implement; Build Studio never writes code. |
| **IV. Minimize Blast Radius** | ✅ PASS | Marketplace-item → changes live under the item root only; the Graphiti stack is user-deployed in Dokploy, so there are **no BOS source edits at all** (no `src/`, no `docker-compose.yml`). |
| **V. The VFS Is Not the Source** | ✅ PASS | KB state (journal, index) persists under `data/`; no `src/` edits for this feature. |
| **VI. Specs & Docs Stay in Sync** | ✅ PASS | spec.md, checklists, design.md, plan.md updated together; drift recorded in `specs/discrepancies.md` if any. |
| **VII. Respect Boundaries** | ✅ PASS | No secrets/package.json/build-config changes; destructive ops (KB delete) confirm via UI. |

**Complexity Tracking**: No violations — marketplace-item (service-only) classification + user-deployed Dokploy Graphiti stack means there are **zero BOS source edits** (BOS kernel stays thin, per Constitution I). No justification needed.

## Project Structure

### Documentation (this feature)

```text
specs/user-specs/038-knowledge-base/
├── spec.md              # Feature specification (agreed, Revision 3)
├── checklists/requirements.md
├── design.md            # Revision 3 (Graphiti engine + service-config delivery)
├── plan.md              # This file
├── 038-knowledge-base.html  # UI mockup (service config page) — UI contract
├── kb-settings.html     # DEFERRED/ARCHIVED (per-agent access page; not implemented)
└── tasks.md             # Phase 2 output (created at implement gate)
```

### Source Code — marketplace-item root (service facet + config page)

> This is the **item root** (staged for `app_build`), not `src/`. Layout per `references/target-marketplace-item.md`. **No `app/` facet.**

```text
knowledge-base/                          # item root (staging dir)
├── services/                            # service facet — the BOS worker daemon
│   ├── service.json                     # id, name, entry, httpPath/wsPath, settingsRegistration.configApp
│   └── src/
│       ├── index.ts                     # worker entry; IPC loop
│       ├── pipeline/
│       │   ├── pipeline.ts              # orchestration: acquire → extract → chunk → ingest
│       │   ├── queue.ts                 # ingestion queue + state journal (retry)
│       │   └── journal.ts               # data/ ingestion state per source
│       ├── extract/                     # PURE-JS text extraction (no native deps)
│       │   ├── pdf.ts                   # pdfjs-dist → text
│       │   ├── docx.ts                  # mammoth → text
│       │   ├── pptx.ts                  # unzip+XML → text
│       │   ├── xlsx.ts                  # SheetJS → cell text
│       │   ├── txt.ts / md.ts           # trivial
│       │   └── html.ts                  # cheerio → readable text (websites)
│       ├── sources/
│       │   ├── upload.ts                # via /api/fs
│       │   ├── drive.ts                 # GSuite invoke route (OAuth folder)
│       │   └── website.ts               # crawler → html pages
│       ├── graphiti/
│       │   ├── client.ts                # MCP client over loopback HTTP; endpoint from config (user-set in config UI, FR-014)
│       │   ├── episodes.ts               # add_episode(group_id=<kb>)
│       │   └── query.ts                  # search_nodes/search_memory_facts + provenance
│       ├── tools.ts                      # kbs_tool_search / kbs_tool_retrieve
│       └── dedupe.ts                    # SHA-256 content-hash registry (FR-008)
│
└── config/                              # service config UI (the configApp) + defaults
    ├── config.html                      # KB management UI (self-contained; UI contract = mockup) incl. Graphiti MCP endpoint setting (FR-014)
    └── default.json                     # graphiti endpoint default, telemetry off, model refs
```

> **No docker-compose file**: the Graphiti/FalkorDB/MCP stack is deployed by the user in **Dokploy**, external to BOS. The item ships no compose file and BOS's `docker-compose.yml` is NOT modified.

**Structure Decision**: Marketplace-item with **service facet only** (`services/`) + **config UI** (`config/`), per `references/target-marketplace-item.md`. The worker service daemon holds the ingestion pipeline (acquire/extract/chunk/episodes) and the query tools. The config UI is the KB management surface, delivered via `settingsRegistration.configApp`. The Graphiti stack is **deployed externally by the user in Dokploy** (no BOS compose file, no BOS source change).

## Design Notes (folded from design.md)

- **Classification**: `marketplace-item` (**service facet only**) — agrees with spec.md App Target (Revision 3). No `src/` edits required; BOS kernel stays thin (Constitution I).
- **ADR-1 (Graphiti adoption)**: Graphiti replaces an earlier flexsearch/sqlite-vector store. Graphiti = temporal knowledge graph (entities/facts), hybrid retrieval, Apache 2.0. Telemetry MUST be disabled (`GRAPHITI_TELEMETRY_ENABLED=false`) for local-first.
- **ADR-2 (pipeline-in-worker)**: extraction + orchestration live in the BOS worker (Node, pure-JS parsers); Graphiti does LLM entity/edge extraction + graph write. Worker reaches BOS only via loopback HTTP.
- **ADR-3 (config-page delivery)**: the KB management UI is the service's `configApp` (self-contained HTML served via `/api/services/<id>/config-app`), rendered at Settings → Plugins → Services → Knowledgebase → config. No separate window app / app facet. The `038-knowledge-base.html` mockup is the UI contract.
- **ADR-4 (Dokploy external deployment)**: Graphiti + FalkorDB + MCP deployed by the user in Dokploy, external to BOS — **no BOS docker-compose change, no BOS core source change**. BOS service is the controller/frontend; worker reaches the Dokploy-deployed MCP endpoint over loopback HTTP. **The endpoint is configurable in the service's config UI (FR-014)** — default `http://127.0.0.1:8020/mcp/`, editable by the user. FalkorDB = one DB per Graphiti group (hard per-KB partition).
- **ADR-5 (retrieval = entities/facts + provenance)**: `search_nodes`/`search_memory_facts` per KB group, passages reconstructed via `get_episodes` — preserves Q=A (agent gets passages + citations).
- **ADR-6 (port-defaults-to-0)**: worker service binds a default port 0 (ephemeral) unless configured, so concurrent items don't collide.
- **Removed (Revision 3)**: no per-agent access assignment, no `services/access.ts`, no `assignedAgentIds`, no availability injection, no app facet. `kb-settings.html` deferred.

## Phase 0 / 1 companions

No separate `research.md`/`data-model.md` needed — research (Graphiti, sqlite-vector, config-page mechanism) is captured in design.md's citations and this plan. `contracts/` will be produced at implement if worker↔config-page and worker↔Graphiti contracts warrant it (MCP tool schemas, services `httpPath` routes, the config-page ↔ worker bridge).
