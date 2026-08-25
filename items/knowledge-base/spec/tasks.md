# Tasks: Knowledge Base

**Input**: Design documents from `/Specs/user-specs/038-knowledge-base/`
**Prerequisites**: plan.md (required), spec.md (required for user stories), design.md
**Tests**: Test tasks included for the worker pipeline and config-page e2e (feature uses Playwright e2e per plan).

**Revision 3**: service-config delivery (no app facet), per-agent access assignment removed (no US4, no kb-settings.html), full functional scope retained.

**Organization**: Tasks grouped by user story; each story independently implementable and testable.

## Format: `[ID] [P?] [Story] Description`
- **[P]**: Can run in parallel (different files, no dependencies)
- **[Story]**: US1–US4 (per spec.md user stories)
- Exact file paths under the marketplace-item root `knowledge-base/` (service facet `services/`, config UI `config/`).

## Path Conventions
- Item root: `knowledge-base/` (staged for `app_build`)
  - Service facet: `knowledge-base/services/`
  - Config UI: `knowledge-base/config/`

> **No docker-compose file**: the Graphiti/FalkorDB/MCP stack is deployed by the user in **Dokploy**, external to BOS. The item ships no compose file and BOS's `docker-compose.yml` is NOT modified.

<!-- Tasks are grouped by user story. Each story is independently implementable/testable and delivered as an MVP increment. -->

## Phase 1: Setup (Shared Infrastructure)

**Purpose**: Project initialization and basic structure

- [ ] T001 Create item-root structure per plan (`knowledge-base/services/`, `knowledge-base/config/`, `knowledge-base/package.json`)
- [ ] T002 Initialize worker service (TypeScript) with deps: `pdfjs-dist`, `mammoth`, SheetJS `xlsx`, `cheerio`, Graphiti MCP client — `knowledge-base/services/package.json`

## Phase 2: Foundational (Blocking Prerequisites)

**Purpose**: Core infrastructure that MUST be complete before ANY user story can be implemented

**⚠️ CRITICAL**: No user story work can begin until this phase is complete

- [ ] T004 Create worker entry + IPC loop — `knowledge-base/services/src/index.ts` (registers `service.json`, binds httpPath default port 0)
- [ ] T005 Create worker `service.json` (id `knowledge-base`, entry, httpPath/wsPath, `settingsRegistration.configApp` → `config/config.html`) — `knowledge-base/services/service.json`
- [ ] T006 [P] Create Graphiti MCP client (loopback HTTP to the user's Dokploy-deployed MCP endpoint, resolved from config — user-set in the config UI per FR-014, default `http://127.0.0.1:8020/mcp/`) — `knowledge-base/services/src/graphiti/client.ts` (add_episode, search_nodes, search_memory_facts, get_episodes)
- [ ] T007 [P] Create KB state store (KB metadata, journal) — `knowledge-base/services/src/state/` (`data/kbs.json`, `data/journal.json`)
- [ ] T008 Create `config/default.json` — graphiti endpoint default (`http://127.0.0.1:8020/mcp/`), telemetry off (`GRAPHITI_TELEMETRY_ENABLED=false`), model refs via `/api/llm/*` proxy — `knowledge-base/config/default.json`
- [ ] T009 Create content-hash dedupe registry (SHA-256) — `knowledge-base/services/src/dedupe.ts` (FR-008)

**Checkpoint**: Foundation ready — user story implementation can begin in parallel

---

## Phase 3: User Story 1 — Create KB + upload documents (Priority: P1) 🎯 MVP

**Goal**: From the service config page, create a knowledge base, upload documents, ingest them, make them queryable via agent tools.
**Independent Test**: From the config page, create KB "Engineering Docs", upload 3 markdown files, observe ingestion complete, confirm content retrievable via query tool.

### Tests for User Story 1
> **NOTE: Write these tests FIRST, ensure they FAIL before implementation**
- [ ] T010 [P] [US1] Worker extraction unit tests — `knowledge-base/services/tests/extract.test.ts` (pdf/docx/pptx/xlsx/txt/md → text)
- [ ] T011 [P] [US1] Worker ingestion pipeline tests — `knowledge-base/services/tests/pipeline.test.ts` (acquire → extract → chunk → add_episode → journal update)
- [ ] T012 [P] [US1] Config-page e2e test — `knowledge-base/config/e2e/038-knowledge-base.spec.ts` (create KB, upload, status Indexed) — **UI must conform to the `038-knowledge-base.html` mockup**

### Implementation for User Story 1
- [ ] T013 [P] [US1] Extractors: PDF `pdfjs-dist` — `knowledge-base/services/src/extract/pdf.ts`
- [ ] T014 [P] [US1] Extractors: DOCX `mammoth` — `knowledge-base/services/src/extract/docx.ts`
- [ ] T015 [P] [US1] Extractors: PPTX (unzip+XML) — `knowledge-base/services/src/extract/pptx.ts`
- [ ] T016 [P] [US1] Extractors: XLSX (SheetJS) — `knowledge-base/services/src/extract/xlsx.ts`
- [ ] T017 [P] [US1] Extractors: TXT/MD — `knowledge-base/services/src/extract/txt.ts`, `knowledge-base/services/src/extract/md.ts`
- [ ] T018 [US1] Source acquisition: upload — `knowledge-base/services/src/sources/upload.ts` (via `/api/fs`)
- [ ] T019 [US1] Ingestion pipeline orchestration (acquire → extract → chunk → add_episode → journal) — `knowledge-base/services/src/pipeline/pipeline.ts`
- [ ] T020 [US1] Ingestion queue + retry — `knowledge-base/services/src/pipeline/queue.ts`
- [ ] T021 [US1] Episode chunking (one doc = one episode default; large docs split by heading/token cap) — `knowledge-base/services/src/pipeline/chunk.ts`
- [ ] T022 [US1] Graphiti `add_episode(group_id=<kb>)` wiring — `knowledge-base/services/src/graphiti/episodes.ts`
- [ ] T023 [US1] **Config page: KB list + create (conforming to mockup screens `screen-list-empty` / `screen-list`)** — `knowledge-base/config/config.html`
- [ ] T024 [US1] **Config page: KB detail + sources tab + per-source status (mockup `screen-detail` + `tab-sources`)** — `knowledge-base/config/config.html`
- [ ] T025 [US1] **Config page: add-source upload dialog (mockup `tab-sources` + upload modal)** — `knowledge-base/config/config.html`
- [ ] T026 [US1] **Config page ↔ worker service bridge (over worker `httpPath` / services config route)** — `knowledge-base/config/config.html` + worker IPC
- [ ] T026b [US1] **Config page: Graphiti MCP endpoint setting (FR-014)** — editable URL field in the config page; persists; worker reads it for all Graphiti calls; change applies without reinstall — `knowledge-base/config/config.html` + worker IPC
- [ ] T027 [US1] Agent query tools `kbs_tool_search` / `kbs_tool_retrieve` — `knowledge-base/services/src/graphiti/query.ts` + `knowledge-base/services/src/tools.ts`

**Checkpoint**: At this point, US1 should be fully functional and testable independently

---

## Phase 4: User Story 2 — Google Drive folder source (Priority: P2)

**Goal**: Connect a Google Drive folder, index files, keep in sync on refresh.
**Independent Test**: Connect a Drive folder, verify files indexed + queryable, add a file, refresh, verify picked up.

### Tests for User Story 2
> **NOTE: Write these tests FIRST, ensure they FAIL before implementation**
- [ ] T028 [P] [US2] Drive source acquisition tests — `knowledge-base/services/tests/sources-drive.test.ts` (invoke route, folder listing, refresh)

### Implementation for User Story 2
- [ ] T029 [P] [US2] Drive source acquisition (GSuite invoke route + OAuth folder) — `knowledge-base/services/src/sources/drive.ts`
- [ ] T030 [US2] Drive refresh (pick up new/changed files; de-index removed) — `knowledge-base/services/src/sources/drive.ts` + `knowledge-base/services/src/pipeline/refresh.ts`
- [ ] T031 [US2] **Config page: Drive connect + folder-select flow (mockup Drive connect modal)** — `knowledge-base/config/config.html`
- [ ] T032 [US2] Integrate with US1 pipeline (reuse extract/chunk/add_episode)

**Checkpoint**: US1 AND US2 both work independently

---

## Phase 5: User Story 3 — Website source (Priority: P2)

**Goal**: Provide a website URL, crawl + index pages, keep queryable.
**Independent Test**: Add a website URL, verify pages crawled/indexed + queryable, re-crawl after update.

### Tests for User Story 3
> **NOTE: Write these tests FIRST, ensure they FAIL before implementation**
- [ ] T033 [P] [US3] Website crawler tests — `knowledge-base/services/tests/sources-website.test.ts` (crawl, same-domain subtree, depth/limit cap)

### Implementation for User Story 3
- [ ] T034 [P] [US3] Website crawler — `knowledge-base/services/src/sources/website.ts` (crawl + HTML pages)
- [ ] T035 [US3] HTML extraction via cheerio — `knowledge-base/services/src/extract/html.ts`
- [ ] T036 [US3] Website re-crawl (pick up changes; de-index removed) — `knowledge-base/services/src/pipeline/refresh.ts` (website variant)
- [ ] T037 [US3] **Config page: website URL input flow (mockup Website modal)** — `knowledge-base/config/config.html`
- [ ] T038 [US3] Integrate with US1 pipeline (per-page = one episode)

**Checkpoint**: US1, US2, US3 all work independently

---

## Phase 4 (revised): User Story 4 — Manage & delete knowledge bases (Priority: P3)

> **Revision 3 note**: the former US4 "per-agent access control" has been **removed** (no per-KB per-agent grants). The lifecycle story (rename/delete/health) becomes **US4**.

**Goal**: Rename, reconfigure, delete KBs; surface ingestion health/errors.
**Independent Test**: Rename a KB, delete a KB (confirmation), confirm sources + index cleaned up.

### Tests for User Story 4
> **NOTE: Write these tests FIRST, ensure they FAIL before implementation**
- [ ] T039 [P] [US4] KB lifecycle tests — `knowledge-base/services/tests/kb-lifecycle.test.ts` (rename, delete+cleanup, error status)

### Implementation for User Story 4
- [ ] T040 [P] [US4] Rename/delete KB + source/index cleanup — `knowledge-base/services/src/state/` (delete → clear Graphiti group)
- [ ] T041 [US4] Per-source ingestion health + actionable errors — `knowledge-base/services/src/state/health.ts` + config page source cards (mockup `tab-health`)
- [ ] T042 [US4] **Config page: rename + delete (confirmation) + health display (mockup `screen-detail` + `tab-health`)** — `knowledge-base/config/config.html`

**Checkpoint**: All user stories independently functional

---

## Phase 6: Polish & Cross-Cutting Concerns

**Purpose**: Improvements affecting multiple user stories

- [ ] T043 [P] Documentation: usage + dev docs per Constitution VI — `docs/usage/` (KB service config guide incl. the user's Dokploy Graphiti stack setup), `docs/dev/` (worker pipeline, Graphiti endpoint config)
- [ ] T044 Update `specs/discrepancies.md` if code/spec drift found
- [ ] T045 Code cleanup + refactor across stories
- [ ] T046 [P] Security hardening: secrets via `/api/secrets`, telemetry off, local-first check
- [ ] T047 Document the Graphiti stack configuration the user deploys in Dokploy (endpoint, `GRAPHITI_TELEMETRY_ENABLED=false`) — **the stack is external, BOS does not orchestrate it**

---

## Dependencies & Execution Order

### Phase Dependencies
- **Setup (Phase 1)**: No dependencies — can start immediately
- **Foundational (Phase 2)**: Depends on Setup — BLOCKS all user stories
- **User Stories (Phase 3–5)**: All depend on Foundational; proceed in priority order (US1 → US2/US3 → US4)
- **Polish (Phase 6)**: Depends on all user stories complete

### User Story Dependencies
- **US1 (P1)**: starts after Foundational; no deps on other stories — MVP
- **US2 (P2)**: after Foundational; reuses US1 pipeline (extract/chunk/add_episode)
- **US3 (P2)**: after Foundational; reuses US1 pipeline
- **US4 (P3, revised)**: after Foundational; depends on state store (T007). (Former US4 access control removed.)

### Within Each User Story
- Tests written FIRST, fail before implementation
- Core pipeline before config-page UI
- Story complete before next priority

### Parallel Opportunities
- All [P]-marked tasks in Setup/Foundational run in parallel
- US2 and US3 can run in parallel after Foundational (different files)
- US4 after US1 (builds on KB detail)

---

## Implementation Strategy

### MVP First (US1 only)
1. Phase 1 Setup → Phase 2 Foundational (CRITICAL)
2. Phase 3 US1 → STOP, validate independently → deploy/demo

### Incremental Delivery
1. Setup + Foundational → foundation ready
2. US1 → test independently → MVP
3. US2 → test independently → deploy/demo
4. US3 → test independently → deploy/demo
5. US4 (lifecycle) → test independently → deploy/demo
6. Each story adds value without breaking previous stories

### Parallel Team Strategy
- Team completes Setup + Foundational together
- Then: Dev A = US1; Dev B = US2; Dev C = US3 in parallel
- US4 after US1 completes

---

## Notes
- [P] = different files, no dependencies
- [Story] maps task to user story for traceability
- Each user story independently completable/testable
- Verify tests fail before implementing
- Commit after each task or logical group
- Stop at any checkpoint to validate story independently
- Avoid: vague tasks, same-file conflicts, cross-story deps that break independence
- **No docker-compose (removed)**: the Graphiti stack is user-deployed in Dokploy — no BOS compose file, no item compose file, no BOS source change.
- **Config page UI (FR-013)**: all config-page tasks (T023–T026, T026b, T031, T037, T042) MUST conform to the `038-knowledge-base.html` mockup in the spec directory — that mockup is the UI contract for the service's configuration page.
- **Graphiti MCP endpoint (FR-014)**: the config page MUST include an editable Graphiti MCP endpoint setting (T026b); the worker resolves the endpoint from this user-set config for all Graphiti calls; a default (`http://127.0.0.1:8020/mcp/`) is provided but editable; changing it must take effect without reinstalling the item.
